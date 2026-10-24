import { HttpError } from '../utils/domain.js';

function localAnswer(question, data, user) {
  const normalizedQuestion = question.toLowerCase();
  const active = data.employees.filter(employee => employee.status === 'active');

  if (/leave|balance|off/.test(normalizedQuestion)) {
    if (user.role === 'employee') {
      return data.leaveTypes.filter(type => type.paid).map(type => {
        const used = data.leaves
          .filter(leave => leave.type === type.name && leave.status !== 'rejected' && leave.startDate.startsWith(data.today.slice(0, 4)))
          .reduce((sum, leave) => sum + leave.days, 0);
        return `${type.name}: ${type.quota - used} of ${type.quota} days available`;
      }).join('. ') + '. Pending requests reserve your balance.';
    }
    return `${data.leaves.filter(leave => leave.status === 'pending').length} leave requests are waiting for review. ${data.leaves.filter(leave => leave.status === 'approved' && leave.startDate <= data.today && leave.endDate >= data.today).length} people are on approved leave today. Open Time off to review each request.`;
  }
  if (/pay|salary/.test(normalizedQuestion)) {
    if (user.role === 'hr') return 'Payroll is restricted to admins. Employees can view their own payslips.';
    return `${data.payrolls.filter(payroll => payroll.status === 'draft').length} payslips are in draft, and ${data.payrolls.filter(payroll => payroll.status === 'paid').length} are marked paid. Open Payroll to review the details.`;
  }
  if (/attend|present|check/.test(normalizedQuestion)) {
    const records = data.attendance.filter(record => record.date === data.today);
    return `${records.length} ${user.role === 'employee' ? 'check-in' : 'people checked in'} today, including ${records.filter(record => record.status === 'late').length} late arrival(s). The late threshold is 9:15 AM in ${data.company.timezone}.`;
  }
  if (user.role === 'employee') {
    return 'I can summarize your leave balance, attendance, and payslips. Try “What is my leave balance?”';
  }
  return `Your workspace has ${active.length} active employees across ${data.departments.length} departments. ${data.leaves.filter(leave => leave.status === 'pending').length} leave requests need review. Ask about attendance, time off, or payroll.`;
}

function allowedContext(data, user) {
  const attendance = data.attendance.filter(record => record.date === data.today);
  const context = {
    date: data.today,
    timezone: data.company.timezone,
    role: user.role,
    activePeople: data.employees.filter(employee => employee.status === 'active').length,
    departments: data.departments.length,
    attendance: {
      checkedIn: attendance.length,
      late: attendance.filter(record => record.status === 'late').length,
    },
  };

  if (user.role === 'employee') {
    context.leaveBalances = data.leaveTypes.filter(type => type.paid).map(type => {
      const used = data.leaves
        .filter(leave => leave.type === type.name && leave.status !== 'rejected' && leave.startDate.startsWith(data.today.slice(0, 4)))
        .reduce((sum, leave) => sum + leave.days, 0);
      return { type: type.name, available: Math.max(0, type.quota - used), quota: type.quota };
    });
  } else {
    context.pendingLeaveRequests = data.leaves.filter(leave => leave.status === 'pending').length;
    context.peopleOnLeave = data.leaves.filter(leave => leave.status === 'approved' && leave.startDate <= data.today && leave.endDate >= data.today).length;
    if (user.role === 'admin') {
      context.payrolls = {
        drafts: data.payrolls.filter(payroll => payroll.status === 'draft').length,
        paid: data.payrolls.filter(payroll => payroll.status === 'paid').length,
      };
    }
  }
  return context;
}

export async function answerAssistant(question, data, user, config, fetchImpl = fetch) {
  if (!config.openAiApiKey) {
    return {
      answer: localAnswer(question, data, user),
      mode: 'local-insights',
      note: 'Local workspace insights. No generative AI provider is connected.',
    };
  }

  let response;
  try {
    response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openAiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.openAiModel,
        temperature: 0.2,
        max_tokens: 500,
        messages: [
          {
            role: 'system',
            content: 'Answer briefly using only the supplied, role-scoped summary. Do not infer missing facts or claim to have records not provided. Never ask for or reveal personal data. If the summary does not contain an answer, say so.',
          },
          {
            role: 'user',
            content: JSON.stringify({ question, workspaceSummary: allowedContext(data, user) }),
          },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, 'The AI assistant is temporarily unavailable.');
  }

  if (!response.ok) throw new HttpError(502, 'The AI assistant is temporarily unavailable.');
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new HttpError(502, 'The AI assistant returned an invalid response.');
  }
  const answer = payload?.choices?.[0]?.message?.content?.trim();
  if (typeof answer !== 'string' || !answer || answer.length > 3000) {
    throw new HttpError(502, 'The AI assistant returned an invalid response.');
  }
  return {
    answer,
    mode: 'openai',
    note: 'AI-generated from a minimal, role-scoped workspace summary.',
  };
}
