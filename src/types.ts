import type Database from 'better-sqlite3';
import type { Env } from './lib/env.js';
import type { Logger } from './lib/log.js';
import type { McpClient } from './lib/pscale.js';
import type { PaymentDriver } from './drivers/types.js';

export type Face = 'character' | 'author' | 'designer';

export interface RateLimit {
  max_per_hour: number;
  max_per_day: number;
}

export interface Product {
  id: string;
  // Bare handle this product's grains are reached from. Defaults to the
  // agent's own id. One grain exists per (issuer, buyer) pair, so two
  // products sold to the same buyer from one issuer would share — and
  // overwrite — one ticket; a product with its own issuer gets its own grain.
  issuer?: string;
  // The product's collective. A register_buyer product may write "{pscale}"
  // in it (sed:founders{pscale}): the list is then chosen by the amount paid,
  // the place-value of its first digit — £50 → 1, £500 → 2, £1,000 → 3.
  sed: string;
  face: Face;
  scope: string;
  duration_days: number;
  tier?: 'soft' | 'medium' | 'hard';
  rate_limit?: RateLimit;
  price: PriceConfig;
  description: string;
  // The buy page's heading; the product id when absent.
  title?: string;
  // A paid buyer is written into the product's sed: collective — the
  // product's public list (founding supporters) — with the date and an
  // optional line of their own, asked for at checkout.
  register_buyer?: boolean;
  // The list kept as an ORDINARY block only this machine can write — latched to
  // a key derived from TICKET_AGENT_SECRET — instead of the product's sed:
  // collective, which anyone may register into. Where an entry is worth
  // something (a seat that keeps beats at a world, counted by its keeper), the
  // list must not take an entry the machine did not write.
  list_block?: string;
  // Who the product is bought FOR: a handle on the beach (the default), or a
  // character at a world's tables — a seat — whose form asks for the
  // character, looks for it at the tables, and keeps the machinery out of sight.
  buyer?: 'handle' | 'character';
  // Offer a bank transfer beside the card: Stripe gives each payer a virtual
  // account of its own and matches the money when it lands, so the operator's
  // own bank details are never shown. Needs the payer's email before checkout;
  // until Stripe switches bank transfers on for the account, checkout is card.
  bank_transfer?: boolean;
  // The ticket carries credits (payway 2.27, sand-v2 2): they are turned into
  // credits the moment it is paid, and every move of them is written in order
  // in the issuer's book, credits:<issuer>, which only this machine writes
  // (lib/credits.ts). Absent: a ticket with no credits.
  credits?: CreditsConfig;
  // Where the success page sends the buyer back to, when they came from a page
  // of their own (a game's frame): an https:// address, or http://localhost in
  // a test run.
  back?: string;
}

// What a credit-bearing ticket's credits do the moment it is paid. `to` names
// who receives them then:
//   buyer           the buyer's own credits, to spend on goes or give
//   pool            a fund for others' goes: nothing reaches a person until
//                   someone draws a go from it (POST /credits/draw)
//   makers:<point>  straight to the makers the point's law names, split equally
//                   (contract type one, point-creators)
//   https://…       split as that address answers, { split: { <handle>: share } },
//                   with {credits}, {buyer} and {at} in the address filled in
//                   (contract types two and three: a family's XP, the ecosystem's)
//   <handle>        straight to one holder named here (the commons, say)
export interface CreditsConfig {
  // How many credits the ticket carries: n for a fixed price, or per_pound
  // times what was paid, for a ticket of any amount (one of the two).
  n?: number;
  per_pound?: number;
  to: string;
  // The point its credits are spent on: a family whose law (function:<point>)
  // names its makers on a line opening 'makers:'.
  point?: string;
  // A pool's draws: how many free goes one handle may draw, and what one go moves.
  free?: number;
  go?: number;
}

export type PriceConfig =
  | { driver: 'stripe'; stripe_price_id: string }
  | { driver: 'gift'; gifters: string[] }
  | { driver: 'manual'; instructions?: string }
  // Priced per job: the operator raises a Stripe invoice (POST /admin/invoice)
  // and the grain is issued when Stripe reports it paid.
  | { driver: 'invoice'; currency: string; days_until_due?: number };

export interface AgentConfig {
  agent: {
    id: string;
    secret_env: string;
    pscale_mcp_url: string;
    // The beach the grains live on and the buyers' names stand at. The buy
    // page reads its index to catch a handle typed a letter or a capital off.
    beach?: string;
  };
  products: Product[];
  verifier?: {
    watch?: string[];
    poll_interval_seconds?: number;
  };
}

export interface AppContext {
  env: Env;
  log: Logger;
  config: AgentConfig;
  db: Database.Database;
  mcp: McpClient;
  stripeDriver: PaymentDriver | null;
  giftDriver: PaymentDriver;
  manualDriver: PaymentDriver;
  // How a block is read from the beach, as its JSON (null where none stands).
  // Absent: a plain fetch of <beach>/.well-known/pscale-beach?block=<name>.
  // Tests hand in a beach of their own.
  readBlock?: (name: string) => Promise<Record<string, unknown> | null>;
}

export type { Env, Logger };
