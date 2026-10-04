// Public catalogue — read-only product list.
//
// Two responses from one route, content-negotiated:
//   GET / Accept: application/json → { agent_id, products: [...] }
//   GET / Accept: text/html (default) → minimal HTML page
//
// No write paths here. The buy affordance per protocol §4.1 is
// `${PUBLIC_URL}/share/${product_id}` (/buy/ answers too) — wired in M3.

import { SHARE } from './purchase.js';
import { Hono } from 'hono';
import type { AppContext } from '../types.js';

type PublicProduct = {
  id: string;
  sed: string;
  face: string;
  scope: string;
  duration_days: number;
  tier?: string;
  description: string;
  driver: string;
  buy_url: string;
};

function publicView(ctx: AppContext): { agent_id: string; products: PublicProduct[] } {
  const products = ctx.config.products.map<PublicProduct>((p) => ({
    id: p.id,
    sed: p.sed,
    face: p.face,
    scope: p.scope,
    duration_days: p.duration_days,
    ...(p.tier ? { tier: p.tier } : {}),
    description: p.description,
    driver: p.price.driver,
    buy_url: `${ctx.env.PUBLIC_URL}${SHARE}/${encodeURIComponent(p.id)}`,
  }));
  return { agent_id: ctx.config.agent.id, products };
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

function renderHtml(view: { agent_id: string; products: PublicProduct[] }): string {
  const items = view.products
    .map(
      (p) => `      <li class="product">
        <h2>${escapeHtml(p.id)}</h2>
        <p class="description">${escapeHtml(p.description)}</p>
        <dl>
          <dt>face</dt><dd>${escapeHtml(p.face)}</dd>
          <dt>scope</dt><dd>${escapeHtml(p.scope)}</dd>
          <dt>duration</dt><dd>${p.duration_days} days</dd>
          ${p.tier ? `<dt>tier</dt><dd>${escapeHtml(p.tier)}</dd>` : ''}
          <dt>collective</dt><dd><code>${escapeHtml(p.sed)}</code></dd>
          <dt>payment</dt><dd>${escapeHtml(p.driver)}</dd>
        </dl>
        <a class="buy" href="${escapeHtml(p.buy_url)}">Buy</a>
      </li>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Tickets — ${escapeHtml(view.agent_id)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    header p { color: #555; margin: 0; }
    h1 { margin-bottom: 0.25rem; }
    ul { list-style: none; padding: 0; }
    .product { border: 1px solid #ddd; padding: 1rem 1.25rem; margin-bottom: 1rem; border-radius: 6px; }
    .product h2 { margin-top: 0; font-family: ui-monospace, monospace; font-size: 1rem; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 0.75rem; margin: 0.75rem 0; font-size: 0.9rem; }
    dt { color: #666; }
    dd { margin: 0; }
    code { font-size: 0.85em; }
    .buy { display: inline-block; padding: 0.5rem 1rem; background: #111; color: #fff; text-decoration: none; border-radius: 4px; }
    .buy:hover { background: #333; }
    footer { margin-top: 3rem; color: #888; font-size: 0.85rem; }
  </style>
</head>
<body>
  <header>
    <h1>Tickets</h1>
    <p>Issued by <code>${escapeHtml(view.agent_id)}</code></p>
  </header>
  <main>
    <ul>
${items || '      <li>No products configured.</li>'}
    </ul>
  </main>
  <footer>
    <p>Reference ticketing agent — <a href="https://github.com/pscale-commons/ticketing-agent">pscale-commons/ticketing-agent</a></p>
  </footer>
</body>
</html>`;
}

export function catalogueRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const view = publicView(ctx);
    const accept = c.req.header('accept') ?? '';
    if (accept.includes('application/json')) {
      return c.json(view);
    }
    return c.html(renderHtml(view));
  });

  return app;
}
