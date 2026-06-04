// M1 round-trip smoke test against the live bsp-mcp.
//
// Run: npx tsx scripts/m1-roundtrip.ts
//
// Steps:
//   1. Establish a grain (issuer → buyer) with a [ticket ...] envelope.
//   2. Walk the issuer's side; assert the envelope round-trips (build → live → parse).
//   3. Write a [ticket-revoked] envelope at <issuer_side>.1.
//   4. Walk again; assert both envelopes are visible.
//
// Uses fresh agent_ids per run (timestamped) to avoid colliding with prior
// runs on the live substrate. Grains are append-only — there is no cleanup.

import { createMcpClient } from '../src/lib/pscale.js';
import { buildTicket, buildRevoked, parseEnvelope, isParseError } from '../src/lib/envelope.js';
import { establish, walkSide, revoke, determineSide } from '../src/lib/grain.js';

const MCP_URL = process.env.MCP_URL ?? 'https://bsp.hermitcrab.me/mcp/v1';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const ISSUER = `tickets-test-issuer-${RUN_ID}`;
const BUYER = `tickets-test-buyer-${RUN_ID}`;
const PASSPHRASE = `dev-passphrase-${RUN_ID}`;

const EXPIRES_AT = new Date(Date.now() + 30 * 24 * 3600 * 1000)
  .toISOString()
  .replace(/\.\d+Z$/, 'Z');

function log(label: string, value?: unknown): void {
  if (value === undefined) console.log(`\n=== ${label} ===`);
  else console.log(`  ${label}:`, value);
}

async function main() {
  log('M1 round-trip start');
  log('mcp_url', MCP_URL);
  log('issuer', ISSUER);
  log('buyer', BUYER);

  const client = await createMcpClient(MCP_URL, { clientName: 'ticketing-agent-m1-smoke' });

  // 1. Build the envelope and establish the grain.
  const ticket = buildTicket({
    face: 'character',
    scope: 'frame:m1-smoke',
    expires: EXPIRES_AT,
    nonce: RUN_ID,
  });
  log('ticket envelope', ticket);

  log('Step 1 — establish grain');
  const grain = await establish({
    client,
    issuer_agent_id: ISSUER,
    buyer_agent_id: BUYER,
    description: `M1 smoke test ticket — issuer ${ISSUER}`,
    envelope: ticket,
    passphrase: PASSPHRASE,
  });
  log('pair_id', grain.pair_id);
  log('issuer_side', grain.issuer_side);
  log('buyer_side', grain.buyer_side);

  // Sanity check — issuer_side matches local lex computation.
  const expectedSide = determineSide(ISSUER, BUYER);
  if (grain.issuer_side !== expectedSide) {
    throw new Error(`side mismatch: server says ${grain.issuer_side}, lex says ${expectedSide}`);
  }
  log('side lex check', 'ok');

  // 2. Walk the issuer's side and verify envelope round-trip.
  log('Step 2 — walk issuer side');
  const before = await walkSide({ client, pair_id: grain.pair_id, side: grain.issuer_side });
  log('walked envelope', before.envelope);
  log('walked revocations', before.revocations);

  if (before.envelope !== ticket) {
    throw new Error(`envelope mismatch:\n  built:  ${ticket}\n  walked: ${before.envelope}`);
  }
  const parsed = parseEnvelope(before.envelope!);
  if (isParseError(parsed)) {
    throw new Error(`walked envelope failed to parse: ${parsed.reason}`);
  }
  if (parsed.kind !== 'ticket') {
    throw new Error(`walked envelope wrong kind: ${parsed.kind}`);
  }
  log('parsed face', parsed.kind === 'ticket' ? parsed.face : '');
  log('parsed scope', parsed.kind === 'ticket' ? parsed.scope : '');
  log('parsed expires', parsed.kind === 'ticket' ? parsed.expires : '');

  // 3. Revoke.
  const revocation = buildRevoked({
    at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    reason: 'm1-smoke-revoke',
  });
  log('revocation envelope', revocation);

  log('Step 3 — write revocation');
  await revoke({
    client,
    pair_id: grain.pair_id,
    issuer_side: grain.issuer_side,
    passphrase: PASSPHRASE,
    revocation,
  });
  log('revocation', 'written');

  // 4. Walk again, assert both visible.
  log('Step 4 — walk again');
  const after = await walkSide({ client, pair_id: grain.pair_id, side: grain.issuer_side });
  log('envelope after revoke', after.envelope);
  log('revocations after revoke', after.revocations);

  if (after.envelope !== ticket) {
    throw new Error(`envelope changed after revocation: ${after.envelope}`);
  }
  if (after.revocations.length === 0) {
    throw new Error('revocation envelope not visible after write');
  }
  if (!after.revocations.includes(revocation)) {
    throw new Error(`revocation mismatch:\n  wrote:    ${revocation}\n  walked:   ${after.revocations.join(' | ')}`);
  }

  log('M1 round-trip', 'PASS');
  await client.close();
}

main().catch((err) => {
  console.error('\nM1 round-trip FAILED:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
