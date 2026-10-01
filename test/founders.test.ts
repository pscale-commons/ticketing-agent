// Founding supporters: a register_buyer product asks for an optional line at
// checkout and, when paid, writes the buyer onto its list — the product's
// sed: collective — with the date and their line, never the amount.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Stripe from 'stripe';
import { createApp } from '../src/server.js';
import { StripeDriver } from '../src/drivers/stripe.js';
import { fakeCtx, fakeMcpClient, fakeStripeDriver, TEST_PRODUCTS } from './helpers.js';
import type { PurchaseRow } from '../src/lib/db.js';
import type { Product } from '../src/types.js';

const FOUNDERS1: Product = {
  id: 'founders1',
  title: 'Founding supporter — £50',
  issuer: 'founder-tickets',
  sed: 'sed:founders1',
  face: 'author',
  scope: 'frame:founders1',
  duration_days: 36500,
  register_buyer: true,
  description: 'Back the beach with £50, once.',
  price: { driver: 'stripe', stripe_price_id: 'price_f1' },
};

function setup() {
  const driver = fakeStripeDriver();
  const mcp = fakeMcpClient();
  const ctx = fakeCtx({ stripeDriver: driver, mcp, products: [...TEST_PRODUCTS, FOUNDERS1] });
  return { ctx, app: createApp(ctx), driver, mcp };
}

async function pay(app: ReturnType<typeof createApp>, driver: ReturnType<typeof fakeStripeDriver>, line?: string) {
  const res = await app.request('/buy/founders1', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ buyer_agent_id: 'Phenomemental' }),
  });
  const { purchase_id } = (await res.json()) as { purchase_id: string };
  driver.webhookEvents.set('sig:f', {
    kind: 'checkout-completed', driver_ref: `cs_${purchase_id}`, purchase_id, amount_cents: 5000, currency: 'gbp',
    ...(line ? { line } : {}),
  });
  const hook = await app.request('/webhook/stripe', {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 'sig:f' }, body: '{}',
  });
  assert.equal(hook.status, 200);
  return purchase_id;
}

test('founders: a paid buyer is written onto the list with the date and their line, never the amount', async () => {
  const { ctx, app, driver, mcp } = setup();
  const purchase_id = await pay(app, driver, 'for the commons');
  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase_id) as PurchaseRow;
  assert.equal(row.status, 'paid');
  const settle = mcp.calls.find((c) => c.name === 'pscale_settle')!;
  assert.equal(settle.args.collective, 'founders1');
  const decl = settle.args.declaration as string;
  assert.match(decl, /^Phenomemental — \d{1,2} [A-Z][a-z]+ \d{4} — “for the commons”$/);
  assert.doesNotMatch(decl, /50|£/);
  assert.ok(settle.args.passphrase);
  const reach = mcp.calls.find((c) => c.name === 'pscale_grain_reach')!;
  assert.equal(reach.args.handle, 'founder-tickets');
});

test('founders: with no line the entry is the handle and the date', async () => {
  const { app, driver, mcp } = setup();
  await pay(app, driver);
  const decl = mcp.calls.find((c) => c.name === 'pscale_settle')!.args.declaration as string;
  assert.match(decl, /^Phenomemental — \d{1,2} [A-Z][a-z]+ \d{4}$/);
});

test('founders: a list that cannot be written never undoes the ticket', async () => {
  const { ctx, app, driver, mcp } = setup();
  mcp.setResponse('pscale_settle', 'Federated registration rejected: closed');
  const purchase_id = await pay(app, driver, 'x');
  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase_id) as PurchaseRow;
  assert.equal(row.status, 'paid');
  assert.ok(row.grain_pair_id);
});

test('products that keep no list write none', async () => {
  const { app, driver, mcp } = setup();
  const res = await app.request('/buy/character-30d', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ buyer_agent_id: 'brisa' }),
  });
  const { purchase_id } = (await res.json()) as { purchase_id: string };
  driver.webhookEvents.set('sig:c', { kind: 'checkout-completed', driver_ref: `cs_${purchase_id}`, purchase_id, amount_cents: 1000, currency: 'usd' });
  await app.request('/webhook/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 'sig:c' }, body: '{}' });
  assert.equal(mcp.calls.filter((c) => c.name === 'pscale_settle').length, 0);
});

test('checkout: a list-keeping product asks for the optional line; the line comes back trimmed to one line', async () => {
  let created: Record<string, unknown> | undefined;
  const fake = {
    prices: { retrieve: async () => ({ type: 'one_time' }) },
    checkout: { sessions: { create: async (p: Record<string, unknown>) => { created = p; return { id: 'cs_1', url: 'https://checkout.test/cs_1' }; } } },
    webhooks: {
      constructEvent: () => ({
        type: 'checkout.session.completed',
        data: { object: {
          id: 'cs_1', payment_status: 'paid', amount_total: 5000, currency: 'gbp',
          metadata: { purchase_id: 'p1', product_id: 'founders1', buyer_agent_id: 'Phenomemental' },
          custom_fields: [{ key: 'line', text: { value: '  for the\n commons ' } }],
        } },
      }),
    },
  } as unknown as Stripe;
  const d = new StripeDriver({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x', stripe: fake });
  await d.createCheckout({ purchase_id: 'p1', product: FOUNDERS1, buyer_agent_id: 'Phenomemental', success_url: 's', cancel_url: 'c' });
  const fields = created!.custom_fields as Array<{ key: string; optional: boolean }>;
  assert.equal(fields[0]!.key, 'line');
  assert.equal(fields[0]!.optional, true);
  await d.createCheckout({ purchase_id: 'p2', product: TEST_PRODUCTS[0]!, buyer_agent_id: 'brisa', success_url: 's', cancel_url: 'c' });
  assert.equal(created!.custom_fields, undefined);
  const ev = d.verifyWebhook({ rawBody: '{}', signature: 'sig' });
  assert.equal(ev.kind === 'checkout-completed' && ev.line, 'for the commons');
});

test('buy page: the heading people read, and a ticket that keeps reads "for good"', async () => {
  const { app } = setup();
  const html = await (await app.request('/buy/founders1')).text();
  assert.match(html, /<h1>Founding supporter — £50<\/h1>/);
  assert.match(html, /<dd>for good<\/dd>/);
});
