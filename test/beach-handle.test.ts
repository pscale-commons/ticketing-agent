// The "Beach handle" invoice field: an invoice made by hand in the Stripe
// dashboard is ticketed to the handle it names when paid; an invoice the
// machine raises carries the field, and a customer it creates holds it as a
// default so the operator's own invoices for them carry it too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Stripe from 'stripe';
import { createApp } from '../src/server.js';
import { StripeDriver, parseInvoicePaid } from '../src/drivers/stripe.js';
import { fakeCtx, fakeStripeDriver, fakeMcpClient, TEST_PRODUCTS } from './helpers.js';
import type { PurchaseRow } from '../src/lib/db.js';
import type { Product } from '../src/types.js';

const CONSULTANCY: Product = {
  id: 'consultancy',
  issuer: 'consultancy-tickets',
  sed: 'sed:consultancy',
  face: 'designer',
  scope: 'beach:test.host',
  duration_days: 365,
  description: 'Consultancy, priced per job',
  price: { driver: 'invoice', currency: 'gbp' },
};

const inv = (o: Record<string, unknown>) =>
  ({ id: 'in_x', amount_paid: 2500, currency: 'gbp', metadata: {}, custom_fields: null, ...o }) as unknown as Stripe.Invoice;

test('parse: an invoice we raised is a completed checkout, whatever fields it carries', () => {
  const ev = parseInvoicePaid(inv({
    billing_reason: 'manual',
    metadata: { purchase_id: 'p1' },
    custom_fields: [{ name: 'Beach handle', value: 'brisa' }],
  }));
  assert.deepEqual(ev, { kind: 'checkout-completed', driver_ref: 'in_x', purchase_id: 'p1', amount_cents: 2500, currency: 'gbp' });
});

test('parse: a dashboard invoice is ticketed by its Beach handle field (name matched loosely, value trimmed)', () => {
  const ev = parseInvoicePaid(inv({
    billing_reason: 'manual',
    custom_fields: [{ name: 'PO number', value: '77' }, { name: ' beach  HANDLE ', value: ' Phenomemental ' }],
  }));
  assert.deepEqual(ev, {
    kind: 'dashboard-invoice', driver_ref: 'in_x', product_id: null, buyer_agent_id: 'Phenomemental',
    amount_cents: 2500, currency: 'gbp',
  });
});

test('parse: a dashboard invoice may name its product in metadata', () => {
  const ev = parseInvoicePaid(inv({
    billing_reason: 'manual',
    metadata: { product_id: 'beach-service' },
    custom_fields: [{ name: 'Beach handle', value: 'brisa' }],
  }));
  assert.equal(ev.kind === 'dashboard-invoice' && ev.product_id, 'beach-service');
});

test('parse: a dashboard invoice with no Beach handle is left alone — the money stays recorded in Stripe', () => {
  const ev = parseInvoicePaid(inv({ billing_reason: 'manual' }));
  assert.deepEqual(ev, { kind: 'ignored', reason: 'invoice:manual-without-beach-handle' });
});

test('parse: renewals read the subscription metadata in either API shape; the first period is left to the checkout', () => {
  const md = { product_id: 'beach-service', buyer_agent_id: 'brisa' };
  const basil = parseInvoicePaid(inv({ billing_reason: 'subscription_cycle', parent: { subscription_details: { metadata: md } } }));
  const acacia = parseInvoicePaid(inv({ billing_reason: 'subscription_cycle', subscription_details: { metadata: md } }));
  assert.equal(basil.kind, 'renewal');
  assert.deepEqual(basil, acacia);
  assert.equal(parseInvoicePaid(inv({ billing_reason: 'subscription_create' })).kind, 'ignored');
});

function setup(products: Product[] = [...TEST_PRODUCTS, CONSULTANCY]) {
  const driver = fakeStripeDriver();
  const mcp = fakeMcpClient();
  const ctx = fakeCtx({ stripeDriver: driver, mcp, products });
  return { ctx, app: createApp(ctx), driver, mcp };
}

async function hook(app: ReturnType<typeof createApp>, sig: string) {
  const res = await app.request('/webhook/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sig },
    body: '{}',
  });
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, unknown>;
}

test('webhook: a paid dashboard invoice issues the ticket for the only invoice product, once', async () => {
  const { ctx, app, driver, mcp } = setup();
  driver.webhookEvents.set('sig:dash', {
    kind: 'dashboard-invoice', driver_ref: 'in_dash', product_id: null, buyer_agent_id: 'brisa', amount_cents: 2500, currency: 'gbp',
  });
  const first = await hook(app, 'sig:dash');
  assert.equal(first.issued, true);
  assert.equal((await hook(app, 'sig:dash')).idempotent, true);
  const reaches = mcp.calls.filter((c) => c.name === 'pscale_grain_reach');
  assert.equal(reaches.length, 1);
  assert.equal(reaches[0]!.args.handle, 'consultancy-tickets');
  assert.equal(reaches[0]!.args.partner_handle, 'brisa');
  const row = ctx.db.prepare("SELECT * FROM purchases WHERE driver_ref = 'in_dash'").get() as PurchaseRow;
  assert.equal(row.status, 'paid');
  assert.equal(row.product_id, 'consultancy');
  assert.equal(row.amount_cents, 2500);
  assert.equal(row.notes, 'dashboard invoice');
});

test('webhook: a dashboard invoice is refused a ticket when the product is unclear or the handle malformed', async () => {
  const two = setup([...TEST_PRODUCTS, CONSULTANCY, { ...CONSULTANCY, id: 'workshop', issuer: 'workshop-tickets' }]);
  two.driver.webhookEvents.set('sig:a', {
    kind: 'dashboard-invoice', driver_ref: 'in_a', product_id: null, buyer_agent_id: 'brisa', amount_cents: 100, currency: 'gbp',
  });
  assert.equal((await hook(two.app, 'sig:a')).ignored, 'no-single-invoice-product');

  const one = setup();
  one.driver.webhookEvents.set('sig:b', {
    kind: 'dashboard-invoice', driver_ref: 'in_b', product_id: 'nope', buyer_agent_id: 'brisa', amount_cents: 100, currency: 'gbp',
  });
  assert.equal((await hook(one.app, 'sig:b')).ignored, 'unknown-product');
  one.driver.webhookEvents.set('sig:c', {
    kind: 'dashboard-invoice', driver_ref: 'in_c', product_id: null, buyer_agent_id: 'two words', amount_cents: 100, currency: 'gbp',
  });
  assert.equal((await hook(one.app, 'sig:c')).ignored, 'invalid-beach-handle');
  assert.equal(one.mcp.calls.filter((c) => c.name === 'pscale_grain_reach').length, 0);
});

test('createInvoice: the invoice carries the Beach handle, and a new customer holds it as a default', async () => {
  const seen: Record<string, unknown[]> = {};
  const rec = (k: string, out: unknown) => async (...args: unknown[]) => { (seen[k] ??= []).push(args[0] ?? args); return out; };
  const fake = {
    customers: { list: rec('customers.list', { data: [] }), create: rec('customers.create', { id: 'cus_new' }) },
    invoices: {
      create: rec('invoices.create', { id: 'in_new' }),
      finalizeInvoice: rec('invoices.finalize', {}),
      sendInvoice: rec('invoices.send', { hosted_invoice_url: 'https://invoice.test/in_new' }),
    },
    invoiceItems: { create: rec('invoiceItems.create', {}) },
  } as unknown as Stripe;
  const d = new StripeDriver({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x', stripe: fake });
  const out = await d.createInvoice({
    purchase_id: 'p9', product: CONSULTANCY, buyer_agent_id: 'Phenomemental', email: 'm@example.test',
    amount_cents: 10000, description: 'Consultancy', send: true,
  });
  assert.equal(out.hosted_url, 'https://invoice.test/in_new');
  const cust = seen['customers.create']![0] as { invoice_settings: { custom_fields: unknown[] } };
  assert.deepEqual(cust.invoice_settings.custom_fields, [{ name: 'Beach handle', value: 'Phenomemental' }]);
  const invoice = seen['invoices.create']![0] as { custom_fields: unknown[]; metadata: Record<string, string> };
  assert.deepEqual(invoice.custom_fields, [{ name: 'Beach handle', value: 'Phenomemental' }]);
  assert.equal(invoice.metadata.purchase_id, 'p9');
});
