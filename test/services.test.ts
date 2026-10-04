// Per-job invoices, subscription renewals, and per-product issuers — the
// paths a beach host's monthly service and a consultant's invoiced work take.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { fakeCtx, fakeStripeDriver, fakeMcpClient, TEST_PRODUCTS } from './helpers.js';
import type { PurchaseRow } from '../src/lib/db.js';
import type { Product } from '../src/types.js';

const AUTH = { authorization: 'Bearer admin-token', 'content-type': 'application/json' };

const SERVICE: Product = {
  id: 'beach-service',
  issuer: 'beach-service-tickets',
  sed: 'sed:beach-service',
  face: 'character',
  scope: 'beach:test.host',
  duration_days: 35,
  description: 'Monthly beach service',
  price: { driver: 'stripe', stripe_price_id: 'price_monthly' },
};

const CONSULTANCY: Product = {
  id: 'consultancy',
  issuer: 'consultancy-tickets',
  sed: 'sed:consultancy',
  face: 'author',
  scope: 'beach:test.host',
  duration_days: 365,
  description: 'Consultancy, priced per job',
  price: { driver: 'invoice', currency: 'gbp' },
};

function setup() {
  const driver = fakeStripeDriver();
  const mcp = fakeMcpClient();
  const ctx = fakeCtx({ stripeDriver: driver, mcp, products: [...TEST_PRODUCTS, SERVICE, CONSULTANCY] });
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

test('invoice product: /buy refuses checkout', async () => {
  const { app } = setup();
  const res = await app.request('/buy/consultancy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ buyer_agent_id: 'brisa' }),
  });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, 'invoice_only');
});

test('admin/invoice: raises a draft, then invoice.paid issues the grain from the product issuer', async () => {
  const { ctx, app, driver, mcp } = setup();
  const res = await app.request('/admin/invoice', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      product_id: 'consultancy',
      buyer_agent_id: 'brisa',
      email: 'brisa@example.test',
      amount_cents: 10000,
      description: 'Consultancy — one session',
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { purchase_id: string; invoice: string; sent: boolean };
  assert.equal(body.sent, false);
  assert.equal(driver.invoices.length, 1);
  assert.equal(driver.invoices[0]!.amount_cents, 10000);

  let row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(body.purchase_id) as PurchaseRow;
  assert.equal(row.status, 'pending');
  assert.equal(row.currency, 'gbp');

  driver.webhookEvents.set('sig:inv', {
    kind: 'checkout-completed',
    driver_ref: body.invoice,
    purchase_id: body.purchase_id,
    amount_cents: 10000,
    currency: 'gbp',
  });
  await hook(app, 'sig:inv');
  row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(body.purchase_id) as PurchaseRow;
  assert.equal(row.status, 'paid');
  const reach = mcp.calls.find((c) => c.name === 'pscale_grain_reach')!;
  assert.equal(reach.args.handle, 'consultancy-tickets');
  assert.match(reach.args.my_side_content as string, /^\[ticket face=author scope=beach:test.host/);
});

test('admin/invoice: rejects a non-invoice product and a bad amount', async () => {
  const { app } = setup();
  const base = { buyer_agent_id: 'brisa', email: 'b@x.test', description: 'x' };
  const a = await app.request('/admin/invoice', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ ...base, product_id: 'beach-service', amount_cents: 100 }),
  });
  assert.equal(a.status, 400);
  const b = await app.request('/admin/invoice', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ ...base, product_id: 'consultancy', amount_cents: 10.5 }),
  });
  assert.equal(b.status, 400);
});

test('renewal: a paid later period re-reaches the same grain once, idempotently', async () => {
  const { ctx, app, driver, mcp } = setup();
  driver.webhookEvents.set('sig:renew', {
    kind: 'renewal',
    driver_ref: 'in_period2',
    product_id: 'beach-service',
    buyer_agent_id: 'brisa',
    amount_cents: 1000,
    currency: 'gbp',
  });
  const first = await hook(app, 'sig:renew');
  assert.equal(first.renewed, true);
  const again = await hook(app, 'sig:renew');
  assert.equal(again.idempotent, true);

  const reaches = mcp.calls.filter((c) => c.name === 'pscale_grain_reach');
  assert.equal(reaches.length, 1);
  assert.equal(reaches[0]!.args.handle, 'beach-service-tickets');
  const rows = ctx.db.prepare("SELECT * FROM purchases WHERE driver_ref = 'in_period2'").all() as PurchaseRow[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'paid');
});

test('renewal: unknown product is acknowledged and ignored', async () => {
  const { app, driver } = setup();
  driver.webhookEvents.set('sig:gone', {
    kind: 'renewal',
    driver_ref: 'in_x',
    product_id: 'retired',
    buyer_agent_id: 'brisa',
    amount_cents: 1000,
    currency: 'gbp',
  });
  const body = await hook(app, 'sig:gone');
  assert.equal(body.ignored, 'unknown-product');
});

test('buy page: asks for the handle exactly and checks it against the beach it names', async () => {
  const driver = fakeStripeDriver();
  const ctx = fakeCtx({ stripeDriver: driver, products: [...TEST_PRODUCTS, SERVICE] });
  ctx.config.agent.beach = 'https://beach.example.test/';
  const html = await (await createApp(ctx).request('/buy/beach-service')).text();
  assert.match(html, /exactly as it stands, capitals and all/);
  assert.match(html, /autocapitalize="none"/);
  assert.match(html, /"https:\/\/beach\.example\.test\/\.well-known\/pscale-beach"/);
  assert.match(html, /Did you mean /);
});

test('share: every product answers at /share/<id>, writes /share links, and /buy/<id> still answers', async () => {
  const driver = fakeStripeDriver();
  const ctx = fakeCtx({ stripeDriver: driver, products: [...TEST_PRODUCTS, SERVICE] });
  const app = createApp(ctx);
  const page = await (await app.request('/share/beach-service')).text();
  assert.match(page, /action="\/share\/beach-service"/);
  const old = await app.request('/buy/beach-service');
  assert.equal(old.status, 200);
  const res = await app.request('/share/beach-service', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ buyer_agent_id: 'brisa' }),
  });
  assert.equal(res.status, 200);
  assert.match(driver.createdSessions.at(-1)!.success_url, /\/share\/beach-service\/success\?purchase=/);
  assert.match(driver.createdSessions.at(-1)!.cancel_url, /\/share\/beach-service\/cancel\?purchase=/);
  assert.equal((await app.request('/share/beach-service/success')).status, 200);
  assert.equal((await app.request('/buy/beach-service/cancel')).status, 200);
  assert.equal((await app.request('/sell/beach-service')).status, 404);
});
