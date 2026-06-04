import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { fakeCtx } from './helpers.js';
import type { PurchaseRow } from '../src/lib/db.js';
import type { Product } from '../src/types.js';

const AUTH = { authorization: 'Bearer admin-token' };

const MANUAL_PRODUCT: Product = {
  id: 'manual-30d',
  sed: 'sed:test-cast',
  face: 'character',
  scope: 'frame:test',
  duration_days: 30,
  description: 'manual product',
  rate_limit: { max_per_hour: 5, max_per_day: 50 },
  price: { driver: 'manual', instructions: 'wire to BANK 12345; reference will be your purchase id' },
};

function manualCtx(overrides: { product?: Product } = {}) {
  return fakeCtx({ products: [overrides.product ?? MANUAL_PRODUCT] });
}

test('manual: POST /buy/:id creates pending row + returns instructions', async () => {
  const ctx = manualCtx();
  const app = createApp(ctx);
  const res = await app.request('/buy/manual-30d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ buyer_agent_id: 'brisa' }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; purchase_id: string; status: string; instructions: string; reference: string };
  assert.equal(body.status, 'pending');
  assert.match(body.instructions, /^wire to BANK/);
  assert.equal(body.reference, body.purchase_id);

  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(body.purchase_id) as PurchaseRow;
  assert.equal(row.status, 'pending');
  assert.equal(row.driver, 'manual');
});

test('manual: instructions can be omitted from product config', async () => {
  const ctx = manualCtx({
    product: {
      ...MANUAL_PRODUCT,
      price: { driver: 'manual' }, // no instructions
    },
  });
  const app = createApp(ctx);
  const res = await app.request('/buy/manual-30d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ buyer_agent_id: 'brisa' }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { instructions: string | null };
  assert.equal(body.instructions, null);
});

test('admin/mark-paid: requires auth', async () => {
  const ctx = manualCtx();
  const app = createApp(ctx);
  ctx.db
    .prepare(
      `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, created_at)
       VALUES ('p1', 'manual-30d', 'brisa', 'pending', 'manual', '2026-05-01T12:00:00Z')`,
    )
    .run();
  const res = await app.request('/admin/mark-paid/p1', { method: 'POST' });
  assert.equal(res.status, 401);
});

test('admin/mark-paid: 404 unknown purchase', async () => {
  const ctx = manualCtx();
  const res = await createApp(ctx).request('/admin/mark-paid/no-such', {
    method: 'POST',
    headers: AUTH,
  });
  assert.equal(res.status, 404);
});

test('admin/mark-paid: 400 if not a manual purchase', async () => {
  const ctx = manualCtx();
  ctx.db
    .prepare(
      `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, created_at)
       VALUES ('p-stripe', 'manual-30d', 'brisa', 'pending', 'stripe', '2026-05-01T12:00:00Z')`,
    )
    .run();
  const res = await createApp(ctx).request('/admin/mark-paid/p-stripe', {
    method: 'POST',
    headers: AUTH,
  });
  assert.equal(res.status, 400);
});

test('admin/mark-paid: idempotent on already-paid', async () => {
  const ctx = manualCtx();
  ctx.db
    .prepare(
      `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, grain_pair_id, created_at, paid_at)
       VALUES ('p1', 'manual-30d', 'brisa', 'paid', 'manual', 'fakepairid12345a', '2026-05-01T12:00:00Z', '2026-05-01T12:00:01Z')`,
    )
    .run();
  const res = await createApp(ctx).request('/admin/mark-paid/p1', {
    method: 'POST',
    headers: AUTH,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; idempotent: boolean };
  assert.equal(body.idempotent, true);
});

test('admin/mark-paid: end-to-end pending → paid + grain reach called', async () => {
  const ctx = manualCtx();
  const app = createApp(ctx);
  // Create a pending row through the buy route (covers full flow).
  const buy = await app.request('/buy/manual-30d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ buyer_agent_id: 'brisa' }),
  });
  const { purchase_id } = (await buy.json()) as { purchase_id: string };

  const res = await app.request(`/admin/mark-paid/${purchase_id}`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ notes: 'wire arrived 2026-05-02 ref purchase_id' }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; pair_id: string };
  assert.ok(body.pair_id);

  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase_id) as PurchaseRow;
  assert.equal(row.status, 'paid');
  assert.equal(row.grain_pair_id, body.pair_id);
  assert.match(row.notes ?? '', /wire arrived/);

  // Grain reach with right shape.
  const mcp = ctx.mcp as ReturnType<typeof import('./helpers.js').fakeMcpClient>;
  const reach = mcp.calls.find((c) => c.name === 'pscale_grain_reach')!;
  assert.match(reach.args.my_side_content as string, /^\[ticket face=character scope=frame:test/);
});

test('admin/mark-paid: rate-limit cap-hit at issuance → 429 + row marked rate_limited', async () => {
  const ctx = manualCtx();
  const app = createApp(ctx);
  const now = new Date().toISOString();

  // Create a pending purchase first (before the cap is hit at /buy time).
  ctx.db
    .prepare(
      `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, created_at)
       VALUES ('pending-1', 'manual-30d', 'brisa', 'pending', 'manual', ?)`,
    )
    .run(now);

  // Fill the hour cap with prior paid rows AFTER the pending was created
  // — simulates the operator marking many paid in a tight window between
  // when the pending was queued and when this one's mark-paid is called.
  for (let i = 0; i < 5; i++) {
    ctx.db
      .prepare(
        `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, created_at, paid_at)
         VALUES (?, 'manual-30d', 'someone', 'paid', 'manual', ?, ?)`,
      )
      .run(`prior-${i}`, now, now);
  }

  const res = await app.request('/admin/mark-paid/pending-1', {
    method: 'POST',
    headers: AUTH,
  });
  assert.equal(res.status, 429);
  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get('pending-1') as PurchaseRow;
  assert.equal(row.status, 'rate_limited');
});
