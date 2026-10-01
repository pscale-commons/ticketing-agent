// Shared test helpers — fake context builders + a fake MCP client + a fake
// payment driver. Keeps every test self-contained so we never need a live
// MCP or live Stripe to run `npm test`.

import Database from 'better-sqlite3';
import { openDb } from '../src/lib/db.js';
import { GiftDriver } from '../src/drivers/gift.js';
import { ManualDriver } from '../src/drivers/manual.js';
import type { AgentConfig, AppContext, Env, Product } from '../src/types.js';
import type {
  CreateCheckoutInput,
  CreateCheckoutResult,
  CreateRefundInput,
  CreateRefundResult,
  PaymentDriver,
  VerifyWebhookInput,
  WebhookEvent,
  CreateInvoiceInput,
  CreateInvoiceResult,
  PaidLookup,
} from '../src/drivers/types.js';
import { WebhookSignatureError } from '../src/drivers/types.js';
import type { McpClient } from '../src/lib/pscale.js';

const noopLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
} as unknown as AppContext['log'];

export const TEST_PRODUCTS: Product[] = [
  {
    id: 'character-30d',
    sed: 'sed:test-cast',
    face: 'character',
    scope: 'frame:test',
    duration_days: 30,
    description: 'A character ticket for testing',
    rate_limit: { max_per_hour: 2, max_per_day: 5 },
    price: { driver: 'stripe', stripe_price_id: 'price_test' },
  },
  {
    id: 'designer-90d',
    sed: 'sed:test-designers',
    face: 'designer',
    scope: 'beach:test.host',
    duration_days: 90,
    tier: 'hard',
    description: 'A designer ticket for testing',
    price: { driver: 'gift', gifters: ['agent:host'] },
  },
];

export type FakeCtxOverrides = {
  products?: Product[];
  stripeDriver?: PaymentDriver | null;
  mcp?: McpClient;
  agentId?: string;
};

export function fakeCtx(overrides: FakeCtxOverrides = {}): AppContext {
  const env: Env = {
    TICKET_AGENT_SECRET: 'test-secret',
    TICKET_AGENT_CONFIG: './config/agent.yaml',
    ADMIN_TOKEN: 'admin-token',
    PORT: 8080,
    PUBLIC_URL: 'https://tickets.test',
    LOG_LEVEL: 'info',
    PURCHASES_DB_PATH: ':memory:',
  };
  const config: AgentConfig = {
    agent: {
      id: overrides.agentId ?? 'agent:tickets-test',
      secret_env: 'TICKET_AGENT_SECRET',
      pscale_mcp_url: 'https://example/mcp/v1',
    },
    products: overrides.products ?? TEST_PRODUCTS,
  };
  return {
    env,
    log: noopLog,
    config,
    db: openDb(':memory:'),
    mcp: overrides.mcp ?? fakeMcpClient(),
    stripeDriver: overrides.stripeDriver === undefined ? fakeStripeDriver() : overrides.stripeDriver,
    giftDriver: new GiftDriver(),
    manualDriver: new ManualDriver(),
  };
}

// ── fake MCP client ────────────────────────────────────────────────────
//
// Models a tiny subset of bsp-mcp's behaviour: per-block JSON storage,
// pscale_settle that allocates positions and auto-creates the sed: block.
// Enough to exercise grain.ts, audit.ts, and verifier.ts without a real MCP.

export type FakeMcpCall = { name: string; args: Record<string, unknown> };

export type FakeMcpClient = McpClient & {
  calls: FakeMcpCall[];
  setResponse(toolName: string, response: string | ((args: Record<string, unknown>) => string)): void;
  setBlock(agent_id: string, block: string, content: Record<string, unknown>): void;
  getBlock(agent_id: string, block: string): Record<string, unknown> | undefined;
};

function blockKey(agent_id: string, block: string): string {
  return `${agent_id}/${block}`;
}

function nextPosition(existing: Record<string, unknown>): string {
  // sed:-style allocation: 1..9 then 11..19, 21..29, ..., 99, 111... — no zeros.
  for (let n = 1; n <= 9; n++) {
    if (!(String(n) in existing)) return String(n);
  }
  for (let prefix = 1; prefix <= 9; prefix++) {
    for (let suffix = 1; suffix <= 9; suffix++) {
      const pos = `${prefix}${suffix}`;
      if (!(pos in existing)) return pos;
    }
  }
  throw new Error('fakeMcpClient: ran out of positions (test fixture)');
}

export function fakeMcpClient(): FakeMcpClient {
  const calls: FakeMcpCall[] = [];
  const responses = new Map<string, string | ((args: Record<string, unknown>) => string)>();
  const blocks = new Map<string, Record<string, unknown>>();

  // Default pscale_grain_reach — recognisable reach response. bsp-mcp takes
  // bare `handle`/`partner_handle` (NOT agent_id/partner_agent_id), and the
  // ack carries `grain:`-prefixed pair_id and `@<beach>`-suffixed sides.
  responses.set(
    'pscale_grain_reach',
    (args) => {
      const issuer = args['handle'] as string;
      const buyer = args['partner_handle'] as string;
      const pair_id = `fake${issuer.slice(0, 6)}${buyer.slice(0, 6)}`.replace(/[^a-f0-9]/gi, '0').slice(0, 16).padEnd(16, '0');
      const issuerSide = issuer < buyer ? '1' : '2';
      const partnerSide = issuerSide === '1' ? '2' : '1';
      const beach = 'https://beach.test';
      return [
        'Grain reached (awaiting partner acceptance at the federated grain).',
        '',
        `pair_id:        grain:${pair_id} on ${beach}`,
        `your side:      grain:${pair_id}:${issuerSide}@${beach}`,
        `partner side:   grain:${pair_id}:${partnerSide}@${beach}`,
        'state:          established',
      ].join('\n');
    },
  );

  // Default bsp — read whole block from in-memory map; minimal write support.
  responses.set('bsp', (args) => {
    const agent_id = args['agent_id'] as string;
    const block = args['block'] as string;
    const spindle = args['spindle'] as string | null | undefined;
    const content = args['content'];
    if (content !== undefined) {
      // Write — only handle terminal point writes for now; extend per test need.
      const key = blockKey(agent_id, block);
      const cur = blocks.get(key) ?? {};
      if (typeof spindle !== 'string' || spindle.length === 0) {
        throw new Error('fakeMcpClient bsp: write requires non-empty spindle');
      }
      const path = spindle.split('.');
      let target = cur as Record<string, unknown>;
      for (let i = 0; i < path.length - 1; i++) {
        const seg = path[i]!;
        const next = target[seg];
        if (typeof next !== 'object' || next === null) {
          target[seg] = {};
        }
        target = target[seg] as Record<string, unknown>;
      }
      target[path[path.length - 1]!] = content;
      blocks.set(key, cur);
      return `[wrote point @ "${spindle}" pscale ${args['pscale_attention'] ?? '?'}]`;
    }
    const key = blockKey(agent_id, block);
    if (!blocks.has(key)) {
      // Empty/absent block — return a shape parseWholeBlockText handles.
      return '[whole block]\n{}';
    }
    if (!spindle) {
      return `[whole block]\n${JSON.stringify(blocks.get(key), null, 2)}`;
    }
    return '';
  });

  // Default pscale_settle — auto-creates the collective on first call (the
  // old pscale_create_collective tool is gone), allocates the next position,
  // stores the declaration. Mirrors the live ack "Registered at sed:<coll>:<pos> on <beach>".
  responses.set('pscale_settle', (args) => {
    const collective = args['collective'] as string;
    const declaration = args['declaration'] as string;
    const key = blockKey(`sed:${collective}`, collective);
    const cur = blocks.get(key) ?? { _: `sed: collective ${collective}` };
    const pos = nextPosition(cur);
    cur[pos] = { _: declaration };
    blocks.set(key, cur);
    return `Settled at sed:${collective}:${pos} on https://beach.test.`;
  });

  return {
    calls,
    setResponse(name, response) {
      responses.set(name, response);
    },
    setBlock(agent_id, block, content) {
      blocks.set(blockKey(agent_id, block), content);
    },
    getBlock(agent_id, block) {
      return blocks.get(blockKey(agent_id, block));
    },
    async callTool(name, args) {
      calls.push({ name, args });
      const r = responses.get(name);
      if (r === undefined) {
        throw new Error(`fakeMcpClient: no response configured for tool ${name}`);
      }
      return typeof r === 'function' ? r(args) : r;
    },
    async close() {},
  };
}

// ── fake payment driver ────────────────────────────────────────────────

export type FakeStripeDriver = PaymentDriver & {
  webhookEvents: Map<string, WebhookEvent>;
  createdSessions: CreateCheckoutInput[];
  refunds: CreateRefundInput[];
  invoices: CreateInvoiceInput[];
  lookups: Map<string, PaidLookup>;
  failNextCheckout?: Error;
  failNextRefund?: Error;
};

export function fakeStripeDriver(): FakeStripeDriver {
  const webhookEvents = new Map<string, WebhookEvent>();
  const createdSessions: CreateCheckoutInput[] = [];
  const refunds: CreateRefundInput[] = [];
  const invoices: CreateInvoiceInput[] = [];
  const lookups = new Map<string, PaidLookup>();

  const driver: FakeStripeDriver = {
    webhookEvents,
    createdSessions,
    refunds,
    invoices,
    lookups,
    name: 'stripe',
    async lookupPaid(driver_ref: string): Promise<PaidLookup | null> {
      return lookups.get(driver_ref) ?? null;
    },
    async createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
      invoices.push(input);
      const driver_ref = `in_${input.purchase_id}`;
      return { driver_ref, hosted_url: input.send ? `https://invoice.stripe.test/${driver_ref}` : null };
    },
    async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
      if (driver.failNextCheckout) {
        const err = driver.failNextCheckout;
        driver.failNextCheckout = undefined;
        throw err;
      }
      createdSessions.push(input);
      return {
        checkout_url: `https://checkout.stripe.test/cs_${input.purchase_id}`,
        driver_ref: `cs_${input.purchase_id}`,
      };
    },
    async createRefund(input: CreateRefundInput): Promise<CreateRefundResult> {
      if (driver.failNextRefund) {
        const err = driver.failNextRefund;
        driver.failNextRefund = undefined;
        throw err;
      }
      refunds.push(input);
      return { refund_id: `re_${input.driver_ref}` };
    },
    verifyWebhook(input: VerifyWebhookInput): WebhookEvent {
      // Fake auth: keyed by the signature header verbatim. Tests register
      // events via `driver.webhookEvents.set(signatureHeader, event)`.
      if (!input.signature) {
        throw new WebhookSignatureError('missing signature');
      }
      const ev = webhookEvents.get(input.signature);
      if (!ev) {
        throw new WebhookSignatureError(`no event registered for signature ${input.signature}`);
      }
      return ev;
    },
  };
  return driver;
}
