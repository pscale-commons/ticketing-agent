// The machine keeps talking to bsp-mcp across bsp-mcp's redeploys (a forgotten
// session answers 404 → open a fresh one, retry once), reads whole blocks that
// carry trailing lines, and can re-issue a ticket whose payment was taken but
// whose grain failed to land.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpClient, parseWholeBlock } from '../src/lib/pscale.js';
import { createApp } from '../src/server.js';
import { fakeCtx, fakeMcpClient, fakeStripeDriver, TEST_PRODUCTS } from './helpers.js';
import type { PurchaseRow } from '../src/lib/db.js';

test('parseWholeBlock: reads the block and ignores the lines bsp-mcp adds after it', () => {
  const block = { _: 'a block', '1': { _: 'a line with } and\nan escaped newline' } };
  const text = '[whole block]\n' + JSON.stringify(block, null, 2) +
    '\n[here now — 1 other at this block in the last 120s: someone looked at the root (2s ago)]\n\nnow · 2026-09-30T17:54:15Z · 2026335277';
  assert.deepEqual(parseWholeBlock(text), block);
  assert.deepEqual(parseWholeBlock('[whole block]\n{}\n[here now — you alone]'), {});
  assert.deepEqual(parseWholeBlock('[whole block]\n{"_":"compact"}\nnow · x'), { _: 'compact' });
  assert.equal(parseWholeBlock('block "x" not found'), null);
});

test('createMcpClient: a forgotten session (404) opens a fresh one and the call succeeds', async () => {
  let sessions = 0;
  const live = new Set<string>();
  const seen: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const msg = JSON.parse(String(init.body));
    const sid = (init.headers as Record<string, string>)['Mcp-Session-Id'];
    seen.push(`${msg.method}${sid ? '@' + sid : ''}`);
    if (msg.method === 'initialize') {
      const id = `s${++sessions}`;
      live.add(id);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }), {
        status: 200, headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': id },
      });
    }
    if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (!live.has(sid)) return new Response('{}', { status: 404, statusText: 'Not Found' });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok ' + sid }] } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const client = await createMcpClient('https://bsp.test/mcp/v1', { fetchImpl });
  assert.equal(await client.callTool('bsp', {}), 'ok s1');
  live.clear(); // bsp-mcp redeploys and forgets every session
  assert.equal(await client.callTool('bsp', {}), 'ok s2');
  assert.deepEqual(seen, [
    'initialize', 'notifications/initialized@s1', 'tools/call@s1',
    'tools/call@s1', 'initialize', 'notifications/initialized@s2', 'tools/call@s2',
  ]);
});

const AUTH = { authorization: 'Bearer admin-token', 'content-type': 'application/json' };

function withRow(status: string) {
  const mcp = fakeMcpClient();
  const ctx = fakeCtx({ stripeDriver: fakeStripeDriver(), mcp, products: TEST_PRODUCTS });
  ctx.db
    .prepare(
      `INSERT INTO purchases (id, product_id, buyer_agent_id, status, driver, driver_ref, created_at, amount_cents, currency, notes)
       VALUES ('p1', 'character-30d', 'brisa', ?, 'stripe', 'in_1', '2026-09-30T17:51:14Z', 1000, 'gbp', 'grain establish failed: 404')`,
    )
    .run(status);
  return { ctx, app: createApp(ctx), mcp };
}

test('admin/reissue: a failed purchase gets its ticket and is marked paid, keeping what it was paid', async () => {
  const { ctx, app, mcp } = withRow('failed');
  const res = await app.request('/admin/reissue/p1', { method: 'POST', headers: AUTH, body: '{}' });
  assert.equal(res.status, 200);
  const row = ctx.db.prepare("SELECT * FROM purchases WHERE id = 'p1'").get() as PurchaseRow;
  assert.equal(row.status, 'paid');
  assert.ok(row.grain_pair_id);
  assert.equal(row.amount_cents, 1000);
  assert.match(row.notes ?? '', /^reissued .* after: grain establish failed: 404/);
  assert.equal(mcp.calls.filter((c) => c.name === 'pscale_grain_reach').length, 1);
  const again = await app.request('/admin/reissue/p1', { method: 'POST', headers: AUTH, body: '{}' });
  assert.equal(((await again.json()) as { idempotent: boolean }).idempotent, true);
});

test('admin/reissue: only a failed purchase is re-issued', async () => {
  const { app, mcp } = withRow('pending');
  const res = await app.request('/admin/reissue/p1', { method: 'POST', headers: AUTH, body: '{}' });
  assert.equal(res.status, 400);
  assert.equal(mcp.calls.length, 0);
  const missing = await app.request('/admin/reissue/nope', { method: 'POST', headers: AUTH, body: '{}' });
  assert.equal(missing.status, 404);
});
