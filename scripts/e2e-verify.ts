// End-to-end: issue → register (payway §2.3 Step A, Candidate A shape) →
// verifier.runOnce → public audit log. Drives the REAL lib code against a live
// bsp-mcp (default: local current-code server on :3001). Disposable handles.
//
//   npx tsx scripts/e2e-verify.ts
//
// Asserts the happy path (verified) plus two rejections (non-established grain,
// expired ticket). Revocation is intentionally out of scope (blocked on the
// bsp-mcp falsy-arg / gray:false bug).

import { randomUUID } from 'node:crypto';
import { createMcpClient } from '../src/lib/pscale.js';
import { openDb } from '../src/lib/db.js';
import { issueGrain } from '../src/lib/issuance.js';
import { establish, revoke } from '../src/lib/grain.js';
import { buildTicket, buildRevoked } from '../src/lib/envelope.js';
import { derivePassphrase } from '../src/lib/grain-passphrase.js';
import { runOnce } from '../src/lib/verifier.js';
import { auditCollectiveName } from '../src/lib/audit.js';
import { ManualDriver } from '../src/drivers/manual.js';
import type { AppContext, AgentConfig, Env, Product } from '../src/types.js';

const MCP_URL = process.env.MCP_URL ?? 'http://localhost:3001/mcp/v1';
const RUN = new Date().toISOString().replace(/[:.]/g, '-').toLowerCase();
const ISSUER = `e2e-issuer-${RUN}`;          // bare handle
const COLL = `e2e-cast-${RUN}`;              // collective bare name
const FRAME = `e2e-${RUN}`;
const SECRET = `e2e-secret-${RUN}`;
const posRe = /sed:[^:\s]+:(\d+)/;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined && !ok ? '  -> ' + JSON.stringify(detail) : ''}`);
  if (!ok) failures++;
}

const log = { info() {}, warn() {}, error: (...a: unknown[]) => console.error('  [verifier.error]', ...a), debug() {}, trace() {}, fatal() {} } as unknown as AppContext['log'];

async function main() {
  const client = await createMcpClient(MCP_URL, { clientName: 'e2e-verify' });
  const product: Product = {
    id: 'e2e-character-30d', sed: `sed:${COLL}`, face: 'character',
    scope: `frame:${FRAME}`, duration_days: 30, description: 'e2e manual character ticket',
    price: { driver: 'manual' },
  };
  const config: AgentConfig = {
    agent: { id: `agent:${ISSUER}`, secret_env: 'TICKET_AGENT_SECRET', pscale_mcp_url: MCP_URL },
    products: [product], verifier: { watch: [`sed:${COLL}`], poll_interval_seconds: 5 },
  };
  const env = {
    TICKET_AGENT_SECRET: SECRET, TICKET_AGENT_CONFIG: './x', ADMIN_TOKEN: 'x',
    PORT: 8080, PUBLIC_URL: 'http://x', LOG_LEVEL: 'info', PURCHASES_DB_PATH: ':memory:',
  } as unknown as Env;
  const ctx: AppContext = {
    env, log, config, db: openDb(':memory:'), mcp: client,
    stripeDriver: null, giftDriver: new ManualDriver(), manualDriver: new ManualDriver(),
  };

  // helper: Step A registration (Candidate A) — register, then overwrite the
  // position with { _: declaration, 1: grain_ref }.
  async function stepA(declaration: string, grainRef: string): Promise<string> {
    const pp = `regpp-${randomUUID()}`;
    const t = await client.callTool('pscale_register', { collective: COLL, declaration, passphrase: pp });
    const pos = posRe.exec(t)?.[1]!;
    await client.callTool('bsp', {
      agent_id: `sed:${COLL}`, block: COLL, spindle: pos, pscale_attention: -pos.length,
      content: { _: declaration, 1: grainRef }, secret: pp,
    });
    return pos;
  }

  // ── 1. Frame-owner writes the payway config sub-block at position 9 ──
  // (collective auto-creates on first register below; write config after.)
  async function writeConfig() {
    await client.callTool('bsp', {
      agent_id: `sed:${COLL}`, block: COLL, spindle: '9', pscale_attention: -1,
      content: { _: 'payway config', 1: `agent:${ISSUER}`, 2: `https://x/buy/${product.id}`, 3: 'character', 4: `frame:${FRAME}`, 5: `agent:${ISSUER}` },
      secret: SECRET,
    });
  }

  // ── 2. Issue a valid ticket grain via the real issuance path (manual mark-paid) ──
  const buyer = `e2e-buyer-${RUN}`;
  const pid = randomUUID();
  ctx.db.prepare(`INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, created_at) VALUES (?, ?, ?, 'pending', 'manual', ?)`)
    .run(pid, product.id, `agent:${buyer}`, new Date().toISOString());
  const purchase = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(pid) as any;
  const issued = await issueGrain({ ctx, purchase, product });
  check('issueGrain ok', issued.ok === true, issued);
  if (!issued.ok) { console.log('cannot continue'); process.exit(1); }
  const validRef = `grain:${issued.pair_id}:${issued.issuer_side}`;
  console.log(`  issued grain ${validRef}`);

  // ── 3. Buyer Step A registration referencing the valid grain ──
  const goodPos = await stepA(`I am ${buyer}, a character`, validRef);
  console.log(`  buyer registered at position ${goodPos} -> ${validRef}`);

  // ── 4. A non-member: registration pointing at a non-established grain ──
  const bogusRef = 'grain:deadbeefdeadbeef:2';
  const badPos = await stepA('I am a freeloader', bogusRef);
  console.log(`  freeloader registered at position ${badPos} -> ${bogusRef}`);

  // ── 5. An expired ticket: establish a grain with a past expiry, register it ──
  const expBuyer = `e2e-expired-${RUN}`;
  const expEnvelope = buildTicket({ face: 'character', scope: `frame:${FRAME}`, expires: '2020-01-01T00:00:00Z', nonce: RUN });
  const expGrain = await establish({ client, issuer_agent_id: ISSUER, buyer_agent_id: expBuyer, description: 'expired e2e', envelope: expEnvelope, passphrase: 'exp-pass' });
  const expRef = `grain:${expGrain.pair_id}:${expGrain.issuer_side}`;
  const expPos = await stepA('I hold a stale ticket', expRef);
  console.log(`  expired-ticket holder registered at position ${expPos} -> ${expRef}`);

  await writeConfig();

  // ── 6. Run the verifier once ──
  const stats = await runOnce(ctx);
  console.log('\nverifier stats:', JSON.stringify(stats));
  check('verifier saw 3 new positions', stats.newPositions === 3, stats);
  check('verifier verified 1', stats.verified === 1, stats);
  check('verifier rejected 2', stats.rejected === 2, stats);

  // ── 7. Check the SQLite decisions ──
  const rows = ctx.db.prepare('SELECT position, decision, reason FROM verifier_decisions ORDER BY position').all() as any[];
  const byPos = Object.fromEntries(rows.map((r) => [r.position, r]));
  check(`good pos ${goodPos} verified`, byPos[goodPos]?.decision === 'verified', byPos[goodPos]);
  check(`bad pos ${badPos} rejected grain-not-established`, byPos[badPos]?.decision === 'rejected' && byPos[badPos]?.reason === 'grain-not-established', byPos[badPos]);
  check(`expired pos ${expPos} rejected expired`, byPos[expPos]?.decision === 'rejected' && byPos[expPos]?.reason === 'expired', byPos[expPos]);

  // ── 8. Read the public audit log; confirm the verified envelope landed ──
  const auditColl = auditCollectiveName(ISSUER, new Date());
  const auditText = await client.callTool('bsp', { agent_id: `sed:${auditColl}`, block: auditColl, spindle: null, pscale_attention: null });
  const hasVerified = auditText.includes('[ticket-verified') && auditText.includes(`registration=sed:${COLL}:${goodPos}`) && auditText.includes(validRef);
  check('audit log has [ticket-verified] for the good registration', hasVerified);
  const hasReject = auditText.includes('[ticket-rejected') && auditText.includes('reason=expired');
  check('audit log has a [ticket-rejected reason=expired]', hasReject);
  console.log(`\n  audit collective: sed:${auditColl}`);

  // ── 9. Revoke the good grain → verifier revocation sweep → [ticket-rejected reason=revoked] ──
  const revPass = derivePassphrase(SECRET, ISSUER, buyer);
  await revoke({
    client, pair_id: issued.pair_id, issuer_side: issued.issuer_side, passphrase: revPass,
    revocation: buildRevoked({ at: '2026-06-04T00:00:00Z', reason: 'admin-refund' }),
  });
  console.log(`  revoked ${validRef}`);
  const stats2 = await runOnce(ctx);
  console.log('verifier stats (post-revoke):', JSON.stringify(stats2));
  check('revocation sweep emitted exactly 1 new rejected', stats2.rejected === 1 && stats2.verified === 0, stats2);
  const goodRows = ctx.db.prepare('SELECT decision, reason FROM verifier_decisions WHERE collective = ? AND position = ? ORDER BY id').all(`sed:${COLL}`, goodPos) as any[];
  check(`good pos ${goodPos}: verified then rejected=revoked`, goodRows.length === 2 && goodRows[1]?.decision === 'rejected' && goodRows[1]?.reason === 'revoked', goodRows);
  const auditText2 = await client.callTool('bsp', { agent_id: `sed:${auditColl}`, block: auditColl, spindle: null, pscale_attention: null });
  check('audit log has [ticket-rejected reason=revoked]', auditText2.includes('[ticket-rejected') && auditText2.includes('reason=revoked'));
  // Idempotent: a third tick writes nothing new.
  const stats3 = await runOnce(ctx);
  check('revocation sweep is idempotent (no new decisions)', stats3.rejected === 0 && stats3.verified === 0, stats3);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  await client.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('E2E FAILED:', e.message); if (e.stack) console.error(e.stack); process.exit(1); });
