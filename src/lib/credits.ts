// Credits — a ticket's credits turned into credits the moment it is paid, and
// every move of them kept, in order, in one block only this machine writes:
// credits:<issuer>, the issuer's book (lane credits.games.1, 25 Nov 2026).
//
// WHY A BOOK, AND WHY THE ISSUER KEEPS IT. A balance read from lines a holder
// writes about themselves holds nothing: one receipt in your own passport's 6.2
// makes credit, one credit can be given twice, any grain with a credits= line
// mints (pool:experience-points 2, shown in memory against bsp-mcp's own
// computeBalance). Credits that money bought need one keeper of their order, and
// the one who took the money is already trusted with it. So this machine writes
// every move, in the order it takes them, under its own latch; a holder asks for
// a move with a gift written at their own passport under their own key (sand-v2
// 3, the out-ledger), and nobody's credits are a number kept anywhere: anyone
// reads the book and works them out (sand-v2 3.4, computed on read).
//
// EACH LINE IS A GIFT in sand-v2's shape (3.1), one recipient a line, with its
// time at 3 and its recipient at 5 where a passport's gift has them the other
// way round: the book is an accumulator, and the beach's accumulator law makes
// an appended entry's 3 its time, stamping any 3 that is not one (ways of the
// beach, pscale-beach stampAppendTimestamp: 'position 3 authoritative for recency').
//   _  what moved, to whom and why, in words (a payer of a fund or a point is never named in
//      them; the grain in 6 still names the buyer to anyone who tests a handle — README)
//   1  the move's id: a purchase, the holder's gift (its probe id), or a free go
//   2  the credits it moves
//   3  when it was written
//   4  the point it moved on (a family, as migration), where it has one
//   5  to: a handle, or fund:<product> (a pool for others' goes)
//   6  from: grain:<pair_id> (a ticket's credits), fund:<product>, or a handle
//   7  what warrants it: 'ticket <purchase id>' for a ticket's credits; the handle
//      a free go was drawn for; 'passport:<holder> 6.3<slot>' for a holder's gift
//
// A holder's credits are what came to them less what went from them, in the
// book's order. A ticket's credits come only from a purchase this machine was
// paid for; a holder's credits move only on a gift they wrote under their own
// key; a fund's go only for a handle under its cap. One process keeps the order
// (the in-process queue below): two machines writing one book would need a lock
// of their own first.

import { randomUUID } from 'node:crypto';
import { deriveCollectivePassphrase } from './audit.js';
import type { AppContext, Product } from '../types.js';

type Block = Record<string, unknown>;

export type Line = {
  slot: string;
  voicing: string;
  id: string;
  n: number;
  to: string;
  point: string;
  at: string;
  from: string;
  warrant: string;
};

const DEFAULT_BEACH = 'https://beach.happyseaurchin.com';
const HANDLE_RE = /^[A-Za-z0-9_-]{2,64}$/;
const POINT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const bookOf = (issuer: string): string => `credits:${issuer}`;
export const fundOf = (product: Product): string => `fund:${product.id}`;
export const issuerOfProduct = (ctx: AppContext, product: Product): string =>
  product.issuer ?? ctx.config.agent.id.replace(/^agent:/, '');
const beachOf = (ctx: AppContext): string => (ctx.config.agent.beach ?? DEFAULT_BEACH).replace(/\/+$/, '');
const round = (x: number): number => Math.round(x * 100) / 100;

// ── reading ─────────────────────────────────────────────────────────────

export function reader(ctx: AppContext): (name: string) => Promise<Block | null> {
  if (ctx.readBlock) return ctx.readBlock;
  const base = `${beachOf(ctx)}/.well-known/pscale-beach?block=`;
  return async (name) => {
    const r = await fetch(base + encodeURIComponent(name), { headers: { Accept: 'application/json' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`the beach answered ${r.status} for ${name}`);
    const b = (await r.json()) as unknown;
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Block) : null;
  };
}

// Every line of a book with its slot, the digits walked from the root (an
// underscore read as 0), in the order the beach allocated them: an accumulator
// counts without zeros and supernests when its nine fill, so a longer slot is a
// later one, and within a length the digits read in order.
export function linesOf(book: Block | null): Line[] {
  const out: Line[] = [];
  (function walk(node: unknown, path: string) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const e = node as Block;
    if (typeof e['1'] === 'string' && typeof e['2'] === 'number' && typeof e['5'] === 'string' && typeof e['6'] === 'string') {
      out.push({
        slot: path.replace(/^0+/, '') || '0',
        voicing: typeof e['_'] === 'string' ? e['_'] : '',
        id: e['1'],
        n: e['2'],
        to: e['5'],
        point: typeof e['4'] === 'string' ? e['4'] : '',
        at: typeof e['3'] === 'string' ? e['3'] : '',
        from: e['6'],
        warrant: typeof e['7'] === 'string' ? e['7'] : '',
      });
      return;
    }
    for (const k of Object.keys(e)) if (k === '_' || /^[1-9]$/.test(k)) walk(e[k], path + (k === '_' ? '0' : k));
  })(book, '');
  return out.sort((a, b) => a.slot.length - b.slot.length || (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
}

// What every holder (a handle or a fund) holds, read in the book's order. A
// ticket's grain is a source, never a holder.
export function balances(lines: Line[]): Map<string, number> {
  const held = new Map<string, number>();
  for (const l of lines) {
    if (!l.from.startsWith('grain:')) held.set(l.from, round((held.get(l.from) ?? 0) - l.n));
    held.set(l.to, round((held.get(l.to) ?? 0) + l.n));
  }
  return held;
}

// The makers a point's law names, on the line that opens 'makers:' wherever it
// stands ('makers: happyseaurchin, matthew — split equally …'), as the plug
// finds 'board:' (ways:arcade). Contract type one splits by them, equally
// (spine:experience-points 1.11118, at David's word: 'Just go for makers split equally').
export async function makersOf(read: (name: string) => Promise<Block | null>, point: string): Promise<string[]> {
  if (!POINT_RE.test(point)) return [];
  const law = await read(`function:${point}`);
  let line = '';
  (function find(n: unknown) {
    if (line) return;
    if (typeof n === 'string') { if (/^\s*makers\s*:/i.test(n)) line = n; return; }
    if (n && typeof n === 'object' && !Array.isArray(n)) for (const k of ['_', ...'123456789']) if (k in (n as Block)) find((n as Block)[k]);
  })(law);
  if (!line) return [];
  const named = line.replace(/^\s*makers\s*:/i, '').split(/\s[—–-]\s|[.;(]/)[0] ?? '';
  return [...new Set(named.split(/,|\band\b/).map((s) => s.trim()).filter((h) => HANDLE_RE.test(h)))];
}

// n split equally, to the cent; what rounding leaves goes to the first named.
export function equally(n: number, handles: string[]): Array<{ to: string; n: number }> {
  if (!handles.length) return [];
  const each = Math.floor((n * 100) / handles.length) / 100;
  const rest = round(n - each * handles.length);
  return handles.map((to, i) => ({ to, n: round(i === 0 ? each + rest : each) }));
}

// A split as an address answers it, { split: { <handle>: share } }, shares
// summing to anything: contract types two and three read a family's XP there.
// The address may ask for what it needs to split by: {credits} (or {n}),
// {buyer}, {at} (the moment paid) and {id} (the purchase) are filled in, each
// encoded; a quiet buyer's product leaves {buyer} out of its address.
export function splitAddress(url: string, fill: { credits: number; buyer: string; at: string; id?: string }): string {
  const v: Record<string, string> = { credits: String(fill.credits), n: String(fill.credits), buyer: fill.buyer, at: fill.at, id: fill.id ?? '' };
  return url.replace(/\{(credits|n|buyer|at|id)\}/g, (_, k: string) => encodeURIComponent(v[k] ?? ''));
}

async function fetchedSplit(url: string, n: number): Promise<Array<{ to: string; n: number }>> {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`the split at ${url} answered ${r.status}`);
  const body = (await r.json()) as { split?: Record<string, unknown> };
  const parts = Object.entries(body.split ?? {}).filter(([h, s]) => (HANDLE_RE.test(h) || /^fund:/.test(h)) && typeof s === 'number' && s > 0) as Array<[string, number]>;
  const total = parts.reduce((t, [, s]) => t + s, 0);
  if (!parts.length || !(total > 0)) throw new Error(`the split at ${url} names nobody`);
  const out = parts.map(([to, s]) => ({ to, n: Math.floor((n * 100 * s) / total) / 100 }));
  out[0]!.n = round(out[0]!.n + n - out.reduce((t, p) => t + p.n, 0));
  return out;
}

// A holder's own gift at their passport's 6.3 (sand-v2 3.1), found by its probe
// id, with the slot that reaches it: the warrant for moving their credits.
export function giftOf(passport: Block | null, probe: string): { slot: string; n: number; to: string; voicing: string } | null {
  const ledger = passport && typeof passport['6'] === 'object' ? ((passport['6'] as Block)['3'] as Block | undefined) : undefined;
  let found: { slot: string; n: number; to: string; voicing: string } | null = null;
  (function walk(node: unknown, path: string) {
    if (found || !node || typeof node !== 'object' || Array.isArray(node)) return;
    const e = node as Block;
    if (path && typeof e['1'] === 'string' && typeof e['2'] === 'number' && typeof e['3'] === 'string') {
      if (e['1'] === probe) found = { slot: path, n: e['2'], to: e['3'], voicing: typeof e['_'] === 'string' ? e['_'] : '' };
      return;
    }
    for (const k of '123456789') if (k in e) walk(e[k], path + k);
  })(ledger, '');
  return found;
}

// ── writing, one move at a time, in the order they arrive ──────────────

const queues = new Map<string, Promise<unknown>>();
function inOrder<T>(issuer: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(issuer) ?? Promise.resolve()).then(fn, fn);
  queues.set(issuer, next.catch(() => undefined));
  return next;
}

// THE BOOK IS FOUNDED LATCHED, the first time a move finds none: the founding
// write carries no secret, so over a book already latched it is refused and
// changes nothing, and only where nothing stands does it create the block.
async function found(ctx: AppContext, issuer: string): Promise<void> {
  const block = bookOf(issuer);
  const key = deriveCollectivePassphrase(ctx.env.TICKET_AGENT_SECRET, block, 'entry');
  await ctx.mcp.callTool('bsp', {
    agent_id: beachOf(ctx), block, new_lock: key,
    content: { _: `The book of ${issuer}'s credits: every credit its tickets carry, from the moment each is paid, and every move of them after, one line a move to each recipient, in the order this ticket machine took them. Written by the machine alone, under its own key; anyone reads what each holder holds by adding what came to them and taking away what went from them, in this order (pscale-commons/ticketing-agent, lib/credits.ts).` },
  }).catch(() => '');
}

async function write(ctx: AppContext, issuer: string, line: Omit<Line, 'slot'>): Promise<string> {
  const beach = beachOf(ctx), block = bookOf(issuer);
  const key = deriveCollectivePassphrase(ctx.env.TICKET_AGENT_SECRET, block, 'entry');
  const content: Block = { _: line.voicing, '1': line.id, '2': line.n, '3': line.at, '5': line.to, '6': line.from };
  if (line.point) content['4'] = line.point;
  if (line.warrant) content['7'] = line.warrant;
  const text = await ctx.mcp.callTool('bsp', { agent_id: beach, block, append: true, content, secret: key });
  const m = /→\s*(?:slot\s*)?([0-9.]+)/.exec(text);   // the beach answers '→ slot 1', an older router '→ 1'
  if (!m) throw new Error(`the book ${block} took no line: ${text.slice(0, 200)}`);
  return m[1]!;
}

// The book as a move finds it: its lines in order, founded first where none stands.
async function bookFor(ctx: AppContext, issuer: string, read: (name: string) => Promise<Block | null>): Promise<Line[]> {
  const book = await read(bookOf(issuer));
  if (!book) await found(ctx, issuer);
  return linesOf(book);
}

const today = (d: Date): string => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

// ── a ticket's credits, the moment it is paid ──────────────────────────

export type MintResult = { ok: true; lines: number } | { ok: false; reason: string };

// How many credits a ticket carries: its fixed n, or per_pound times what was
// paid (a ticket of any amount), to the whole credit.
export function creditsFor(product: Product, amount_cents?: number): number | null {
  const c = product.credits;
  if (!c) return null;
  if (c.n !== undefined) return c.n;
  if (c.per_pound !== undefined && typeof amount_cents === 'number' && amount_cents > 0) return Math.floor((amount_cents / 100) * c.per_pound);
  return null;
}

export async function mintAtPayment(
  ctx: AppContext,
  product: Product,
  purchase_id: string,
  buyer: string,
  pair_id: string,
  now: Date = new Date(),
  amount_cents?: number,
): Promise<MintResult> {
  const c = product.credits;
  if (!c) return { ok: false, reason: 'no credits on this product' };
  const n = creditsFor(product, amount_cents);
  if (!n) return { ok: false, reason: 'credits per pound, and no amount paid to count them by' };
  const issuer = issuerOfProduct(ctx, product);
  const read = reader(ctx);
  const title = product.title ?? product.id;
  return inOrder(issuer, async () => {
    try {
      const book = await bookFor(ctx, issuer, read);
      const done = new Set(book.filter((l) => l.id === purchase_id).map((l) => l.to));
      let to: Array<{ to: string; n: number }>;
      let words: (r: { to: string; n: number }) => string;
      const point = c.point ?? (c.to.startsWith('makers:') ? c.to.slice('makers:'.length) : '');
      if (c.to === 'buyer') {
        to = [{ to: buyer, n }];
        words = (r) => `${r.n} credits for ${r.to}, from their ticket '${title}', paid ${today(now)}`;
      } else if (c.to === 'pool') {
        to = [{ to: fundOf(product), n }];
        words = (r) => `${r.n} credits into the fund for others' goes of ${point}, from a ticket '${title}' paid ${today(now)}: ${Math.floor(r.n / (c.go ?? 1))} goes for players who put nothing in`;
      } else if (c.to.startsWith('makers:')) {
        to = equally(n, await makersOf(read, point));
        if (!to.length) throw new Error(`function:${point} names no makers`);
        words = (r) => `${r.n} of ${n} credits to ${r.to}, a maker of ${point} (split equally), from a ticket '${title}' paid ${today(now)}`;
      } else if (c.to.startsWith('https://')) {
        const url = splitAddress(c.to, { credits: n, buyer, at: now.toISOString(), id: purchase_id });
        to = await fetchedSplit(url, n);
        words = (r) => `${r.n} of ${n} credits to ${r.to}, by the split at ${c.to.split('?')[0]} read ${now.toISOString()}, from a ticket '${title}' paid ${today(now)}`;
      } else {
        to = [{ to: c.to, n }];
        words = (r) => `${r.n} credits to ${r.to}, from a ticket '${title}' paid ${today(now)}`;
      }
      let lines = 0;
      for (const r of to) {
        if (done.has(r.to)) continue;
        await write(ctx, issuer, {
          voicing: words(r), id: purchase_id, n: r.n, to: r.to, point,
          at: now.toISOString(), from: `grain:${pair_id}`, warrant: `ticket ${purchase_id}`,
        });
        lines++;
      }
      return { ok: true as const, lines };
    } catch (err) {
      return { ok: false as const, reason: (err as Error).message };
    }
  });
}

// ── a free go, drawn from a fund others filled ─────────────────────────

export type DrawResult =
  | { ok: true; free_left: number; fund_left: number; makers: string[] }
  | { ok: false; error: string; free_left?: number; fund_left?: number };

export async function draw(ctx: AppContext, product: Product, holder: string, now: Date = new Date()): Promise<DrawResult> {
  const c = product.credits;
  if (!c || c.to !== 'pool' || !c.point || !c.free || !c.go) return { ok: false, error: 'not_a_fund' };
  if (!HANDLE_RE.test(holder)) return { ok: false, error: 'invalid_holder' };
  const issuer = issuerOfProduct(ctx, product), fund = fundOf(product), read = reader(ctx);
  const { point, free, go } = c;
  return inOrder(issuer, async () => {
    const book = await bookFor(ctx, issuer, read);
    const left = balances(book).get(fund) ?? 0;
    const had = new Set(book.filter((l) => l.from === fund && l.warrant === holder).map((l) => l.id)).size;
    if (had >= free) return { ok: false as const, error: 'no_free_goes_left', free_left: 0, fund_left: left };
    if (left < go) return { ok: false as const, error: 'fund_empty', free_left: free - had, fund_left: left };
    const makers = await makersOf(read, point);
    if (!makers.length) return { ok: false as const, error: 'point_names_no_makers' };
    const id = `free-${randomUUID()}`;
    for (const r of equally(go, makers)) {
      await write(ctx, issuer, {
        voicing: `a free go of ${point} for ${holder}, their ${had + 1} of ${free}: ${r.n} credit to ${r.to}, a maker, from the fund others filled`,
        id, n: r.n, to: r.to, point, at: now.toISOString(), from: fund, warrant: holder,
      });
    }
    return { ok: true as const, free_left: free - had - 1, fund_left: round(left - go), makers };
  });
}

// ── a holder's own gift: a go paid, or credits given ───────────────────

export type SpendResult =
  | { ok: true; balance: number; already?: boolean; to: string[] }
  | { ok: false; error: string; balance?: number };

// The holder wrote a gift at passport:<holder> 6.3 under their own key — to
// 'function:<point>' (a go of that point: its makers, equally) or to a handle —
// and asks this machine to move it. It moves only what the book says they hold.
export async function spend(ctx: AppContext, issuer: string, holder: string, probe: string, now: Date = new Date()): Promise<SpendResult> {
  if (!HANDLE_RE.test(holder)) return { ok: false, error: 'invalid_holder' };
  if (!/^[A-Za-z0-9_:.\-]{1,128}$/.test(probe)) return { ok: false, error: 'invalid_probe' };
  const read = reader(ctx);
  return inOrder(issuer, async () => {
    const book = await bookFor(ctx, issuer, read);
    const held = balances(book).get(holder) ?? 0;
    const before = book.filter((l) => l.id === probe && l.from === holder);
    if (before.length) return { ok: true as const, balance: held, already: true, to: before.map((l) => l.to) };
    const gift = giftOf(await read(`passport:${holder}`), probe);
    if (!gift) return { ok: false as const, error: 'no_gift', balance: held };
    if (!(gift.n > 0)) return { ok: false as const, error: 'nothing_given', balance: held };
    if (gift.n > held) return { ok: false as const, error: 'short', balance: held };
    let to: Array<{ to: string; n: number }>, point = '', words: (r: { to: string; n: number }) => string;
    const m = /^function:([a-z0-9][a-z0-9-]{0,63})$/.exec(gift.to);
    if (m) {
      point = m[1]!;
      to = equally(gift.n, await makersOf(read, point));
      if (!to.length) return { ok: false as const, error: 'point_names_no_makers', balance: held };
      words = (r) => `${holder} paid ${gift.n} for a go of ${point}: ${r.n} to ${r.to}, a maker`;
    } else if (HANDLE_RE.test(gift.to) && gift.to !== holder) {
      to = [{ to: gift.to, n: gift.n }];
      words = (r) => `${holder} gave ${r.n} to ${r.to}`;
    } else {
      return { ok: false as const, error: 'gift_names_no_one', balance: held };
    }
    for (const r of to) {
      await write(ctx, issuer, {
        voicing: words(r), id: probe, n: r.n, to: r.to, point,
        at: now.toISOString(), from: holder, warrant: `passport:${holder} 6.3${gift.slot}`,
      });
    }
    return { ok: true as const, balance: round(held - gift.n), to: to.map((r) => r.to) };
  });
}

// The issuers whose books this machine keeps: every credit-bearing product's.
export function creditIssuers(ctx: AppContext): Set<string> {
  return new Set(ctx.config.products.filter((p) => p.credits).map((p) => issuerOfProduct(ctx, p)));
}
