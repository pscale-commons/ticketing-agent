import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/lib/db.js';
import * as rateLimit from '../src/lib/rate-limit.js';
import type { Product } from '../src/types.js';

const PRODUCT: Product = {
  id: 'rate-test',
  sed: 'sed:rate-test',
  face: 'character',
  scope: 'frame:rate-test',
  duration_days: 30,
  description: 'rate test',
  rate_limit: { max_per_hour: 2, max_per_day: 5 },
  price: { driver: 'stripe', stripe_price_id: 'price_x' },
};

const NO_LIMIT_PRODUCT: Product = { ...PRODUCT, id: 'no-limit', rate_limit: undefined };

function insertPaid(db: ReturnType<typeof openDb>, product_id: string, paid_at_iso: string, n: number = 1): void {
  const stmt = db.prepare(
    `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, driver_ref, created_at, paid_at, amount_cents, currency)
     VALUES (?, ?, 'buyer', 'paid', 'stripe', NULL, ?, ?, 1000, 'usd')`,
  );
  for (let i = 0; i < n; i++) stmt.run(`p-${product_id}-${paid_at_iso}-${i}`, product_id, paid_at_iso, paid_at_iso);
}

test('rate-limit: no rate_limit configured → always allowed', () => {
  const db = openDb(':memory:');
  const decision = rateLimit.check(db, NO_LIMIT_PRODUCT);
  assert.equal(decision.allowed, true);
});

test('rate-limit: under both caps → allowed', () => {
  const db = openDb(':memory:');
  const now = new Date('2026-05-01T12:00:00Z');
  insertPaid(db, PRODUCT.id, '2026-05-01T11:30:00Z', 1); // within hour
  const decision = rateLimit.check(db, PRODUCT, now);
  assert.equal(decision.allowed, true);
  if (decision.allowed) {
    assert.equal(decision.hour_count, 1);
    assert.equal(decision.day_count, 1);
  }
});

test('rate-limit: hour cap hit → not allowed', () => {
  const db = openDb(':memory:');
  const now = new Date('2026-05-01T12:00:00Z');
  insertPaid(db, PRODUCT.id, '2026-05-01T11:30:00Z', 2); // == max_per_hour
  const decision = rateLimit.check(db, PRODUCT, now);
  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.equal(decision.reason, 'hour-cap');
    assert.equal(decision.cap, 2);
  }
});

test('rate-limit: day cap hit → not allowed', () => {
  const db = openDb(':memory:');
  const now = new Date('2026-05-01T12:00:00Z');
  // Spread 5 paid purchases through the day, all >1h ago so hour-cap is fine.
  insertPaid(db, PRODUCT.id, '2026-05-01T01:00:00Z');
  insertPaid(db, PRODUCT.id, '2026-05-01T02:00:00Z');
  insertPaid(db, PRODUCT.id, '2026-05-01T03:00:00Z');
  insertPaid(db, PRODUCT.id, '2026-05-01T04:00:00Z');
  insertPaid(db, PRODUCT.id, '2026-05-01T05:00:00Z');
  const decision = rateLimit.check(db, PRODUCT, now);
  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.equal(decision.reason, 'day-cap');
    assert.equal(decision.cap, 5);
    assert.equal(decision.day_count, 5);
    assert.equal(decision.hour_count, 0);
  }
});

test('rate-limit: paid_at older than the window does not count', () => {
  const db = openDb(':memory:');
  const now = new Date('2026-05-01T12:00:00Z');
  insertPaid(db, PRODUCT.id, '2026-04-30T10:00:00Z', 10); // > 24h ago
  const decision = rateLimit.check(db, PRODUCT, now);
  assert.equal(decision.allowed, true);
  if (decision.allowed) {
    assert.equal(decision.hour_count, 0);
    assert.equal(decision.day_count, 0);
  }
});

test('rate-limit: only paid status counts (pending/failed/rate_limited ignored)', () => {
  const db = openDb(':memory:');
  const now = new Date('2026-05-01T12:00:00Z');
  // Six pendings — should not block.
  for (let i = 0; i < 6; i++) {
    db.prepare(
      `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, created_at)
       VALUES (?, ?, 'buyer', 'pending', 'stripe', '2026-05-01T11:00:00Z')`,
    ).run(`pending-${i}`, PRODUCT.id);
  }
  const decision = rateLimit.check(db, PRODUCT, now);
  assert.equal(decision.allowed, true);
});

test('rate-limit: notifyCapHit makes a POST when webhook configured', async () => {
  const calls: Array<{ url: string; payload: any }> = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: url.toString(), payload: JSON.parse(init?.body as string) });
    return new Response('{}', { status: 200 });
  };
  await rateLimit.notifyCapHit(
    'https://hook.test/cap',
    {
      product_id: PRODUCT.id,
      reason: 'hour-cap',
      cap: 2,
      hour_count: 2,
      day_count: 2,
      purchase_id: 'p-1',
    },
    fakeFetch,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://hook.test/cap');
  assert.equal(calls[0]!.payload.event, 'rate_limit_cap_hit');
  assert.equal(calls[0]!.payload.product_id, 'rate-test');
});

test('rate-limit: notifyCapHit no-ops when webhook unset', async () => {
  let called = false;
  const fakeFetch: typeof fetch = async () => {
    called = true;
    return new Response('{}');
  };
  await rateLimit.notifyCapHit(
    undefined,
    { product_id: 'x', reason: 'hour-cap', cap: 1, hour_count: 1, day_count: 1, purchase_id: 'p' },
    fakeFetch,
  );
  assert.equal(called, false);
});
