// A seat at a world (David, 2026-10-03: "£5 for 100 beats. Each player pays
// their own ticket"): bought for a character, written onto a list only this
// machine can write — never the open sed: collective — and sold from a form
// that asks for the character and keeps the machinery out of the player's way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { fakeCtx, fakeMcpClient, fakeStripeDriver, TEST_PRODUCTS } from './helpers.js';
import type { PurchaseRow } from '../src/lib/db.js';
import type { Product } from '../src/types.js';

const SEAT: Product = {
  id: 'brackenfoot-seat',
  title: 'A seat at brackenfoot — 100 beats, £5',
  issuer: 'brackenfoot-seats',
  sed: 'sed:brackenfoot-seats',
  list_block: 'seats:brackenfoot',
  buyer: 'character',
  face: 'character',
  scope: 'frame:brackenfoot',
  duration_days: 36500,
  register_buyer: true,
  description: 'A seat at a brackenfoot table: its keeper kept for 100 of the beats your character makes happen.',
  price: { driver: 'stripe', stripe_price_id: 'price_seat' },
};

function setup() {
  const driver = fakeStripeDriver();
  const mcp = fakeMcpClient();
  const ctx = fakeCtx({ stripeDriver: driver, mcp, products: [...TEST_PRODUCTS, SEAT] });
  mcp.setResponse('bsp', (args: Record<string, unknown>) => (args.append ? '[append @ "https://beach.test/seats:brackenfoot" → 1 (slot 1)]' : '[written]'));
  return { ctx, app: createApp(ctx), driver, mcp };
}

async function buy(app: ReturnType<typeof createApp>, driver: ReturnType<typeof fakeStripeDriver>) {
  const res = await app.request('/buy/brackenfoot-seat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ buyer_agent_id: 'Ugarth' }),
  });
  const { purchase_id } = (await res.json()) as { purchase_id: string };
  driver.webhookEvents.set('sig:s', { kind: 'checkout-completed', driver_ref: `cs_${purchase_id}`, purchase_id, amount_cents: 500, currency: 'gbp' });
  const hook = await app.request('/webhook/stripe', {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 'sig:s' }, body: '{}',
  });
  assert.equal(hook.status, 200);
  return purchase_id;
}

test('seats: a paid seat is appended to the list this machine alone writes, never settled into the open collective', async () => {
  const { ctx, app, driver, mcp } = setup();
  const purchase_id = await buy(app, driver);
  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase_id) as PurchaseRow;
  assert.equal(row.status, 'paid');
  assert.equal(mcp.calls.filter((c) => c.name === 'pscale_settle').length, 0);
  const writes = mcp.calls.filter((c) => c.name === 'bsp' && c.args.block === 'seats:brackenfoot');
  const found = writes.find((c) => c.args.new_lock)!;
  const append = writes.find((c) => c.args.append)!;
  assert.ok(found && !found.args.secret, 'the founding write carries no secret, so over a latched list it changes nothing');
  assert.equal(append.args.secret, found.args.new_lock, 'every entry is written under the key the list was founded with');
  assert.match((append.args.content as { _: string })._, /^Ugarth — \d{1,2} [A-Z][a-z]+ \d{4}$/);
});

test("seats: the form asks for the character, looks for it at the tables, and shows no machinery", async () => {
  const { app } = setup();
  const html = await (await app.request('/buy/brackenfoot-seat')).text();
  assert.match(html, /Your character's name — exactly as it stands at the table/);
  assert.match(html, /stands at a table yet/);
  assert.doesNotMatch(html, /<dt>collective<\/dt>/);
  assert.match(html, /shows beside your character at happyseaurchin\.com\/models/);
});

test('seats: the success page says where the seat will show', async () => {
  const { app } = setup();
  const html = await (await app.request('/buy/brackenfoot-seat/success')).text();
  assert.match(html, /your seat is on its way/);
});

test('seats: the config keeps who a product is for and the list only this machine writes', async () => {
  const { loadConfig } = await import('../src/lib/config.js');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'seat-'));
  const path = join(dir, 'agent.yaml');
  writeFileSync(path, [
    'agent:', '  id: agent:test', '  secret_env: TICKET_AGENT_SECRET', '  pscale_mcp_url: https://bsp.test/mcp/v1',
    'products:', '  - id: brackenfoot-seat', '    issuer: brackenfoot-seats', '    sed: sed:brackenfoot-seats',
    '    list_block: seats:brackenfoot', '    buyer: character', '    face: character', '    scope: frame:brackenfoot',
    '    duration_days: 36500', '    register_buyer: true', '    description: a seat',
    '    price:', '      driver: stripe', '      stripe_price_id: price_seat', '',
  ].join('\n'));
  const p = loadConfig(path).products[0];
  assert.equal(p.list_block, 'seats:brackenfoot');
  assert.equal(p.buyer, 'character');
});
