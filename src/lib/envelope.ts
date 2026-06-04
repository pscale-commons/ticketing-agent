// Envelope grammar per payway.md §2.2 / §2.3 / §2.4.
//
//   [ticket face=<face> scope=<scope> expires=<iso8601> (tier=...)? (seats=...)? (nonce=...)?]
//   [ticket-revoked at=<iso8601> reason=<short>]
//   [ticket-verified by=agent:<verifier-id> at=<iso8601>]
//   [ticket-rejected by=agent:<verifier-id> at=<iso8601> reason=<short>]
//   [ticket-expired at=<iso8601>]
//
// `credits=<n>` is reserved (§2.2). v1 verifiers MUST reject any [ticket]
// envelope containing it (§2.4 rule 8). The parser surfaces it via
// `hasCredits` so the caller (verifier) can write the right rejection.
//
// One module. Parse, build, round-trip. No class hierarchy, no validator
// framework — eight `if`s for verification belong in lib/grain.ts (M4),
// not here.

import type { Face } from '../types.js';

export type Tier = 'soft' | 'medium' | 'hard';

export type TicketEnvelope = {
  kind: 'ticket';
  face: Face;
  scope: string;
  expires: string;
  tier?: Tier;
  seats?: number;
  nonce?: string;
  hasCredits: boolean;
};

export type TicketRevokedEnvelope = {
  kind: 'ticket-revoked';
  at: string;
  reason: string;
};

// `registration` and `grain` are extension fields on the verifier envelopes
// — not in payway.md §2.3 today, but required because the
// envelopes get written into a public audit log block, not "onto the
// registration position" (the registrant's lock prevents that). Each entry
// must carry its registration ref so external readers can correlate.
// Flagged for bsp-mcp-server to pin in §2.3.

export type TicketVerifiedEnvelope = {
  kind: 'ticket-verified';
  by: string;
  at: string;
  registration?: string;
  grain?: string;
};

export type TicketRejectedEnvelope = {
  kind: 'ticket-rejected';
  by: string;
  at: string;
  reason: string;
  registration?: string;
  grain?: string;
};

export type TicketExpiredEnvelope = {
  kind: 'ticket-expired';
  at: string;
  registration?: string;
  grain?: string;
};

export type Envelope =
  | TicketEnvelope
  | TicketRevokedEnvelope
  | TicketVerifiedEnvelope
  | TicketRejectedEnvelope
  | TicketExpiredEnvelope;

export type ParseError = { kind: 'parse-error'; reason: string };
export type ParseResult = Envelope | ParseError;

const ENVELOPE_RE = /^\[([a-z][a-z-]*)\s*(.*?)\s*\]$/;
const KV_RE = /([a-zA-Z][a-zA-Z0-9_-]*)=(\S+)/g;
const FACES: ReadonlySet<Face> = new Set(['character', 'author', 'designer']);
const TIERS: ReadonlySet<Tier> = new Set(['soft', 'medium', 'hard']);

function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let m: RegExpExecArray | null;
  KV_RE.lastIndex = 0;
  while ((m = KV_RE.exec(body)) !== null) {
    fields[m[1]!] = m[2]!;
  }
  return fields;
}

function isIso8601(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

export function parseEnvelope(text: string): ParseResult {
  const trimmed = text.trim();
  const m = ENVELOPE_RE.exec(trimmed);
  if (!m) return { kind: 'parse-error', reason: 'not-an-envelope' };

  const head = m[1]!;
  const fields = parseFields(m[2]!);

  switch (head) {
    case 'ticket': {
      const { face, scope, expires, tier, seats, nonce, credits, ...rest } = fields;
      if (!face) return { kind: 'parse-error', reason: 'missing-face' };
      if (!FACES.has(face as Face)) return { kind: 'parse-error', reason: 'bad-face' };
      if (!scope) return { kind: 'parse-error', reason: 'missing-scope' };
      if (!expires) return { kind: 'parse-error', reason: 'missing-expires' };
      if (!isIso8601(expires)) return { kind: 'parse-error', reason: 'bad-expires' };
      if (tier && !TIERS.has(tier as Tier)) return { kind: 'parse-error', reason: 'bad-tier' };
      let seatsN: number | undefined;
      if (seats !== undefined) {
        const n = Number(seats);
        if (!Number.isInteger(n) || n < 1) return { kind: 'parse-error', reason: 'bad-seats' };
        seatsN = n;
      }
      if (Object.keys(rest).length > 0) {
        return { kind: 'parse-error', reason: `unknown-field:${Object.keys(rest)[0]}` };
      }
      const env: TicketEnvelope = {
        kind: 'ticket',
        face: face as Face,
        scope,
        expires,
        hasCredits: credits !== undefined,
      };
      if (tier) env.tier = tier as Tier;
      if (seatsN !== undefined) env.seats = seatsN;
      if (nonce) env.nonce = nonce;
      return env;
    }
    case 'ticket-revoked': {
      const { at, reason, ...rest } = fields;
      if (!at) return { kind: 'parse-error', reason: 'missing-at' };
      if (!isIso8601(at)) return { kind: 'parse-error', reason: 'bad-at' };
      if (!reason) return { kind: 'parse-error', reason: 'missing-reason' };
      if (Object.keys(rest).length > 0) {
        return { kind: 'parse-error', reason: `unknown-field:${Object.keys(rest)[0]}` };
      }
      return { kind: 'ticket-revoked', at, reason };
    }
    case 'ticket-verified': {
      const { by, at, registration, grain, ...rest } = fields;
      if (!by) return { kind: 'parse-error', reason: 'missing-by' };
      if (!at) return { kind: 'parse-error', reason: 'missing-at' };
      if (!isIso8601(at)) return { kind: 'parse-error', reason: 'bad-at' };
      if (Object.keys(rest).length > 0) {
        return { kind: 'parse-error', reason: `unknown-field:${Object.keys(rest)[0]}` };
      }
      const env: TicketVerifiedEnvelope = { kind: 'ticket-verified', by, at };
      if (registration) env.registration = registration;
      if (grain) env.grain = grain;
      return env;
    }
    case 'ticket-rejected': {
      const { by, at, reason, registration, grain, ...rest } = fields;
      if (!by) return { kind: 'parse-error', reason: 'missing-by' };
      if (!at) return { kind: 'parse-error', reason: 'missing-at' };
      if (!isIso8601(at)) return { kind: 'parse-error', reason: 'bad-at' };
      if (!reason) return { kind: 'parse-error', reason: 'missing-reason' };
      if (Object.keys(rest).length > 0) {
        return { kind: 'parse-error', reason: `unknown-field:${Object.keys(rest)[0]}` };
      }
      const env: TicketRejectedEnvelope = { kind: 'ticket-rejected', by, at, reason };
      if (registration) env.registration = registration;
      if (grain) env.grain = grain;
      return env;
    }
    case 'ticket-expired': {
      const { at, registration, grain, ...rest } = fields;
      if (!at) return { kind: 'parse-error', reason: 'missing-at' };
      if (!isIso8601(at)) return { kind: 'parse-error', reason: 'bad-at' };
      if (Object.keys(rest).length > 0) {
        return { kind: 'parse-error', reason: `unknown-field:${Object.keys(rest)[0]}` };
      }
      const env: TicketExpiredEnvelope = { kind: 'ticket-expired', at };
      if (registration) env.registration = registration;
      if (grain) env.grain = grain;
      return env;
    }
    default:
      return { kind: 'parse-error', reason: `unknown-envelope:${head}` };
  }
}

export function isParseError(r: ParseResult): r is ParseError {
  return r.kind === 'parse-error';
}

function ensureNoSpace(name: string, value: string): void {
  if (/\s/.test(value)) throw new Error(`envelope field ${name} cannot contain whitespace`);
}

export type BuildTicketInput = {
  face: Face;
  scope: string;
  expires: string;
  tier?: Tier;
  seats?: number;
  nonce?: string;
};

export function buildTicket(input: BuildTicketInput): string {
  ensureNoSpace('scope', input.scope);
  ensureNoSpace('expires', input.expires);
  if (!isIso8601(input.expires)) throw new Error('expires must be ISO 8601 UTC');
  const parts = [`face=${input.face}`, `scope=${input.scope}`, `expires=${input.expires}`];
  if (input.tier) parts.push(`tier=${input.tier}`);
  if (input.seats !== undefined) {
    if (!Number.isInteger(input.seats) || input.seats < 1) throw new Error('seats must be a positive integer');
    parts.push(`seats=${input.seats}`);
  }
  if (input.nonce !== undefined) {
    ensureNoSpace('nonce', input.nonce);
    parts.push(`nonce=${input.nonce}`);
  }
  return `[ticket ${parts.join(' ')}]`;
}

export function buildRevoked(input: { at: string; reason: string }): string {
  ensureNoSpace('at', input.at);
  ensureNoSpace('reason', input.reason);
  if (!isIso8601(input.at)) throw new Error('at must be ISO 8601 UTC');
  return `[ticket-revoked at=${input.at} reason=${input.reason}]`;
}

function appendRefs(parts: string[], registration?: string, grain?: string): void {
  if (registration !== undefined) {
    ensureNoSpace('registration', registration);
    parts.push(`registration=${registration}`);
  }
  if (grain !== undefined) {
    ensureNoSpace('grain', grain);
    parts.push(`grain=${grain}`);
  }
}

export function buildVerified(input: { by: string; at: string; registration?: string; grain?: string }): string {
  ensureNoSpace('by', input.by);
  ensureNoSpace('at', input.at);
  if (!isIso8601(input.at)) throw new Error('at must be ISO 8601 UTC');
  const parts = [`by=${input.by}`, `at=${input.at}`];
  appendRefs(parts, input.registration, input.grain);
  return `[ticket-verified ${parts.join(' ')}]`;
}

export function buildRejected(input: { by: string; at: string; reason: string; registration?: string; grain?: string }): string {
  ensureNoSpace('by', input.by);
  ensureNoSpace('at', input.at);
  ensureNoSpace('reason', input.reason);
  if (!isIso8601(input.at)) throw new Error('at must be ISO 8601 UTC');
  const parts = [`by=${input.by}`, `at=${input.at}`, `reason=${input.reason}`];
  appendRefs(parts, input.registration, input.grain);
  return `[ticket-rejected ${parts.join(' ')}]`;
}

export function buildExpired(input: { at: string; registration?: string; grain?: string }): string {
  ensureNoSpace('at', input.at);
  if (!isIso8601(input.at)) throw new Error('at must be ISO 8601 UTC');
  const parts = [`at=${input.at}`];
  appendRefs(parts, input.registration, input.grain);
  return `[ticket-expired ${parts.join(' ')}]`;
}
