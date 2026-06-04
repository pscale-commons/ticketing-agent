// Grain operations for the ticketing agent.
//
// Three primitives — establish, walk, revoke — over the bsp-mcp grain
// substrate. Nothing here is a "grain object"; the grain lives on the beach.
// We hold a pair_id, a side digit, and a passphrase; we read and write text
// through the MCP client.
//
// CONVENTION RESOLUTION (M1) — pinned against the live bsp-mcp at
// https://bsp.hermitcrab.me/mcp/v1 and protocol-block-references.md §1.
//
// 1. Grain reference form is `grain:<pair_id>:<side>` (three parts).
//    Side is the lex-ordered position of the agent_id in the pair:
//    smaller agent_id occupies side "1", larger occupies side "2".
//    This matches `pscale_grain_reach` tool description ("After completion,
//    your side address grain:{pair_id}:{your_side} can be used as a routing
//    identity") and tools/grain.ts:114-115 in bsp-mcp-server.
//
//    The example `*:agent:<issuer>:grain:<pair_id>` in payway.md
//    §2.3 is malformed against block-references.md §1 dispatch rules —
//    flagged for the bsp-mcp-server session to pin.
//
// 2. The `[ticket ...]` envelope IS the issuer's side underscore. We write
//    it via `pscale_grain_reach` directly: `my_side_content` = the envelope.
//    Atomic with grain establishment; one MCP call. (Sub-question 1 in the
//    earlier triage — resolved here in favour of underscore-IS-envelope; the
//    `_envelope` sub-position pattern from xstream-frame doesn't apply
//    because grains aren't synthesis blocks.)
//
// 3. `[ticket-revoked]` envelopes go to a sub-position of the issuer's side:
//    `<issuer_side>.1` as a terminal string. This avoids the read-modify-write
//    race of overwriting the side underscore, and it lets the verifier scan
//    issuer-side children for any revocation envelope without parsing
//    concatenated text. (Sub-question 3 — resolved here, flagged for the
//    protocol doc to pin.)
//
// Per CLAUDE.md: no caching of bsp() reads, no Grain class, no parallel
// model. The substrate is the truth; we just call through.

import type { McpClient } from './pscale.js';

export type Side = '1' | '2';

export type GrainAddress = {
  pair_id: string;
  issuer_side: Side;
  buyer_side: Side;
};

// Side determination matches `determineSide` in bsp-mcp-server/src/locks.ts —
// lex-smaller agent_id is "1", lex-larger is "2". Computable client-side,
// no MCP call needed.
export function determineSide(agent_id: string, partner_agent_id: string): Side {
  if (agent_id === partner_agent_id) {
    throw new Error('determineSide: agent_id and partner_agent_id must differ');
  }
  return agent_id < partner_agent_id ? '1' : '2';
}

// pair_id derivation matches bsp-mcp-server/src/locks.ts `pairId`:
// sha256(sort(A_id, B_id) | join('|')).slice(0, 16). We don't recompute it
// locally — pscale_grain_reach is the source of truth and returns it in the
// response text. Store what the server tells us.

// Live pscale_grain_reach response lines (bsp.hermitcrab.me, beach v2):
//   pair_id:        grain:<16hex> on https://<beach>
//   your side:      grain:<16hex>:<side>@https://<beach>
//   partner side:   grain:<16hex>:<side>@https://<beach>
// The pair_id now carries a `grain:` prefix; sides carry an `@<beach>` suffix.
// Regexes tolerate both the prefixed live form and the bare-hex legacy form.
const PAIR_ID_RE = /pair_id:\s+(?:grain:)?([a-f0-9]{16})/i;
const YOUR_SIDE_RE = /your side:\s+grain:[a-f0-9]{16}:([12])/i;
const PARTNER_SIDE_RE = /partner side:\s+grain:[a-f0-9]{16}:([12])/i;

function parseReachResponse(text: string): GrainAddress {
  const pairMatch = PAIR_ID_RE.exec(text);
  const yourMatch = YOUR_SIDE_RE.exec(text);
  const partnerMatch = PARTNER_SIDE_RE.exec(text);
  if (!pairMatch || !yourMatch || !partnerMatch) {
    throw new Error(`pscale_grain_reach: could not parse response\n---\n${text}\n---`);
  }
  return {
    pair_id: pairMatch[1]!,
    issuer_side: yourMatch[1] as Side,
    buyer_side: partnerMatch[1] as Side,
  };
}

// ── establish ────────────────────────────────────────────────────────────
//
// Issue a ticket grain. The envelope text is the issuer's side underscore.
// Returns the grain address — pair_id and which side the issuer occupies.

export type EstablishInput = {
  client: McpClient;
  issuer_agent_id: string;
  buyer_agent_id: string;
  description: string;
  envelope: string; // a [ticket ...] envelope built via lib/envelope.ts buildTicket()
  passphrase: string;
};

export async function establish(input: EstablishInput): Promise<GrainAddress> {
  const { client, issuer_agent_id, buyer_agent_id, description, envelope, passphrase } = input;
  // bsp-mcp pscale_grain_reach takes bare `handle`/`partner_handle` (NOT the
  // old `agent_id`/`partner_agent_id`). On the new substrate `agent_id` is
  // repurposed to mean the beach URL; we let it default to the canonical
  // beach (https://beach.happyseaurchin.com), which is also what the verifier
  // reads collectives from, so grains and collectives share one home.
  const text = await client.callTool('pscale_grain_reach', {
    handle: issuer_agent_id,
    partner_handle: buyer_agent_id,
    description,
    my_side_content: envelope,
    my_passphrase: passphrase,
  });
  return parseReachResponse(text);
}

// ── walk ─────────────────────────────────────────────────────────────────
//
// Read a grain side. Returns the underscore (the envelope) and any
// revocation envelopes found at issuer-side children.
//
// The bsp pscale convention runs negative: P_end = -length(spindle). A
// point-read at terminus uses P_att = P_end; whole-block read uses
// (spindle empty, P_att null). We use whole-block — grains are small and
// we want both the side's underscore and its children in one call.

export type GrainSideContent = {
  envelope: string | null;
  revocations: string[];
};

export type WalkInput = {
  client: McpClient;
  pair_id: string;
  side: Side;
};

export async function walkSide(input: WalkInput): Promise<GrainSideContent> {
  const { client, pair_id, side } = input;
  const text = await client.callTool('bsp', {
    agent_id: `grain:${pair_id}`,
    block: 'grain',
    spindle: null,
    pscale_attention: null,
  });
  return extractSide(text, side);
}

// The whole-block read returns text starting with `[whole block]` followed
// by a JSON-rendered block. Parse the JSON and extract the requested side.
const WHOLE_BLOCK_PREFIX_RE = /^\s*\[whole block\]\s*/;

type RawBlock = Record<string, unknown>;

function parseWholeBlockText(text: string): RawBlock | null {
  const stripped = text.replace(WHOLE_BLOCK_PREFIX_RE, '');
  const i = stripped.indexOf('{');
  if (i === -1) return null;
  try {
    return JSON.parse(stripped.slice(i)) as RawBlock;
  } catch {
    return null;
  }
}

export function extractSide(wholeBlockText: string, side: Side): GrainSideContent {
  const block = parseWholeBlockText(wholeBlockText);
  const sideContent = block?.[side];
  return sideContentToView(sideContent);
}

function sideContentToView(sideContent: unknown): GrainSideContent {
  if (sideContent === undefined || sideContent === null) {
    return { envelope: null, revocations: [] };
  }
  if (typeof sideContent === 'string') {
    return { envelope: sideContent, revocations: [] };
  }
  if (typeof sideContent !== 'object') {
    return { envelope: null, revocations: [] };
  }
  const obj = sideContent as Record<string, unknown>;
  const envelope = typeof obj._ === 'string' ? obj._ : null;
  const revocations: string[] = [];
  for (let d = 1; d <= 9; d++) {
    const child = obj[String(d)];
    if (typeof child === 'string' && child.startsWith('[ticket-revoked')) {
      revocations.push(child);
    }
  }
  return { envelope, revocations };
}

// ── walkGrain ────────────────────────────────────────────────────────────
//
// Returns both sides plus the position-9 agent_id mapping. The verifier
// uses this for rule 7 (grain was established by the agent listed as
// _tickets.issuer) — the side number alone is not enough; we need to see
// which bare agent_id the substrate has recorded on that side.

export type WalkedGrain = {
  agents: { '1': string | null; '2': string | null };
  sides: { '1': GrainSideContent; '2': GrainSideContent };
};

export async function walkGrain(opts: { client: McpClient; pair_id: string }): Promise<WalkedGrain> {
  const text = await opts.client.callTool('bsp', {
    agent_id: `grain:${opts.pair_id}`,
    block: 'grain',
    spindle: null,
    pscale_attention: null,
  });
  const block = parseWholeBlockText(text) ?? {};
  const agentsRaw = (block['9'] as Record<string, unknown> | undefined) ?? {};
  return {
    agents: {
      '1': typeof agentsRaw['1'] === 'string' ? (agentsRaw['1'] as string) : null,
      '2': typeof agentsRaw['2'] === 'string' ? (agentsRaw['2'] as string) : null,
    },
    sides: {
      '1': sideContentToView(block['1']),
      '2': sideContentToView(block['2']),
    },
  };
}

// ── revoke ───────────────────────────────────────────────────────────────
//
// Write a [ticket-revoked] envelope at the issuer's side child position.
// Per the convention pinned at the top of this file, revocations go at
// `<issuer_side>.1` — first child of the issuer's side. The lock on the
// issuer's side covers writes to its children (whetstone branch 3.6 — sed:
// and grain: substrates lock per position).

export type RevokeInput = {
  client: McpClient;
  pair_id: string;
  issuer_side: Side;
  passphrase: string;
  revocation: string; // a [ticket-revoked ...] envelope built via buildRevoked()
};

export async function revoke(input: RevokeInput): Promise<void> {
  const { client, pair_id, issuer_side, passphrase, revocation } = input;
  // Point-write at "<side>.1": spindle length 2 → P_end = -2 → P_att = -2.
  const spindle = `${issuer_side}.1`;
  // gray:false is REQUIRED — grain curate-writes default to gray (private,
  // encrypted to both parties' published keys). A [ticket-revoked] envelope
  // must be PUBLIC so the verifier (a third party, not a grain party) can
  // read it. Without gray:false the beach rejects the write unless the buyer
  // has published keys. NOTE: the grain must be fully established (buyer has
  // accepted via pscale_grain_reach) before any curate write is permitted —
  // a one-sided grain has only the issuer at position 9 and rejects writes.
  const result = await client.callTool('bsp', {
    agent_id: `grain:${pair_id}`,
    block: 'grain',
    spindle,
    pscale_attention: -spindle.split('.').length,
    content: revocation,
    secret: passphrase,
    gray: false,
  });
  // bsp returns "[wrote point @ ...]" on success. Anything else (e.g.
  // "Write rejected: ...") means the call landed but the substrate refused.
  if (!/\[wrote\b/.test(result)) {
    throw new Error(`revoke: bsp did not confirm write — got: ${result}`);
  }
}
