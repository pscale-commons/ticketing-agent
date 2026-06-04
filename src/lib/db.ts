import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type PurchaseStatus = 'pending' | 'paid' | 'failed' | 'refunded' | 'rate_limited';

export interface PurchaseRow {
  id: string;
  product_id: string;
  buyer_agent_id: string;
  status: PurchaseStatus;
  driver: string;
  driver_ref: string | null;
  grain_pair_id: string | null;
  created_at: string;
  paid_at: string | null;
  refunded_at: string | null;
  amount_cents: number | null;
  currency: string | null;
  notes: string | null;
}

export function openDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS purchases (
      id              TEXT PRIMARY KEY,
      product_id      TEXT NOT NULL,
      buyer_agent_id  TEXT NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'rate_limited')),
      driver          TEXT NOT NULL,
      driver_ref      TEXT,
      grain_pair_id   TEXT,
      created_at      TEXT NOT NULL,
      paid_at         TEXT,
      refunded_at     TEXT,
      amount_cents    INTEGER,
      currency        TEXT,
      notes           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_purchases_product   ON purchases (product_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_buyer     ON purchases (buyer_agent_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_status    ON purchases (status);
    CREATE INDEX IF NOT EXISTS idx_purchases_paid_at   ON purchases (paid_at);
    CREATE INDEX IF NOT EXISTS idx_purchases_driver_ref ON purchases (driver_ref);

    CREATE TABLE IF NOT EXISTS verifier_decisions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      collective      TEXT NOT NULL,
      position        TEXT NOT NULL,
      decision        TEXT NOT NULL CHECK (decision IN ('verified', 'rejected', 'expired')),
      reason          TEXT,
      grain_ref       TEXT,
      envelope        TEXT NOT NULL,
      audit_block     TEXT NOT NULL,
      audit_position  TEXT NOT NULL,
      decided_at      TEXT NOT NULL,
      expires_at      TEXT,
      UNIQUE (collective, position, decision)
    );

    CREATE INDEX IF NOT EXISTS idx_verifier_decisions_lookup ON verifier_decisions (collective, position);
    CREATE INDEX IF NOT EXISTS idx_verifier_decisions_expiry ON verifier_decisions (decision, expires_at);
  `);

  return db;
}

export interface VerifierDecisionRow {
  id: number;
  collective: string;
  position: string;
  decision: 'verified' | 'rejected' | 'expired';
  reason: string | null;
  grain_ref: string | null;
  envelope: string;
  audit_block: string;
  audit_position: string;
  decided_at: string;
  expires_at: string | null;
}
