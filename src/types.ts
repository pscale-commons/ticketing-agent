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
