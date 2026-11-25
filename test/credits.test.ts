// Credits minted at the moment of payment (David, 25 November 2026: a ticket
// turns into credits at the moment of payment, not monthly; sand-v2 2, the
// mint-as-gave ruling of 25 August). A top-up into the beach's commons, paid
// by card, becomes credits=N on its ticket, a [ticket-verified] line naming
// the grain, and one gift on the issuer's passport at 6.3 to the commons —
// the three things a reader checks before it counts a mint (bsp-mcp
// verifyGrainMint). Test issuer and fake drivers only: no live key is touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { creditsFor } from '../src/lib/issuance.js';
import { parseEnvelope, buildTicket } from '../src/lib/envelope.js';
import { fakeCtx, fakeMcpClient, fakeStripeDriver, TEST_PRODUCTS } from './helpers.js';
import type { PurchaseRow } from '../src/lib/db.js';
import type { Product } from '../src/types.js';

const COMMONS: Product = {
  id: 'commons',
  title: "Into the beach's commons — any amount",
  issuer: 'test-tickets',
  sed: 'sed:commons-tickets',
  face: 'author',
  scope: 'frame:commons',
  duration_days: 36500,
  description: "Money into the beach's commons, shared by everyone's time on the beach.",
  price: { driver: 'stripe', stripe_price_id: 'price_commons' },
  credits: { per_pound: 1000, to: 'commons' },
};

function setup() {
  const driver = fakeStripeDriver();
  const mcp = fakeMcpClient();
  const ctx = fakeCtx({ stripeDriver: driver, mcp, products: [...TEST_PRODUCTS, COMMONS] });
  let slot = 0;
  mcp.setResponse('bsp', (args: Record<string, unknown>) => (args.append ? `[append @ "https://beach.test/${args.block}" spindle ${args.spindle} → ${args.spindle}${++slot} (slot ${slot})]` : '[written]'));
  return { ctx, app: createApp(ctx), driver, mcp };
}

async function topUp(app: ReturnType<typeof createApp>, driver: ReturnType<typeof fakeStripeDriver>, who: string, amount_cents: number, sig: string) {
  const res = await app.request('/buy/commons', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ buyer_agent_id: who }),
  });
  const { purchase_id } = (await res.json()) as { purchase_id: string };
  driver.webhookEvents.set(sig, { kind: 'checkout-completed', driver_ref: `cs_${purchase_id}`, purchase_id, amount_cents, currency: 'gbp' });
  const hook = await app.request('/webhook/stripe', {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: '{}',
  });
  assert.equal(hook.status, 200);
  return purchase_id;
}

test('creditsFor: every whole penny counts, rounded down; no amount mints nothing; a product without credits mints nothing', () => {
  assert.equal(creditsFor(COMMONS, 500), 5000);
  assert.equal(creditsFor(COMMONS, 1), 10);
  assert.equal(creditsFor({ ...COMMONS, credits: { per_pound: 3 } }, 50), 1);
  assert.equal(creditsFor(COMMONS, 0), 0);
  assert.equal(creditsFor(COMMONS, undefined), 0);
  assert.equal(creditsFor(TEST_PRODUCTS[0]!, 500), 0);
});

test('envelope: credits= is written only when asked, and parses back as a credit-bearing ticket', () => {
  const plain = buildTicket({ face: 'author', scope: 'frame:commons', expires: '2126-01-01T00:00:00Z' });
  assert.doesNotMatch(plain, /credits=/);
  const env = buildTicket({ face: 'author', scope: 'frame:commons', expires: '2126-01-01T00:00:00Z', credits: 5000 });
  assert.match(env, /credits=5000\]$/);
  const parsed = parseEnvelope(env);
  assert.ok(!('reason' in parsed) && parsed.kind === 'ticket' && parsed.hasCredits);
  assert.throws(() => buildTicket({ face: 'author', scope: 'x', expires: '2126-01-01T00:00:00Z', credits: 0 }));
});

test('a paid top-up mints at the moment of payment: credits on the ticket, a verified line naming its grain, one gift to the commons', async () => {
  const { ctx, app, driver, mcp } = setup();
  const purchase_id = await topUp(app, driver, 'Ana', 500, 'sig:a');
  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase_id) as PurchaseRow;
  assert.equal(row.status, 'paid');

  const reach = mcp.calls.find((c) => c.name === 'pscale_grain_reach')!;
  assert.equal(reach.args.handle, 'test-tickets');
  assert.match(reach.args.my_side_content as string, /credits=5000\]$/);

  const pid = row.grain_pair_id!;
  const audit = mcp.calls.find((c) => c.name === 'pscale_settle')!;
  assert.match(audit.args.declaration as string, new RegExp(`^\\[ticket-verified by=agent:tickets-test at=\\S+ grain=grain:${pid}\\]$`));

  const writes = mcp.calls.filter((c) => c.name === 'bsp' && c.args.block === 'passport:test-tickets');
  const found = writes.find((c) => c.args.new_lock)!;
  const gift = writes.find((c) => c.args.append)!;
  assert.ok(found && !found.args.secret, 'the founding write carries no secret, so over a latched passport it changes nothing');
  assert.equal(gift.args.spindle, '6.31', 'gifts go on shelves of nine, never straight under 6.3');
  const whole = writes.find((c) => !c.args.append && c.args.spindle === '6.311')!;
  assert.ok(whole, 'the gift is written whole where its append landed, so the beach stamp cannot sit at its recipient');
  assert.deepEqual(whole.args.content, gift.args.content);
  assert.equal(whole.args.secret, found.args.new_lock);
  assert.equal(gift.args.secret, found.args.new_lock, 'the gift is written under the key the mint was founded with');
  const g = gift.args.content as Record<string, unknown>;
  assert.equal(g['1'], `mint-${purchase_id}`);
  assert.equal(g['2'], 5000);
  assert.equal(g['3'], 'commons');
  assert.equal(g['4'], '0.1');
  assert.equal(g['6'], `grain:${pid}`);
  assert.match(g['7'] as string, /^sed:tickets-test-audit-\d{4}-\d{2}:\d+$/, 'field 7 is the audit position a reader opens (verifyGrainMint)');
  assert.doesNotMatch(g._ as string, /Ana/, 'the payer is never named in the gift');
  assert.match(g._ as string, /^minted 5000 to commons — .*£5\.00/);
});

test("a buyer's second top-up re-reaches the same grain, so its ticket carries the whole it backs and the gift only the new credits", async () => {
  const { app, driver, mcp } = setup();
  await topUp(app, driver, 'Ana', 500, 'sig:a1');
  await topUp(app, driver, 'Ana', 200, 'sig:a2');
  const reaches = mcp.calls.filter((c) => c.name === 'pscale_grain_reach');
  assert.match(reaches[1]!.args.my_side_content as string, /credits=7000\]$/);
  const gifts = mcp.calls.filter((c) => c.name === 'bsp' && c.args.append).map((c) => (c.args.content as Record<string, unknown>)['2']);
  assert.deepEqual(gifts, [5000, 2000]);
});

test('a product without credits mints nothing and touches no passport', async () => {
  const { app, driver, mcp } = setup();
  const res = await app.request('/buy/character-30d', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ buyer_agent_id: 'Ana' }),
  });
  const { purchase_id } = (await res.json()) as { purchase_id: string };
  driver.webhookEvents.set('sig:c', { kind: 'checkout-completed', driver_ref: `cs_${purchase_id}`, purchase_id, amount_cents: 500, currency: 'gbp' });
  await app.request('/webhook/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 'sig:c' }, body: '{}' });
  assert.doesNotMatch(mcp.calls.find((c) => c.name === 'pscale_grain_reach')!.args.my_side_content as string, /credits=/);
  assert.equal(mcp.calls.filter((c) => c.name === 'bsp' && String(c.args.block).startsWith('passport:')).length, 0);
  assert.equal(mcp.calls.filter((c) => c.name === 'pscale_settle').length, 0);
});

test('a full shelf sends the gift to the next, founding it first', async () => {
  const { app, driver, mcp } = setup();
  mcp.setResponse('bsp', (args: Record<string, unknown>) => {
    if (!args.append) return '[written]';
    if (args.spindle === '6.31') return 'Beach save rejected (node_full): "6.31" of "passport:test-tickets" is full: nine slots, all taken.';
    const tries = mcp.calls.filter((c) => c.args.append && c.args.spindle === '6.32').length;
    return tries === 1 ? 'Beach save rejected (not_found): no node at "6.32" of "passport:test-tickets"' : '[append @ "https://beach.test/passport:test-tickets" → 6.321 (slot 1)]';
  });
  await topUp(app, driver, 'Ana', 500, 'sig:s');
  const shelf = mcp.calls.find((c) => c.name === 'bsp' && c.args.spindle === '6.32' && !c.args.append)!;
  assert.ok(shelf, 'the second shelf is founded');
  assert.equal(shelf.args.secret, mcp.calls.find((c) => c.args.new_lock)!.args.new_lock);
  assert.match((shelf.args.content as { _: string })._, /^Shelf 2 /);
  assert.equal(mcp.calls.filter((c) => c.args.append && c.args.spindle === '6.32').length, 2);
});

test('a mint that cannot be written never undoes the ticket', async () => {
  const { ctx, app, driver, mcp } = setup();
  mcp.setResponse('bsp', (args: Record<string, unknown>) => (args.append ? 'Beach save rejected: secret does not match' : '[written]'));
  const purchase_id = await topUp(app, driver, 'Ana', 500, 'sig:f');
  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase_id) as PurchaseRow;
  assert.equal(row.status, 'paid');
  assert.ok(row.grain_pair_id);
});

test('config: a product keeps its credits — the rate, whom they go to, the topic — and refuses a bad one', async () => {
  const { loadConfig } = await import('../src/lib/config.js');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'credits-'));
  const yaml = (credits: string[]) => [
    'agent:', '  id: agent:test', '  secret_env: TICKET_AGENT_SECRET', '  pscale_mcp_url: https://bsp.test/mcp/v1',
    'products:', '  - id: commons', '    issuer: test-tickets', '    sed: sed:commons-tickets', '    face: author',
    '    scope: frame:commons', '    duration_days: 36500', '    description: the commons',
    '    price:', '      driver: stripe', '      stripe_price_id: price_commons', ...credits, '',
  ].join('\n');
  const good = join(dir, 'good.yaml');
  writeFileSync(good, yaml(['    credits:', '      per_pound: 1000', '      to: commons']));
  assert.deepEqual(loadConfig(good).products[0]!.credits, { per_pound: 1000, to: 'commons' });
  const bad = join(dir, 'bad.yaml');
  writeFileSync(bad, yaml(['    credits:', '      per_pound: 0.5']));
  assert.throws(() => loadConfig(bad), /credits\.per_pound/);
});
