import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEnvelope,
  isParseError,
  buildTicket,
  buildRevoked,
  buildVerified,
  buildRejected,
  buildExpired,
} from '../src/lib/envelope.js';

// ── round-trip: build → parse → equality on the structural fields ──

test('ticket: minimal round-trip', () => {
  const text = buildTicket({
    face: 'character',
    scope: 'frame:scene-001',
    expires: '2026-06-01T00:00:00Z',
  });
  assert.equal(text, '[ticket face=character scope=frame:scene-001 expires=2026-06-01T00:00:00Z]');
  const parsed = parseEnvelope(text);
  assert.deepEqual(parsed, {
    kind: 'ticket',
    face: 'character',
    scope: 'frame:scene-001',
    expires: '2026-06-01T00:00:00Z',
    hasCredits: false,
  });
});

test('ticket: all optional fields round-trip', () => {
  const text = buildTicket({
    face: 'designer',
    scope: 'frame:*',
    expires: '2026-12-31T23:59:59Z',
    tier: 'hard',
    seats: 4,
    nonce: 'abc-123',
  });
  const parsed = parseEnvelope(text);
  assert.deepEqual(parsed, {
    kind: 'ticket',
    face: 'designer',
    scope: 'frame:*',
    expires: '2026-12-31T23:59:59Z',
    tier: 'hard',
    seats: 4,
    nonce: 'abc-123',
    hasCredits: false,
  });
});

test('ticket: beach scope', () => {
  const parsed = parseEnvelope('[ticket face=author scope=beach:cyrus.gm.example expires=2026-09-01T00:00:00Z]');
  assert.equal(parsed.kind, 'ticket');
});

test('ticket: credits= reserved field is parsed but flagged', () => {
  // Per protocol §2.4 rule 8: v1 verifiers MUST reject credit-bearing grains.
  const parsed = parseEnvelope('[ticket face=character scope=frame:x expires=2026-06-01T00:00:00Z credits=10]');
  assert.equal(parsed.kind, 'ticket');
  if (parsed.kind === 'ticket') {
    assert.equal(parsed.hasCredits, true);
  }
});

test('ticket: missing required fields rejected', () => {
  assert.equal(parseEnvelope('[ticket scope=frame:x expires=2026-06-01T00:00:00Z]').kind, 'parse-error');
  assert.equal(parseEnvelope('[ticket face=character expires=2026-06-01T00:00:00Z]').kind, 'parse-error');
  assert.equal(parseEnvelope('[ticket face=character scope=frame:x]').kind, 'parse-error');
});

test('ticket: bad face rejected', () => {
  // observer is not a valid face for issued tickets (payway-gated sed: collectives are character/author/designer per §0)
  const parsed = parseEnvelope('[ticket face=observer scope=frame:x expires=2026-06-01T00:00:00Z]');
  assert.ok(isParseError(parsed));
  assert.match((parsed as { reason: string }).reason, /bad-face/);
});

test('ticket: bad expires (non-ISO) rejected', () => {
  const parsed = parseEnvelope('[ticket face=character scope=frame:x expires=2026-06-01]');
  assert.ok(isParseError(parsed));
});

test('ticket: bad tier rejected', () => {
  const parsed = parseEnvelope('[ticket face=character scope=frame:x expires=2026-06-01T00:00:00Z tier=ultra]');
  assert.ok(isParseError(parsed));
});

test('ticket: unknown field rejected', () => {
  const parsed = parseEnvelope('[ticket face=character scope=frame:x expires=2026-06-01T00:00:00Z bogus=1]');
  assert.ok(isParseError(parsed));
});

test('ticket-revoked: round-trip', () => {
  const text = buildRevoked({ at: '2026-05-15T10:00:00Z', reason: 'refund' });
  assert.equal(text, '[ticket-revoked at=2026-05-15T10:00:00Z reason=refund]');
  const parsed = parseEnvelope(text);
  assert.deepEqual(parsed, { kind: 'ticket-revoked', at: '2026-05-15T10:00:00Z', reason: 'refund' });
});

test('ticket-verified: round-trip', () => {
  const text = buildVerified({ by: 'agent:tickets-test', at: '2026-05-01T12:00:00Z' });
  const parsed = parseEnvelope(text);
  assert.deepEqual(parsed, { kind: 'ticket-verified', by: 'agent:tickets-test', at: '2026-05-01T12:00:00Z' });
});

test('ticket-rejected: round-trip', () => {
  const text = buildRejected({
    by: 'agent:tickets-test',
    at: '2026-05-01T12:00:00Z',
    reason: 'expired',
  });
  const parsed = parseEnvelope(text);
  assert.deepEqual(parsed, {
    kind: 'ticket-rejected',
    by: 'agent:tickets-test',
    at: '2026-05-01T12:00:00Z',
    reason: 'expired',
  });
});

test('ticket-expired: round-trip', () => {
  const text = buildExpired({ at: '2026-09-01T00:00:00Z' });
  const parsed = parseEnvelope(text);
  assert.deepEqual(parsed, { kind: 'ticket-expired', at: '2026-09-01T00:00:00Z' });
});

test('parse: not-an-envelope', () => {
  assert.equal(parseEnvelope('not an envelope').kind, 'parse-error');
  assert.equal(parseEnvelope('[ticket').kind, 'parse-error');
  assert.equal(parseEnvelope('').kind, 'parse-error');
});

test('parse: unknown envelope head rejected', () => {
  const parsed = parseEnvelope('[ticket-frobnicated at=2026-01-01T00:00:00Z]');
  assert.ok(isParseError(parsed));
  assert.match((parsed as { reason: string }).reason, /unknown-envelope/);
});

test('build: rejects whitespace in field values', () => {
  assert.throws(() =>
    buildTicket({ face: 'character', scope: 'frame:foo bar', expires: '2026-06-01T00:00:00Z' }),
  );
});

test('build: rejects non-ISO expires', () => {
  assert.throws(() => buildTicket({ face: 'character', scope: 'frame:x', expires: '2026-06-01' }));
});

test('build: rejects bad seats', () => {
  assert.throws(() =>
    buildTicket({ face: 'character', scope: 'frame:x', expires: '2026-06-01T00:00:00Z', seats: 0 }),
  );
});

test('parse: tolerates extra inner whitespace', () => {
  const parsed = parseEnvelope('[ticket   face=character    scope=frame:x  expires=2026-06-01T00:00:00Z]');
  assert.equal(parsed.kind, 'ticket');
});

test('verifier envelopes: registration and grain extension fields round-trip', () => {
  const t = buildVerified({
    by: 'agent:tickets-test',
    at: '2026-05-01T12:00:00Z',
    registration: 'sed:cast:11',
    grain: 'grain:abc123def4567890:1',
  });
  assert.equal(
    t,
    '[ticket-verified by=agent:tickets-test at=2026-05-01T12:00:00Z registration=sed:cast:11 grain=grain:abc123def4567890:1]',
  );
  assert.deepEqual(parseEnvelope(t), {
    kind: 'ticket-verified',
    by: 'agent:tickets-test',
    at: '2026-05-01T12:00:00Z',
    registration: 'sed:cast:11',
    grain: 'grain:abc123def4567890:1',
  });

  const r = buildRejected({
    by: 'agent:tickets-test',
    at: '2026-05-01T12:00:00Z',
    reason: 'face-mismatch',
    registration: 'sed:cast:11',
    grain: 'grain:abc123def4567890:1',
  });
  assert.deepEqual(parseEnvelope(r), {
    kind: 'ticket-rejected',
    by: 'agent:tickets-test',
    at: '2026-05-01T12:00:00Z',
    reason: 'face-mismatch',
    registration: 'sed:cast:11',
    grain: 'grain:abc123def4567890:1',
  });

  const e = buildExpired({
    at: '2026-09-01T00:00:00Z',
    registration: 'sed:cast:11',
    grain: 'grain:abc123def4567890:1',
  });
  assert.deepEqual(parseEnvelope(e), {
    kind: 'ticket-expired',
    at: '2026-09-01T00:00:00Z',
    registration: 'sed:cast:11',
    grain: 'grain:abc123def4567890:1',
  });
});
