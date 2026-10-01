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
  // Offer a bank transfer beside the card: Stripe gives each payer a virtual
  // account of its own and matches the money when it lands, so the operator's
  // own bank details are never shown. Needs the payer's email before checkout;
  // until Stripe switches bank transfers on for the account, checkout is card.
  bank_transfer?: boolean;
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
