// Stripe is the record of a sale. When the machine's own row is gone — its
// database lost, as it was on every redeploy before the volume — a paid
// session or invoice still gets its ticket: from its metadata at the webhook,
// or read back from Stripe by the operator's re-issue.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Stripe from 'stripe';
import { createApp } from '../src/server.js';
import { StripeDriver } from '../src/drivers/stripe.js';
import { appendDecision } from '../src/lib/audit.js';
import { fakeCtx, fakeMcpClient, fakeStripeDriver, TEST_PRODUCTS } from './helpers.js';
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
const AUTH = { authorization: 'Bearer admin-token', 'content-type': 'application/json' };

function setup() {
  const driver = fakeStripeDriver();
  const mcp = fakeMcpClient();
  const ctx = fakeCtx({ stripeDriver: driver, mcp, products: [...TEST_PRODUCTS, CONSULTANCY] });
  return { ctx, app: createApp(ctx), driver, mcp };
}

test('webhook: a paid sale whose row is gone is ticketed from its metadata, under its own purchase id', async () => {
  const { ctx, app, driver, mcp } = setup();
  driver.webhookEvents.set('sig:lost', {
    kind: 'checkout-completed', driver_ref: 'in_lost', purchase_id: 'p-lost', amount_cents: 1000, currency: 'gbp',
    product_id: 'consultancy', buyer_agent_id: 'Phenomemental',
  });
  const res = await app.request('/webhook/stripe', {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 'sig:lost' }, body: '{}',
  });
  const body = (await res.json()) as { issued?: boolean };
  assert.equal(body.issued, true);
  const row = ctx.db.prepare("SELECT * FROM purchases WHERE id = 'p-lost'").get() as PurchaseRow;
  assert.equal(row.status, 'paid');
  assert.equal(row.driver_ref, 'in_lost');
  const reach = mcp.calls.find((c) => c.name === 'pscale_grain_reach')!;
  assert.equal(reach.args.handle, 'consultancy-tickets');
  assert.equal(reach.args.partner_handle, 'Phenomemental');
});

test('admin/reissue: with no row at all, a paid Stripe invoice is read back and ticketed, once', async () => {
  const { ctx, app, driver, mcp } = setup();
  driver.lookups.set('in_paid', {
    paid: true, purchase_id: 'p-gone', product_id: 'consultancy', buyer_agent_id: 'Phenomemental', amount_cents: 1000, currency: 'gbp',
  });
  const res = await app.request('/admin/reissue/in_paid', { method: 'POST', headers: AUTH, body: '{}' });
  assert.equal(res.status, 200);
  const row = ctx.db.prepare("SELECT * FROM purchases WHERE id = 'p-gone'").get() as PurchaseRow;
  assert.equal(row.status, 'paid');
  assert.equal(row.amount_cents, 1000);
  assert.match(row.notes ?? '', /from Stripe in_paid/);
  const again = await app.request('/admin/reissue/in_paid', { method: 'POST', headers: AUTH, body: '{}' });
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { idempotent?: boolean }).idempotent, true);
  assert.equal(mcp.calls.filter((c) => c.name === 'pscale_grain_reach').length, 1);
});

test('admin/reissue: an unpaid or unknown Stripe id writes nothing', async () => {
  const { app, driver, mcp } = setup();
  driver.lookups.set('in_open', {
    paid: false, purchase_id: null, product_id: 'consultancy', buyer_agent_id: 'brisa', amount_cents: 0, currency: 'gbp',
  });
  assert.equal((await app.request('/admin/reissue/in_open', { method: 'POST', headers: AUTH, body: '{}' })).status, 400);
  assert.equal((await app.request('/admin/reissue/in_unknown', { method: 'POST', headers: AUTH, body: '{}' })).status, 404);
  assert.equal((await app.request('/admin/reissue/not-a-ref', { method: 'POST', headers: AUTH, body: '{}' })).status, 404);
  assert.equal(mcp.calls.length, 0);
});

test('lookupPaid: an invoice says whether it is paid, and to whom — metadata first, then the Beach handle field', async () => {
  const fake = {
    invoices: {
      retrieve: async (id: string) => ({
        id, status: 'paid', amount_paid: 1000, currency: 'gbp',
        metadata: id === 'in_meta' ? { purchase_id: 'p1', product_id: 'consultancy', buyer_agent_id: 'Phenomemental' } : {},
        custom_fields: [{ name: 'Beach handle', value: 'brisa' }],
      }),
    },
  } as unknown as Stripe;
  const d = new StripeDriver({ secretKey: 'sk_test_x', webhookSecret: 'whsec_x', stripe: fake });
  const meta = await d.lookupPaid('in_meta');
  assert.deepEqual(meta, { paid: true, purchase_id: 'p1', product_id: 'consultancy', buyer_agent_id: 'Phenomemental', amount_cents: 1000, currency: 'gbp' });
  const field = await d.lookupPaid('in_dash');
  assert.equal(field?.buyer_agent_id, 'brisa');
  assert.equal(field?.product_id, null);
  assert.equal(await d.lookupPaid('pi_other'), null);
});

test('audit: entries are settled (pscale_settle), and a failed append is an error, not a silent "?"', async () => {
  const mcp = fakeMcpClient();
  const ok = await appendDecision({ client: mcp, ticketAgentSecret: 's', verifier_bare_id: 'tickets-test', envelope: '[ticket-verified]' });
  assert.match(ok.audit_position, /^\d+$/);
  assert.equal(mcp.calls.at(-1)!.name, 'pscale_settle');
  mcp.setResponse('pscale_settle', 'Federated registration rejected: collective is closed');
  await assert.rejects(
    appendDecision({ client: mcp, ticketAgentSecret: 's', verifier_bare_id: 'tickets-test', envelope: '[ticket-verified]' }),
    /audit append to sed:tickets-test-audit-\d{4}-\d{2} failed/,
  );
});
