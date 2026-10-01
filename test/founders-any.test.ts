// Founding supporters, any amount: the amount chooses the list by its scale,
// a bank transfer is offered beside the card (and falls back to card until
// Stripe switches transfers on), and a transfer pays when the money lands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Stripe from 'stripe';
import { createApp } from '../src/server.js';
import { StripeDriver } from '../src/drivers/stripe.js';
import { pscaleOf } from '../src/lib/issuance.js';
import { fakeCtx, fakeMcpClient, fakeStripeDriver, TEST_PRODUCTS } from './helpers.js';
import type { Product } from '../src/types.js';

const ANY: Product = {
  id: 'founders',
  title: 'Founding supporter — any amount',
  issuer: 'founder-tickets',
  sed: 'sed:founders{pscale}',
  face: 'author',
  scope: 'frame:founders',
  duration_days: 36500,
  register_buyer: true,
  bank_transfer: true,
  description: 'Back the beach with any amount from £50.',
  price: { driver: 'stripe', stripe_price_id: 'price_any' },
};

test('pscaleOf: the place-value of the first digit, in whole pounds', () => {
  assert.equal(pscaleOf(5000), 1);      // £50
  assert.equal(pscaleOf(99999), 2);     // £999.99
  assert.equal(pscaleOf(100000), 3);    // £1,000
  assert.equal(pscaleOf(999999), 3);    // £9,999.99
});

function setup() {
  const driver = fakeStripeDriver();
  const mcp = fakeMcpClient();
  const ctx = fakeCtx({ stripeDriver: driver, mcp, products: [...TEST_PRODUCTS, ANY] });
  return { ctx, app: createApp(ctx), driver, mcp };
}

test('any amount: £1,000 lands on founders3; £120 on founders2', async () => {
  for (const [amount, list] of [[100000, 'founders3'], [12000, 'founders2']] as const) {
    const { app, driver, mcp } = setup();
    const res = await app.request('/buy/founders', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ buyer_agent_id: 'friend', email: 'f@example.test' }),
    });
    const { purchase_id } = (await res.json()) as { purchase_id: string };
    assert.equal(driver.createdSessions.at(-1)!.email, 'f@example.test');
    driver.webhookEvents.set('sig', { kind: 'checkout-completed', driver_ref: `cs_${purchase_id}`, purchase_id, amount_cents: amount, currency: 'gbp' });
    await app.request('/webhook/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' }, body: '{}' });
    const settle = mcp.calls.find((c) => c.name === 'pscale_settle')!;
    assert.equal(settle.args.collective, list);
    assert.doesNotMatch(settle.args.declaration as string, /£|1000|120/);
  }
});

test('buy page: a bank-transfer product asks for the email; a handle alone gets one short email step', async () => {
  const { app, driver } = setup();
  const form = await (await app.request('/buy/founders')).text();
  assert.match(form, /name="email" type="email" required/);
  const step = await app.request('/buy/founders', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'buyer_agent_id=friend',
  });
  assert.equal(step.status, 200);
  const html = await step.text();
  assert.match(html, /<input type="hidden" name="buyer_agent_id" value="friend" \/>/);
  assert.match(html, /name="email"/);
  assert.equal(driver.createdSessions.length, 0);
  const bad = await app.request('/buy/founders', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'buyer_agent_id=friend&email=nope',
  });
  assert.equal(bad.status, 400);
});

function fakeStripe(opts: { refuseTransfers?: boolean } = {}) {
  const sessions: Array<Record<string, unknown>> = [];
  const customers: Array<Record<string, unknown>> = [];
  const fake = {
    prices: { retrieve: async () => ({ type: 'one_time' }) },
    customers: {
      list: async () => ({ data: [] }),
      create: async (p: Record<string, unknown>) => { customers.push(p); return { id: 'cus_new' }; },
    },
    checkout: { sessions: { create: async (p: Record<string, unknown>) => {
      sessions.push(p);
      if (opts.refuseTransfers && Array.isArray(p.payment_method_types) && (p.payment_method_types as string[]).includes('customer_balance')) {
        throw new Error('The payment method type `customer_balance` is invalid. Please ensure the provided type is activated in your dashboard');
      }
      return { id: 'cs_1', url: 'https://checkout.test/cs_1' };
    } } },
    webhooks: { constructEvent: (_b: string, sig: string) => ({
      type: sig,
      data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 100000, currency: 'gbp', metadata: { purchase_id: 'p1' } } },
    }) },
  } as unknown as Stripe;
  return { d: new StripeDriver({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x', stripe: fake }), sessions, customers };
}

test('checkout: a bank transfer beside the card, the payer made a customer holding their Beach handle', async () => {
  const { d, sessions, customers } = fakeStripe();
  await d.createCheckout({ purchase_id: 'p1', product: ANY, buyer_agent_id: 'friend', email: 'f@example.test', success_url: 's', cancel_url: 'c' });
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0]!.payment_method_types, ['card', 'customer_balance']);
  assert.equal(sessions[0]!.customer, 'cus_new');
  assert.equal(customers[0]!.email, 'f@example.test');
  assert.deepEqual((customers[0]!.invoice_settings as { custom_fields: unknown }).custom_fields, [{ name: 'Beach handle', value: 'friend' }]);
});

test('checkout: until Stripe switches transfers on, the same checkout runs on card', async () => {
  const { d, sessions } = fakeStripe({ refuseTransfers: true });
  const out = await d.createCheckout({ purchase_id: 'p1', product: ANY, buyer_agent_id: 'friend', email: 'f@example.test', success_url: 's', cancel_url: 'c' });
  assert.equal(out.checkout_url, 'https://checkout.test/cs_1');
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1]!.payment_method_types, undefined);
  assert.equal(sessions[1]!.customer, 'cus_new');
});

test('webhook parse: a transfer that lands pays like a card; one that fails is left alone', () => {
  const { d } = fakeStripe();
  const landed = d.verifyWebhook({ rawBody: '{}', signature: 'checkout.session.async_payment_succeeded' });
  assert.equal(landed.kind, 'checkout-completed');
  assert.equal(landed.kind === 'checkout-completed' && landed.amount_cents, 100000);
  const failed = d.verifyWebhook({ rawBody: '{}', signature: 'checkout.session.async_payment_failed' });
  assert.deepEqual(failed, { kind: 'ignored', reason: 'async-payment-failed' });
});
