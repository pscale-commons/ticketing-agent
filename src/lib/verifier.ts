// Verifier daemon — watches configured sed: collectives, applies the
// canonical eight-rule check from payway.md §2.4 to each new
// ticketed registration, writes a [ticket-verified|rejected|expired]
// envelope to the public audit log, and records the decision in SQLite
// so we don't reprocess.
//
// Per CLAUDE.md: eight `if`s in one function. No rules engine.
//
// Per CLAUDE.md: do NOT cache bsp() reads beyond a single tick. Each tick
// re-reads the collective fresh.
//
// Per CLAUDE.md: ticket truth lives on the substrate. SQLite holds local
// state ("which positions have we processed") only.
//
// PROTOCOL DEVIATION (sub-question 5 — pending bsp-mcp-server pin):
// §2.3 says the verifier writes the [ticket-verified] envelope "onto the
// registration". The current sed: lock model write-locks each position
// to the registrant's passphrase, so a foreign agent cannot write to a
// registrant's position or its children. The audit log on the verifier's
// own beach is the canonical destination instead. The envelope carries
// `registration=sed:<collective>:<position>` and `grain=grain:<pair>:<side>`
// fields (extension over §2.3 grammar) so synthesis daemons and external
// observers can correlate.

import { parseEnvelope, isParseError, buildVerified, buildRejected, buildExpired } from './envelope.js';
import { walkGrain } from './grain.js';
import { parseWholeBlock } from './pscale.js';
import { appendDecision } from './audit.js';
import type { AppContext } from '../types.js';
import type { VerifierDecisionRow } from './db.js';

export type RunStats = {
  collectives: number;
  newPositions: number;
  verified: number;
  rejected: number;
  expired: number;
  errors: number;
};

type TicketsMeta = {
  issuer: string;
  face: string;
  scope: string;
  verifier?: string;
  purchase_url?: string;
};

const GRAIN_REF_RE = /^grain:([a-f0-9]{16}):([12])$/;

function bareAgent(id: string | null | undefined): string {
  if (!id) return '';
  return id.startsWith('agent:') ? id.slice('agent:'.length) : id;
}

function nowIso(now: Date): string {
  return now.toISOString().replace(/\.\d+Z$/, 'Z');
}

// Scope compatibility per §2.4 rule 4. Three forms supported:
//   - exact match
//   - ticket scope ends with '*' → prefix match against collective scope
//   - beach scope (`beach:X`) → not yet implemented in v1; flagged as
//     `beach-scope-not-supported-yet` so it's visible in audit logs and
//     the bsp-mcp-server session can decide on the canonical resolution.
export function isScopeCompatible(ticket_scope: string, collective_scope: string): { ok: true } | { ok: false; reason: string } {
  if (ticket_scope === collective_scope) return { ok: true };
  if (ticket_scope.endsWith('*')) {
    const prefix = ticket_scope.slice(0, -1);
    if (collective_scope.startsWith(prefix)) return { ok: true };
    return { ok: false, reason: 'scope-mismatch' };
  }
  if (ticket_scope.startsWith('beach:')) {
    // Frame-host lookup not implemented in v1.
    return { ok: false, reason: 'beach-scope-not-supported-yet' };
  }
  return { ok: false, reason: 'scope-mismatch' };
}

// Walk the collective's digit-trie and collect every registrant position that
// carries a ticket-grain reference at its digit-1 child. On the federated
// substrate a whole-block read nests multi-digit positions as a trie —
// position "11" is block["1"]["1"], "111" is block["1"]["1"]["1"]. A registrant
// node is { _: <declaration>, 1: "grain:<pair>:<side>" } per payway §2.3 Step A
// (canonical shape: the registrant overwrites its whole position with that
// object; the spec's `<position>.1` child addressing is invalid on the
// floor-anchored substrate). Position 9 (payway config) is excluded naturally —
// its child 1 is `agent:<issuer>`, not a grain ref.
type Registration = { position: string; grain_ref: string };

function collectRegistrations(block: Record<string, unknown>): Registration[] {
  const out: Registration[] = [];
  const descend = (node: unknown, path: string[]): void => {
    if (typeof node !== 'object' || node === null) return;
    const obj = node as Record<string, unknown>;
    const ref = obj['1'];
    if (typeof ref === 'string' && GRAIN_REF_RE.test(ref)) {
      out.push({ position: path.join(''), grain_ref: ref });
      return; // a registrant node is a leaf for our purposes — don't recurse
    }
    for (let d = 1; d <= 9; d++) {
      const child = obj[String(d)];
      if (child !== undefined) descend(child, [...path, String(d)]);
    }
  };
  for (let d = 1; d <= 9; d++) {
    const child = block[String(d)];
    if (child !== undefined) descend(child, [String(d)]);
  }
  return out;
}

// Payway config sub-block at the collective's position 9 (payway §2.1):
// numbered fields {1:issuer, 2:purchase_url, 3:face, 4:scope, 5:verifier}.
// NOT a `_tickets` sibling key — sibling keys are invisible to bsp() on the
// federated substrate, which walks only `_` and digits 1-9.
function parseTicketsMeta(config: unknown): TicketsMeta | null {
  if (typeof config !== 'object' || config === null) return null;
  const t = config as Record<string, unknown>;
  if (typeof t['1'] !== 'string' || typeof t['3'] !== 'string' || typeof t['4'] !== 'string') return null;
  const meta: TicketsMeta = { issuer: t['1'], face: t['3'], scope: t['4'] };
  if (typeof t['5'] === 'string') meta.verifier = t['5'];
  if (typeof t['2'] === 'string') meta.purchase_url = t['2'];
  return meta;
}

const parseWholeBlockText = (text: string): Record<string, unknown> | null => parseWholeBlock(text);

// ── runOnce ──────────────────────────────────────────────────────────────

export async function runOnce(ctx: AppContext, now: Date = new Date()): Promise<RunStats> {
  const stats: RunStats = { collectives: 0, newPositions: 0, verified: 0, rejected: 0, expired: 0, errors: 0 };
  const watched = (
    ctx.config.verifier?.watch ?? Array.from(new Set(ctx.config.products.map((p) => p.sed)))
  ).filter((s) => s.startsWith('sed:'));

  for (const collectiveAddr of watched) {
    stats.collectives++;
    try {
      await processCollective(ctx, collectiveAddr, now, stats);
    } catch (err) {
      ctx.log.error(
        { collective: collectiveAddr, err: (err as Error).message },
        'verifier: collective tick failed',
      );
      stats.errors++;
    }
  }

  await runRevocationSweep(ctx, now, stats);
  await runExpirySweep(ctx, now, stats);
  return stats;
}

async function processCollective(
  ctx: AppContext,
  collectiveAddr: string,
  now: Date,
  stats: RunStats,
): Promise<void> {
  const name = collectiveAddr.startsWith('sed:') ? collectiveAddr.slice('sed:'.length) : collectiveAddr;
  const text = await ctx.mcp.callTool('bsp', {
    agent_id: `sed:${name}`,
    block: name,
    spindle: null,
    pscale_attention: null,
  });
  const block = parseWholeBlockText(text);
  if (!block) {
    ctx.log.warn({ collective: collectiveAddr }, 'verifier: could not parse collective block');
    return;
  }
  const tickets = parseTicketsMeta(block['9']);
  if (!tickets) {
    // Open collective (no payway config at position 9) — nothing to verify.
    return;
  }

  for (const { position, grain_ref } of collectRegistrations(block)) {
    const seen = ctx.db
      .prepare('SELECT 1 AS x FROM verifier_decisions WHERE collective = ? AND position = ? LIMIT 1')
      .get(collectiveAddr, position) as { x: number } | undefined;
    if (seen) continue;

    stats.newPositions++;
    try {
      await processOne(ctx, collectiveAddr, position, grain_ref, tickets, now, stats);
    } catch (err) {
      ctx.log.error(
        { collective: collectiveAddr, position, grain_ref, err: (err as Error).message },
        'verifier: position processing failed',
      );
      stats.errors++;
    }
  }
}

async function processOne(
  ctx: AppContext,
  collectiveAddr: string,
  position: string,
  grain_ref: string,
  tickets: TicketsMeta,
  now: Date,
  stats: RunStats,
): Promise<void> {
  const registration_ref = `${collectiveAddr}:${position}`;
  const m = GRAIN_REF_RE.exec(grain_ref);
  if (!m) {
    await rejectAndAudit(ctx, collectiveAddr, position, grain_ref, registration_ref, 'malformed-grain-ref', now, stats);
    return;
  }
  const pair_id = m[1]!;
  const claimed_issuer_side = m[2]! as '1' | '2';

  const grain = await walkGrain({ client: ctx.mcp, pair_id });
  const sideContent = grain.sides[claimed_issuer_side];

  // Rule 1 — grain established on the claimed side.
  if (!grain.agents[claimed_issuer_side]) {
    await rejectAndAudit(ctx, collectiveAddr, position, grain_ref, registration_ref, 'grain-not-established', now, stats);
    return;
  }

  // Rule 2 — has a [ticket ...] envelope.
  if (!sideContent.envelope) {
    await rejectAndAudit(ctx, collectiveAddr, position, grain_ref, registration_ref, 'no-ticket-envelope', now, stats);
    return;
  }
  const parsed = parseEnvelope(sideContent.envelope);
  if (isParseError(parsed) || parsed.kind !== 'ticket') {
    await rejectAndAudit(ctx, collectiveAddr, position, grain_ref, registration_ref, 'malformed-envelope', now, stats);
    return;
  }

  // Rule 3 — face matches.
  if (parsed.face !== tickets.face) {
    await rejectAndAudit(ctx, collectiveAddr, position, grain_ref, registration_ref, 'face-mismatch', now, stats);
    return;
  }

  // Rule 4 — scope compatible.
  const scope = isScopeCompatible(parsed.scope, tickets.scope);
  if (!scope.ok) {
    await rejectAndAudit(ctx, collectiveAddr, position, grain_ref, registration_ref, scope.reason, now, stats);
    return;
  }

  // Rule 5 — not expired.
  const expiresMs = Date.parse(parsed.expires);
  if (Number.isFinite(expiresMs) && expiresMs <= now.getTime()) {
    await rejectAndAudit(ctx, collectiveAddr, position, grain_ref, registration_ref, 'expired', now, stats);
    return;
  }

  // Rule 6 — no later [ticket-revoked] envelope on the issuer side.
  if (sideContent.revocations.length > 0) {
    await rejectAndAudit(ctx, collectiveAddr, position, grain_ref, registration_ref, 'revoked', now, stats);
    return;
  }

  // Rule 7 — grain established by the payway config issuer (9.1).
  if (bareAgent(grain.agents[claimed_issuer_side]) !== bareAgent(tickets.issuer)) {
    await rejectAndAudit(ctx, collectiveAddr, position, grain_ref, registration_ref, 'issuer-mismatch', now, stats);
    return;
  }

  // Rule 8 — no `credits=` field.
  if (parsed.hasCredits) {
    await rejectAndAudit(ctx, collectiveAddr, position, grain_ref, registration_ref, 'credits-not-supported', now, stats);
    return;
  }

  // All eight rules pass.
  await verifyAndAudit(ctx, collectiveAddr, position, grain_ref, registration_ref, parsed.expires, now, stats);
}

// ── decision writers ────────────────────────────────────────────────────

async function verifyAndAudit(
  ctx: AppContext,
  collectiveAddr: string,
  position: string,
  grain_ref: string,
  registration_ref: string,
  expires_at: string,
  now: Date,
  stats: RunStats,
): Promise<void> {
  const envelope = buildVerified({
    by: ctx.config.agent.id,
    at: nowIso(now),
    registration: registration_ref,
    grain: grain_ref,
  });
  const audit = await appendDecision({
    client: ctx.mcp,
    ticketAgentSecret: ctx.env.TICKET_AGENT_SECRET,
    verifier_bare_id: bareAgent(ctx.config.agent.id),
    envelope,
    date: now,
  });
  ctx.db
    .prepare(
      `INSERT OR IGNORE INTO verifier_decisions
       (collective, position, decision, reason, grain_ref, envelope, audit_block, audit_position, decided_at, expires_at)
       VALUES (?, ?, 'verified', NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(collectiveAddr, position, grain_ref, envelope, audit.audit_block, audit.audit_position, now.toISOString(), expires_at);
  stats.verified++;
  ctx.log.info(
    { registration: registration_ref, grain: grain_ref, audit: `sed:${audit.audit_block}:${audit.audit_position}` },
    'verifier: verified',
  );
}

async function rejectAndAudit(
  ctx: AppContext,
  collectiveAddr: string,
  position: string,
  grain_ref: string,
  registration_ref: string,
  reason: string,
  now: Date,
  stats: RunStats,
): Promise<void> {
  const envelope = buildRejected({
    by: ctx.config.agent.id,
    at: nowIso(now),
    reason,
    registration: registration_ref,
    grain: grain_ref,
  });
  const audit = await appendDecision({
    client: ctx.mcp,
    ticketAgentSecret: ctx.env.TICKET_AGENT_SECRET,
    verifier_bare_id: bareAgent(ctx.config.agent.id),
    envelope,
    date: now,
  });
  ctx.db
    .prepare(
      `INSERT OR IGNORE INTO verifier_decisions
       (collective, position, decision, reason, grain_ref, envelope, audit_block, audit_position, decided_at, expires_at)
       VALUES (?, ?, 'rejected', ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(collectiveAddr, position, reason, grain_ref, envelope, audit.audit_block, audit.audit_position, now.toISOString());
  stats.rejected++;
  ctx.log.info(
    { registration: registration_ref, grain: grain_ref, reason, audit: `sed:${audit.audit_block}:${audit.audit_position}` },
    'verifier: rejected',
  );
}

async function expireAndAudit(
  ctx: AppContext,
  row: VerifierDecisionRow,
  now: Date,
  stats: RunStats,
): Promise<void> {
  const envelope = buildExpired({
    at: nowIso(now),
    registration: `${row.collective}:${row.position}`,
    grain: row.grain_ref ?? '',
  });
  const audit = await appendDecision({
    client: ctx.mcp,
    ticketAgentSecret: ctx.env.TICKET_AGENT_SECRET,
    verifier_bare_id: bareAgent(ctx.config.agent.id),
    envelope,
    date: now,
  });
  ctx.db
    .prepare(
      `INSERT OR IGNORE INTO verifier_decisions
       (collective, position, decision, reason, grain_ref, envelope, audit_block, audit_position, decided_at, expires_at)
       VALUES (?, ?, 'expired', 'ticket-expired', ?, ?, ?, ?, ?, NULL)`,
    )
    .run(row.collective, row.position, row.grain_ref, envelope, audit.audit_block, audit.audit_position, now.toISOString());
  stats.expired++;
  ctx.log.info(
    { registration: `${row.collective}:${row.position}`, grain: row.grain_ref, audit: `sed:${audit.audit_block}:${audit.audit_position}` },
    'verifier: expired',
  );
}

// ── revocation sweep ────────────────────────────────────────────────────
//
// Catches the verified→revoked transition. For every previously-verified
// (collective, position) row that doesn't yet have a rejected/expired
// counterpart, walk its grain; if a [ticket-revoked] envelope has appeared,
// emit a fresh [ticket-rejected reason=revoked] audit entry so external
// readers see the change. Idempotent because once we've emitted a 'rejected'
// row the next sweep's NOT EXISTS filter excludes this position.

async function runRevocationSweep(ctx: AppContext, now: Date, stats: RunStats): Promise<void> {
  const rows = ctx.db
    .prepare(
      `SELECT * FROM verifier_decisions vd
       WHERE vd.decision = 'verified'
         AND NOT EXISTS (
           SELECT 1 FROM verifier_decisions vd2
           WHERE vd2.collective = vd.collective
             AND vd2.position = vd.position
             AND vd2.decision IN ('rejected', 'expired')
         )`,
    )
    .all() as VerifierDecisionRow[];

  for (const row of rows) {
    if (!row.grain_ref) continue;
    const m = GRAIN_REF_RE.exec(row.grain_ref);
    if (!m) continue;
    const pair_id = m[1]!;
    const claimed_issuer_side = m[2]! as '1' | '2';

    let walked;
    try {
      walked = await walkGrain({ client: ctx.mcp, pair_id });
    } catch (err) {
      ctx.log.error(
        { collective: row.collective, position: row.position, err: (err as Error).message },
        'verifier: revocation sweep walk failed',
      );
      stats.errors++;
      continue;
    }

    if (walked.sides[claimed_issuer_side].revocations.length === 0) continue;

    try {
      await rejectAndAudit(
        ctx,
        row.collective,
        row.position,
        row.grain_ref,
        `${row.collective}:${row.position}`,
        'revoked',
        now,
        stats,
      );
    } catch (err) {
      ctx.log.error(
        { collective: row.collective, position: row.position, err: (err as Error).message },
        'verifier: revocation audit write failed',
      );
      stats.errors++;
    }
  }
}

// ── expiry sweep ────────────────────────────────────────────────────────

async function runExpirySweep(ctx: AppContext, now: Date, stats: RunStats): Promise<void> {
  const rows = ctx.db
    .prepare(
      `SELECT * FROM verifier_decisions vd
       WHERE vd.decision = 'verified'
         AND vd.expires_at IS NOT NULL
         AND vd.expires_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM verifier_decisions vd2
           WHERE vd2.collective = vd.collective
             AND vd2.position = vd.position
             AND vd2.decision = 'expired'
         )`,
    )
    .all(now.toISOString()) as VerifierDecisionRow[];

  for (const row of rows) {
    try {
      const renewed = await renewedExpiry(ctx, row, now);
      if (renewed) {
        // A subscription renewal re-reached the grain with a later expiry:
        // carry the verified decision forward rather than expire it.
        ctx.db
          .prepare(
            "UPDATE verifier_decisions SET expires_at = ? WHERE collective = ? AND position = ? AND decision = 'verified'",
          )
          .run(renewed, row.collective, row.position);
        continue;
      }
      await expireAndAudit(ctx, row, now, stats);
    } catch (err) {
      ctx.log.error(
        { collective: row.collective, position: row.position, err: (err as Error).message },
        'verifier: expiry write failed',
      );
      stats.errors++;
    }
  }
}

// The grain's current expiry when it lies beyond now (the ticket was
// renewed since it was verified), else null.
async function renewedExpiry(ctx: AppContext, row: VerifierDecisionRow, now: Date): Promise<string | null> {
  if (!row.grain_ref) return null;
  const m = GRAIN_REF_RE.exec(row.grain_ref);
  if (!m) return null;
  const walked = await walkGrain({ client: ctx.mcp, pair_id: m[1]! });
  const envelope = walked.sides[m[2]! as '1' | '2'].envelope;
  if (!envelope) return null;
  const parsed = parseEnvelope(envelope);
  if (isParseError(parsed) || parsed.kind !== 'ticket') return null;
  const ms = Date.parse(parsed.expires);
  return Number.isFinite(ms) && ms > now.getTime() ? parsed.expires : null;
}

// ── start/stop ──────────────────────────────────────────────────────────

export type VerifierHandle = { stop: () => void };

export function start(ctx: AppContext): VerifierHandle {
  const intervalMs = (ctx.config.verifier?.poll_interval_seconds ?? 5) * 1000;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const stats = await runOnce(ctx);
      if (stats.newPositions > 0 || stats.expired > 0) {
        ctx.log.info({ stats }, 'verifier tick');
      } else {
        ctx.log.debug({ stats }, 'verifier tick (idle)');
      }
    } catch (err) {
      ctx.log.error({ err: (err as Error).message }, 'verifier tick threw');
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  timer = setTimeout(tick, intervalMs);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
