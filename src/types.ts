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
