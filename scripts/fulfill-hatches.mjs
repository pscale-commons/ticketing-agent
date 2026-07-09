#!/usr/bin/env node
// fulfill-hatches.mjs — the invocable fulfiller for PROVISIONING tickets on a
// hatch collective (ways:tickets branch 5). The AUTHOR'S servant: run it when
// a sale lands; it lists verified-but-unfulfilled registrations and performs
// one hatch per invocation. Deliberately manual-first (useful before
// automated) — put it on a timer only when volume warrants.
//
//   node scripts/fulfill-hatches.mjs --list
//   node scripts/fulfill-hatches.mjs --fulfill <position> --handle <name> \
//        --purpose <rpg|magi|xstream> [--reg-secret <registrant lock>]
//
// Env: BEACH (default https://beach.happyseaurchin.com), COLLECTIVE (default
// sed:genus-hatch), AUDIT_BARE (default hatch-tickets).
//
// Fulfilment record: appended to the open accumulator `fulfilled:<collective
// bare>` on the beach (readable by anyone); additionally marked at the
// registration position's digit 2 when --reg-secret is supplied (assisted
// mode — the position belongs to the registrant, so only their lock can
// write there). Pending = has a grain ref at digit 1 + a ticket-verified
// verdict in the audit + no digit-2 mark + no ledger entry.

const BEACH = (process.env.BEACH || 'https://beach.happyseaurchin.com').replace(/\/$/, '');
const COLLECTIVE = process.env.COLLECTIVE || 'sed:genus-hatch';
const AUDIT_BARE = process.env.AUDIT_BARE || 'hatch-tickets';
const EP = `${BEACH}/.well-known/pscale-beach`;
const LEDGER = `fulfilled:${COLLECTIVE.replace(/^sed:/, '')}`;

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] ?? true) : undefined; };

const get = async (block) => {
  const r = await fetch(`${EP}?block=${encodeURIComponent(block)}`);
  return r.ok ? r.json() : null;
};
const post = async (body) => {
  const r = await fetch(EP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 140)}`);
  return j;
};

// Walk registrant trie positions (floor-2+; skip position 9 = payway config).
function collectPositions(node, path, out) {
  if (typeof node !== 'object' || node === null) return;
  for (let d = 1; d <= 9; d++) {
    const c = node[String(d)];
    if (c === undefined || typeof c !== 'object' || c === null) continue;
    const p = path + d;
    if (p === '9') continue;
    if (typeof c._ === 'string' && p.length >= 2) out.push({ position: p, node: c });
    collectPositions(c, p, out);
  }
}

async function pendingList() {
  const [coll, ledger] = await Promise.all([get(COLLECTIVE), get(LEDGER)]);
  if (!coll) throw new Error(`${COLLECTIVE} not found at ${BEACH}`);
  const ledgerText = ledger ? JSON.stringify(ledger) : '';
  // Audit collectives: current + previous month.
  const now = new Date();
  const mm = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const audits = await Promise.all([
    get(`sed:${AUDIT_BARE}-audit-${mm(now)}`),
    get(`sed:${AUDIT_BARE}-audit-${mm(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)))}`),
  ]);
  const auditText = JSON.stringify(audits);
  const positions = [];
  collectPositions(coll, '', positions);
  const rows = [];
  for (const { position, node } of positions) {
    const grainRef = typeof node['1'] === 'string' ? node['1'] : null;
    if (!grainRef || !grainRef.startsWith('grain:')) continue;
    const regRef = `${COLLECTIVE}:${position}`;
    const verified = auditText.includes(`[ticket-verified`) && auditText.includes(`registration=${regRef} `) || auditText.includes(`registration=${regRef}]`);
    const fulfilled = typeof node['2'] === 'string' && node['2'].length > 0 || ledgerText.includes(`"${regRef}"`) || ledgerText.includes(regRef + ' ');
    rows.push({ position, grainRef, verified, fulfilled, who: (node._ || '').slice(0, 70) });
  }
  return rows;
}

const FOURTEEN = ['reflexive', 'vision', 'capabilities', 'relationships', 'stash',
  'history', 'conditions', 'surface', 'cadence', 'last-touched', 'located',
  'reflective-compass', 'phase', 'phi'];

async function hatch(handle, purpose, passphrase) {
  const blocks = FOURTEEN.map(n => [`genome:${n}`, `${n}:${handle}`])
    .concat([[`genome:purpose-${purpose}`, `purpose:${handle}`]]);
  for (const [src, dst] of blocks) {
    const content = await get(src);
    if (!content) throw new Error(`genome block missing: ${src}`);
    await post({ block: dst, content, new_lock: passphrase });
    for (let d = 1; d <= 9; d++) await post({ block: dst, spindle: String(d), new_lock: passphrase });
    console.log(`  ✓ ${dst}`);
  }
  const task = `task:${handle}`;
  await post({ block: task, content: { _: `${task} at ${BEACH} — the give channel: directed work from the holder arrives here and enters the given of the next wake.` }, new_lock: passphrase });
  for (let d = 1; d <= 9; d++) await post({ block: task, spindle: String(d), new_lock: passphrase });
  console.log(`  ✓ ${task}`);
}

if (flag('list')) {
  const rows = await pendingList();
  for (const r of rows) {
    console.log(`${r.fulfilled ? 'FULFILLED' : r.verified ? 'PENDING  ' : 'UNVERIFIED'} ${COLLECTIVE}:${r.position} ← ${r.grainRef}\n           ${r.who}`);
  }
  const pending = rows.filter(r => r.verified && !r.fulfilled);
  console.log(`\n${pending.length} pending fulfilment${pending.length === 1 ? '' : 's'}.`);
} else if (flag('fulfill')) {
  const position = String(flag('fulfill'));
  const handle = String(flag('handle') || '');
  const purpose = String(flag('purpose') || '');
  if (!handle || !['rpg', 'magi', 'xstream'].includes(purpose)) {
    console.error('need --handle <name> and --purpose rpg|magi|xstream'); process.exit(1);
  }
  const rows = await pendingList();
  const row = rows.find(r => r.position === position);
  if (!row) { console.error(`no registration at position ${position}`); process.exit(1); }
  if (!row.verified) { console.error(`registration ${position} has no verified verdict — refusing`); process.exit(1); }
  if (row.fulfilled) { console.error(`registration ${position} already fulfilled — refusing`); process.exit(1); }
  const { randomBytes } = await import('node:crypto');
  const passphrase = `${handle}-${randomBytes(8).toString('hex')}`;
  console.log(`hatching ${handle} (purpose-${purpose}) for ${COLLECTIVE}:${position}…`);
  await hatch(handle, purpose, passphrase);
  await post({ block: LEDGER, append: true, content: { _: `FULFILLED ${COLLECTIVE}:${position} → ${handle} (purpose-${purpose}) hatched, sixteen blocks sealed. Passphrase delivered by the operator out-of-band.`, 1: 'fulfill-hatches', 2: `${COLLECTIVE}:${position}`, 3: new Date().toISOString() } });
  const regSecret = flag('reg-secret');
  if (typeof regSecret === 'string') {
    await post({ block: COLLECTIVE, spindle: `${position}2`, secret: regSecret, content: `FULFILLED ${new Date().toISOString().slice(0, 10)}: ${handle} hatched (purpose-${purpose}); ledger ${LEDGER}.` });
    console.log(`  ✓ digit-2 mark at ${position}`);
  }
  console.log(`\nHATCHED: ${handle}. PASSPHRASE (shown once — hand to the holder, never store):\n\n  ${passphrase}\n`);
} else {
  console.log('usage: fulfill-hatches.mjs --list | --fulfill <position> --handle <h> --purpose <rpg|magi|xstream> [--reg-secret <lock>]');
}
