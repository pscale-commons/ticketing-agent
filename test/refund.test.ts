import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { fakeCtx } from './helpers.js';
import type { PurchaseRow } from '../src/lib/db.js';

const AUTH = { authorization: 'Bearer admin-token' };

function seedPaid(
  ctx: ReturnType<typeof fakeCtx>,
  overrides: Partial<PurchaseRow> = {},
): string {
  const id = overrides.id ?? `purchase-${Math.random().toString(36).slice(2, 10)}`;
  ctx.db
    .prepare(
      `INSERT INTO purchases
       (id, product_id, buyer_agent_id, status, driver, driver_ref, grain_pair_id, created_at, paid_at, amount_cents, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      overrides.product_id ?? 'character-30d',
      overrides.buyer_agent_id ?? 'brisa',
      overrides.status ?? 'paid',
      overrides.driver ?? 'stripe',
      overrides.driver_ref ?? `cs_${id}`,
      overrides.grain_pair_id ?? 'fakepairid12345a',
      overrides.created_at ?? '2026-05-01T12:00:00Z',
      overrides.paid_at ?? '2026-05-01T12:00:01Z',
      overrides.amount_cents ?? 1000,
      overrides.currency ?? 'usd',
    );
  return id;
}

test('refund: requires auth', async () => {
  const ctx = fakeCtx();
  const id = seedPaid(ctx);
  const res = await createApp(ctx).request(`/admin/refund/${id}`, { method: 'POST' });
  assert.equal(res.status, 401);
});

test('refund: 404 for unknown purchase', async () => {
  const res = await createApp(fakeCtx()).request('/admin/refund/no-such', {
    method: 'POST',
    headers: AUTH,
  });
  assert.equal(res.status, 404);
});

test('refund: 400 for non-refundable status', async () => {
  const ctx = fakeCtx();
  const id = seedPaid(ctx, { status: 'pending' });
  const res = await createApp(ctx).request(`/admin/refund/${id}`, {
    method: 'POST',
    headers: AUTH,
  });
  assert.equal(res.status, 400);
});

test('refund: paid → stripe refund + grain revoke + status updated', async () => {
  const ctx = fakeCtx();
  const id = seedPaid(ctx);
  const driver = ctx.stripeDriver as ReturnType<typeof import('./helpers.js').fakeStripeDriver>;
  const mcp = ctx.mcp as ReturnType<typeof import('./helpers.js').fakeMcpClient>;

  const res = await createApp(ctx).request(`/admin/refund/${id}`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'cancelled' }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; refund_id: string; revoked: boolean; pair_id: string };
  assert.equal(body.ok, true);
  assert.equal(body.refund_id, `re_cs_${id}`);
  assert.equal(body.revoked, true);

  // Stripe refund called once.
  assert.equal(driver.refunds.length, 1);
  assert.equal(driver.refunds[0]!.reason, 'cancelled');
  assert.equal(driver.refunds[0]!.driver_ref, `cs_${id}`);

  // Grain revoke called: a bsp write to "<issuer_side>.1" carrying [ticket-revoked].
  const revokeCall = mcp.calls.find(
    (c) => c.name === 'bsp' && typeof c.args.spindle === 'string' && /\.1$/.test(c.args.spindle as string),
  );
  assert.ok(revokeCall, 'expected a bsp revoke write');
  assert.match(revokeCall!.args.content as string, /^\[ticket-revoked at=/);
  assert.match(revokeCall!.args.content as string, /reason=cancelled/);

  // Row updated.
  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(id) as PurchaseRow;
  assert.equal(row.status, 'refunded');
  assert.ok(row.refunded_at);
  assert.match(row.notes ?? '', /cancelled/);
});

test('refund: rate_limited → stripe refund only, no grain action', async () => {
  const ctx = fakeCtx();
  const id = seedPaid(ctx, { status: 'rate_limited', grain_pair_id: null });
  const driver = ctx.stripeDriver as ReturnType<typeof import('./helpers.js').fakeStripeDriver>;
  const mcp = ctx.mcp as ReturnType<typeof import('./helpers.js').fakeMcpClient>;

  const res = await createApp(ctx).request(`/admin/refund/${id}`, {
    method: 'POST',
    headers: AUTH,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { revoked: boolean };
  assert.equal(body.revoked, false);
  assert.equal(driver.refunds.length, 1);
  // No grain writes.
  assert.equal(mcp.calls.filter((c) => c.name === 'bsp' && c.args.content !== undefined).length, 0);

  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(id) as PurchaseRow;
  assert.equal(row.status, 'refunded');
});

test('refund: rejects whitespace in reason', async () => {
  const ctx = fakeCtx();
  const id = seedPaid(ctx);
  const res = await createApp(ctx).request(`/admin/refund/${id}`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'has spaces' }),
  });
  assert.equal(res.status, 400);
});

test('refund: stripe failure → 502, no row update, no grain write', async () => {
  const ctx = fakeCtx();
  const id = seedPaid(ctx);
  const driver = ctx.stripeDriver as ReturnType<typeof import('./helpers.js').fakeStripeDriver>;
  driver.failNextRefund = new Error('stripe down');
  const mcp = ctx.mcp as ReturnType<typeof import('./helpers.js').fakeMcpClient>;

  const res = await createApp(ctx).request(`/admin/refund/${id}`, {
    method: 'POST',
    headers: AUTH,
  });
  assert.equal(res.status, 502);

  // Grain not touched.
  assert.equal(mcp.calls.filter((c) => c.name === 'bsp' && c.args.content !== undefined).length, 0);

  // Row remains paid.
  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(id) as PurchaseRow;
  assert.equal(row.status, 'paid');
});

test('refund: grain revoke failure after stripe success → 502 with stripe_refunded flag, row marked refunded with note', async () => {
  const ctx = fakeCtx();
  const id = seedPaid(ctx);
  const mcp = ctx.mcp as ReturnType<typeof import('./helpers.js').fakeMcpClient>;
  // Make bsp writes fail (revoke is a bsp write).
  mcp.setResponse('bsp', () => 'Write rejected: simulated lock failure');

  const res = await createApp(ctx).request(`/admin/refund/${id}`, {
    method: 'POST',
    headers: AUTH,
  });
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string; stripe_refunded: boolean; refund_id: string };
  assert.equal(body.error, 'grain_revoke_failed');
  assert.equal(body.stripe_refunded, true);
  assert.match(body.refund_id, /^re_cs_/);

  // Row marked refunded so we don't double-refund — note records the failure.
  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(id) as PurchaseRow;
  assert.equal(row.status, 'refunded');
  assert.match(row.notes ?? '', /grain revoke failed/);
});

test('refund: stripe driver missing → 500', async () => {
  const ctx = fakeCtx({ stripeDriver: null });
  const id = seedPaid(ctx);
  const res = await createApp(ctx).request(`/admin/refund/${id}`, {
    method: 'POST',
    headers: AUTH,
  });
  assert.equal(res.status, 500);
});
