# ticketing-agent

## To the next instance — read this before touching anything

This repo is a small Node service that does three things: take payment, issue a ticket grain, run a verifier loop. That's it. If you find yourself writing a "ticket validation framework", a "grain object model", a "scope DSL", or a "payment abstraction layer beyond the existing PaymentDriver interface" — stop. The substrate (bsp-mcp) does the load-bearing work. We are a thin issuer-and-verifier between Stripe and pscale.

You are stepping into a project that orbits a **non-traditional substrate**. The pscale geometry that this agent writes onto is described in `pscale-commons/bsp-mcp-server`. Read that repo's `CLAUDE.md` first if you have any instinct to reach for an ORM, a typed grain class, an envelope schema validator that does more than parse text, or any other "make this look like normal code" abstraction. Those instincts are wrong here. They are wrong specifically because pscale already solved the problems those abstractions usually exist to solve, and our job is to operate within the substrate, not over it.

The dominant failure mode of this kind of service is **building a parallel model of grains and envelopes in our own data structures**, then keeping that model "in sync" with what's actually in pscale. Don't. The grain is the block in pscale. The envelope is the text we wrote into a position. We hold a SQLite row tracking that we made the issuance happen and what it cost, plus a Stripe reference for refunds. That is the entire scope of our local state. **The SQLite database is for fiat side-effects (idempotency, refund accounting), not for ticket truth.** Ticket truth lives on the beach.

If your code is getting more complex — caching layers over `bsp()`, type hierarchies for envelopes, a "Grain" class with methods, a service layer that wraps the MCP client — every one of those is the wrong move. Step back. The substrate has already removed the need.

## Read first (before any code change)

**The protocol convention this agent implements:**
- `pscale://payway` (alias `pscale://protocol-paywall` still resolves) — the full convention spec. Available via the bsp-mcp resource, or as `docs/payway.md` in `pscale-commons/bsp-mcp-server`. **Section 6 (federation guarantees) is non-negotiable.** If a change you are about to make would violate §6.1 (substrate stays neutral), §6.2 (client stays neutral), §6.3 (small reference impl), §6.4 (no protocol-level fees), or §6.5 (interoperability invariant) — stop and flag it.

**The substrate this agent writes onto:**
- `pscale://sunstone` — eight-branch teaching block. Branches 1, 2, 3, 5, 8 are most relevant: geometry (what we walk), function (the bsp() primitive that walks), modifiers (face/tier/secret/gray), composition (star references — `ticket_grain` registrations use these), voicing (how we author envelope text and audit-log entries).
- `pscale://whetstone` — operational reference. Branch 2 (selection-shape derivation) tells you what `bsp()` returns for any (S, P) pair. Branch 4 (storage) clarifies what is and isn't in scope for a substrate client.
- `pscale://protocol-xstream-frame` — V-L-S over pscale. Reads matter to us because the verifier writes a confirmation envelope onto a registration row, and the *synthesis daemon* on the frame-owner's host then honours that registration as a face-authorised participant in the V-L-S loop. We don't run synthesis; we enable the gate that lets it run.

If bsp-mcp is connected, prefer the `pscale://...` resources directly. Otherwise the markdown lives at:
- `<bsp-mcp-server>/docs/payway.md`
- `<bsp-mcp-server>/src/sunstone.json`
- `<bsp-mcp-server>/src/whetstone.json`
- `<bsp-mcp-server>/docs/protocol-xstream-frame.md`

## What this is

A small HTTP service (Hono on Node 22) that:

1. **Operates as a pscale agent** with its own `agent_id`, secret, keys.
2. **Accepts purchase requests** for one or more configured `sed:` collectives, declared in `config/agent.yaml`.
3. **Routes payment** through a configured driver (Stripe reference; `gift` and `manual` alternates).
4. **On payment success, issues a grain** via `pscale_grain_reach` to the buyer's `agent_id`, with envelope text per the payway convention.
5. **Runs a verifier worker** that watches configured collectives, walks ticket grains, and writes `[ticket-verified]` / `[ticket-rejected]` / `[ticket-expired]` envelopes onto registrations.
6. **Writes a public audit log** to its own beach at `verifier-audit:<yyyy-mm>` — append-only, one block per calendar month.
7. **Handles refunds** by writing `[ticket-revoked]` envelopes onto issued grains (Stripe driver also calls the Stripe refund API).

That's it. The full reference build is M0–M7 in §8 of the protocol doc; we are at M0 (skeleton).

## What NOT to do

1. **Do not build a Grain class, a Ticket class, or any object hierarchy that mirrors what's already in pscale.** The grain is `bsp()` behind the network. The envelope is a string. Parse it where you need it (one tiny module: `lib/envelope.ts`); do not promote it to an OO concept.
2. **Do not write a "ticket validation framework".** §2.4 of the protocol doc is the canonical verification rule list — eight items. Implement them as eight checks, not as a chain-of-responsibility, not as a strategy pattern, not as a rules engine. Eight `if`s in one function.
3. **Do not add fields to grains we issue, or invent grammar beyond what §2.2 specifies.** The envelope is `[ticket face=... scope=... expires=... (optional: tier|seats|nonce)]`. `credits=` is reserved and v1 verifiers MUST reject it (§2.4 rule 8). If you reach for a new field, ask whether it belongs in the issuer's local SQLite (operational) or in the buyer's grain (canonical) — almost always the former.
4. **Do not cache `bsp()` reads beyond a single tick window.** The verifier loop polls; cache invalidation across polls is more bugs than performance gains. The grain on the substrate is the truth.
5. **Do not let SQLite hold ticket truth.** SQLite holds: pending purchases, idempotency keys, Stripe references, refund records, rate-limit counters. SQLite does NOT hold: who is verified, what envelopes are on which grain, who is registered in what collective. Those live on the beach. If you ever feel tempted to mirror pscale state into SQLite "for performance" — that's the inversion failure.
6. **Do not allowlist issuers, rank issuers, or treat any agent_id as privileged.** This is a §6.2 (client) issue, but it has an analogue here: do not assume our agent is special. A frame-owner pointing `_tickets.issuer` at a different agent must Just Work, with this codebase as the reference for that other deployment.
7. **Do not add multi-tenant SaaS features, KYC integrations, analytics dashboards, or a billing engine.** §6.3. Forks targeting specific markets can; the reference cannot.
8. **Do not skip Stripe webhook signature verification, ever.** And do not log secrets — pino redaction is configured, keep the redaction list current.
9. **Do not amend or skip hooks on commits.** Standard project hygiene; nothing payway-specific here.

## What TO do

1. **Keep handlers thin.** A route handler does: validate input → call one library function → return result. If a route is doing more than that, the library function is the wrong shape.
2. **Confirm `bsp()` and `pscale_grain_reach` parameter shapes via `tool_search` against the live bsp-mcp before coding M1.** The protocol doc uses logical pseudocode in §2.3 and §2.4 of the build spec; the actual MCP tool signatures are canon. `tool_search bsp` and `tool_search pscale_grain_reach`.
3. **Resolve the grain-ref syntax once, in one place.** §9.5 of the build spec: `*:agent:X:grain:Y` vs whatever `protocol-block-references.md` pins. Resolve it in M1 against the live MCP, document the answer in `lib/grain.ts` as a comment, and post it back to `pscale-commons/bsp-mcp-server` if the protocol doc needs a clarification edit.
4. **Treat the public audit log (§4.6) as a write-only append target.** No reads inside our own code path — the audit is for *external* observers (issuer cross-checks, future independent monitor). One write per verification decision, one daily summary, that's it.
5. **Make the gift driver use Ed25519 against `pscale_key_publish`-ed public keys.** The gifter signs a message attesting to the gift; the agent verifies the signature against the gifter's published key in passport position 9. No new key management.
6. **Test against a real bsp-mcp endpoint.** Default in `config/agent.yaml.example` points at `https://bsp.hermitcrab.me/mcp/v1`. Use a dev `agent_id` for testing, not a production one.
7. **Match the spec's milestone scope.** Don't bundle M3 work into M1. Each milestone is supposed to be independently testable.

## Architecture (M0 — current state)

```
src/
├── index.ts                 # entry — load env, config, db; start server; signal handlers
├── server.ts                # Hono app factory (health endpoint only at M0)
├── types.ts                 # AppContext, Product, PriceConfig, Face
└── lib/
    ├── env.ts               # zod env validation (TICKET_AGENT_SECRET, ADMIN_TOKEN, etc.)
    ├── log.ts               # pino with secret redaction
    ├── config.ts            # YAML + zod (agent identity, products, verifier watch list)
    └── db.ts                # SQLite open + purchases table schema
```

Future milestones add (per protocol §8):

- **M1**: `lib/envelope.ts`, `lib/grain.ts`, `lib/pscale.ts` (MCP client). Round-trip envelope tests.
- **M2**: `routes/catalogue.ts` — public product list page.
- **M3**: `drivers/stripe.ts`, `routes/purchase.ts`, `routes/webhook.ts`, `lib/rate-limit.ts`, `routes/admin.ts`.
- **M4**: `lib/verifier.ts`, `lib/audit.ts`. Verifier worker watches configured collectives.
- **M5**: `routes/refund.ts` — Stripe refund + grain revoke.
- **M6**: `drivers/gift.ts`, `drivers/manual.ts`.
- **M7**: catalogue page styling, deploy.

## Storage

**SQLite at `data/purchases.sqlite`** (gitignored). Single table `purchases`:

| column | purpose |
|---|---|
| `id` | UUID primary key (also the idempotency key, generated at `/buy` time) |
| `product_id` | references `config/agent.yaml` products[].id |
| `buyer_agent_id` | the buyer's pscale `agent_id` |
| `status` | `pending` \| `paid` \| `failed` \| `refunded` \| `rate_limited` |
| `driver` | `stripe` \| `gift` \| `manual` |
| `driver_ref` | driver-specific reference (Stripe Checkout Session ID, etc.) — used to look up by webhook |
| `grain_pair_id` | the pair_id of the issued grain, after webhook success |
| `created_at`, `paid_at`, `refunded_at` | ISO8601 timestamps |
| `amount_cents`, `currency` | what was charged (for refund accounting) |
| `notes` | free-form admin notes |

Counts for `lib/rate-limit.ts` come from this table — `SELECT count(*) WHERE product_id = ? AND status = 'paid' AND paid_at > ?`. No separate counter table.

**The substrate (pscale) holds**: the grain (with `[ticket ...]` envelope), revocations (`[ticket-revoked]`), the collective's `_tickets` field, the registration that references the grain, the `[ticket-verified]` / `[ticket-rejected]` / `[ticket-expired]` envelopes, and the public audit log at `verifier-audit:<yyyy-mm>` on this agent's own beach. None of that is mirrored in SQLite.

## Federation guarantees — the §6 social contract

These are not decoration. Anyone reviewing a PR reads them first.

1. **Substrate stays neutral.** Nothing in this repo causes bsp-mcp to learn what a ticket is. We are a client.
2. **Client (xstream-play, others) stays neutral.** Our buy-affordance contract (§4 of protocol) doesn't allowlist us as the canonical issuer. Our public-facing materials don't imply we are.
3. **Reference impl stays small.** "Forkable in an afternoon." If a feature meaningfully raises self-host bar, it goes in a fork.
4. **No protocol-level fees.** Our income (if any) is what Stripe charges and what frame-owners voluntarily pay us as a hosted-issuer service. Nothing in envelope grammar, metadata, or daemon convention takes a cut.
5. **Interoperability invariant.** A frame-owner switches from us to another issuer with a five-minute migration: change `_tickets.issuer` and `_tickets.purchase_url`, tell their verifier to expect the new issuer's `agent_id`. Done. Existing live grains stop being honoured (because they're from us, not the new issuer); new purchases use the new path.

## Lineage and relationships

| Repo | Role | Relationship to us |
|---|---|---|
| `pscale-commons/bsp-mcp-server` | The substrate (pscale geometry + bsp() + 5 primitives) | We are a *client* of bsp-mcp. We do not modify it. We use its tools via MCP. |
| `pscale-commons/ticketing-agent` (this repo) | Reference issuer + verifier | The deployable artefact frame-owners fork. |
| xstream-play | Reference payway-aware client | Reads our `_tickets`, surfaces buy buttons, polls for grains, performs Step A registration. We do not depend on xstream-play; the affordance contract (§4 of protocol) is fully specified. |

Coordination point with xstream-play: the grain-reference syntax used in registrations (`*:agent:X:grain:Y` per draft, to be confirmed against `protocol-block-references.md` during M1). Both sides must use the same string. Resolve here, post back.

## Open decisions that the next session should be aware of

From §9 of the protocol doc / build spec:

1. **Hosted reference issuer**: David may run one publicly (e.g. `tickets.machus.ai`) but framed as "one option among many", not "the official issuer." This decision affects M7 (deploy + README messaging), not earlier milestones.
2. **Verifier-only mode**: ship a `--verifier-only` flag for frame-owners using third-party issuers. Lands in M4.
3. **Default ticket duration units**: days. Configurable. Some frames may want hours. Land the defaults; don't over-engineer the units up front.
4. **Grain-reference syntax**: confirm `*:agent:X:grain:Y` against `protocol-block-references.md` in M1.
5. **Soft-LLM rate-limit per ticket vs per session**: not our problem — that's a synthesis-daemon concern on the frame-owner's host. Note it, don't solve it here.
6. **Multi-frame season passes**: scope `beach:X` admits the holder to all `_tickets`-marked collectives on agent X's beach. Already in spec; verifier rule 4 (§2.4) handles it. Test it explicitly in M4.

## Security and secrets discipline

- Pino redaction is configured for `secret`, `TICKET_AGENT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ADMIN_TOKEN`, `authorization`, `cookie`. Keep the list current as new sensitive fields appear.
- No key material on disk outside `.env` or a sealed secret store. The `TICKET_AGENT_SECRET` is the pscale agent secret; everything cryptographic with it (Argon2id derivations for `pscale_key_publish`, write-locks for grains we issue) is delegated to bsp-mcp via MCP calls.
- Stripe webhooks: signature verification is non-negotiable. The webhook handler must verify before doing any work.
- Idempotency: every webhook handler checks whether the purchase has already been settled before issuing a grain. Re-delivered webhooks must not double-issue. Stripe SDK retries are common; this is non-negotiable.
- Rate-limit caps (§3.9 of protocol): per-product hour and day caps; cap-hit logs high-severity event and (if `RATE_LIMIT_WEBHOOK` is set) POSTs to that URL. The buyer is NOT auto-refunded on cap-hit — operator decides via `/admin/refund`.

## What success looks like at each milestone

- **M0** (now): server boots, `/health` returns the agent identity, env+config validation rejects bad configs with clear errors. ✅
- **M1**: round-trip tests for every envelope shape (`[ticket]`, `[ticket-revoked]`, `[ticket-verified]`, `[ticket-rejected]`, `[ticket-expired]`); `lib/grain.ts` can establish, walk, and revoke a grain against the live bsp-mcp using a dev agent_id; grain-ref syntax confirmed.
- **M2**: catalogue page renders all configured products with descriptions and Stripe-driven Buy links; YAML reload by restart is documented.
- **M3**: full Stripe test-mode flow — click Buy, complete Checkout, webhook fires, grain lands on beach with correct envelope, SQLite row marked `paid`. Rate-limit caps trigger correctly when forced.
- **M4**: registrations referencing valid grains get `[ticket-verified]` envelopes; invalid ones get `[ticket-rejected]` with a reason; expired ones get `[ticket-expired]`; audit log entries land at `verifier-audit:<yyyy-mm>` for each.
- **M5**: `/admin/refund` calls Stripe refund + writes `[ticket-revoked]`; verifier picks up revocation on next poll and re-evaluates registrations holding that grain.
- **M6**: gift driver verifies Ed25519 signatures from gifters' published keys; manual driver returns bank-transfer instructions and an `/admin/mark-paid/:id` endpoint completes the flow.
- **M7**: deployable to a single host with three commands (clone, install, configure-and-restart); README is the public face.

## Notes for the build sessions

- Confirm tool parameter shapes via `tool_search` before writing code that calls them.
- Test the federation property explicitly: stand up two ticketing agents under different agent_ids in dev, point two collectives at them, run the verifier against both, confirm xstream-play (when ready) treats them identically.
- The `§6 guarantees` aren't decoration. If you find yourself building something that would violate one of them, stop and write it up rather than working around it.
- Treat the protocol doc in bsp-mcp-server as the source of truth for the convention. If the convention itself needs a change, propose the edit there, don't fork the convention into this repo.
