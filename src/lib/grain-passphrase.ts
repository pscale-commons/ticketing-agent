// Per-grain passphrase derivation.
//
// The grain side write-lock passphrase is HMAC-SHA256 of the issuer-buyer
// agent_id pair, keyed with TICKET_AGENT_SECRET. Deterministic from
// (TICKET_AGENT_SECRET, issuer_agent_id, buyer_agent_id) — no per-grain
// secret on disk. Rotating TICKET_AGENT_SECRET invalidates revocation
// authority on all previously-issued grains, so that's a deliberate
// operational decision.
//
// The buyer never needs this; only the issuer does, to write the original
// envelope and any later [ticket-revoked] envelope.

import { createHmac } from 'node:crypto';

export function derivePassphrase(
  ticketAgentSecret: string,
  issuer_agent_id: string,
  buyer_agent_id: string,
): string {
  return createHmac('sha256', ticketAgentSecret)
    .update(`${issuer_agent_id}\n${buyer_agent_id}`)
    .digest('hex');
}
