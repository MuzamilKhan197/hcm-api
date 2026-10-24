import { Router } from 'express';
import { body } from 'express-validator';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import PDFDocument from 'pdfkit';
import { authenticate, allow } from '../middleware/auth.js';
import { validate } from '../controllers/auth.js';
import { assert, dateInZone, workdays, validDate, validTimezone, payrollAmount } from '../utils/domain.js';
import { answerAssistant } from '../services/assistant.js';

const text = (field, min = 1, max = 200) => body(field).isString().trim().isLength({ min, max }).withMessage(`Please enter a valid ${field} (${min}–${max} characters).`);
const log = (tx, user, action, details = '') => tx.insert('auditLogs', { userId: user._id, action, details });
const notify = (tx, userId, title, message) => tx.insert('notifications', { userId, title, message, read: false });
const staffOnly = allow('admin', 'hr');
const assistantLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Please wait before asking the assistant again.' },
});
async function workspace(db, user) {
  const filter = user.role === 'employee' ? { employeeId: user.employeeId || 'none' } : {};
  const [company, employees, departments, attendance, leaves, leaveTypes, holidays, payrolls, announcements, notifications, auditLogs] = await Promise.all([
    db.one('companies'), db.all('employees', user.role === 'employee' ? { _id: user.employeeId || 'none' } : {}), db.all('departments'), db.all('attendance', filter), db.all('leaves', filter), db.all('leaveTypes'), db.all('holidays'),
    user.role === 'hr' ? [] : db.all('payrolls', filter), db.all('announcements'), db.all('notifications', { userId: user._id }), user.role === 'admin' ? db.all('auditLogs') : [],
  ]);
  return { company, mode: db.mode, today: dateInZone(new Date(), company.timezone), employees: employees.map(employee => {
    if (user.role !== 'hr') return employee;
    const { baseSalary, allowance, ...publicEmployee } = employee; return publicEmployee;
  }), departments, attendance, leaves, leaveTypes, holidays, payrolls, announcements: announcements.reverse(), notifications: notifications.reverse(), auditLogs: auditLogs.reverse().slice(0, 100) };
}
export function workspaceRouter(db, config) {
  const router = Router();
  router.use(authenticate(db, config));
  router.get('/workspace', async (req, res) => res.json(await workspace(db, req.user)));

  router.post('/departments', allow('admin'), text('name', 2, 60), body('description').optional().isString().trim().isLength({ max: 300 }), validate, async (req, res) => {
    const record = await db.transaction(async tx => {
      const department = await tx.insert('departments', { name: req.body.name, description: req.body.description || '', color: '#4c8e7b' });
      await log(tx, req.user, 'Department created', department.name); return department;
    });
    res.status(201).json(record);
  });

  router.post('/employees', staffOnly, text('name', 2, 80), body('email').isEmail().withMessage('Enter a valid email.').normalizeEmail(), text('designation', 2, 80), text('departmentId'),
    body('phone').optional({ values: 'falsy' }).isString().trim().isLength({ max: 40 }).withMessage('Phone must be 40 characters or fewer.'),
    body('address').optional({ values: 'falsy' }).isString().trim().isLength({ max: 300 }).withMessage('Address must be 300 characters or fewer.'),
    body('emergencyContact').optional({ values: 'falsy' }).isString().trim().isLength({ max: 120 }).withMessage('Emergency contact must be 120 characters or fewer.'),
    body('password').isString().isLength({ min: 8, max: 72 }).withMessage('Temporary password must be 8–72 characters.'),
    body('joinDate').custom(validDate).withMessage('Enter a valid joining date.'),
    body('baseSalary').optional().isFloat({ min: 0, max: 1e8 }).toFloat(), body('allowance').optional().isFloat({ min: 0, max: 1e7 }).toFloat(), validate,
    async (req, res) => {
      const role = req.body.role || 'employee';
      assert(['hr', 'employee'].includes(role), 'Employee role must be HR or Employee.');
      assert(req.user.role === 'admin' || role === 'employee', 'Only an admin can add an HR account.', 403);
      assert(req.user.role === 'admin' || (req.body.baseSalary === undefined && req.body.allowance === undefined), 'Only an admin can set compensation.', 403);
      const password = await bcrypt.hash(req.body.password, 12);
      const record = await db.transaction(async tx => {
        assert(await tx.one('departments', { _id: req.body.departmentId }), 'Choose an existing department.');
        const company = await tx.one('companies');
        // Updating the singleton serializes employee-code allocation across processes.
        await tx.update('companies', { _id: company._id }, { name: company.name });
        const user = await tx.insert('users', { name: req.body.name, email: req.body.email, password, role, active: true });
        let codeNumber = (await tx.all('employees')).length + 1;
        while (await tx.one('employees', { employeeCode: `EMP-${String(codeNumber).padStart(3, '0')}` })) codeNumber += 1;
        const employee = await tx.insert('employees', { userId: user._id, employeeCode: `EMP-${String(codeNumber).padStart(3, '0')}`, name: req.body.name, email: req.body.email, phone: req.body.phone || '', address: req.body.address || '', emergencyContact: req.body.emergencyContact || '', designation: req.body.designation, departmentId: req.body.departmentId, joinDate: req.body.joinDate, employmentType: ['Full-time','Part-time','Contract'].includes(req.body.employmentType) ? req.body.employmentType : 'Full-time', baseSalary: req.body.baseSalary || 0, allowance: req.body.allowance || 0, status: 'active', avatarColor: 'sage' });
        await tx.update('users', { _id: user._id }, { employeeId: employee._id });
        if (!await tx.one('designations', { name: employee.designation })) await tx.insert('designations', { name: employee.designation });
        await notify(tx, user._id, 'Welcome aboard', 'Your HCM Lite account is ready.');
        await log(tx, req.user, 'Employee registered', employee.name);
        if (req.user.role === 'hr') { const { baseSalary, allowance, ...visible } = employee; return visible; }
        return employee;
      });
      res.status(201).json(record);
    });

  router.patch('/employees/:id', staffOnly,
    body('name').optional().isString().trim().isLength({ min: 2, max: 80 }).withMessage('Name must be 2–80 characters.'),
    body('email').optional().isEmail().withMessage('Enter a valid email.').normalizeEmail(),
    body('phone').optional().isString().trim().isLength({ max: 40 }),
    body('address').optional().isString().trim().isLength({ max: 300 }),
    body('emergencyContact').optional().isString().trim().isLength({ max: 120 }),
    body('designation').optional().isString().trim().isLength({ min: 2, max: 80 }),
    body('departmentId').optional().isString().trim(),
    body('employmentType').optional().isIn(['Full-time', 'Part-time', 'Contract']),
    body('status').optional().isIn(['active', 'inactive']),
    body('baseSalary').optional().isFloat({ min: 0, max: 1e8 }).toFloat(),
    body('allowance').optional().isFloat({ min: 0, max: 1e7 }).toFloat(),
    validate, async (req, res) => {
    const result = await db.transaction(async tx => {
      const employee = await tx.one('employees', { _id: req.params.id });
      assert(employee, 'Employee not found.', 404);
      assert(req.user.role === 'admin' || !['status', 'baseSalary', 'allowance'].some(key => req.body[key] !== undefined), 'Only an admin can change account status or compensation.', 403);
      assert(employee.userId !== req.user._id || req.body.status !== 'inactive', 'You cannot deactivate your own account.');
      const editable = ['name', 'email', 'phone', 'address', 'emergencyContact', 'designation', 'departmentId', 'employmentType', 'status', 'baseSalary', 'allowance'];
      const changes = Object.fromEntries(editable.filter(key => req.body[key] !== undefined).map(key => [key, req.body[key]]));
      assert(Object.keys(changes).length, 'No supported changes were provided.');
      if (changes.departmentId) assert(await tx.one('departments', { _id: changes.departmentId }), 'Choose an existing department.');
      const updated = await tx.update('employees', { _id: employee._id }, changes);
      const linkedUserChanges = Object.fromEntries(['name', 'email'].filter(key => changes[key] !== undefined).map(key => [key, changes[key]]));
      const linkedUser = await tx.one('users', { _id: employee.userId });
      assert(linkedUser, 'Employee account not found.', 404);
      const userChanges = { ...linkedUserChanges };
      if (changes.status) {
        userChanges.active = changes.status === 'active';
        if (changes.status === 'inactive' && employee.status !== 'inactive') {
          userChanges.sessionVersion = (linkedUser.sessionVersion || 0) + 1;
        }
      }
      if (Object.keys(userChanges).length) await tx.update('users', { _id: employee.userId }, userChanges);
      const action = changes.status === 'inactive' ? 'Employee deactivated'
        : changes.status === 'active' ? 'Employee reactivated'
          : 'Employee updated';
      await log(tx, req.user, action, employee.name);
      if (req.user.role === 'hr') {
        const { baseSalary, allowance, ...visible } = updated;
        return visible;
      }
      return updated;
    });
    res.json(result);
  });

  router.delete('/employees/:id', allow('admin'), async (req, res) => {
    await db.transaction(async tx => {
      const employee = await tx.one('employees', { _id: req.params.id });
      assert(employee, 'Employee not found.', 404);
      assert(employee.userId !== req.user._id, 'You cannot delete your own account.');
      const user = await tx.one('users', { _id: employee.userId });
      assert(user && user.role !== 'admin', 'Employee account not found.', 404);

      for (const collection of ['attendance', 'leaves', 'payrolls']) {
        await tx.delete(collection, { employeeId: employee._id });
      }
      for (const leave of await tx.all('leaves', { reviewedBy: user._id })) {
        await tx.update('leaves', { _id: leave._id }, { reviewedBy: '' });
      }
      await tx.delete('notifications', { userId: user._id });
      for (const notification of await tx.all('notifications')) {
        if (`${notification.title} ${notification.message}`.includes(employee.name)) {
          await tx.delete('notifications', { _id: notification._id });
        }
      }
      await tx.delete('aiLogs', { userId: user._id });
      await tx.delete('auditLogs', { userId: user._id });
      await tx.delete('auditLogs', { details: employee.name });
      await tx.delete('announcements', { author: employee.name });
      await tx.delete('employees', { _id: employee._id });
      await tx.delete('users', { _id: user._id });
      await log(tx, req.user, 'Employee permanently deleted');
    });
    res.status(204).end();
  });

  router.post('/attendance/check-in', async (req, res) => {
    assert(req.user.employeeId, 'Create an employee profile to use attendance.');
    const result = await db.transaction(async tx => {
      const company = await tx.one('companies');
      const now = new Date(); const date = dateInZone(now, company.timezone);
      const employee = await tx.one('employees', { _id: req.user.employeeId });
      assert(employee && employee.joinDate <= date, 'Attendance is available from your joining date.');
      const prior = await tx.all('attendance', { employeeId: req.user.employeeId });
      assert(!prior.some(a => !a.checkOut), 'Check out of your open shift before checking in again.', 409);
      assert(!await tx.one('attendance', { employeeId: req.user.employeeId, date }), 'You have already checked in today.', 409);
      const leave = (await tx.all('leaves', { employeeId: req.user.employeeId, status: 'approved' })).some(l => l.startDate <= date && l.endDate >= date);
      assert(!leave, 'You are on approved leave today.');
      const time = new Intl.DateTimeFormat('en-GB', { timeZone: company.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
      const record = await tx.insert('attendance', { employeeId: req.user.employeeId, date, checkIn: now.toISOString(), checkOut: null, status: time > '09:15' ? 'late' : 'present' });
      await log(tx, req.user, 'Checked in', date); return record;
    }); res.status(201).json(result);
  });
  router.post('/attendance/check-out', async (req, res) => {
    assert(req.user.employeeId, 'You need an employee profile first.');
    const result = await db.transaction(async tx => {
      const records = await tx.all('attendance', { employeeId: req.user.employeeId });
      const current = records.filter(a => !a.checkOut).sort((a,b) => b.date.localeCompare(a.date))[0];
      assert(current, 'No open check-in found.', 409);
      const updated = await tx.update('attendance', { _id: current._id, checkOut: current.checkOut }, { checkOut: new Date().toISOString() });
      assert(updated, 'You have already checked out.', 409);
      await log(tx, req.user, 'Checked out', current.date); return updated;
    }); res.json(result);
  });

  router.post('/leaves', text('type', 2, 30), body('startDate').custom(validDate), body('endDate').custom(validDate), text('reason', 5, 600), validate, async (req, res) => {
    assert(req.user.employeeId, 'Create an employee profile before requesting leave.');
    const { type, startDate, endDate, reason } = req.body;
    assert(startDate <= endDate && startDate.slice(0,4) === endDate.slice(0,4), 'Choose dates in the same year, with the end after the start.');
    const result = await db.transaction(async tx => {
      const company = await tx.one('companies');
      assert(startDate >= dateInZone(new Date(), company.timezone), 'Leave cannot start in the past.');
      const employee = await tx.one('employees', { _id: req.user.employeeId });
      assert(employee && startDate >= employee.joinDate, 'Leave cannot start before your joining date.');
      await tx.update('employees', { _id: employee._id }, { name: employee.name });
      const leaveType = await tx.one('leaveTypes', { name: type }); assert(leaveType, 'Choose a valid leave type.');
      const days = workdays(startDate, endDate, await tx.all('holidays')).length; assert(days > 0, 'This range contains no working days.');
      const existing = (await tx.all('leaves', { employeeId: req.user.employeeId })).filter(l => l.status !== 'rejected');
      assert(!existing.some(l => l.startDate <= endDate && l.endDate >= startDate), 'This request overlaps an existing leave request.', 409);
      const used = existing.filter(l => l.type === type && l.startDate.slice(0,4) === startDate.slice(0,4)).reduce((sum,l) => sum + l.days, 0);
      assert(used + days <= leaveType.quota, `Not enough ${type.toLowerCase()} leave remaining. Pending requests also reserve your balance.`);
      const record = await tx.insert('leaves', { employeeId: req.user.employeeId, type, startDate, endDate, reason, days, status: 'pending' });
      for (const approver of (await tx.all('users', { active: true })).filter(u => ['admin','hr'].includes(u.role) && u._id !== req.user._id)) await notify(tx, approver._id, 'Leave request needs review', `${req.user.name} requested ${days} day(s) of ${type.toLowerCase()} leave.`);
      await log(tx, req.user, 'Leave requested', `${type}: ${startDate} to ${endDate}`); return record;
    }); res.status(201).json(result);
  });
  router.patch('/leaves/:id', staffOnly, body('status').isIn(['approved', 'rejected']).withMessage('Choose approved or rejected.'), validate, async (req, res) => {
    const result = await db.transaction(async tx => {
      const leave = await tx.one('leaves', { _id: req.params.id }); assert(leave, 'Leave request not found.', 404);
      assert(leave.employeeId !== req.user.employeeId, 'Another HR manager or admin must review your own leave.', 403);
      assert(leave.status === 'pending', 'This request has already been reviewed.', 409);
      const record = await tx.update('leaves', { _id: leave._id, status: 'pending' }, { status: req.body.status, reviewedBy: req.user._id });
      assert(record, 'This request has already been reviewed.', 409);
      const employee = await tx.one('employees', { _id: leave.employeeId });
      await notify(tx, employee.userId, `Leave ${req.body.status}`, `Your ${leave.type.toLowerCase()} leave for ${leave.startDate} has been ${req.body.status}.`);
      await log(tx, req.user, `Leave ${req.body.status}`, employee.name); return record;
    }); res.json(result);
  });

  router.post('/payrolls/generate', allow('admin'), body('month').matches(/^20\d{2}-(0[1-9]|1[0-2])$/).withMessage('Choose a valid payroll month.'), body('taxPercent').optional().isFloat({ min: 0, max: 60 }).toFloat(), validate, async (req, res) => {
    const result = await db.transaction(async tx => {
      const company = await tx.one('companies');
      assert(req.body.month <= dateInZone(new Date(), company.timezone).slice(0,7), 'Future payroll cannot be generated.');
      await tx.update('companies', { _id: company._id }, { name: company.name });
      const existing = await tx.all('payrolls', { month: req.body.month });
      const employees = (await tx.all('employees', { status: 'active' })).filter(e => e.joinDate.slice(0,7) <= req.body.month && !existing.some(p => p.employeeId === e._id));
      assert(employees.length, 'Payroll already exists for all eligible employees, or no employees are eligible.', 409);
      assert(employees.every(e => e.baseSalary > 0), 'Set a salary for every eligible employee before generating payroll.');
      const leaves = await tx.all('leaves'); const holidays = await tx.all('holidays'); const departments = await tx.all('departments');
      const records = [];
      for (const employee of employees) {
        const payroll = await tx.insert('payrolls', { employeeId: employee._id, employeeName: employee.name, employeeCode: employee.employeeCode, designation: employee.designation, department: departments.find(d => d._id === employee.departmentId)?.name || '', month: req.body.month, ...payrollAmount(employee, req.body.month, leaves, holidays, req.body.taxPercent || 0), taxPercent: req.body.taxPercent || 0, currency: company.currency, status: 'draft' });
        records.push(payroll);
        const user = await tx.one('users', { _id: employee.userId });
        if (user?.active) await notify(tx, user._id, 'Payroll generated', `Your payslip for ${req.body.month} is available in Payroll.`);
      }
      await log(tx, req.user, 'Payroll generated', `${req.body.month}: ${records.length} payslips`); return records;
    }); res.status(201).json(result);
  });
  router.patch('/payrolls/:id/pay', allow('admin'), async (req, res) => {
    const result = await db.transaction(async tx => {
      const payroll = await tx.update('payrolls', { _id: req.params.id, status: 'draft' }, { status: 'paid', paidAt: new Date().toISOString() });
      assert(payroll, 'Draft payroll not found, or it is already marked paid.', 409);
      const employee = await tx.one('employees', { _id: payroll.employeeId });
      await notify(tx, employee.userId, 'Your payslip is ready', `Payroll for ${payroll.month} has been marked paid.`);
      await log(tx, req.user, 'Payroll marked paid', `${payroll.employeeName} · ${payroll.month}`); return payroll;
    }); res.json(result);
  });
  router.get('/payrolls/:id/pdf', allow('admin', 'employee'), async (req, res) => {
    const payroll = await db.one('payrolls', { _id: req.params.id });
    assert(payroll && (req.user.role === 'admin' || payroll.employeeId === req.user.employeeId), 'Payslip not found.', 404);
    const company = await db.one('companies');
    const doc = new PDFDocument({ size: 'A4', margin: 55 });
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="payslip-${payroll.month}-${payroll.employeeCode}.pdf"`);
    doc.pipe(res); doc.fillColor('#186254').fontSize(25).text(company.name).moveDown(0.4);
    doc.fillColor('#252e2a').fontSize(16).text(`Payslip | ${payroll.month}`).moveDown();
    doc.fontSize(11).text(`Employee: ${payroll.employeeName}`).text(`Employee ID: ${payroll.employeeCode}`).text(`Designation: ${payroll.designation}`).text(`Department: ${payroll.department}`).text(`Status: ${payroll.status.toUpperCase()}`).moveDown(2);
    const amount = n => `${payroll.currency} ${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    for (const [label, value] of [['Gross pay',payroll.gross],['Unpaid leave deduction',payroll.deduction],[`Withholding (${payroll.taxPercent}%)`,payroll.tax],['Net pay',payroll.net]]) doc.fontSize(13).text(`${label}: ${amount(value)}`).moveDown(0.7);
    doc.moveDown(2).fontSize(9).fillColor('#68756f').text(`Working days: ${payroll.workingDays} | Paid days: ${payroll.paidDays}`).text('Salary is prorated by working days from the joining date. Unpaid leave is deducted.').text('Withholding is an administrator-entered rate. This is not a statutory tax calculation.').text('Marked paid records payment status only; HCM Lite does not transfer funds.'); doc.end();
  });

  router.post('/announcements', staffOnly, text('title', 3, 100), text('content', 10, 2000), validate, async (req, res) => {
    const record = await db.transaction(async tx => {
      const announcement = await tx.insert('announcements', { title: req.body.title, content: req.body.content, author: req.user.name, category: 'Team update' });
      for (const recipient of await tx.all('users', { active: true })) {
        await notify(tx, recipient._id, 'New company announcement', announcement.title);
      }
      await log(tx, req.user, 'Announcement published', announcement.title); return announcement;
    }); res.status(201).json(record);
  });
  router.patch('/notifications/:id/read', async (req, res) => {
    const notification = await db.transaction(async tx => {
      const updated = await tx.update('notifications', { _id: req.params.id, userId: req.user._id }, { read: true });
      assert(updated, 'Notification not found.', 404);
      return updated;
    });
    res.json(notification);
  });
  router.patch('/notifications/read', async (req, res) => {
    await db.transaction(async tx => { for (const n of await tx.all('notifications', { userId: req.user._id, read: false })) await tx.update('notifications', { _id: n._id }, { read: true }); });
    res.json({ ok: true });
  });
  router.patch('/company', allow('admin'),
    body('name').optional().isString().trim().isLength({ min: 2, max: 100 }).withMessage('Company name must be 2–100 characters.'),
    body('email').optional({ values: 'falsy' }).isEmail().withMessage('Enter a valid company email address.').normalizeEmail(),
    body('phone').optional().isString().trim().isLength({ max: 40 }),
    body('address').optional().isString().trim().isLength({ max: 300 }),
    body('timezone').optional().isString().trim().isLength({ min: 1, max: 100 }).custom(validTimezone).withMessage('Choose a valid IANA timezone.'),
    validate, async (req, res) => {
    const changes = Object.fromEntries(['name', 'email', 'phone', 'address', 'timezone'].filter(key => req.body[key] !== undefined).map(key => [key, req.body[key]]));
    assert(Object.keys(changes).length, 'Enter a company detail to update.');
    const record = await db.transaction(async tx => { const company = await tx.update('companies', { _id: 'workspace' }, changes); await log(tx, req.user, 'Company settings updated', company.name); return company; });
    res.json(record);
  });
  router.post('/holidays', allow('admin'), text('name', 2, 100), body('date').custom(validDate).withMessage('Choose a valid date.'), validate, async (req, res) => {
    const company = await db.one('companies');
    assert(req.body.date > dateInZone(new Date(), company.timezone), 'Add holidays for future dates.');
    const record = await db.transaction(async tx => {
      assert(!(await tx.all('leaves')).some(l => l.status !== 'rejected' && l.startDate <= req.body.date && l.endDate >= req.body.date), 'A leave request includes this date. Review it before changing the calendar.');
      const holiday = await tx.insert('holidays', { name: req.body.name, date: req.body.date }); await log(tx, req.user, 'Holiday added', holiday.name); return holiday;
    }); res.status(201).json(record);
  });
  router.post('/assistant', assistantLimit, text('question', 2, 500), validate, async (req, res) => {
    const data = await workspace(db, req.user); const question = req.body.question;
    const result = await answerAssistant(question, data, req.user, config);
    await db.transaction(tx => tx.insert('aiLogs', { userId: req.user._id, question: req.body.question, answer: result.answer, mode: result.mode }));
    res.json(result);
  });
  return router;
}
