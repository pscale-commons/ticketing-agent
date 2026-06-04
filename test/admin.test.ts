import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { fakeCtx } from './helpers.js';
import type { PurchaseRow } from '../src/lib/db.js';

const AUTH = { authorization: 'Bearer admin-token' };

test('admin: rejects missing token', async () => {
  const app = createApp(fakeCtx());
  const res = await app.request('/admin/purchases');
  assert.equal(res.status, 401);
});

test('admin: rejects wrong token', async () => {
  const app = createApp(fakeCtx());
  const res = await app.request('/admin/purchases', { headers: { authorization: 'Bearer wrong' } });
  assert.equal(res.status, 401);
});

test('admin: lists purchases', async () => {
  const ctx = fakeCtx();
  ctx.db
    .prepare(
      `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, created_at)
       VALUES ('p1', 'character-30d', 'brisa', 'pending', 'stripe', '2026-05-01T12:00:00Z')`,
    )
    .run();
  const app = createApp(ctx);
  const res = await app.request('/admin/purchases', { headers: AUTH });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { purchases: PurchaseRow[] };
  assert.equal(body.purchases.length, 1);
  assert.equal(body.purchases[0]!.id, 'p1');
});

test('admin: filters by status', async () => {
  const ctx = fakeCtx();
  ctx.db.prepare(
    `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, created_at)
     VALUES ('p1', 'character-30d', 'brisa', 'pending', 'stripe', '2026-05-01T12:00:00Z'),
            ('p2', 'character-30d', 'casey', 'paid', 'stripe', '2026-05-01T13:00:00Z')`,
  ).run();
  const app = createApp(ctx);
  const res = await app.request('/admin/purchases?status=paid', { headers: AUTH });
  const body = (await res.json()) as { purchases: PurchaseRow[] };
  assert.equal(body.purchases.length, 1);
  assert.equal(body.purchases[0]!.id, 'p2');
});

test('admin: lookup by id', async () => {
  const ctx = fakeCtx();
  ctx.db.prepare(
    `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, created_at)
     VALUES ('p1', 'character-30d', 'brisa', 'pending', 'stripe', '2026-05-01T12:00:00Z')`,
  ).run();
  const app = createApp(ctx);
  const res = await app.request('/admin/purchases/p1', { headers: AUTH });
  assert.equal(res.status, 200);
  const body = (await res.json()) as PurchaseRow;
  assert.equal(body.id, 'p1');

  const missing = await app.request('/admin/purchases/p2', { headers: AUTH });
  assert.equal(missing.status, 404);
});

test('admin: rate-limit decision endpoint', async () => {
  const app = createApp(fakeCtx());
  const res = await app.request('/admin/rate-limit/character-30d', { headers: AUTH });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { decision: { allowed: boolean }; rate_limit: { max_per_hour: number } };
  assert.equal(body.decision.allowed, true);
  assert.equal(body.rate_limit.max_per_hour, 2);
});
