// Purchase flow.
//
//   GET  /buy/:id           → minimal HTML form to enter buyer_agent_id
//                              (Accept: application/json returns product info)
//   POST /buy/:id           → creates a pending purchase + driver checkout;
//                              form-encoded → 303 redirect to checkout_url;
//                              JSON          → returns { checkout_url, purchase_id }
//   GET  /buy/:id/success   → static success page (grain arrives async)
//   GET  /buy/:id/cancel    → static cancel page
//
// Per protocol §4 the *client* (xstream-play) handles the buy affordance
// and redirect; this route is the issuer-side endpoint that affordance
// points at. Both browser-form and JSON-API flows are supported so a
// fork without xstream-play in front still works.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import type { AppContext, Product } from '../types.js';
import type { PurchaseRow } from '../lib/db.js';
import * as rateLimit from '../lib/rate-limit.js';
import { verifyGift } from '../drivers/gift.js';
import { issueGrain } from '../lib/issuance.js';

const AGENT_ID_RE = /^[a-zA-Z0-9_:.\-]{2,128}$/;
const DEFAULT_BEACH = 'https://beach.happyseaurchin.com';

function findProduct(ctx: AppContext, id: string): Product | undefined {
  return ctx.config.products.find((p) => p.id === id);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });
}

function buyFormCopy(product: Product): { intro: string; submit: string; help: string } {
  switch (product.price.driver) {
    case 'stripe':
      return {
        intro: '',
        submit: 'Continue to payment',
        help: 'You will be redirected to Stripe to complete payment. The grain arrives on the substrate after Stripe confirms the charge.',
      };
    case 'gift':
      return {
        intro:
          'This product is invitation-only. To redeem, an authorised gifter signs a message authorising you and submits it via the API. The browser form is read-only here.',
        submit: 'Submit (gift signature required)',
        help:
          'Browser submission alone will fail with <code>missing_gift_fields</code>. See the README for the gift redemption flow.',
      };
    case 'manual':
      return {
        intro: '',
        submit: 'Request bank transfer instructions',
        help: 'You will receive bank details and a reference number. Once the operator confirms receipt, the grain is issued.',
      };
    case 'invoice':
      return {
        intro: 'Priced per job and paid by invoice. Ask the operator for one; the invoice arrives by email, and the grain is issued when it is paid.',
        submit: '',
        help: '',
      };
  }
}

// A slipped letter or capital sends a ticket to the wrong name, and a phone
// capitalises a first letter unasked. So the handle box speaks one quiet line
// when the typed name is a letter or two — or only a capital, a space or a
// hyphen — from a name standing in MORE blocks on the beach: "Did you mean …?".
// Never a gate; the button works as before. The measure is the one the beach's
// own pages take (happyseaurchin-home theme.js, xstream-bsp
// src/kernel/name-standing.ts): the last segment of every block name, so a
// person with a shell and a pool but no passport still stands.
function nameCheckScript(beach: string): string {
  return `<script>
(function(){
  var INDEX = ${JSON.stringify(beach.replace(/\/+$/, '') + '/.well-known/pscale-beach')};
  var box = document.getElementById('buyer_agent_id'), line = document.getElementById('near');
  function tail(n){ return n.slice(n.lastIndexOf(':') + 1); }
  function fold(s){ return s.toLowerCase().replace(/[\\s\\-_]/g, ''); }
  function edits(a, b){
    if (Math.abs(a.length - b.length) > 2) return 9;
    var prev = [], i, j;
    for (j = 0; j <= b.length; j++) prev.push(j);
    for (i = 1; i <= a.length; i++){
      var cur = [i];
      for (j = 1; j <= b.length; j++)
        cur.push(Math.min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + (a[i-1] !== b[j-1] ? 1 : 0)));
      prev = cur;
    }
    return prev[b.length];
  }
  function standing(blocks){
    var m = new Map();
    blocks.forEach(function(b){
      if (b.indexOf(':') < 0 || /^(archive|sed|grain):/.test(b)) return;
      var t = tail(b); m.set(t, (m.get(t) || 0) + 1);
    });
    return m;
  }
  function near(name, stand){
    var f = fold(name), mine = stand.get(name) || 0, best = null;
    stand.forEach(function(n, o){
      if (o === name || n <= mine) return;
      var same = fold(o) === f;
      if (!same && (Math.min(name.length, o.length) < 5 || edits(f, fold(o)) > 2)) return;
      if (!best || n > best.n) best = { name: o, n: n };
    });
    return best ? { name: best.name, mine: mine } : null;
  }
  var stand = null, asked = false;
  function say(){
    var name = box.value.trim();
    var hit = stand && name.length >= 3 ? near(name, stand) : null;
    if (!hit){ line.hidden = true; return; }
    line.textContent = '';
    line.appendChild(document.createTextNode(hit.mine
      ? name + ' stands in ' + hit.mine + ' block' + (hit.mine === 1 ? '' : 's') + ' on the beach, a near name in more. Did you mean '
      : 'Nothing stands under ' + name + ' on the beach. Did you mean '));
    var pick = document.createElement('a');
    pick.href = '#'; pick.textContent = hit.name;
    pick.addEventListener('click', function(e){ e.preventDefault(); box.value = hit.name; say(); box.focus(); });
    line.appendChild(pick);
    line.appendChild(document.createTextNode('? Or carry on, if this name is yours.'));
    line.hidden = false;
  }
  function ask(){
    if (asked) return; asked = true;
    fetch(INDEX, { cache: 'no-store' }).then(function(r){ return r.ok ? r.json() : null; })
      .then(function(ix){ if (ix && ix.blocks){ stand = standing(ix.blocks); say(); } })
      .catch(function(){ /* the form stands without it */ });
  }
  box.addEventListener('focus', ask);
  box.addEventListener('input', function(){ ask(); say(); });
})();
</script>`;
}

function renderBuyForm(product: Product, beach: string): string {
  const copy = buyFormCopy(product);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(product.title ?? 'Buy — ' + product.id)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    label { display: block; margin: 1rem 0 0.25rem; font-size: 0.9rem; color: #555; }
    input { width: 100%; padding: 0.5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
    .meta { background: #f6f6f6; padding: 0.75rem 1rem; border-radius: 4px; font-size: 0.9rem; }
    .meta dt { color: #666; }
    .meta dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 0.75rem; margin: 0; }
    button { margin-top: 1rem; padding: 0.6rem 1.25rem; background: #111; color: #fff; border: 0; border-radius: 4px; font-size: 1rem; cursor: pointer; }
    .help { color: #777; font-size: 0.85rem; margin-top: 0.75rem; }
    .near { color: #8a5a00; font-size: 0.85rem; margin: 0.5rem 0 0; }
    .intro { background: #fff8e1; border-left: 3px solid #d4a017; padding: 0.75rem 1rem; margin: 1rem 0; font-size: 0.9rem; }
    a { color: #555; }
    code { background: #f0f0f0; padding: 0.1rem 0.3rem; border-radius: 3px; }
  </style>
</head>
<body>
  <p><a href="/">&larr; back to catalogue</a></p>
  <h1>${escapeHtml(product.title ?? product.id)}</h1>
  <p>${escapeHtml(product.description)}</p>
  <div class="meta">
    <dl>
      <dt>face</dt><dd>${escapeHtml(product.face)}</dd>
      <dt>scope</dt><dd>${escapeHtml(product.scope)}</dd>
      <dt>duration</dt><dd>${product.duration_days >= 36500 ? 'for good' : product.duration_days + ' days'}</dd>
      ${product.tier ? `<dt>tier</dt><dd>${escapeHtml(product.tier)}</dd>` : ''}
      <dt>collective</dt><dd><code>${escapeHtml(product.sed)}</code></dd>
      <dt>payment</dt><dd>${escapeHtml(product.price.driver)}</dd>
    </dl>
  </div>
  ${copy.intro ? `<div class="intro">${escapeHtml(copy.intro)}</div>` : ''}
  ${product.price.driver === 'invoice' ? '' : `<form method="post" action="/buy/${encodeURIComponent(product.id)}">
    <label for="buyer_agent_id">Your handle on the beach — exactly as it stands, capitals and all. The ticket goes to that name.</label>
    <input id="buyer_agent_id" name="buyer_agent_id" type="text" required pattern="[a-zA-Z0-9_:.\\-]{2,128}" placeholder="e.g. brisa" autocapitalize="none" autocorrect="off" spellcheck="false" />
    <p id="near" class="near" hidden></p>
    ${product.bank_transfer ? emailField() : ''}
    <button type="submit">${escapeHtml(copy.submit)}</button>
    <p class="help">${copy.help}</p>
  </form>
  ${nameCheckScript(beach)}`}
</body>
</html>`;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function emailField(): string {
  return `<label for="email">Your email — Stripe sends your receipt here, and can give you bank transfer details if you would rather pay that way than by card.</label>
    <input id="email" name="email" type="email" required autocomplete="email" />`;
}

// A product that offers a bank transfer needs the payer's email before
// checkout. Someone arriving with only a handle (from a page with a handle
// box alone) is asked for it here, in one step, and carries on.
function renderEmailStep(product: Product, buyer_agent_id: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(product.title ?? product.id)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    label { display: block; margin: 1rem 0 0.25rem; font-size: 0.9rem; color: #555; }
    input { width: 100%; padding: 0.5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
    button { margin-top: 1rem; padding: 0.6rem 1.25rem; background: #111; color: #fff; border: 0; border-radius: 4px; font-size: 1rem; cursor: pointer; }
    .who { color: #555; }
  </style>
</head>
<body>
  <h1>${escapeHtml(product.title ?? product.id)}</h1>
  <p class="who">For <strong>${escapeHtml(buyer_agent_id)}</strong>.</p>
  <form method="post" action="/buy/${encodeURIComponent(product.id)}">
    <input type="hidden" name="buyer_agent_id" value="${escapeHtml(buyer_agent_id)}" />
    ${emailField()}
    <button type="submit">Continue to payment</button>
  </form>
</body>
</html>`;
}

function renderStatus(title: string, message: string, productId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; text-align: center; }
    h1 { margin-bottom: 0.5rem; }
    p { color: #555; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  <p><a href="/buy/${encodeURIComponent(productId)}">&larr; back to product</a> · <a href="/">catalogue</a></p>
</body>
</html>`;
}

export function purchaseRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get('/buy/:id', (c) => {
    const product = findProduct(ctx, c.req.param('id'));
    if (!product) return c.json({ error: 'unknown_product' }, 404);
    if (c.req.header('accept')?.includes('application/json')) {
      return c.json({
        id: product.id,
        sed: product.sed,
        face: product.face,
        scope: product.scope,
        duration_days: product.duration_days,
        ...(product.tier ? { tier: product.tier } : {}),
        description: product.description,
        ...(product.title ? { title: product.title } : {}),
        driver: product.price.driver,
      });
    }
    return c.html(renderBuyForm(product, ctx.config.agent.beach ?? DEFAULT_BEACH));
  });

  app.post('/buy/:id', async (c) => {
    const product = findProduct(ctx, c.req.param('id'));
    if (!product) return c.json({ error: 'unknown_product' }, 404);

    const contentType = c.req.header('content-type') ?? '';
    const isJson = contentType.includes('application/json');
    const body: Record<string, unknown> = isJson
      ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
      : (await c.req.parseBody()) as Record<string, unknown>;

    const buyer_agent_id = typeof body.buyer_agent_id === 'string' ? body.buyer_agent_id : undefined;
    if (!buyer_agent_id || !AGENT_ID_RE.test(buyer_agent_id)) {
      return c.json({ error: 'invalid_buyer_agent_id' }, 400);
    }
    if (buyer_agent_id === ctx.config.agent.id || buyer_agent_id === bareId(ctx.config.agent.id)) {
      return c.json({ error: 'cannot_buy_from_self' }, 400);
    }

    // Pre-check rate-limit so we don't take payment / issue gifts we'd
    // have to refund. Authoritative re-check happens immediately before
    // grain issuance.
    const decision = rateLimit.check(ctx.db, product);
    if (!decision.allowed) {
      ctx.log.warn(
        { product_id: product.id, reason: decision.reason, hour_count: decision.hour_count, day_count: decision.day_count },
        'purchase rejected by rate limit (pre-checkout)',
      );
      return c.json({ error: 'rate_limited', reason: decision.reason }, 429);
    }

    switch (product.price.driver) {
      case 'stripe': {
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        if (email && !EMAIL_RE.test(email)) return c.json({ error: 'invalid_email' }, 400);
        if (product.bank_transfer && !email && !isJson) return c.html(renderEmailStep(product, buyer_agent_id));
        return handleStripe(ctx, c, product, buyer_agent_id, isJson, email || undefined);
      }
      case 'gift':   return handleGift(ctx, c, product, buyer_agent_id, body);
      case 'manual': return handleManual(ctx, c, product, buyer_agent_id);
      case 'invoice': return c.json({ error: 'invoice_only', note: 'priced per job — the operator raises an invoice' }, 400);
    }
  });

  app.get('/buy/:id/success', (c) => {
    const product = findProduct(ctx, c.req.param('id'));
    if (!product) return c.json({ error: 'unknown_product' }, 404);
    return c.html(
      renderStatus(
        'Payment received',
        product.bank_transfer
          ? 'Thanks. If you paid by card, your ticket arrives on the beach shortly. If you chose a bank transfer, send it with the details Stripe gave you: your ticket arrives when the money lands. You can close this tab.'
          : 'Thanks. Your ticket grain will arrive on the substrate shortly. You can close this tab.',
        product.id,
      ),
    );
  });

  app.get('/buy/:id/cancel', (c) => {
    const product = findProduct(ctx, c.req.param('id'));
    if (!product) return c.json({ error: 'unknown_product' }, 404);
    return c.html(renderStatus('Payment cancelled', 'No charge was made.', product.id));
  });

  return app;
}

function bareId(prefixed: string): string {
  return prefixed.startsWith('agent:') ? prefixed.slice('agent:'.length) : prefixed;
}

// ── per-driver handlers ────────────────────────────────────────────────

async function handleStripe(
  ctx: AppContext,
  c: Context,
  product: Product,
  buyer_agent_id: string,
  isJson: boolean,
  email?: string,
): Promise<Response> {
  if (product.price.driver !== 'stripe') throw new Error('handleStripe called with wrong driver');
  if (!ctx.stripeDriver) {
    ctx.log.error({ product_id: product.id }, 'stripe driver not configured');
    return c.json({ error: 'stripe_not_configured' }, 500);
  }

  const purchase_id = randomUUID();
  const created_at = new Date().toISOString();

  let driver_ref: string;
  let checkout_url: string;
  try {
    const result = await ctx.stripeDriver.createCheckout({
      purchase_id,
      product,
      buyer_agent_id,
      ...(email ? { email } : {}),
      success_url: `${ctx.env.PUBLIC_URL}/buy/${encodeURIComponent(product.id)}/success?purchase=${purchase_id}`,
      cancel_url: `${ctx.env.PUBLIC_URL}/buy/${encodeURIComponent(product.id)}/cancel?purchase=${purchase_id}`,
    });
    driver_ref = result.driver_ref;
    checkout_url = result.checkout_url;
  } catch (err) {
    ctx.log.error({ err: (err as Error).message, product_id: product.id }, 'stripe checkout creation failed');
    return c.json({ error: 'checkout_creation_failed' }, 502);
  }

  ctx.db
    .prepare(
      `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, driver_ref, created_at)
       VALUES (?, ?, ?, 'pending', 'stripe', ?, ?)`,
    )
    .run(purchase_id, product.id, buyer_agent_id, driver_ref, created_at);

  ctx.log.info(
    { purchase_id, product_id: product.id, buyer_agent_id, driver_ref },
    'purchase pending; redirecting to Stripe Checkout',
  );

  if (isJson) return c.json({ checkout_url, purchase_id });
  return c.redirect(checkout_url, 303);
}

async function handleGift(
  ctx: AppContext,
  c: Context,
  product: Product,
  buyer_agent_id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  if (product.price.driver !== 'gift') throw new Error('handleGift called with wrong driver');
  const gifter_agent_id = typeof body.gifter_agent_id === 'string' ? body.gifter_agent_id : '';
  const issued_at = typeof body.issued_at === 'string' ? body.issued_at : '';
  const nonce = typeof body.nonce === 'string' ? body.nonce : '';
  const signature = typeof body.signature === 'string' ? body.signature : '';
  if (!gifter_agent_id || !issued_at || !nonce || !signature) {
    return c.json({ error: 'missing_gift_fields', required: ['gifter_agent_id', 'issued_at', 'nonce', 'signature'] }, 400);
  }
  if (!product.price.gifters.includes(gifter_agent_id)) {
    return c.json({ error: 'gifter_not_authorised' }, 403);
  }

  // Idempotency: nonce already redeemed?
  const existing = ctx.db
    .prepare("SELECT id, status FROM purchases WHERE driver = 'gift' AND driver_ref = ?")
    .get(nonce) as { id: string; status: string } | undefined;
  if (existing) {
    if (existing.status === 'paid') {
      return c.json({ error: 'gift_already_redeemed', purchase_id: existing.id }, 409);
    }
    return c.json({ error: 'gift_redemption_in_progress', purchase_id: existing.id }, 409);
  }

  const verified = await verifyGift({
    client: ctx.mcp,
    product_id: product.id,
    buyer_agent_id,
    gifter_agent_id,
    issued_at,
    nonce,
    signature,
  });
  if (!verified.ok) {
    ctx.log.warn(
      { product_id: product.id, gifter_agent_id, buyer_agent_id, reason: verified.reason },
      'gift verification rejected',
    );
    return c.json({ error: 'gift_verification_failed', reason: verified.reason }, 400);
  }

  const purchase_id = randomUUID();
  const now = new Date();
  ctx.db
    .prepare(
      `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, driver_ref, created_at, notes)
       VALUES (?, ?, ?, 'pending', 'gift', ?, ?, ?)`,
    )
    .run(purchase_id, product.id, buyer_agent_id, nonce, now.toISOString(), `gift from ${gifter_agent_id}`);
  const purchase = ctx.db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchase_id) as PurchaseRow;

  const result = await issueGrain({ ctx, purchase, product, now });
  if (!result.ok) {
    return c.json({ error: 'grain_issuance_failed', reason: result.reason, purchase_id }, 502);
  }
  return c.json({ ok: true, purchase_id, pair_id: result.pair_id, issuer_side: result.issuer_side });
}

async function handleManual(
  ctx: AppContext,
  c: Context,
  product: Product,
  buyer_agent_id: string,
): Promise<Response> {
  if (product.price.driver !== 'manual') throw new Error('handleManual called with wrong driver');
  const purchase_id = randomUUID();
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, created_at)
       VALUES (?, ?, ?, 'pending', 'manual', ?)`,
    )
    .run(purchase_id, product.id, buyer_agent_id, now);
  ctx.log.info(
    { purchase_id, product_id: product.id, buyer_agent_id },
    'manual purchase pending; awaiting operator mark-paid',
  );
  return c.json({
    ok: true,
    purchase_id,
    status: 'pending',
    instructions: product.price.instructions ?? null,
    reference: purchase_id,
  });
}
