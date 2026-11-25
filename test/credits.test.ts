// Credits (lib/credits.ts, routes/credits.ts): a ticket's credits written into
// the issuer's book the moment it is paid, free goes drawn from a fund others
// filled, and a holder's own gift moved only as far as the book says they hold.
// The beach is in memory: the fake MCP's bsp founds and appends to a book, and
// ctx.readBlock reads the same blocks, so what the machine wrote is what it reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/lib/config.js';
import { parseEnvelope } from '../src/lib/envelope.js';
import { linesOf, balances, makersOf, equally, giftOf } from '../src/lib/credits.js';
import { fakeCtx, fakeMcpClient, fakeStripeDriver, TEST_PRODUCTS } from './helpers.js';
import type { Product } from '../src/types.js';

const OWN: Product = {
  id: 'migration-credits', title: 'Credits for Migration — 10 credits, £1', issuer: 'arcade-credits',
  sed: 'sed:arcade-credits', face: 'character', scope: 'frame:migration', duration_days: 36500,
  description: 'Ten credits, a go each.', price: { driver: 'stripe', stripe_price_id: 'price_own' },
  credits: { n: 10, to: 'buyer', point: 'migration' }, back: 'https://happyseaurchin.com/games/migration',
};
const FUND: Product = {
  id: 'migration-goes', title: 'Goes of Migration for others — 4 goes, £1', issuer: 'arcade-credits',
  sed: 'sed:arcade-credits', face: 'character', scope: 'frame:migration', duration_days: 36500,
  description: 'Four goes for players who put nothing in.', price: { driver: 'stripe', stripe_price_id: 'price_fund' },
  credits: { n: 4, to: 'pool', point: 'migration', free: 3, go: 1 },
};

const LAW = { _: 'THE LAW of migration', '1': 'mode: game', '8': { _: 'makers: happyseaurchin, matthew — split equally; every credit spent on a go lands with them' } };

// An in-memory beach: blocks by name; a book grows as an accumulator does.
function beach() {
  const blocks = new Map<string, Record<string, unknown>>();
  const latches = new Map<string, string>();
  const mcp = fakeMcpClient();
  mcp.setResponse('bsp', (args: Record<string, unknown>) => {
    const name = args.block as string;
    if (args.new_lock && !args.append) {
      if (blocks.has(name)) return '[refused — the block is latched]';
      blocks.set(name, args.content as Record<string, unknown>);
      latches.set(name, args.new_lock as string);
      return '[created, latched]';
    }
    if (args.append) {
      assert.equal(args.secret, latches.get(name), 'every line is written under the key the book was founded with');
      const b = blocks.get(name)!;
      const n = Object.keys(b).filter((k) => /^[1-9]$/.test(k)).length + 1;
      assert.ok(n <= 9, 'a test book stays under nine lines');
      b[String(n)] = args.content as Record<string, unknown>;
      return `[append @ "https://beach.test/${name}" → slot ${n}]`;
    }
    return '[written]';
  });
  return { blocks, mcp, read: async (name: string) => blocks.get(name) ?? null };
}

function setup(products: Product[] = [...TEST_PRODUCTS, OWN, FUND]) {
  const b = beach();
  const driver = fakeStripeDriver();
  const ctx = { ...fakeCtx({ stripeDriver: driver, mcp: b.mcp, products }), readBlock: b.read };
  b.blocks.set('function:migration', LAW);
  return { ...b, ctx, driver, app: createApp(ctx) };
}

async function buy(s: ReturnType<typeof setup>, product: string, buyer: string, n = 1) {
  const res = await s.app.request(`/buy/${product}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ buyer_agent_id: buyer }),
  });
  const { purchase_id } = (await res.json()) as { purchase_id: string };
  s.driver.webhookEvents.set(`sig:${n}`, { kind: 'checkout-completed', driver_ref: `cs_${purchase_id}`, purchase_id, amount_cents: 100, currency: 'gbp' });
  const hook = await s.app.request('/webhook/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `sig:${n}` }, body: '{}' });
  assert.equal(hook.status, 200);
  return purchase_id;
}

const post = (s: ReturnType<typeof setup>, path: string, body: unknown) =>
  s.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://happyseaurchin.com' }, body: JSON.stringify(body) });

function gift(s: ReturnType<typeof setup>, holder: string, slot: string, probe: string, n: number, to: string) {
  const p = (s.blocks.get(`passport:${holder}`) ?? { _: `passport of ${holder}`, '6': { _: 'accumulators', '3': { _: 'gifts' } } }) as any;
  p['6']['3'][slot] = { _: `a go of Migration: ${n} to its makers`, '1': probe, '2': n, '3': to, '5': '2026-11-25T17:00:00Z' };
  s.blocks.set(`passport:${holder}`, p);
}

test('credits: a ticket bought for oneself is written into the book as credits for the buyer, the moment it is paid', async () => {
  const s = setup();
  const id = await buy(s, 'migration-credits', 'ana');
  const lines = linesOf(await s.read('credits:arcade-credits'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.to, 'ana');
  assert.equal(lines[0]!.n, 10);
  assert.equal(lines[0]!.warrant, `ticket ${id}`);
  assert.match(lines[0]!.from, /^grain:[0-9a-f]{16}$/);
  assert.equal(balances(lines).get('ana'), 10);
  const reach = s.mcp.calls.find((c) => c.name === 'pscale_grain_reach')!;
  const env = parseEnvelope(reach.args.my_side_content as string);
  assert.ok(env.kind === 'ticket' && env.credits === 10, 'the ticket itself carries credits=10 (payway 2.27)');
});

test('credits: the founding write carries no secret, so over a latched book it changes nothing', async () => {
  const s = setup();
  await buy(s, 'migration-credits', 'ana');
  const found = s.mcp.calls.find((c) => c.name === 'bsp' && c.args.new_lock)!;
  assert.ok(found && !found.args.secret);
});

test('credits: a reissue of a paid purchase writes nothing twice', async () => {
  const s = setup();
  const id = await buy(s, 'migration-credits', 'ana');
  const { mintAtPayment } = await import('../src/lib/credits.js');
  const again = await mintAtPayment(s.ctx, OWN, id, 'ana', '0123456789abcdef');
  assert.deepEqual(again, { ok: true, lines: 0 });
  assert.equal(linesOf(await s.read('credits:arcade-credits')).length, 1);
});

test('credits: a fund ticket fills the fund, never naming who paid', async () => {
  const s = setup();
  await buy(s, 'migration-goes', 'david');
  const [line] = linesOf(await s.read('credits:arcade-credits'));
  assert.equal(line!.to, 'fund:migration-goes');
  assert.equal(line!.n, 4);
  assert.ok(!/david/.test(line!.voicing), 'the payer of a fund is never named in the book');
});

test('credits: free goes are drawn from the fund to the makers, split equally, three a handle', async () => {
  const s = setup();
  await buy(s, 'migration-goes', 'david');
  for (let k = 1; k <= 3; k++) {
    const r = await post(s, '/credits/draw', { product: 'migration-goes', holder: 'ben' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    const body = (await r.json()) as { free_left: number; fund_left: number };
    assert.equal(body.free_left, 3 - k);
    assert.equal(body.fund_left, 4 - k);
  }
  const fourth = await post(s, '/credits/draw', { product: 'migration-goes', holder: 'ben' });
  assert.equal(fourth.status, 409);
  assert.equal(((await fourth.json()) as { error: string }).error, 'no_free_goes_left');
  const held = balances(linesOf(await s.read('credits:arcade-credits')));
  assert.equal(held.get('happyseaurchin'), 1.5);
  assert.equal(held.get('matthew'), 1.5);
  assert.equal(held.get('fund:migration-goes'), 1);
});

test('credits: an empty fund draws nothing', async () => {
  const s = setup();
  await buy(s, 'migration-goes', 'david');
  for (const h of ['ben', 'cy', 'di', 'ed']) assert.equal((await post(s, '/credits/draw', { product: 'migration-goes', holder: h })).status, 200);
  const r = await post(s, '/credits/draw', { product: 'migration-goes', holder: 'fay' });
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { error: string }).error, 'fund_empty');
});

test('credits: a paid go moves only on the gift the holder wrote at their own passport, to the point\'s makers', async () => {
  const s = setup();
  await buy(s, 'migration-credits', 'ana');
  const none = await post(s, '/credits/spend', { issuer: 'arcade-credits', holder: 'ana', probe: 'go-1' });
  assert.equal(none.status, 404, 'no gift at her 6.3, nothing moves');
  gift(s, 'ana', '1', 'go-1', 1, 'function:migration');
  const r = await post(s, '/credits/spend', { issuer: 'arcade-credits', holder: 'ana', probe: 'go-1' });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { balance: number }).balance, 9);
  const lines = linesOf(await s.read('credits:arcade-credits'));
  const go = lines.filter((l) => l.id === 'go-1');
  assert.deepEqual(go.map((l) => [l.to, l.n, l.warrant]), [['happyseaurchin', 0.5, 'passport:ana 6.31'], ['matthew', 0.5, 'passport:ana 6.31']]);
  const again = await post(s, '/credits/spend', { issuer: 'arcade-credits', holder: 'ana', probe: 'go-1' });
  assert.equal(((await again.json()) as { already: boolean }).already, true, 'one gift moves once');
  assert.equal(balances(linesOf(await s.read('credits:arcade-credits'))).get('ana'), 9);
});

test('credits: a gift past what the book holds is refused, and two at once cannot both take the last credits', async () => {
  const s = setup();
  await buy(s, 'migration-credits', 'ana');
  gift(s, 'ana', '1', 'big', 11, 'function:migration');
  const big = await post(s, '/credits/spend', { issuer: 'arcade-credits', holder: 'ana', probe: 'big' });
  assert.equal(big.status, 409);
  gift(s, 'ana', '2', 'a', 10, 'cy');
  gift(s, 'ana', '3', 'b', 10, 'di');
  const [ra, rb] = await Promise.all([
    post(s, '/credits/spend', { issuer: 'arcade-credits', holder: 'ana', probe: 'a' }),
    post(s, '/credits/spend', { issuer: 'arcade-credits', holder: 'ana', probe: 'b' }),
  ]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 409], 'the book keeps one order: the second finds nothing left');
  const held = balances(linesOf(await s.read('credits:arcade-credits')));
  assert.equal(held.get('ana'), 0);
  assert.equal((held.get('cy') ?? 0) + (held.get('di') ?? 0), 10);
});

test('credits: an unknown issuer, a handle that is not one, and a fund that is not a fund are refused', async () => {
  const s = setup();
  assert.equal((await post(s, '/credits/spend', { issuer: 'someone-else', holder: 'ana', probe: 'x' })).status, 404);
  assert.equal((await post(s, '/credits/draw', { product: 'migration-credits', holder: 'ana' })).status, 404);
  assert.equal((await post(s, '/credits/draw', { product: 'migration-goes', holder: 'a b' })).status, 400);
  const pre = await s.app.request('/credits/draw', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
});

test('credits: makers are read off the law\'s makers: line, and split to the cent', async () => {
  const read = async (n: string) => (n === 'function:g' ? { _: 'law', '3': { _: 'x', '2': 'makers: ana, ben and cy (split equally)' } } : null);
  assert.deepEqual(await makersOf(read, 'g'), ['ana', 'ben', 'cy']);
  assert.deepEqual(await makersOf(read, 'h'), []);
  assert.deepEqual(equally(1, ['ana', 'ben', 'cy']), [{ to: 'ana', n: 0.34 }, { to: 'ben', n: 0.33 }, { to: 'cy', n: 0.33 }]);
});

test('credits: a book read in order across a supernest, and a gift found under a nested slot', () => {
  const l = (id: string, to: string) => ({ _: id, '1': id, '2': 1, '3': '2026-11-25T17:00:00Z', '5': to, '6': 'x' });
  const book = { _: { _: { _: 'book', '1': l('a', 'p'), '2': l('b', 'p') }, '1': { _: '', '1': l('c', 'p') } }, '1': { _: '', '1': { _: '', '1': l('d', 'p') } } };
  assert.deepEqual(linesOf(book).map((x) => x.id), ['a', 'b', 'c', 'd']);
  const passport = { _: 'p', '6': { _: 'acc', '3': { _: 'gifts', '1': { _: 'g', '1': 'p1', '2': 1, '3': 'function:migration' }, '2': { _: 'g', '1': 'p2', '2': 2, '3': 'ben' } } } };
  assert.deepEqual(giftOf(passport, 'p2'), { slot: '2', n: 2, to: 'ben', voicing: 'g' });
  assert.equal(giftOf(passport, 'nope'), null);
});

test('credits: config takes a credit-bearing product, and refuses a fund that names no point', () => {
  const dir = mkdtempSync(join(tmpdir(), 'credits-'));
  const base = `agent: { id: 'agent:t', secret_env: S, pscale_mcp_url: 'https://x/mcp' }\nproducts:\n`;
  const ok = `${base}  - { id: c, sed: 'sed:c', face: character, scope: 'frame:m', duration_days: 1, description: d, price: { driver: stripe, stripe_price_id: p }, credits: { n: 10, to: buyer }, back: 'http://localhost:3000/games/migration' }\n`;
  writeFileSync(join(dir, 'ok.yaml'), ok);
  assert.equal(loadConfig(join(dir, 'ok.yaml')).products[0]!.credits!.n, 10);
  const bad = `${base}  - { id: c, sed: 'sed:c', face: character, scope: 'frame:m', duration_days: 1, description: d, price: { driver: stripe, stripe_price_id: p }, credits: { n: 10, to: pool } }\n`;
  writeFileSync(join(dir, 'bad.yaml'), bad);
  assert.throws(() => loadConfig(join(dir, 'bad.yaml')), /a pool names its point/);
});

test('credits: the success page of a credit ticket says where the credits go and leads back', async () => {
  const s = setup();
  const r = await s.app.request('/share/migration-credits/success');
  const html = await r.text();
  assert.match(html, /written into the book/);
  assert.match(html, /href="https:\/\/happyseaurchin.com\/games\/migration"/);
});

test('credits: a product read as JSON carries its issuer and credit terms, for the page that offers it', async () => {
  const s = setup();
  const r = await s.app.request('/share/migration-goes', { headers: { accept: 'application/json' } });
  const body = (await r.json()) as { issuer: string; credits: { to: string; free: number; go: number } };
  assert.equal(body.issuer, 'arcade-credits');
  assert.equal(r.headers.get('access-control-allow-origin'), '*', 'a page on another origin reads a product\'s terms');
  assert.deepEqual([body.credits.to, body.credits.free, body.credits.go], ['pool', 3, 1]);
  const plain = await s.app.request('/share/character-30d', { headers: { accept: 'application/json' } });
  assert.equal(((await plain.json()) as { credits?: unknown }).credits, undefined);
});
