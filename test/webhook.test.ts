import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { fakeCtx, fakeStripeDriver, fakeMcpClient } from './helpers.js';
import type { PurchaseRow } from '../src/lib/db.js';
import type { FakeMcpClient, FakeStripeDriver } from './helpers.js';
import type { AppContext } from '../src/types.js';

function setupFlow(): {
  ctx: AppContext;
  app: ReturnType<typeof createApp>;
  driver: FakeStripeDriver;
  mcp: FakeMcpClient;
} {
  const driver = fakeStripeDriver();
  const mcp = fakeMcpClient();
  const ctx = fakeCtx({ stripeDriver: driver, mcp });
  return { ctx, app: createApp(ctx), driver, mcp };
}

async function createPendingPurchase(
  app: ReturnType<typeof createApp>,
  body: { buyer_agent_id: string; product_id?: string } = { buyer_agent_id: 'brisa' },
): Promise<{ purchase_id: string; driver_ref: string }> {
  const product_id = body.product_id ?? 'character-30d';
  const res = await app.request(`/buy/${product_id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ buyer_agent_id: body.buyer_agent_id }),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { checkout_url: string; purchase_id: string };
  return { purchase_id: json.purchase_id, driver_ref: `cs_${json.purchase_id}` };
}

test('webhook: invalid signature → 400', async () => {
  const { app } = setupFlow();
  const res = await app.request('/webhook/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 400);
});

test('webhook: ignored event type returns 200 ok', async () => {
  const { app, driver } = setupFlow();
  driver.webhookEvents.set('sig:other', { kind: 'ignored', reason: 'event-type:invoice.created' });
  const res = await app.request('/webhook/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'sig:other' },
    body: '{}',
  });
  assert.equal(res.status, 200);
});

test('webhook: unknown purchase_id → 200 with ignored', async () => {
  const { app, driver } = setupFlow();
  driver.webhookEvents.set('sig:ghost', {
    kind: 'checkout-completed',
    driver_ref: 'cs_ghost',
    purchase_id: 'no-such-purchase',
    amount_cents: 1000,
    currency: 'usd',
  });
  const res = await app.request('/webhook/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'sig:ghost' },
    body: '{}',
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ignored: string };
  assert.equal(body.ignored, 'unknown-purchase');
});

test('webhook: happy path issues grain and marks purchase paid', async () => {
  const { ctx, app, driver, mcp } = setupFlow();
  const { purchase_id } = await createPendingPurchase(app);

  driver.webhookEvents.set('sig:ok', {
    kind: 'checkout-completed',
    driver_ref: `cs_${purchase_id}`,
    purchase_id,
    amount_cents: 1000,
    currency: 'usd',
  });
  const res = await app.request('/webhook/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'sig:ok' },
    body: '{}',
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; pair_id: string; issuer_side: string };
  assert.equal(body.ok, true);
  assert.ok(body.pair_id);

  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase_id) as PurchaseRow;
  assert.equal(row.status, 'paid');
  assert.equal(row.amount_cents, 1000);
  assert.equal(row.currency, 'usd');
  assert.equal(row.grain_pair_id, body.pair_id);
  assert.ok(row.paid_at);

  // Verify the issuer called pscale_grain_reach with the right shape.
  const reach = mcp.calls.find((c) => c.name === 'pscale_grain_reach')!;
  assert.ok(reach);
  assert.equal(reach.args.handle, 'tickets-test');
  assert.equal(reach.args.partner_handle, 'brisa');
  assert.match(reach.args.my_side_content as string, /^\[ticket face=character scope=frame:test/);
  assert.match(reach.args.my_side_content as string, /nonce=/);
  assert.ok(reach.args.my_passphrase);
});

test('webhook: re-delivery is idempotent', async () => {
  const { ctx, app, driver } = setupFlow();
  const { purchase_id } = await createPendingPurchase(app);
  driver.webhookEvents.set('sig:dup', {
    kind: 'checkout-completed',
    driver_ref: `cs_${purchase_id}`,
    purchase_id,
    amount_cents: 1000,
    currency: 'usd',
  });

  const first = await app.request('/webhook/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'sig:dup' },
    body: '{}',
  });
  assert.equal(first.status, 200);

  const second = await app.request('/webhook/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'sig:dup' },
    body: '{}',
  });
  assert.equal(second.status, 200);
  const body = (await second.json()) as { idempotent?: boolean };
  assert.equal(body.idempotent, true);

  // Only one paid row.
  const paidCount = (ctx.db.prepare("SELECT count(*) AS n FROM purchases WHERE status = 'paid'").get() as { n: number }).n;
  assert.equal(paidCount, 1);
});

test('webhook: rate-limit cap-hit at webhook time marks rate_limited and fires hook', async () => {
  const { ctx, app, driver, mcp } = setupFlow();
  const { purchase_id } = await createPendingPurchase(app);

  // Pre-populate two paid purchases to push the same product over the hour cap (max=2).
  const now = new Date().toISOString();
  for (let i = 0; i < 2; i++) {
    ctx.db
      .prepare(
        `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, created_at, paid_at)
         VALUES (?, 'character-30d', 'someone', 'paid', 'stripe', ?, ?)`,
      )
      .run(`prior-${i}`, now, now);
  }

  driver.webhookEvents.set('sig:cap', {
    kind: 'checkout-completed',
    driver_ref: `cs_${purchase_id}`,
    purchase_id,
    amount_cents: 1000,
    currency: 'usd',
  });
  const res = await app.request('/webhook/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'sig:cap' },
    body: '{}',
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { rate_limited?: boolean };
  assert.equal(body.rate_limited, true);

  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase_id) as PurchaseRow;
  assert.equal(row.status, 'rate_limited');
  assert.equal(row.amount_cents, 1000);
  assert.match(row.notes ?? '', /hour-cap/);

  // Grain establish must NOT have been called.
  assert.equal(mcp.calls.filter((c) => c.name === 'pscale_grain_reach').length, 0);
});

test('webhook: grain issuance failure marks failed and ack 200', async () => {
  const { ctx, app, driver, mcp } = setupFlow();
  const { purchase_id } = await createPendingPurchase(app);
  mcp.setResponse('pscale_grain_reach', () => {
    throw new Error('substrate unreachable');
  });

  driver.webhookEvents.set('sig:fail', {
    kind: 'checkout-completed',
    driver_ref: `cs_${purchase_id}`,
    purchase_id,
    amount_cents: 1000,
    currency: 'usd',
  });
  const res = await app.request('/webhook/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'sig:fail' },
    body: '{}',
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { error?: string };
  assert.equal(body.error, 'grain_issuance_failed');

  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase_id) as PurchaseRow;
  assert.equal(row.status, 'failed');
  assert.match(row.notes ?? '', /substrate unreachable/);
});
