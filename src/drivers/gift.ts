// Gift driver — Ed25519 signature against `pscale_key_publish`-ed pubkeys.
//
// A gifter (an agent_id allowed in a product's `gifters` list) signs a
// canonical message authorising a specific buyer for a specific product:
//
//   ticket-gift:<product_id>:<buyer_agent_id>:<issued_at>:<nonce>
//
// The buyer (or anyone holding the signed message) submits it to
// POST /buy/<product_id>. We:
//   1. Confirm gifter is in product.price.gifters.
//   2. Confirm issued_at is within an acceptable window (default 24h).
//   3. Confirm the nonce hasn't been redeemed before (idempotency).
//   4. Read the gifter's published pubkey from passport position 9.
//   5. Verify the signature.
//
// The driver does NOT create a Stripe checkout; the gift flow's grain
// issuance happens inline in the purchase route once the gifter's
// signature verifies. The driver exposes verify and the canonical message
// builder; the route does the rest.
//
// CreateCheckout / verifyWebhook on this driver throw — gift redemption
// uses POST /buy directly, not Checkout Session redirects, and there's no
// payment processor to receive a webhook. createRefund returns a no-op
// so /admin/refund still revokes the grain (the gift is "refunded" by
// revoking; there's no money to return).

import nacl from 'tweetnacl';
import type {
  CreateCheckoutInput,
  CreateCheckoutResult,
  CreateRefundInput,
  CreateRefundResult,
  PaymentDriver,
  VerifyWebhookInput,
  WebhookEvent,
} from './types.js';
import type { McpClient } from '../lib/pscale.js';
import { parseWholeBlock } from '../lib/pscale.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const GIFT_WINDOW_MS_DEFAULT = 24 * 60 * 60 * 1000;

export type VerifyGiftInput = {
  client: McpClient;
  product_id: string;
  buyer_agent_id: string;
  gifter_agent_id: string;
  issued_at: string;
  nonce: string;
  signature: string; // base64
  now?: Date;
  windowMs?: number;
};

export type VerifyGiftResult =
  | { ok: true }
  | { ok: false; reason: string };

export function giftMessage(opts: {
  product_id: string;
  buyer_agent_id: string;
  issued_at: string;
  nonce: string;
}): string {
  return `ticket-gift:${opts.product_id}:${opts.buyer_agent_id}:${opts.issued_at}:${opts.nonce}`;
}

function fromBase64(b64: string): Uint8Array | null {
  try {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
}

function bareAgent(id: string): string {
  return id.startsWith('agent:') ? id.slice('agent:'.length) : id;
}

async function fetchEd25519Pubkey(client: McpClient, gifter_bare_id: string): Promise<string | null> {
  // Read the whole passport block — small, simpler than chasing the right
  // (S, P) for a position-9 subtree read.
  const text = await client.callTool('bsp', {
    agent_id: gifter_bare_id,
    block: 'passport',
    spindle: null,
    pscale_attention: null,
  });
  const block = parseWholeBlock(text);
  if (!block) return null;
  const keys = block['9'];
  if (typeof keys !== 'object' || keys === null) return null;
  const ed = (keys as Record<string, unknown>).ed25519;
  return typeof ed === 'string' ? ed : null;
}

export async function verifyGift(input: VerifyGiftInput): Promise<VerifyGiftResult> {
  if (!ISO_RE.test(input.issued_at)) return { ok: false, reason: 'bad-issued-at' };
  if (!input.nonce || /\s/.test(input.nonce)) return { ok: false, reason: 'bad-nonce' };

  const now = input.now ?? new Date();
  const window = input.windowMs ?? GIFT_WINDOW_MS_DEFAULT;
  const issuedMs = Date.parse(input.issued_at);
  if (!Number.isFinite(issuedMs)) return { ok: false, reason: 'bad-issued-at' };
  if (issuedMs > now.getTime() + 60_000) return { ok: false, reason: 'issued-in-future' };
  if (now.getTime() - issuedMs > window) return { ok: false, reason: 'gift-expired' };

  const gifter_bare = bareAgent(input.gifter_agent_id);
  const pubkeyB64 = await fetchEd25519Pubkey(input.client, gifter_bare);
  if (!pubkeyB64) return { ok: false, reason: 'gifter-pubkey-not-published' };
  const pubkey = fromBase64(pubkeyB64);
  if (!pubkey || pubkey.length !== 32) return { ok: false, reason: 'gifter-pubkey-malformed' };

  const sig = fromBase64(input.signature);
  if (!sig || sig.length !== 64) return { ok: false, reason: 'signature-malformed' };

  const message = new TextEncoder().encode(
    giftMessage({
      product_id: input.product_id,
      buyer_agent_id: input.buyer_agent_id,
      issued_at: input.issued_at,
      nonce: input.nonce,
    }),
  );
  const ok = nacl.sign.detached.verify(message, sig, pubkey);
  return ok ? { ok: true } : { ok: false, reason: 'signature-mismatch' };
}

export class GiftDriver implements PaymentDriver {
  readonly name = 'gift';

  // Gift redemption is signature-based, not Checkout-based. The purchase
  // route calls verifyGift() directly; the driver's PaymentDriver-shaped
  // surface is mostly inert.
  async createCheckout(_input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    throw new Error('GiftDriver.createCheckout: gift products do not use Checkout');
  }
  verifyWebhook(_input: VerifyWebhookInput): WebhookEvent {
    throw new Error('GiftDriver.verifyWebhook: gift driver has no webhook source');
  }
  async createRefund(_input: CreateRefundInput): Promise<CreateRefundResult> {
    // Nothing to refund — gift was free. Grain revocation still happens.
    return { refund_id: null };
  }
}
