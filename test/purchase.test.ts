import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { fakeCtx } from './helpers.js';
import type { PurchaseRow } from '../src/lib/db.js';

test('GET /buy/:id (HTML) renders the form', async () => {
  const app = createApp(fakeCtx());
  const res = await app.request('/buy/character-30d');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<form method="post"/);
  assert.match(html, /name="buyer_agent_id"/);
  assert.match(html, /character-30d/);
});

test('GET /buy/:id (JSON) returns product info', async () => {
  const app = createApp(fakeCtx());
  const res = await app.request('/buy/character-30d', { headers: { accept: 'application/json' } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { id: string; driver: string; face: string };
  assert.equal(body.id, 'character-30d');
  assert.equal(body.driver, 'stripe');
  assert.equal(body.face, 'character');
});

test('GET /buy/:id 404 for unknown product', async () => {
  const app = createApp(fakeCtx());
  const res = await app.request('/buy/no-such');
  assert.equal(res.status, 404);
});

test('POST /buy/:id (JSON) creates pending purchase + returns checkout URL', async () => {
  const ctx = fakeCtx();
  const app = createApp(ctx);
  const res = await app.request('/buy/character-30d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ buyer_agent_id: 'brisa' }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { checkout_url: string; purchase_id: string };
  assert.match(body.checkout_url, /^https:\/\/checkout\.stripe\.test\/cs_/);
  assert.ok(body.purchase_id);

  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(body.purchase_id) as PurchaseRow;
  assert.equal(row.status, 'pending');
  assert.equal(row.product_id, 'character-30d');
  assert.equal(row.buyer_agent_id, 'brisa');
  assert.equal(row.driver, 'stripe');
  assert.equal(row.driver_ref, `cs_${body.purchase_id}`);
});

test('POST /buy/:id (form) returns 303 redirect to checkout', async () => {
  const app = createApp(fakeCtx());
  const res = await app.request('/buy/character-30d', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'buyer_agent_id=brisa',
  });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location') ?? '', /^https:\/\/checkout\.stripe\.test\/cs_/);
});

test('POST /buy/:id rejects bad buyer_agent_id', async () => {
  const app = createApp(fakeCtx());
  const res = await app.request('/buy/character-30d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ buyer_agent_id: 'bad spaces!' }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'invalid_buyer_agent_id');
});

test('POST /buy/:id rejects empty buyer_agent_id', async () => {
  const app = createApp(fakeCtx());
  const res = await app.request('/buy/character-30d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('POST /buy/:id rejects buying from self', async () => {
  const app = createApp(fakeCtx());
  const res = await app.request('/buy/character-30d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ buyer_agent_id: 'tickets-test' }), // matches bare agent id
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'cannot_buy_from_self');
});

test('POST /buy/:id (gift product) without gift fields → 400', async () => {
  const app = createApp(fakeCtx());
  const res = await app.request('/buy/designer-90d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ buyer_agent_id: 'brisa' }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string; required: string[] };
  assert.equal(body.error, 'missing_gift_fields');
  assert.deepEqual(body.required.sort(), ['gifter_agent_id', 'issued_at', 'nonce', 'signature']);
});

test('POST /buy/:id 500 when stripe driver not configured', async () => {
  const app = createApp(fakeCtx({ stripeDriver: null }));
  const res = await app.request('/buy/character-30d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ buyer_agent_id: 'brisa' }),
  });
  assert.equal(res.status, 500);
});

test('POST /buy/:id pre-checkout rate limit 429', async () => {
  const ctx = fakeCtx();
  const now = new Date().toISOString();
  // Pre-populate two paid purchases within the hour to hit the cap (max_per_hour: 2).
  for (let i = 0; i < 2; i++) {
    ctx.db
      .prepare(
        `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, created_at, paid_at)
         VALUES (?, 'character-30d', 'someone', 'paid', 'stripe', ?, ?)`,
      )
      .run(`prior-${i}`, now, now);
  }
  const app = createApp(ctx);
  const res = await app.request('/buy/character-30d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ buyer_agent_id: 'brisa' }),
  });
  assert.equal(res.status, 429);
  const body = (await res.json()) as { error: string; reason: string };
  assert.equal(body.error, 'rate_limited');
  assert.equal(body.reason, 'hour-cap');
});

test('POST /buy/:id 502 when checkout creation fails', async () => {
  const ctx = fakeCtx();
  // The fake driver throws on next checkout
  (ctx.stripeDriver as any).failNextCheckout = new Error('stripe down');
  const app = createApp(ctx);
  const res = await app.request('/buy/character-30d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ buyer_agent_id: 'brisa' }),
  });
  assert.equal(res.status, 502);
});

test('GET /buy/:id/success and /cancel render', async () => {
  const app = createApp(fakeCtx());
  const succ = await app.request('/buy/character-30d/success');
  assert.equal(succ.status, 200);
  assert.match(await succ.text(), /Payment received/);
  const cnl = await app.request('/buy/character-30d/cancel');
  assert.equal(cnl.status, 200);
  assert.match(await cnl.text(), /Payment cancelled/);
});
