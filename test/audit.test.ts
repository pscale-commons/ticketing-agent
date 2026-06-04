import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeMcpClient } from './helpers.js';
import {
  appendDecision,
  auditCollectiveName,
  deriveCollectivePassphrase,
} from '../src/lib/audit.js';

test('audit: collective name follows yyyy-mm convention', () => {
  const name = auditCollectiveName('tickets-test', new Date('2026-05-15T08:00:00Z'));
  assert.equal(name, 'tickets-test-audit-2026-05');
});

test('audit: collective name pads month', () => {
  const name = auditCollectiveName('tk', new Date('2026-01-01T00:00:00Z'));
  assert.equal(name, 'tk-audit-2026-01');
});

test('audit: passphrases are deterministic but distinct per kind', () => {
  const a = deriveCollectivePassphrase('S', 'col', 'creator');
  const b = deriveCollectivePassphrase('S', 'col', 'creator');
  const c = deriveCollectivePassphrase('S', 'col', 'entry');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('audit: appendDecision registers the entry (collective auto-created by register)', async () => {
  const mcp = fakeMcpClient();
  const date = new Date('2026-05-01T12:00:00Z');
  const result = await appendDecision({
    client: mcp,
    ticketAgentSecret: 'secret',
    verifier_bare_id: 'tickets-test',
    envelope: '[ticket-verified by=agent:tickets-test at=2026-05-01T12:00:00Z registration=sed:cast:11 grain=grain:abc123def4567890:1]',
    date,
  });
  assert.equal(result.audit_block, 'tickets-test-audit-2026-05');
  assert.equal(result.audit_position, '1');

  // The old pscale_create_collective tool no longer exists — register auto-creates.
  const createCalls = mcp.calls.filter((c) => c.name === 'pscale_create_collective');
  const registerCalls = mcp.calls.filter((c) => c.name === 'pscale_register');
  assert.equal(createCalls.length, 0, 'must not call the removed pscale_create_collective');
  assert.equal(registerCalls.length, 1);
  assert.equal(registerCalls[0]!.args.collective, 'tickets-test-audit-2026-05');
});

test('audit: subsequent appends in the same month register to the same collective', async () => {
  const mcp = fakeMcpClient();
  const date = new Date('2026-05-01T12:00:00Z');
  await appendDecision({
    client: mcp,
    ticketAgentSecret: 'secret',
    verifier_bare_id: 'tickets-test',
    envelope: '[ticket-verified by=a at=2026-05-01T12:00:00Z]',
    date,
  });
  const second = await appendDecision({
    client: mcp,
    ticketAgentSecret: 'secret',
    verifier_bare_id: 'tickets-test',
    envelope: '[ticket-rejected by=a at=2026-05-01T12:01:00Z reason=test]',
    date,
  });
  assert.equal(second.audit_position, '2');
  const registerCalls = mcp.calls.filter((c) => c.name === 'pscale_register');
  assert.equal(registerCalls.length, 2);
  assert.ok(registerCalls.every((c) => c.args.collective === 'tickets-test-audit-2026-05'));
});

test('audit: month rollover starts a new collective', async () => {
  const mcp = fakeMcpClient();
  const may = new Date('2026-05-31T23:59:00Z');
  const june = new Date('2026-06-01T00:01:00Z');
  await appendDecision({
    client: mcp,
    ticketAgentSecret: 'secret',
    verifier_bare_id: 'tickets-test',
    envelope: '[ticket-verified by=a at=2026-05-31T23:59:00Z]',
    date: may,
  });
  await appendDecision({
    client: mcp,
    ticketAgentSecret: 'secret',
    verifier_bare_id: 'tickets-test',
    envelope: '[ticket-verified by=a at=2026-06-01T00:01:00Z]',
    date: june,
  });
  const registerCalls = mcp.calls.filter((c) => c.name === 'pscale_register');
  assert.deepEqual(
    registerCalls.map((c) => c.args.collective),
    ['tickets-test-audit-2026-05', 'tickets-test-audit-2026-06'],
  );
});
