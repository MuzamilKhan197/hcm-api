import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerAssistant } from '../src/services/assistant.js';

const data = {
  today: '2026-10-25',
  company: { name: 'Private Company', timezone: 'Asia/Karachi' },
  employees: [{ name: 'Private Employee', email: 'person@example.com', status: 'active', baseSalary: 90000 }],
  departments: [{ name: 'Private Department' }],
  attendance: [{ date: '2026-10-25', status: 'late' }],
  leaves: [],
  leaveTypes: [{ name: 'Annual', quota: 18, paid: true }],
  payrolls: [{ status: 'paid', net: 85000 }],
};
const user = { role: 'admin' };

test('AI assistant sends only a minimal, role-scoped summary to the provider', async () => {
  let sentRequest;
  const result = await answerAssistant('Summarize the workspace', data, user, {
    openAiApiKey: 'test-api-key',
    openAiModel: 'test-model',
  }, async (url, options) => {
    sentRequest = { url, options };
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: 'One active teammate.' } }] };
      },
    };
  });

  assert.equal(sentRequest.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(sentRequest.options.headers.Authorization, 'Bearer test-api-key');
  const payload = JSON.parse(sentRequest.options.body);
  const serializedContext = payload.messages[1].content;
  assert.equal(payload.model, 'test-model');
  assert.equal(serializedContext.includes('Private Employee'), false);
  assert.equal(serializedContext.includes('person@example.com'), false);
  assert.equal(serializedContext.includes('90000'), false);
  assert.equal(serializedContext.includes('Private Company'), false);
  assert.equal(result.mode, 'openai');
  assert.equal(result.answer, 'One active teammate.');
});

test('AI assistant reports provider failures instead of returning local success-shaped answers', async () => {
  await assert.rejects(
    answerAssistant('Summarize the workspace', data, user, { openAiApiKey: 'test-api-key' }, async () => ({
      ok: false,
      status: 401,
    })),
    error => error.status === 502 && error.message === 'The AI assistant is temporarily unavailable.',
  );
});

test('AI assistant retains local insights when no provider key is configured', async () => {
  const result = await answerAssistant('Summarize the workspace', data, user, {});
  assert.equal(result.mode, 'local-insights');
  assert.match(result.answer, /1 active employees/);
});
