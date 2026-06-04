import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCtx, fakeMcpClient, type FakeMcpClient } from './helpers.js';
import { runOnce, isScopeCompatible } from '../src/lib/verifier.js';
import type { AppContext } from '../src/types.js';
import type { VerifierDecisionRow } from '../src/lib/db.js';
import { buildTicket, buildRevoked } from '../src/lib/envelope.js';

// ── helpers ─────────────────────────────────────────────────────────────

const ISSUER_BARE = 'tickets-test';
const COLLECTIVE = 'sed:test-cast';
const COLLECTIVE_NAME = 'test-cast';
const PAIR_ID = 'abc123def4567890';

// Place a registrant node at a logical position in the collective's digit-trie:
// position "11" → block["1"]["1"], "111" → block["1"]["1"]["1"]. Mirrors how the
// federated beach nests multi-digit positions in a whole-block read.
function placeAtPosition(block: Record<string, unknown>, position: string, node: unknown): void {
  const digits = position.split('');
  let t = block;
  for (let i = 0; i < digits.length - 1; i++) {
    const d = digits[i]!;
    if (typeof t[d] !== 'object' || t[d] === null) t[d] = {};
    t = t[d] as Record<string, unknown>;
  }
  t[digits[digits.length - 1]!] = node;
}

function setUpCollective(
  mcp: FakeMcpClient,
  opts: { face: string; scope: string; issuer: string; positions?: Record<string, unknown> },
): void {
  // Payway config lives at position 9 with numbered fields (payway §2.1) —
  // NOT a `_tickets` sibling key. Registrant positions nest in the digit-trie.
  const block: Record<string, unknown> = {
    _: 'cast for test',
    '9': {
      _: 'payway config',
      '1': opts.issuer,
      '2': 'https://tickets.test/buy/character-30d',
      '3': opts.face,
      '4': opts.scope,
    },
  };
  for (const [position, node] of Object.entries(opts.positions ?? {})) {
    placeAtPosition(block, position, node);
  }
  mcp.setBlock(`sed:${COLLECTIVE_NAME}`, COLLECTIVE_NAME, block);
}

function setUpGrain(
  mcp: FakeMcpClient,
  opts: { issuerSide: '1' | '2'; envelope: string; revocation?: string; issuerAgentId?: string },
): void {
  const partnerSide = opts.issuerSide === '1' ? '2' : '1';
  const sideContent: Record<string, unknown> = { _: opts.envelope };
  if (opts.revocation) sideContent['1'] = opts.revocation;
  mcp.setBlock(`grain:${PAIR_ID}`, 'grain', {
    _: 'test grain',
    [opts.issuerSide]: sideContent,
    [partnerSide]: { _: '' },
    '9': {
      [opts.issuerSide]: opts.issuerAgentId ?? ISSUER_BARE,
      [partnerSide]: 'brisa',
    },
  });
}

function makeRegistration(grain_ref: string): Record<string, unknown> {
  return { _: 'I am a buyer', '1': grain_ref };
}

function ctxWithCollective(): { ctx: AppContext; mcp: FakeMcpClient } {
  const mcp = fakeMcpClient();
  const ctx = fakeCtx({
    mcp,
    products: [
      {
        id: 'character-30d',
        sed: COLLECTIVE,
        face: 'character',
        scope: 'frame:test',
        duration_days: 30,
        description: 'test',
        price: { driver: 'stripe', stripe_price_id: 'price_x' },
      },
    ],
  });
  return { ctx, mcp };
}

function getDecision(ctx: AppContext, position: string): VerifierDecisionRow | undefined {
  return ctx.db
    .prepare('SELECT * FROM verifier_decisions WHERE collective = ? AND position = ? ORDER BY id DESC LIMIT 1')
    .get(COLLECTIVE, position) as VerifierDecisionRow | undefined;
}

const FUTURE = '2027-01-01T00:00:00Z';

// ── isScopeCompatible unit ──────────────────────────────────────────────

test('scope-compat: exact match', () => {
  assert.deepEqual(isScopeCompatible('frame:thornkeep-001', 'frame:thornkeep-001'), { ok: true });
});

test('scope-compat: prefix wildcard on ticket', () => {
  assert.deepEqual(isScopeCompatible('frame:thornkeep-*', 'frame:thornkeep-001'), { ok: true });
});

test('scope-compat: prefix wildcard mismatch', () => {
  const r = isScopeCompatible('frame:thornkeep-*', 'frame:other-001');
  assert.equal(r.ok, false);
});

test('scope-compat: beach scope flagged not-supported-yet', () => {
  const r = isScopeCompatible('beach:cyrus.gm.example', 'frame:thornkeep-001');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'beach-scope-not-supported-yet');
});

// ── runOnce: happy path + each rejection rule ──────────────────────────

test('verifier: open collective (no position-9 config) is skipped silently', async () => {
  const mcp = fakeMcpClient();
  const ctx = fakeCtx({
    mcp,
    products: [
      {
        id: 'p',
        sed: COLLECTIVE,
        face: 'character',
        scope: 'frame:test',
        duration_days: 30,
        description: 't',
        price: { driver: 'stripe', stripe_price_id: 'x' },
      },
    ],
  });
  mcp.setBlock(`sed:${COLLECTIVE_NAME}`, COLLECTIVE_NAME, {
    _: 'open',
    '1': { _: 'no ticket needed' },
  });
  const stats = await runOnce(ctx);
  assert.equal(stats.newPositions, 0);
  assert.equal(stats.verified, 0);
});

test('verifier: happy path → verified + audit entry', async () => {
  const { ctx, mcp } = ctxWithCollective();
  setUpCollective(mcp, {
    face: 'character',
    scope: 'frame:test',
    issuer: 'agent:tickets-test',
    positions: { '11': makeRegistration(`grain:${PAIR_ID}:1`) },
  });
  setUpGrain(mcp, {
    issuerSide: '1',
    envelope: buildTicket({ face: 'character', scope: 'frame:test', expires: FUTURE }),
  });
  const stats = await runOnce(ctx);
  assert.equal(stats.verified, 1);
  assert.equal(stats.rejected, 0);

  const row = getDecision(ctx, '11')!;
  assert.equal(row.decision, 'verified');
  assert.equal(row.audit_block, 'tickets-test-audit-' + new Date().toISOString().slice(0, 7));
  assert.match(row.envelope, /^\[ticket-verified by=agent:tickets-test/);
  assert.match(row.envelope, /registration=sed:test-cast:11/);
  assert.match(row.envelope, new RegExp(`grain=grain:${PAIR_ID}:1`));
});

test('verifier: rule 1 rejection — grain not established', async () => {
  const { ctx, mcp } = ctxWithCollective();
  setUpCollective(mcp, {
    face: 'character',
    scope: 'frame:test',
    issuer: 'agent:tickets-test',
    positions: { '11': makeRegistration(`grain:${PAIR_ID}:1`) },
  });
  // Don't set up the grain — walk returns empty.
  const stats = await runOnce(ctx);
  assert.equal(stats.rejected, 1);
  const row = getDecision(ctx, '11')!;
  assert.equal(row.decision, 'rejected');
  assert.equal(row.reason, 'grain-not-established');
});

test('verifier: rule 2 rejection — no [ticket] envelope on side', async () => {
  const { ctx, mcp } = ctxWithCollective();
  setUpCollective(mcp, {
    face: 'character',
    scope: 'frame:test',
    issuer: 'agent:tickets-test',
    positions: { '11': makeRegistration(`grain:${PAIR_ID}:1`) },
  });
  // Side has agent_id but no ticket envelope (random text instead).
  mcp.setBlock(`grain:${PAIR_ID}`, 'grain', {
    '1': { _: 'just a description, no envelope' },
    '9': { '1': ISSUER_BARE, '2': 'brisa' },
  });
  const stats = await runOnce(ctx);
  assert.equal(stats.rejected, 1);
  assert.equal(getDecision(ctx, '11')!.reason, 'malformed-envelope');
});

test('verifier: rule 3 rejection — face mismatch', async () => {
  const { ctx, mcp } = ctxWithCollective();
  setUpCollective(mcp, {
    face: 'character',
    scope: 'frame:test',
    issuer: 'agent:tickets-test',
    positions: { '11': makeRegistration(`grain:${PAIR_ID}:1`) },
  });
  setUpGrain(mcp, {
    issuerSide: '1',
    envelope: buildTicket({ face: 'designer', scope: 'frame:test', expires: FUTURE }),
  });
  await runOnce(ctx);
  assert.equal(getDecision(ctx, '11')!.reason, 'face-mismatch');
});

test('verifier: rule 4 rejection — scope mismatch', async () => {
  const { ctx, mcp } = ctxWithCollective();
  setUpCollective(mcp, {
    face: 'character',
    scope: 'frame:test',
    issuer: 'agent:tickets-test',
    positions: { '11': makeRegistration(`grain:${PAIR_ID}:1`) },
  });
  setUpGrain(mcp, {
    issuerSide: '1',
    envelope: buildTicket({ face: 'character', scope: 'frame:other', expires: FUTURE }),
  });
  await runOnce(ctx);
  assert.equal(getDecision(ctx, '11')!.reason, 'scope-mismatch');
});

test('verifier: rule 4 prefix wildcard accepted', async () => {
  const { ctx, mcp } = ctxWithCollective();
  setUpCollective(mcp, {
    face: 'character',
    scope: 'frame:thornkeep-001',
    issuer: 'agent:tickets-test',
    positions: { '11': makeRegistration(`grain:${PAIR_ID}:1`) },
  });
  setUpGrain(mcp, {
    issuerSide: '1',
    envelope: buildTicket({ face: 'character', scope: 'frame:thornkeep-*', expires: FUTURE }),
  });
  await runOnce(ctx);
  assert.equal(getDecision(ctx, '11')!.decision, 'verified');
});

test('verifier: rule 5 rejection — already expired at first look', async () => {
  const { ctx, mcp } = ctxWithCollective();
  setUpCollective(mcp, {
    face: 'character',
    scope: 'frame:test',
    issuer: 'agent:tickets-test',
    positions: { '11': makeRegistration(`grain:${PAIR_ID}:1`) },
  });
  setUpGrain(mcp, {
    issuerSide: '1',
    envelope: buildTicket({ face: 'character', scope: 'frame:test', expires: '2020-01-01T00:00:00Z' }),
  });
  await runOnce(ctx);
  assert.equal(getDecision(ctx, '11')!.reason, 'expired');
});

test('verifier: rule 6 rejection — revoked', async () => {
  const { ctx, mcp } = ctxWithCollective();
  setUpCollective(mcp, {
    face: 'character',
    scope: 'frame:test',
    issuer: 'agent:tickets-test',
    positions: { '11': makeRegistration(`grain:${PAIR_ID}:1`) },
  });
  setUpGrain(mcp, {
    issuerSide: '1',
    envelope: buildTicket({ face: 'character', scope: 'frame:test', expires: FUTURE }),
    revocation: buildRevoked({ at: '2026-04-01T00:00:00Z', reason: 'refund' }),
  });
  await runOnce(ctx);
  assert.equal(getDecision(ctx, '11')!.reason, 'revoked');
});

test('verifier: rule 7 rejection — issuer mismatch', async () => {
  const { ctx, mcp } = ctxWithCollective();
  setUpCollective(mcp, {
    face: 'character',
    scope: 'frame:test',
    issuer: 'agent:tickets-test',
    positions: { '11': makeRegistration(`grain:${PAIR_ID}:1`) },
  });
  setUpGrain(mcp, {
    issuerSide: '1',
    envelope: buildTicket({ face: 'character', scope: 'frame:test', expires: FUTURE }),
    issuerAgentId: 'someone-else',
  });
  await runOnce(ctx);
  assert.equal(getDecision(ctx, '11')!.reason, 'issuer-mismatch');
});

test('verifier: rule 8 rejection — credits= field reserved', async () => {
  const { ctx, mcp } = ctxWithCollective();
  setUpCollective(mcp, {
    face: 'character',
    scope: 'frame:test',
    issuer: 'agent:tickets-test',
    positions: { '11': makeRegistration(`grain:${PAIR_ID}:1`) },
  });
  // Manually craft envelope with credits= since builder doesn't permit it.
  mcp.setBlock(`grain:${PAIR_ID}`, 'grain', {
    '1': { _: '[ticket face=character scope=frame:test expires=' + FUTURE + ' credits=10]' },
    '9': { '1': ISSUER_BARE, '2': 'brisa' },
  });
  await runOnce(ctx);
  assert.equal(getDecision(ctx, '11')!.reason, 'credits-not-supported');
});

test('verifier: position without ticket_grain ref is skipped', async () => {
  const { ctx, mcp } = ctxWithCollective();
  setUpCollective(mcp, {
    face: 'character',
    scope: 'frame:test',
    issuer: 'agent:tickets-test',
    positions: { '11': { _: 'I am a buyer with no ticket' } },
  });
  const stats = await runOnce(ctx);
  assert.equal(stats.newPositions, 0);
  assert.equal(getDecision(ctx, '11'), undefined);
});

test('verifier: idempotent — second tick does not re-process verified row', async () => {
  const { ctx, mcp } = ctxWithCollective();
  setUpCollective(mcp, {
    face: 'character',
    scope: 'frame:test',
    issuer: 'agent:tickets-test',
    positions: { '11': makeRegistration(`grain:${PAIR_ID}:1`) },
  });
  setUpGrain(mcp, {
    issuerSide: '1',
    envelope: buildTicket({ face: 'character', scope: 'frame:test', expires: FUTURE }),
  });
  const a = await runOnce(ctx);
  assert.equal(a.verified, 1);
  const b = await runOnce(ctx);
  assert.equal(b.newPositions, 0);
  assert.equal(b.verified, 0);
});

test('verifier: expiry sweep writes [ticket-expired] after expires_at passes', async () => {
  const { ctx, mcp } = ctxWithCollective();
  const expiresSoon = new Date(Date.now() + 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
  setUpCollective(mcp, {
    face: 'character',
    scope: 'frame:test',
    issuer: 'agent:tickets-test',
    positions: { '11': makeRegistration(`grain:${PAIR_ID}:1`) },
  });
  setUpGrain(mcp, {
    issuerSide: '1',
    envelope: buildTicket({ face: 'character', scope: 'frame:test', expires: expiresSoon }),
  });
  await runOnce(ctx);
  // First decision is verified.
  const verified = ctx.db
    .prepare("SELECT * FROM verifier_decisions WHERE collective = ? AND position = ? AND decision = 'verified'")
    .get(COLLECTIVE, '11') as VerifierDecisionRow | undefined;
  assert.ok(verified);

  // Run again "in the future" — past the ticket's expires.
  const future = new Date(Date.parse(expiresSoon) + 60_000);
  await runOnce(ctx, future);

  const expired = ctx.db
    .prepare("SELECT * FROM verifier_decisions WHERE collective = ? AND position = ? AND decision = 'expired'")
    .get(COLLECTIVE, '11') as VerifierDecisionRow | undefined;
  assert.ok(expired, 'expected an expired decision row');
  assert.match(expired!.envelope, /^\[ticket-expired/);
  assert.match(expired!.envelope, /registration=sed:test-cast:11/);
});

test('verifier: collective walk failure is caught and logged', async () => {
  const { ctx, mcp } = ctxWithCollective();
  mcp.setResponse('bsp', () => {
    throw new Error('boom');
  });
  const stats = await runOnce(ctx);
  assert.equal(stats.errors, 1);
});

test('verifier: revocation sweep — verified row whose grain was revoked emits a fresh [ticket-rejected reason=revoked]', async () => {
  const { ctx, mcp } = ctxWithCollective();
  setUpCollective(mcp, {
    face: 'character',
    scope: 'frame:test',
    issuer: 'agent:tickets-test',
    positions: { '11': makeRegistration(`grain:${PAIR_ID}:1`) },
  });
  setUpGrain(mcp, {
    issuerSide: '1',
    envelope: buildTicket({ face: 'character', scope: 'frame:test', expires: FUTURE }),
  });
  // First tick → verified.
  let stats = await runOnce(ctx);
  assert.equal(stats.verified, 1);
  assert.equal(stats.rejected, 0);

  // Now revoke the grain on the substrate.
  setUpGrain(mcp, {
    issuerSide: '1',
    envelope: buildTicket({ face: 'character', scope: 'frame:test', expires: FUTURE }),
    revocation: buildRevoked({ at: '2026-05-15T12:00:00Z', reason: 'admin-refund' }),
  });

  // Second tick — same registration, but now the grain shows revocation.
  stats = await runOnce(ctx);
  assert.equal(stats.verified, 0, 'should not re-verify the same position');
  assert.equal(stats.rejected, 1, 'should emit one new rejected decision for the verified→revoked transition');

  const decisions = ctx.db
    .prepare('SELECT * FROM verifier_decisions WHERE collective = ? AND position = ? ORDER BY id ASC')
    .all(COLLECTIVE, '11') as VerifierDecisionRow[];
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0]!.decision, 'verified');
  assert.equal(decisions[1]!.decision, 'rejected');
  assert.equal(decisions[1]!.reason, 'revoked');
  assert.match(decisions[1]!.envelope, /^\[ticket-rejected /);
  assert.match(decisions[1]!.envelope, /reason=revoked/);
  assert.match(decisions[1]!.envelope, /registration=sed:test-cast:11/);

  // Third tick — should be idempotent; no further decisions written.
  stats = await runOnce(ctx);
  assert.equal(stats.verified, 0);
  assert.equal(stats.rejected, 0);
  const after = ctx.db
    .prepare('SELECT count(*) as n FROM verifier_decisions WHERE collective = ? AND position = ?')
    .get(COLLECTIVE, '11') as { n: number };
  assert.equal(after.n, 2);
});

test('verifier: revocation sweep skips rows where grain has no revocation', async () => {
  const { ctx, mcp } = ctxWithCollective();
  setUpCollective(mcp, {
    face: 'character',
    scope: 'frame:test',
    issuer: 'agent:tickets-test',
    positions: { '11': makeRegistration(`grain:${PAIR_ID}:1`) },
  });
  setUpGrain(mcp, {
    issuerSide: '1',
    envelope: buildTicket({ face: 'character', scope: 'frame:test', expires: FUTURE }),
  });
  await runOnce(ctx);

  // Tick again with no revocation — nothing new should be written.
  const stats = await runOnce(ctx);
  assert.equal(stats.rejected, 0);
  assert.equal(stats.expired, 0);
  const count = ctx.db
    .prepare('SELECT count(*) as n FROM verifier_decisions WHERE collective = ? AND position = ?')
    .get(COLLECTIVE, '11') as { n: number };
  assert.equal(count.n, 1);
});
