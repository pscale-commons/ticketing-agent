# ticketing-agent

Reference issuer + verifier for the [bsp-mcp payway convention](https://github.com/pscale-commons/bsp-mcp-server/blob/main/docs/payway.md).

A small Node/Hono service that:

1. Takes payment for participation in a `sed:` collective.
2. Issues a *ticket grain* on the substrate via `pscale_grain_reach`.
3. Runs a verifier that walks each watched collective every few seconds and writes `[ticket-verified | ticket-rejected | ticket-expired]` envelopes into a public audit log on its own beach.

Forkable in an afternoon. The whole thing is ~2k lines of TypeScript over a small SQLite database. The substrate (bsp-mcp) does the load-bearing work; this agent is a thin layer between Stripe and the beach.

> **Federation guarantees** (§6 of the protocol): no central issuer, no central client, no protocol-level fees. Anyone can stand up their own deployment; a frame-owner switches issuers in a five-minute migration.

## What's in the box

| Capability | Status | Where |
|---|---|---|
| HTTP + config + SQLite skeleton | ✅ M0 | `src/index.ts`, `src/server.ts`, `src/lib/{env,log,config,db}.ts` |
| Envelope grammar + grain helpers (establish, walk, revoke) | ✅ M1 | `src/lib/{envelope,grain,pscale}.ts` |
| Public catalogue page | ✅ M2 | `src/routes/catalogue.ts` |
| Stripe Checkout, webhook, idempotent issuance, rate-limit caps | ✅ M3 | `src/drivers/stripe.ts`, `src/routes/{purchase,webhook}.ts`, `src/lib/rate-limit.ts` |
| Verifier daemon, eight-rule check, public audit log, expiry sweep, revocation sweep | ✅ M4 / M5 | `src/lib/{verifier,audit}.ts` |
| Refunds: Stripe refund + grain revoke | ✅ M5 | `src/routes/admin.ts` |
| Gift driver (Ed25519-signed redemption) | ✅ M6 | `src/drivers/gift.ts` |
| Manual driver (bank transfer + admin mark-paid) | ✅ M6 | `src/drivers/manual.ts` |

## Stack

- Node 22, TypeScript, ES modules
- Hono on `@hono/node-server`
- `better-sqlite3` for purchase records, idempotency keys, refund tracking, and verifier decision history
- `pino` with secret redaction
- `zod` for env + YAML validation
- `tweetnacl` for Ed25519 signature verification (gift driver)
- `stripe` for Checkout Session + webhooks (Stripe driver)

The substrate connection is a tiny in-tree HTTP MCP client over `bsp-mcp`'s Streamable HTTP transport — no MCP SDK dependency.

## Three-command install

```bash
git clone <this-repo> ticketing-agent && cd ticketing-agent
npm install
cp .env.example .env && cp config/agent.yaml.example config/agent.yaml
# ── edit .env and config/agent.yaml ──
npm run dev
```

`/health` should return your agent identity. The catalogue is at `/`.

## Configuration

Two files — both are validated at startup; bad values fail loud rather than silently.

### `.env`

| Variable | Required for | Notes |
|---|---|---|
| `TICKET_AGENT_SECRET` | All flows | This is your pscale agent secret. Used as the HMAC key for per-grain passphrase derivation; rotating it invalidates revocation authority on previously-issued grains, so do this carefully. |
| `ADMIN_TOKEN` | All flows | Bearer token gating `/admin/*` endpoints. |
| `STRIPE_SECRET_KEY` | Stripe products | Otherwise leave unset. |
| `STRIPE_WEBHOOK_SECRET` | Stripe products | Webhook signature verification is non-negotiable. |
| `RATE_LIMIT_WEBHOOK` | Optional | If set, POSTed when a per-product cap is hit at issuance. |
| `PORT` | Optional, defaults `8080` | |
| `PUBLIC_URL` | Optional, defaults `http://localhost:8080` | Used in `success_url` / `cancel_url` for Stripe and in catalogue links. |
| `LOG_LEVEL` | Optional, defaults `info` | `trace`-`fatal`. |
| `PURCHASES_DB_PATH` | Optional, defaults `./data/purchases.sqlite` | |

### `config/agent.yaml`

Declares the agent's identity, the bsp-mcp endpoint it talks to, the products it sells, and which collectives the verifier watches. See [`config/agent.yaml.example`](config/agent.yaml.example) for a full example with all three driver kinds.

```yaml
agent:
  id: agent:my-tickets             # any unique pscale agent_id
  secret_env: TICKET_AGENT_SECRET
  pscale_mcp_url: https://bsp.hermitcrab.me/mcp/v1
  beach: https://beach.happyseaurchin.com   # optional: where buyers' names stand (the buy page's "did you mean …?")

products:
  - id: character-30d
    # issuer: my-frame-tickets     # optional: this product's own grain handle — one grain
    #                              # stands per (issuer, buyer), so give each product sold
    #                              # to the same people its own
    sed: sed:my-frame-cast
    face: character                # character | author | designer
    scope: frame:my-frame          # exact, prefix-pattern (frame:foo-*), or beach:X
    duration_days: 30
    rate_limit:
      max_per_hour: 100
      max_per_day: 500
    price:
      driver: stripe
      stripe_price_id: price_XXX
    description: "Play a character in my frame for 30 days"

  - id: consultancy                # priced per job — see "Invoice" below
    issuer: my-consultancy-tickets
    sed: sed:my-consultancy
    face: designer
    scope: beach:my.beach.host
    duration_days: 365
    price:
      driver: invoice
      currency: gbp
    description: "Consultancy, priced per job"

verifier:
  poll_interval_seconds: 5
  # Defaults to the union of products[].sed if omitted.
  # watch:
  #   - sed:my-frame-cast
```

## Endpoints

### Public

- `GET /` — product catalogue (HTML; `Accept: application/json` for the JSON form).
- `GET /buy/:product_id` — per-driver buy form.
- `POST /buy/:product_id` — start a purchase.
  - **Stripe**: `{ buyer_agent_id }` → returns `{ checkout_url, purchase_id }` (or 303 redirect for form posts).
  - **Gift**: `{ buyer_agent_id, gifter_agent_id, issued_at, nonce, signature }`. Signature is base64 Ed25519 over `ticket-gift:<product_id>:<buyer_agent_id>:<issued_at>:<nonce>`. Returns `{ ok, purchase_id, pair_id }` on success.
  - **Manual**: `{ buyer_agent_id }` → returns `{ purchase_id, status: "pending", instructions, reference }`.
- `GET /buy/:product_id/{success,cancel}` — minimal landing pages.
- `POST /webhook/stripe` — Stripe Checkout Session webhook. Signature-verified, idempotent, rate-limited at issuance time.
- `GET /health` — agent identity + product count.

### Admin (require `Authorization: Bearer <ADMIN_TOKEN>`)

- `GET /admin/purchases[?status=...]` — list purchases.
- `GET /admin/purchases/:id` — single row.
- `GET /admin/rate-limit/:product_id` — current rate-limit decision for a product.
- `POST /admin/refund/:id` — Stripe refund + grain revoke. Body: `{ reason }` (no whitespace). The verifier picks up the revocation on its next tick and writes a `[ticket-rejected reason=revoked]` audit entry.
- `POST /admin/mark-paid/:id` — operator confirms a manual (bank transfer) purchase has cleared. Issues the grain and marks the row paid. Body: `{ notes }` (optional).
- `POST /admin/reissue/:id` — write the ticket for a purchase that was paid but whose grain failed to land (`status: failed`, e.g. bsp-mcp unreachable at the moment of payment). Marks the row paid on success. `:id` is the purchase id or the Stripe invoice (`in_…`) / checkout session (`cs_…`); when the machine holds no row for it at all, the sale is read back from Stripe. Body: `{ notes }` (optional).
- `POST /admin/invoice` — raise a Stripe invoice for an invoice-priced product. Body: `{ product_id, buyer_agent_id, email, name?, amount_cents, description, send? }` (`amount_cents` in the currency's minor unit; `send: true` finalises and emails it, otherwise a draft waits in the dashboard).

## Driver flows

### Stripe

`product.price.driver: stripe` with `stripe_price_id`. Buyer hits POST `/buy/:product_id` with their `agent_id`; we create a Checkout Session with metadata that round-trips the purchase id and redirect them. Stripe's `checkout.session.completed` webhook signature-verifies, looks up the purchase, runs the authoritative rate-limit check, derives the per-grain passphrase from `TICKET_AGENT_SECRET`, and calls `pscale_grain_reach` on the buyer's agent_id. The grain lands; the row is marked `paid`.

A recurring price makes the checkout a **subscription**: the first period is issued as above, and each later period arrives as `invoice.paid` (`subscription_cycle`) and re-reaches the same grain with a fresh expiry. Give the product a `duration_days` a few days past the billing period so a retried card never lapses a ticket. The webhook endpoint must listen for `checkout.session.completed` **and** `invoice.paid`.

Refund: `POST /admin/refund/:id` with `{ reason }`. Calls `stripe.refunds.create` then writes a `[ticket-revoked]` envelope to `<issuer-side>.1` of the grain. The verifier picks this up on the next tick.

### Gift

`product.price.driver: gift` with `gifters: [agent:host, ...]`. The gifter has previously run `pscale_key_publish` so their public Ed25519 key sits at `passport:9.ed25519`. They sign the canonical message `ticket-gift:<product_id>:<buyer_agent_id>:<issued_at>:<nonce>` and hand the buyer the result. The buyer (or an automated client) POSTs to `/buy/:product_id` with the signed bundle. We fetch the gifter's pubkey, verify the signature, and issue the grain inline — no payment processor in the loop.

The 24-hour `issued_at` window prevents replay of stale signatures; the `nonce` gives single-use semantics within the window.

### Invoice

`product.price.driver: invoice` with `currency` (and optional `days_until_due`, default 14): work priced per job. Two ways to raise one, both ticketed when Stripe reports the invoice paid (`invoice.paid`):

- **From the machine** — `POST /admin/invoice`. The invoice carries the payer's handle in a custom field **Beach handle**, and a customer the machine creates keeps that field as a default.
- **In the Stripe dashboard**, as you would any invoice — add a custom field named **Beach handle** holding the payer's handle, exactly as it stands on the beach. (A customer the machine created already carries it.) When it is paid, the ticket is issued for the machine's invoice product — or the product named by an invoice metadata key `product_id`, when the machine sells more than one. An invoice with no Beach handle is left alone: the money is recorded in Stripe and no ticket is written.

### Manual

`product.price.driver: manual` with optional `instructions`. POST `/buy/:product_id` returns the instructions text and a `reference` (the purchase id). The buyer sends payment out of band; the operator reconciles their bank statement and calls `POST /admin/mark-paid/:purchase_id`. The grain is issued at that moment.

## Verifier daemon

Runs in-process. On each tick (default every 5 seconds):

1. **Process collective**: for each watched `sed:` collective with a `_tickets` field, walk its registrations, find positions whose sub-position 1 is a `grain:<pair_id>:<side>` reference, and apply the eight-rule check from §2.4 of the protocol — face match, scope compat, expires in future, no revocation, issuer matches `_tickets.issuer`, no `credits=` field, etc. Write `[ticket-verified]` or `[ticket-rejected reason=...]` to the audit collective.
2. **Revocation sweep**: for each previously-verified row whose grain now carries a `[ticket-revoked]` envelope, write a fresh `[ticket-rejected reason=revoked]`.
3. **Expiry sweep**: for each previously-verified row whose `expires_at` has passed, write `[ticket-expired]`.

The audit collective is `sed:<verifier-bare-id>-audit-<yyyy-mm>` on the agent's beach. One per calendar month. Each entry's underscore is the verifier envelope, with `registration=<sed:...>` and `grain=<grain:...>` extension fields so external readers can correlate.

## Storage shape

SQLite at `data/purchases.sqlite`. Two tables:

- `purchases` — fiat-side state only. Pending → paid/rate_limited/failed/refunded transitions; idempotency key for webhooks; Stripe `driver_ref` for refund lookup; `gift` purchases use the nonce as `driver_ref`.
- `verifier_decisions` — local tracking of which `(collective, position, decision)` combinations have been written to the audit log. UNIQUE on the triple; a verified→revoked transition writes a new `rejected` row.

**Ticket truth lives on the substrate, not in SQLite.** The local DB is purely for fiat-side bookkeeping.

## Running tests

```bash
npm run typecheck
npm test                                  # 110 unit tests, all in-memory
npx tsx scripts/m1-roundtrip.ts          # live round-trip against bsp.hermitcrab.me
                                          # — uses an ephemeral dev agent_id
```

The unit tests cover envelope round-trips, the eight verifier rules, all driver flows (Stripe / gift / manual), refund + revocation paths, audit log appends, idempotency, and rate-limit windows. They run against an in-memory fake bsp-mcp so `npm test` never hits the network.

The M1 round-trip script is the integration smoke — establishes a grain, walks it, revokes, walks again — against a live bsp-mcp endpoint.

## Deploying

Three commands on a single VPS:

```bash
git clone <this-repo> /opt/ticketing-agent
cd /opt/ticketing-agent && npm install --production && npm run build
node dist/index.js                        # add a systemd unit / pm2 / etc
```

You'll need:

- A pscale `agent_id` and matching `TICKET_AGENT_SECRET`.
- A reachable bsp-mcp endpoint (`config.agent.pscale_mcp_url`).
- Your `_tickets` field added to each `sed:` collective you're issuing for, pointing at this agent and your `purchase_url`.
- Stripe keys (test mode is fine to start).
- A `ADMIN_TOKEN` (long random string).
- HTTPS in front (Stripe webhooks require it for production).
- **`PURCHASES_DB_PATH` on persistent storage.** On a platform with ephemeral disks (Railway: `railway volume add --mount-path /data`, with `PURCHASES_DB_PATH=/data/purchases.sqlite`), a deploy without a volume wipes the purchase rows and the verifier's decisions. Stripe stays the record of every sale — a paid session or invoice whose row is gone is still ticketed from its own metadata, and `POST /admin/reissue/<in_…|cs_…>` repairs one by hand — but pending invoices, idempotency and the verifier's memory live in the database.

## Federation

A frame-owner switching from this issuer to another one updates `_tickets.issuer` and `_tickets.purchase_url` on their collective. Existing live grains stop being honoured by the new verifier (because they're from the old issuer); new purchases use the new path. Five-minute migration. Nothing about this agent's deployment encodes anything that couples a collective to it.

If you fork this repo for a multi-tenant SaaS, KYC integrations, or analytics, please keep that in your fork — the reference stays small (§6.3 of the protocol).

## License

MIT. See [LICENSE](LICENSE).
