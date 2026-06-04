import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { fakeCtx } from './helpers.js';

test('catalogue: GET / with Accept: application/json returns view', async () => {
  const app = createApp(fakeCtx());
  const res = await app.request('/', { headers: { accept: 'application/json' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const body = (await res.json()) as { agent_id: string; products: Array<Record<string, unknown>> };
  assert.equal(body.agent_id, 'agent:tickets-test');
  assert.equal(body.products.length, 2);
  assert.equal(body.products[0]!.id, 'character-30d');
  assert.equal(body.products[0]!.buy_url, 'https://tickets.test/buy/character-30d');
  assert.equal(body.products[0]!.driver, 'stripe');
  assert.equal(body.products[1]!.driver, 'gift');
  assert.equal(body.products[1]!.tier, 'hard');
});

test('catalogue: GET / default returns HTML page', async () => {
  const app = createApp(fakeCtx());
  const res = await app.request('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  assert.match(html, /<title>Tickets — agent:tickets-test<\/title>/);
  assert.match(html, /character-30d/);
  assert.match(html, /designer-90d/);
  assert.match(html, /href="https:\/\/tickets\.test\/buy\/character-30d"/);
});

test('catalogue: HTML escapes hostile config strings', async () => {
  const ctx = fakeCtx();
  ctx.config.products[0]!.description = '<script>alert(1)</script>';
  const app = createApp(ctx);
  const res = await app.request('/');
  const html = await res.text();
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('health: still responds', async () => {
  const app = createApp(fakeCtx());
  const res = await app.request('/health');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; agent_id: string; products: number };
  assert.equal(body.status, 'ok');
  assert.equal(body.products, 2);
});

test('catalogue: registered routes do not break the 404 handler', async () => {
  const app = createApp(fakeCtx());
  const res = await app.request('/no-such-thing');
  assert.equal(res.status, 404);
});
