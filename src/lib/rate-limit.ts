// Per-product rate limiting per protocol §3.9.
//
// Hour cap and day cap, both counted from the purchases table by
// `paid_at` (only successful issuances count). A cap-hit logs a
// high-severity event and (if RATE_LIMIT_WEBHOOK is set) POSTs to it.
// The buyer is NOT auto-refunded — operator decides via /admin/refund.
//
// Per CLAUDE.md "Counts for `lib/rate-limit.ts` come from this table —
// SELECT count(*) WHERE product_id = ? AND status = 'paid' AND paid_at > ?.
// No separate counter table."

import type Database from 'better-sqlite3';
import type { Product } from '../types.js';

export type RateLimitDecision =
  | { allowed: true; hour_count: number; day_count: number }
  | { allowed: false; reason: 'hour-cap' | 'day-cap'; hour_count: number; day_count: number; cap: number };

export function check(
  db: Database.Database,
  product: Product,
  now: Date = new Date(),
): RateLimitDecision {
  if (!product.rate_limit) {
    return { allowed: true, hour_count: 0, day_count: 0 };
  }
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const stmt = db.prepare<[string, string]>(
    "SELECT count(*) as n FROM purchases WHERE product_id = ? AND status = 'paid' AND paid_at > ?",
  );
  const hour_count = (stmt.get(product.id, hourAgo) as { n: number }).n;
  const day_count = (stmt.get(product.id, dayAgo) as { n: number }).n;

  if (hour_count >= product.rate_limit.max_per_hour) {
    return {
      allowed: false,
      reason: 'hour-cap',
      hour_count,
      day_count,
      cap: product.rate_limit.max_per_hour,
    };
  }
  if (day_count >= product.rate_limit.max_per_day) {
    return {
      allowed: false,
      reason: 'day-cap',
      hour_count,
      day_count,
      cap: product.rate_limit.max_per_day,
    };
  }
  return { allowed: true, hour_count, day_count };
}

// Fire-and-forget POST to the rate-limit webhook if configured. Called once
// per cap-hit. Keeps logs flowing even if the receiver is unavailable.
export async function notifyCapHit(
  webhook_url: string | undefined,
  payload: { product_id: string; reason: string; cap: number; hour_count: number; day_count: number; purchase_id: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!webhook_url) return;
  try {
    await fetchImpl(webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'rate_limit_cap_hit', ...payload, at: new Date().toISOString() }),
    });
  } catch {
    // Webhook failures are operational noise; the high-severity log is the canonical record.
  }
}
