import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { createApp } from '../src/server.js';
import { fakeCtx, fakeMcpClient } from './helpers.js';
import { giftMessage } from '../src/drivers/gift.js';
import type { PurchaseRow } from '../src/lib/db.js';
import type { Product } from '../src/types.js';

// Build a product set where designer-90d's gifters list contains an agent
// whose pubkey we publish into the fake passport block.
function setupGiftCtx(opts: { gifter_bare?: string; gifter_agent_id?: string; nowProduct?: Partial<Product> } = {}) {
  const gifter_bare = opts.gifter_bare ?? 'host';
  const gifter_agent_id = opts.gifter_agent_id ?? `agent:${gifter_bare}`;
  const keypair = nacl.sign.keyPair();
  const ed25519_pub_b64 = Buffer.from(keypair.publicKey).toString('base64');
  const ed25519_secret = keypair.secretKey;
  const x25519_pub_b64 = Buffer.from(nacl.box.keyPair().publicKey).toString('base64');

  const mcp = fakeMcpClient();
  // Publish the gifter's passport with position 9 carrying both pubkeys.
  mcp.setBlock(gifter_bare, 'passport', {
    _: 'I gift tickets',
    '9': { ed25519: ed25519_pub_b64, x25519: x25519_pub_b64 },
  });

  const products: Product[] = [
    {
      id: 'designer-90d',
      sed: 'sed:test-designers',
      face: 'designer',
      scope: 'beach:test.host',
      duration_days: 90,
      tier: 'hard',
      description: 'designer ticket',
      price: { driver: 'gift', gifters: [gifter_agent_id] },
      ...(opts.nowProduct ?? {}),
    },
  ];
  const ctx = fakeCtx({ products, mcp });
  return { ctx, mcp, keypair, ed25519_secret, gifter_agent_id };
}

function signGift(opts: {
  product_id: string;
  buyer_agent_id: string;
  issued_at: string;
  nonce: string;
  secret: Uint8Array;
}): string {
  const msg = new TextEncoder().encode(giftMessage(opts));
  const sig = nacl.sign.detached(msg, opts.secret);
  return Buffer.from(sig).toString('base64');
}

test('gift: happy path → grain issued + status=paid', async () => {
  const { ctx, mcp, ed25519_secret, gifter_agent_id } = setupGiftCtx();
  const app = createApp(ctx);
  const issued_at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const nonce = 'gift-nonce-1';
  const signature = signGift({
    product_id: 'designer-90d',
    buyer_agent_id: 'brisa',
    issued_at,
    nonce,
    secret: ed25519_secret,
  });

  const res = await app.request('/buy/designer-90d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      buyer_agent_id: 'brisa',
      gifter_agent_id,
      issued_at,
      nonce,
      signature,
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; purchase_id: string; pair_id: string };
  assert.equal(body.ok, true);
  assert.ok(body.pair_id);

  const row = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(body.purchase_id) as PurchaseRow;
  assert.equal(row.status, 'paid');
  assert.equal(row.driver, 'gift');
  assert.equal(row.driver_ref, nonce);
  assert.match(row.notes ?? '', /gift from agent:host/);

  // Grain reach was called with the right envelope.
  const reach = mcp.calls.find((c) => c.name === 'pscale_grain_reach')!;
  assert.match(reach.args.my_side_content as string, /^\[ticket face=designer scope=beach:test.host/);
});

test('gift: gifter not in product.gifters → 403', async () => {
  const { ctx, ed25519_secret } = setupGiftCtx();
  const app = createApp(ctx);
  const issued_at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const signature = signGift({
    product_id: 'designer-90d',
    buyer_agent_id: 'brisa',
    issued_at,
    nonce: 'n1',
    secret: ed25519_secret,
  });
  const res = await app.request('/buy/designer-90d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      buyer_agent_id: 'brisa',
      gifter_agent_id: 'agent:not-allowed',
      issued_at,
      nonce: 'n1',
      signature,
    }),
  });
  assert.equal(res.status, 403);
});

test('gift: bad signature → 400 with reason', async () => {
  const { ctx, gifter_agent_id } = setupGiftCtx();
  const app = createApp(ctx);
  const issued_at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const otherKey = nacl.sign.keyPair();
  const wrongSig = signGift({
    product_id: 'designer-90d',
    buyer_agent_id: 'brisa',
    issued_at,
    nonce: 'nx',
    secret: otherKey.secretKey,
  });
  const res = await app.request('/buy/designer-90d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      buyer_agent_id: 'brisa',
      gifter_agent_id,
      issued_at,
      nonce: 'nx',
      signature: wrongSig,
    }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string; reason: string };
  assert.equal(body.error, 'gift_verification_failed');
  assert.equal(body.reason, 'signature-mismatch');
});

test('gift: expired (issued_at older than window) → 400 gift-expired', async () => {
  const { ctx, ed25519_secret, gifter_agent_id } = setupGiftCtx();
  const app = createApp(ctx);
  const issued_at = '2020-01-01T00:00:00Z';
  const signature = signGift({
    product_id: 'designer-90d',
    buyer_agent_id: 'brisa',
    issued_at,
    nonce: 'old',
    secret: ed25519_secret,
  });
  const res = await app.request('/buy/designer-90d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      buyer_agent_id: 'brisa',
      gifter_agent_id,
      issued_at,
      nonce: 'old',
      signature,
    }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { reason: string };
  assert.equal(body.reason, 'gift-expired');
});

test('gift: replay (same nonce already paid) → 409', async () => {
  const { ctx, ed25519_secret, gifter_agent_id } = setupGiftCtx();
  const app = createApp(ctx);
  const issued_at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const nonce = 'replay-nonce';
  const signature = signGift({
    product_id: 'designer-90d',
    buyer_agent_id: 'brisa',
    issued_at,
    nonce,
    secret: ed25519_secret,
  });
  const body = JSON.stringify({
    buyer_agent_id: 'brisa',
    gifter_agent_id,
    issued_at,
    nonce,
    signature,
  });
  const first = await app.request('/buy/designer-90d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(first.status, 200);
  const second = await app.request('/buy/designer-90d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(second.status, 409);
});

test('gift: gifter has not published a pubkey → 400', async () => {
  const { ctx, ed25519_secret, gifter_agent_id } = setupGiftCtx();
  // Wipe the passport to simulate a gifter who never ran pscale_key_publish.
  (ctx.mcp as ReturnType<typeof fakeMcpClient>).setBlock('host', 'passport', { _: 'no keys' });
  const app = createApp(ctx);
  const issued_at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const signature = signGift({
    product_id: 'designer-90d',
    buyer_agent_id: 'brisa',
    issued_at,
    nonce: 'nopub',
    secret: ed25519_secret,
  });
  const res = await app.request('/buy/designer-90d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      buyer_agent_id: 'brisa',
      gifter_agent_id,
      issued_at,
      nonce: 'nopub',
      signature,
    }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { reason: string };
  assert.equal(body.reason, 'gifter-pubkey-not-published');
});

test('gift: rate-limit applies pre-issuance', async () => {
  const { ctx, ed25519_secret, gifter_agent_id } = setupGiftCtx({
    nowProduct: { rate_limit: { max_per_hour: 1, max_per_day: 5 } },
  });
  // One paid in the last hour to hit the cap.
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, created_at, paid_at)
       VALUES ('prior', 'designer-90d', 'someone', 'paid', 'gift', ?, ?)`,
    )
    .run(now, now);

  const app = createApp(ctx);
  const issued_at = now.replace(/\.\d+Z$/, 'Z');
  const signature = signGift({
    product_id: 'designer-90d',
    buyer_agent_id: 'brisa',
    issued_at,
    nonce: 'rl',
    secret: ed25519_secret,
  });
  const res = await app.request('/buy/designer-90d', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      buyer_agent_id: 'brisa',
      gifter_agent_id,
      issued_at,
      nonce: 'rl',
      signature,
    }),
  });
  assert.equal(res.status, 429);
});
