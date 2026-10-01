import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { AgentConfig } from '../types.js';

const faceSchema = z.enum(['character', 'author', 'designer']);

const rateLimitSchema = z.object({
  max_per_hour: z.number().int().positive(),
  max_per_day: z.number().int().positive(),
});

const priceSchema = z.discriminatedUnion('driver', [
  z.object({ driver: z.literal('stripe'), stripe_price_id: z.string().min(1) }),
  z.object({ driver: z.literal('gift'), gifters: z.array(z.string().min(1)).min(1) }),
  z.object({ driver: z.literal('manual'), instructions: z.string().optional() }),
  z.object({
    driver: z.literal('invoice'),
    currency: z.string().regex(/^[a-z]{3}$/, 'currency is a lowercase ISO code, e.g. gbp'),
    days_until_due: z.number().int().positive().optional(),
  }),
]);

const productSchema = z.object({
  id: z.string().min(1),
  issuer: z.string().regex(/^[a-zA-Z0-9_\-]{2,64}$/, 'issuer is a bare handle').optional(),
  sed: z.string().regex(/^sed:/, 'sed must start with "sed:"'),
  face: faceSchema,
  scope: z.string().min(1),
  duration_days: z.number().int().positive(),
  title: z.string().min(1).optional(),
  register_buyer: z.boolean().optional(),
  list_block: z.string().regex(/^[a-z0-9][a-z0-9:\-]{1,127}$/, 'list_block is a block name').optional(),
  buyer: z.enum(['handle', 'character']).optional(),
  bank_transfer: z.boolean().optional(),
  tier: z.enum(['soft', 'medium', 'hard']).optional(),
  rate_limit: rateLimitSchema.optional(),
  price: priceSchema,
  description: z.string().min(1),
});

const configSchema = z.object({
  agent: z.object({
    id: z.string().regex(/^agent:/, 'agent.id must start with "agent:"'),
    secret_env: z.string().min(1),
    pscale_mcp_url: z.string().url(),
    beach: z.string().url().optional(),
  }),
  products: z.array(productSchema).min(1),
  verifier: z
    .object({
      watch: z.array(z.string()).optional(),
      poll_interval_seconds: z.number().int().positive().default(5),
    })
    .optional(),
});

export function loadConfig(path: string): AgentConfig {
  const raw = readFileSync(path, 'utf-8');
  const parsed = configSchema.safeParse(parseYaml(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid config at ${path}:\n${issues}`);
  }
  const ids = new Set<string>();
  for (const p of parsed.data.products) {
    if (ids.has(p.id)) throw new Error(`Duplicate product id: ${p.id}`);
    ids.add(p.id);
  }
  return parsed.data;
}
