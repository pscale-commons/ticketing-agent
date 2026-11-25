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
  // CREDITS minted at the moment of payment (sand-v2 2, mint-as-gave, as
  // ruled 25 August 2026): every pound paid becomes `per_pound` credits. The
  // ticket carries the whole it backs (credits=N, payway 2.27), the audit log
  // marks it verified, and the issuer gives the credits in one gift on its own
  // passport at 6.3 — to `to`, a handle such as the beach's commons, else to
  // the buyer — filed at `topic`, where the receiver keeps its receipt. Where
  // the credits go after that is the receiving handle's own law: the contract
  // (one, a game's makers; two, a product's four columns; three, everyone's
  // four columns) lives with the pot, never in the ticket. A credit is never
  // paid back out as money (sand-v2 1.3).
  credits?: CreditsConfig;
}

export interface CreditsConfig {
  per_pound: number;
  to?: string;
  topic?: string;
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
}

export type { Env, Logger };
