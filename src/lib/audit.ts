// Public audit log for verifier decisions.
//
// One sed: collective per calendar month, named
//   sed:<verifier-bare-id>-audit-<yyyy-mm>
// Each verification decision becomes a registration in that collective —
// the declaration is the verifier envelope text (which carries
// `registration=...` and `grain=...` so external readers can correlate).
//
// Why sed:
//   - Append-only by construction.
//   - Server allocates the position deterministically; we don't track
//     "next position" locally.
//   - Public-readable, sovereign-write — exactly what an audit log wants.
//   - One MCP call per entry.
//
// Why per calendar month: keeps any single block bounded; old months
// remain readable but stop being written to. CLAUDE.md "append-only, one
// block per calendar month."
//
// The collective's own creator passphrase + each entry's registration
// passphrase derive deterministically from TICKET_AGENT_SECRET, so we
// never store a per-entry secret; sed: positions are immutable
// post-registration so we don't need to remember the per-entry one.

import { createHmac } from 'node:crypto';
import type { McpClient } from './pscale.js';

// Live pscale_register ack: "Registered at sed:<collective>:<position> on <beach>."
// Collective names carry no colon, so [^:\s]+ captures the name and :(\d+) the
// position. Fall back to a generic "position: N" form for older servers.
const POSITION_RE = /sed:[^:\s]+:(\d+)\b/;
const POSITION_FALLBACK_RE = /position\s*[:=]\s*(\d+)/i;

export type AuditDecision = 'verified' | 'rejected' | 'expired';

export type AppendInput = {
  client: McpClient;
  ticketAgentSecret: string;
  verifier_bare_id: string; // e.g. "tickets-test"
  envelope: string;          // [ticket-verified ...] or [ticket-rejected ...] etc.
  date?: Date;
};

export type AppendResult = {
  audit_block: string;       // collective name (without sed: prefix)
  audit_position: string;    // server-allocated position digit string
};

export function auditCollectiveName(verifier_bare_id: string, date: Date = new Date()): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${verifier_bare_id}-audit-${yyyy}-${mm}`;
}

export function deriveCollectivePassphrase(secret: string, collective: string, kind: 'creator' | 'entry'): string {
  return createHmac('sha256', secret).update(`${collective}\n${kind}`).digest('hex');
}

export async function appendDecision(input: AppendInput): Promise<AppendResult> {
  const date = input.date ?? new Date();
  const collective = auditCollectiveName(input.verifier_bare_id, date);

  // No explicit creation step: pscale_register auto-creates the sed: collective
  // on first registration (the old pscale_create_collective tool no longer
  // exists on the substrate). Each entry is a registrant whose declaration is
  // the verifier envelope; the per-entry passphrase derives deterministically
  // from TICKET_AGENT_SECRET, and sed: positions are immutable post-register.
  const passphrase = deriveCollectivePassphrase(input.ticketAgentSecret, collective, 'entry');
  const text = await input.client.callTool('pscale_register', {
    collective,
    declaration: input.envelope,
    passphrase,
  });

  const positionMatch = POSITION_RE.exec(text) ?? POSITION_FALLBACK_RE.exec(text);
  const audit_position = positionMatch?.[1] ?? '?';

  return { audit_block: collective, audit_position };
}
