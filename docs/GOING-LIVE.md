# Going live — standing up the whole payway system

A runbook for a future session (or operator) to take the payway from "validated
in dev" to "a real person can buy a ticket and participate." Written 2026-06-04,
after the bsp-mcp federated-substrate port. Read this repo's `CLAUDE.md` and the
spec at `pscale://payway` first.

## 0. The four layers (what runs where)

```
USERS
  ▲  click "buy", then create
xstream-bsp / xstream-play   FRONT-END (separate repo) — the app users touch.
  ▲                          Reads the §9 config, shows the buy button, does Step A,
  │                          polls the audit log, unlocks. Talks to the beach directly.
ticketing-agent (THIS repo)  BACK-END — takes payment, issues ticket-grains, runs the
  ▲                          verifier. Talks to the beach THROUGH bsp-mcp.
bsp-mcp                      API — bsp() + 5 primitives. Ticket-blind. Reads/writes the beach.
  ▲
beach (beach.happyseaurchin.com)   STORAGE — the grains, the §9 payway config, the
                             registrations, and the public audit log live here.
```

The issuer (ticketing-agent) and the client (xstream-bsp) **never call each
other** — they coordinate only through the beach (grain + §9 config + audit log)
plus one HTTP redirect (user → the issuer's `purchase_url`). That decoupling is
the federation property; keep it.

## 1. Decisions before you start

- **Agent identity** — pick an `agent_id` (e.g. `agent:my-tickets`) and a bare handle (`my-tickets`). Generate a long random `TICKET_AGENT_SECRET` (the pscale agent secret; it HMAC-derives every per-grain passphrase, so rotating it invalidates revocation authority on already-issued grains).
- **bsp-mcp endpoint** — use the public `https://bsp.hermitcrab.me/mcp/v1`, or self-host (§2). The daemon issues + verifies through this.
- **Beach** — the default `https://beach.happyseaurchin.com` (a bsp-mcp forwards to it), or self-host a beach. Grains, collectives, and the audit log all land here.
- **Driver** — start with `manual` or `gift` (no payment processor) to prove the path; add `stripe` for real money (§7).
- **Collective + face + scope** — which `sed:` collective you gate, which CADO face it represents (`character`/`author`/`designer`), and what the ticket authorises (`frame:<id>`, `frame:<prefix>-*`, or — v2 — `beach:<host>`).

## 2. Substrate (beach + bsp-mcp)

**Option A — use the public substrate (zero infra).** Point the daemon at
`https://bsp.hermitcrab.me/mcp/v1`. It forwards to `beach.happyseaurchin.com`.
The beach is shared and federated — use **disposable handles** while testing and
clean up after (grains/`sed:` blocks need operator-KV cleanup, not HTTP DELETE).

**Option B — self-host bsp-mcp** (recommended for control / current code):

```bash
git clone https://github.com/pscale-commons/bsp-mcp-server ~/bsp-mcp && cd ~/bsp-mcp
npm install
PORT=3001 npm start          # serves /mcp/v1 ; forwards to DEFAULT_BEACH
# DEFAULT_BEACH env var overrides the beach (default beach.happyseaurchin.com)
```

Confirm reachable:

```bash
curl -sS -X POST http://localhost:3001/mcp/v1 \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```

> Note: at time of writing the *deployed* hermitcrab build lagged main on some
> behaviours; if a falsy-arg-sensitive path (e.g. `gray:false`) misbehaves,
> test against a freshly-started current build (Option B) before assuming a daemon bug.

## 3. Deploy the ticketing-agent (M7)

```bash
git clone https://github.com/pscale-commons/ticketing-agent /opt/ticketing-agent
cd /opt/ticketing-agent && npm install && npm run build
cp .env.example .env                       # fill it in (below)
cp config/agent.yaml.example config/agent.yaml   # fill it in (below)
node dist/index.js                         # add systemd/pm2; put HTTPS in front
```

**`.env`** — `TICKET_AGENT_SECRET` (random), `ADMIN_TOKEN` (random; gates `/admin/*`), `PUBLIC_URL` (your https URL — used in Stripe success/cancel + catalogue links), `PORT`. For Stripe products also `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`. Optional `RATE_LIMIT_WEBHOOK`, `LOG_LEVEL`, `PURCHASES_DB_PATH`.

**`config/agent.yaml`** — `agent.id`, `agent.secret_env: TICKET_AGENT_SECRET`, `agent.pscale_mcp_url` (your bsp-mcp endpoint from §2), `products[]` (id, sed, face, scope, duration_days, price.driver + driver fields, description), and `verifier.watch` (defaults to the union of `products[].sed`). See `config/agent.yaml.example`.

Verify: `GET /health` returns the agent identity; the catalogue renders at `/`. HTTPS in front is required for Stripe webhooks.

## 4. Turn the payway on for a collective (§5 onboarding)

This is the one write that gates a collective. Done by the frame-owner (who holds
the collective's admin lock), once per collective, via `bsp()`:

```
bsp(agent_id="sed:<collective>", block="<collective>",
    spindle="9", pscale_attention=-1,
    content={ "_": "payway config",
              "1": "agent:<issuer-id>",                       # 9.1 issuer  (your agent)
              "2": "https://<issuer-domain>/buy/<product>",   # 9.2 purchase_url
              "3": "character",                               # 9.3 face
              "4": "frame:<scene-id>",                        # 9.4 scope
              "5": "agent:<verifier-id>" },                   # 9.5 verifier (defaults to 9.1)
    secret="<collective admin secret>")
```

An empty/absent position 9 means the collective is **open** (anyone registers).
To migrate to a different issuer later, change 9.1 + 9.2 — a five-minute migration
(existing grains stop being honoured because they're from the old issuer).

> Storage shape: registrants land at floor-2+ positions (11, 12, …); a whole-block
> read nests them as a digit-trie (position `11` = `block["1"]["1"]`). Position 9
> holds the config. Sibling keys like `_tickets` are **invisible** to `bsp()` — do
> not use them.

## 5. Smoke-test the issuer + verifier (no client needed)

Fastest: the bundled live integration test, pointed at your bsp-mcp:

```bash
MCP_URL=http://localhost:3001/mcp/v1 npx tsx scripts/e2e-verify.ts
# drives issue → Step A register → verify → audit → revoke → revocation sweep,
# plus non-member + expired rejections. "ALL CHECKS PASSED" = the back-end works.
```

Or manual, exercising the real HTTP routes (manual driver, no Stripe):

1. `POST /buy/<product_id>` with `{ buyer_agent_id }` → `pending` purchase + instructions.
2. `POST /admin/mark-paid/<purchase_id>` (Bearer `ADMIN_TOKEN`) → issues the grain, marks `paid`.
3. The buyer/client performs **Step A** (register + attach grain ref — see §6).
4. The in-process verifier ticks → writes `[ticket-verified]` to `sed:<agent-bare>-audit-<yyyy-mm>`.

Confirm by reading that audit collective: it should hold a `[ticket-verified … registration=sed:<collective>:<pos> grain=grain:<pair>:<side>]` entry.

## 6. The client (xstream-bsp) — the user-facing half

Any §4-compliant payway-aware client works; the reference is **xstream-bsp**
(`~/Projects/xstream-bsp`). It reads the §9 config, surfaces the buy affordance,
performs Step A on grain arrival, polls the verifier's audit log, and unlocks.

**⚠ As of 2026-06-04 the reference client was built against the OLD substrate and
needs the same port this repo got** (see the audit notes). The load-bearing fixes:

- **Config read** (`src/kernel/paywall.ts` `readTickets`): read **position 9**
  numbered fields, not a `_tickets` sibling key. (Else the gate always reports
  "open" and no buy button appears.)
- **Step A second write** (`paywall.ts` `referenceGrainInRegistration`): use the
  ratified **Candidate A** — overwrite the whole position with
  `{ _: declaration, 1: "grain:<pair>:<side>" }` at `spindle="<position>"`,
  `pscale_attention=-len(position)`. **NOT** `spindle="<position>.1"` (rejected by
  the floor model). This MUST match the verifier's read shape, or nothing verifies.
- **Audit walk** (`paywall.ts` `walkVerifierAudit`): descend the digit-trie to find
  entries; flat `Object.entries(block)` finds nothing on the new beach.
- **Addressing convention**: the client's browser-side `bsp-client.ts` talks to
  beaches directly; confirm its `sed:`/`grain:` block addressing matches how
  bsp-mcp stores them, so client and verifier touch the SAME blocks.
- Cosmetic: `paywall` → `payway` rename across `src/kernel/*` + the banner.
- Already correct (leave alone): envelope parsing, the 8-rule local validation,
  the whole-block grain read, and the federation discipline (no issuer allowlist,
  issuer `agent_id` displayed, no interposition, reflexive-proportion UI).

After the port: configure the client with your bsp-mcp/beach endpoint and the
frame, and the `purchase_url` it opens must be your deployed `/buy/<product>`.

## 7. Stripe (real money)

Create a Stripe account + product/price; put the `price_id` in the product config
(`price: { driver: stripe, stripe_price_id: price_… }`). Point a Stripe webhook at
`https://<you>/webhook/stripe` and set `STRIPE_WEBHOOK_SECRET`. Test mode first.
The webhook is signature-verified, idempotent, and rate-limited at issuance.

## 8. Prove the federation property

Stand up **two** issuers under different `agent_id`s, point two collectives at them
(different 9.1/9.2), run a verifier for each, and confirm the client treats them
identically — no badge, no ranking, no allowlist. This is the §6.2 regression test;
it's easy to violate without realising.

## 9. Operations

- **Refund**: `POST /admin/refund/<purchase_id>` `{ reason }` → Stripe refund (if Stripe) + a `[ticket-revoked]` write to the grain; the verifier emits `[ticket-rejected reason=revoked]` on its next tick.
- **Rate limits**: per-product hour/day caps (`§3.9`); cap-hit logs high-severity and (if `RATE_LIMIT_WEBHOOK` set) POSTs. Buyers are NOT auto-refunded on cap-hit — operator decides.
- **Audit log**: public, append-only, one `sed:<agent-bare>-audit-<yyyy-mm>` collective per month. Write-only from our side; for external observers.

## Appendix — the substrate shapes (hard-won, 2026-06)

- `pscale_grain_reach` takes bare `handle`/`partner_handle` (not `agent_id`/`partner_agent_id`); `agent_id` = beach URL. Response `pair_id` carries a `grain:` prefix.
- Grain whole-block: `block['9']` = parties map `{side: handle}`; envelope at `block[side]._`. A one-sided issuer reach is enough to verify.
- `sed:` payway config at `block['9']` numbered fields; registrants nest in a digit-trie; registration node is `{_: declaration, 1: grain-ref}` (Candidate A).
- `[ticket-revoked]`: PUBLIC write (`gray:false`) at `<issuer-side>.1`, `pscale_attention=-1` (grain sides sit at the floor). Works on a one-sided grain.
- `pscale_register` auto-creates the collective (no `pscale_create_collective`); ack is `Registered at sed:<coll>:<pos> on <beach>`.
