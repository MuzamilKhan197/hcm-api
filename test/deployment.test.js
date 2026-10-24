import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import app from '../app.js';
import legacyApp from '../src/app.js';
import { createServerlessHandler, readServerConfig } from '../src/serverless.js';
import { createDemoStore } from '../src/config/database.js';

const env = {
  VERCEL: '1',
  MONGODB_URI: 'mongodb://database.invalid/hcm',
  JWT_SECRET: 'test-only-deployment-secret-longer-than-32-characters',
  CLIENT_URL: 'https://hcm-client-seven.vercel.app/',
};
function fixture(options) {
  const application = express();
  application.use(createServerlessHandler(options));
  return application;
}

test('Vercel entry and compatibility entry export the same Express function without requiring env at import', async () => {
  assert.equal(typeof app, 'function');
  assert.equal(app, legacyApp);
  const response = await request(app).get('/').expect(200);
  assert.equal(response.body.service, 'HCM Lite API');
  const deployment = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url)));
  assert.equal(deployment.framework, 'express');
  assert.deepEqual(Object.keys(deployment.functions), ['app.js']);
});

test('missing production configuration returns actionable JSON instead of a crashed module', async () => {
  const application = fixture({ env: { VERCEL: '1' } });
  const response = await request(application).get('/api/auth/status').expect(503).expect('Content-Type', /json/);
  assert.equal(response.body.code, 'SERVER_CONFIGURATION_ERROR');
  assert.match(response.body.message, /MONGODB_URI/);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('production origin validation normalizes trailing slash and rejects credentials and paths', () => {
  assert.equal(readServerConfig(env).config.clientUrl, 'https://hcm-client-seven.vercel.app');
  assert.equal(readServerConfig(env).config.production, true);
  for (const clientUrl of ['https://user:password@example.com', 'https://example.com/path', 'http://example.com', 'https://example.com?token=secret']) {
    assert.throws(() => readServerConfig({ ...env, CLIENT_URL: clientUrl }), /CLIENT_URL/);
  }
  assert.throws(() => readServerConfig({ ...env, JWT_SECRET: '' }), /JWT_SECRET/);
  assert.throws(() => readServerConfig({ ...env, CLIENT_URL: '' }), /CLIENT_URL/);
});

test('concurrent and warm function requests share one lazy MongoDB initialization', async () => {
  const store = await createDemoStore();
  let connections = 0;
  const application = fixture({ env, connect: async () => { connections++; return store; } });
  const responses = await Promise.all([
    request(application).get('/api/auth/status'),
    request(application).get('/auth/status'),
    request(application).get('/api/health'),
  ]);
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(connections, 1);
  await request(application).get('/api/auth/status').expect(200);
  assert.equal(connections, 1);
});

test('failed MongoDB initialization is retried and never returns connection secrets', async () => {
  const store = await createDemoStore();
  let attempts = 0;
  const application = fixture({ env, connect: async () => {
    attempts++;
    if (attempts === 1) throw new Error('mongodb://private-user:private-password@database');
    return store;
  } });
  const failed = await request(application).get('/api/auth/status').expect(503);
  assert.equal(failed.body.code, 'DATABASE_UNAVAILABLE');
  assert.ok(!JSON.stringify(failed.body).includes('private-password'));
  await request(application).get('/api/auth/status').expect(200);
  assert.equal(attempts, 2);
});

test('proxied API requests retain origin validation and disable response caching', async () => {
  const store = await createDemoStore();
  const application = fixture({ env, connect: async () => store });
  const allowed = await request(application).get('/api/auth/status')
    .set('Origin', 'https://hcm-client-seven.vercel.app')
    .set('X-Forwarded-For', '203.0.113.10').expect(200);
  assert.equal(allowed.headers['cache-control'], 'no-store');
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://hcm-client-seven.vercel.app');
  await request(application).post('/api/auth/login').set('Origin', 'https://untrusted.example').send({}).expect(403);
});
