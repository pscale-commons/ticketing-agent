// The two moves a page asks this machine for (lib/credits.ts keeps the book):
//
//   POST /credits/draw   { product, holder }        a free go for holder, drawn from
//                                                    the product's fund, under its cap
//   POST /credits/spend  { issuer, holder, probe }  move the gift holder wrote at
//                                                    passport:<holder> 6.3 (its probe id):
//                                                    a go of a point, or credits given
//
// A page on another origin calls them, so they answer CORS; neither takes a key,
// a card or a cookie: a draw is open to any handle up to the fund's cap (free
// goes are for people who put nothing in), and a spend's authority is the gift
// standing in the holder's own passport, which only their key could write.

import { Hono } from 'hono';
import type { AppContext } from '../types.js';
import { draw, spend, creditIssuers } from '../lib/credits.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '600',
};

const STATUS: Record<string, 400 | 404 | 409 | 500> = {
  invalid_holder: 400, invalid_probe: 400, not_a_fund: 404, unknown_product: 404, unknown_issuer: 404, no_gift: 404,
  no_free_goes_left: 409, fund_empty: 409, short: 409, nothing_given: 400, gift_names_no_one: 400,
  point_names_no_makers: 500,
};

export function creditsRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.options('/credits/:verb', (c) => new Response(null, { status: 204, headers: CORS }));

  app.post('/credits/draw', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const product = ctx.config.products.find((p) => p.id === body.product);
    if (!product) return c.json({ ok: false, error: 'unknown_product' }, 404, CORS);
    const r = await draw(ctx, product, String(body.holder ?? ''));
    if (r.ok) ctx.log.info({ product_id: product.id, holder: body.holder, free_left: r.free_left, fund_left: r.fund_left }, 'free go drawn');
    return c.json(r, r.ok ? 200 : STATUS[r.error] ?? 400, CORS);
  });

  app.post('/credits/spend', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const issuer = String(body.issuer ?? '');
    if (!creditIssuers(ctx).has(issuer)) return c.json({ ok: false, error: 'unknown_issuer' }, 404, CORS);
    const r = await spend(ctx, issuer, String(body.holder ?? ''), String(body.probe ?? ''));
    if (r.ok && !r.already) ctx.log.info({ issuer, holder: body.holder, probe: body.probe, to: r.to }, 'gift moved');
    return c.json(r, r.ok ? 200 : STATUS[r.error] ?? 400, CORS);
  });

  return app;
}
