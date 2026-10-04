// Stripe payment driver — Checkout Session for purchase, webhook signature
// verification for confirmation. All other Stripe operations (refunds in
// M5) happen on the raw client which we expose for routes that need it.
//
// We never write Stripe secrets to logs; pino's redact list in lib/log.ts
// covers STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.

import Stripe from 'stripe';
import type {
  CreateCheckoutInput,
  CreateCheckoutResult,
  CreateInvoiceInput,
  CreateInvoiceResult,
  PaidLookup,
  CreateRefundInput,
  CreateRefundResult,
  PaymentDriver,
  VerifyWebhookInput,
  WebhookEvent,
} from './types.js';
import { WebhookSignatureError } from './types.js';

// The invoice custom field that names the payer's handle on the beach. An
// invoice the machine raises carries it, a customer the machine creates holds
// it as a default (so the operator's own dashboard invoices for them carry it
// too), and a paid invoice the machine did not raise is ticketed by it.
export const BEACH_HANDLE_FIELD = 'Beach handle';
const BEACH_HANDLE_RE = /^\s*beach\s*handle\s*$/i;

export type StripeDriverOptions = {
  secretKey: string;
  webhookSecret: string;
  stripe?: Stripe;
};

export class StripeDriver implements PaymentDriver {
  readonly name = 'stripe';
  readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(opts: StripeDriverOptions) {
    // No apiVersion pin — let the SDK use its built-in default so the build
    // doesn't fight Stripe SDK upgrades.
    this.stripe = opts.stripe ?? new Stripe(opts.secretKey);
    this.webhookSecret = opts.webhookSecret;
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    if (input.product.price.driver !== 'stripe') {
      throw new Error(`product ${input.product.id} is not a Stripe product`);
    }
    // The purchase_id round-trips via metadata so the webhook can find the row.
    const metadata = {
      purchase_id: input.purchase_id,
      product_id: input.product.id,
      buyer_agent_id: input.buyer_agent_id,
    };
    // A recurring price makes the checkout a subscription. The first period
    // arrives as checkout.session.completed like any payment; each later
    // period arrives as invoice.paid carrying the subscription's metadata.
    const price = await this.stripe.prices.retrieve(input.product.price.stripe_price_id);
    const recurring = price.type === 'recurring';
    const base: Stripe.Checkout.SessionCreateParams = {
      mode: recurring ? 'subscription' : 'payment',
      line_items: [{ price: input.product.price.stripe_price_id, quantity: 1 }],
      success_url: input.success_url,
      cancel_url: input.cancel_url,
      metadata,
      ...(recurring ? { subscription_data: { metadata } } : {}),
      ...(input.product.register_buyer
        ? {
            custom_fields: [{
              key: 'line',
              label: { type: 'custom' as const, custom: 'A line for the founders list (optional)' },
              type: 'text' as const,
              optional: true,
              text: { maximum_length: 140 },
            }],
          }
        : {}),
    };
    // A bank transfer beside the card: it needs the payer as a customer before
    // checkout, and Stripe offers it only once switched on for the account —
    // until then (or for a subscription) the same checkout runs on its own.
    let session: Stripe.Checkout.Session;
    if (input.product.bank_transfer && input.email && !recurring) {
      const customer = await this.customerFor(input.email, input.buyer_agent_id);
      try {
        session = await this.stripe.checkout.sessions.create({
          ...base,
          customer: customer.id,
          payment_method_types: ['card', 'customer_balance'],
          payment_method_options: {
            customer_balance: { funding_type: 'bank_transfer', bank_transfer: { type: 'gb_bank_transfer' } },
          },
        });
      } catch (err) {
        if (!/customer_balance/i.test((err as Error).message)) throw err;
        session = await this.stripe.checkout.sessions.create({ ...base, customer: customer.id });
      }
    } else {
      session = await this.stripe.checkout.sessions.create(base);
    }
    if (!session.url) {
      throw new Error('Stripe Checkout Session created but had no url');
    }
    return { checkout_url: session.url, driver_ref: session.id };
  }

  async createRefund(input: CreateRefundInput): Promise<CreateRefundResult> {
    // driver_ref is a Checkout Session id (cs_…) or, for a raised invoice or
    // a subscription period, an invoice id (in_…). Refunds attach to the
    // payment_intent behind either — retrieve to find it. A subscription's
    // first period is a session whose payment sits on its invoice.
    let invoice_id: string | null = input.driver_ref.startsWith('in_') ? input.driver_ref : null;
    let payment_intent: string | null = null;
    if (!invoice_id) {
      const session = await this.stripe.checkout.sessions.retrieve(input.driver_ref);
      if (session.payment_intent) {
        payment_intent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id;
      } else if (session.invoice) {
        invoice_id = typeof session.invoice === 'string' ? session.invoice : session.invoice.id;
      }
    }
    if (invoice_id) {
      const invoice = (await this.stripe.invoices.retrieve(invoice_id)) as unknown as {
        payment_intent?: string | { id: string } | null;
      };
      const pi = invoice.payment_intent;
      payment_intent = typeof pi === 'string' ? pi : pi?.id ?? null;
    }
    if (!payment_intent) {
      throw new Error(`Stripe ${input.driver_ref} has no payment_intent (was it paid?)`);
    }
    const refund = await this.stripe.refunds.create({
      payment_intent,
      ...(input.reason ? { metadata: { reason: input.reason } } : {}),
    });
    return { refund_id: refund.id };
  }

  // The payer as a Stripe customer, found by email or made — a new one holds
  // its Beach handle as an invoice default, so later invoices carry it too.
  private async customerFor(email: string, handle: string, name?: string): Promise<{ id: string }> {
    const found = await this.stripe.customers.list({ email, limit: 1 });
    if (found.data[0]) return found.data[0];
    return this.stripe.customers.create({
      email,
      ...(name ? { name } : {}),
      metadata: { handle },
      invoice_settings: { custom_fields: [{ name: BEACH_HANDLE_FIELD, value: handle }] },
    });
  }

  async createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
    if (input.product.price.driver !== 'invoice') {
      throw new Error(`product ${input.product.id} is not an invoice product`);
    }
    const { currency, days_until_due } = input.product.price;
    const customer = await this.customerFor(input.email, input.buyer_agent_id, input.name);
    const invoice = await this.stripe.invoices.create({
      customer: customer.id,
      collection_method: 'send_invoice',
      days_until_due: days_until_due ?? 14,
      currency,
      description: input.description,
      pending_invoice_items_behavior: 'exclude',
      custom_fields: [{ name: BEACH_HANDLE_FIELD, value: input.buyer_agent_id }],
      metadata: {
        purchase_id: input.purchase_id,
        product_id: input.product.id,
        buyer_agent_id: input.buyer_agent_id,
      },
    });
    await this.stripe.invoiceItems.create({
      customer: customer.id,
      invoice: invoice.id!,
      amount: input.amount_cents,
      currency,
      description: input.description,
    });
    if (!input.send) return { driver_ref: invoice.id!, hosted_url: null };
    await this.stripe.invoices.finalizeInvoice(invoice.id!);
    const sent = await this.stripe.invoices.sendInvoice(invoice.id!);
    return { driver_ref: invoice.id!, hosted_url: sent.hosted_invoice_url ?? null };
  }

  // Read a session (cs_…) or an invoice (in_…) back from Stripe: whether it is
  // paid, and what it sold to whom — its metadata, or an invoice's Beach handle
  // field, or a renewal's subscription metadata.
  async lookupPaid(driver_ref: string): Promise<PaidLookup | null> {
    if (driver_ref.startsWith('cs_')) {
      const s = await this.stripe.checkout.sessions.retrieve(driver_ref);
      return {
        paid: s.payment_status === 'paid',
        purchase_id: s.metadata?.purchase_id ?? null,
        product_id: s.metadata?.product_id ?? null,
        buyer_agent_id: s.metadata?.buyer_agent_id ?? null,
        amount_cents: s.amount_total ?? 0,
        currency: (s.currency ?? 'usd').toLowerCase(),
      };
    }
    if (driver_ref.startsWith('in_')) {
      const inv = await this.stripe.invoices.retrieve(driver_ref);
      const loose = inv as unknown as {
        subscription_details?: { metadata?: Record<string, string> | null } | null;
        parent?: { subscription_details?: { metadata?: Record<string, string> | null } | null } | null;
      };
      const md = { ...(loose.parent?.subscription_details?.metadata ?? loose.subscription_details?.metadata ?? {}), ...(inv.metadata ?? {}) };
      const field = (inv.custom_fields ?? []).find((f) => BEACH_HANDLE_RE.test(f.name));
      return {
        paid: inv.status === 'paid',
        purchase_id: md.purchase_id ?? null,
        product_id: md.product_id ?? null,
        buyer_agent_id: (md.buyer_agent_id ?? field?.value ?? '').trim() || null,
        amount_cents: inv.amount_paid ?? 0,
        currency: (inv.currency ?? 'usd').toLowerCase(),
      };
    }
    return null;
  }

  verifyWebhook(input: VerifyWebhookInput): WebhookEvent {
    if (!input.signature) {
      throw new WebhookSignatureError('missing Stripe-Signature header');
    }
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(input.rawBody, input.signature, this.webhookSecret);
    } catch (err) {
      throw new WebhookSignatureError(`signature verification failed: ${(err as Error).message}`);
    }
    if (event.type === 'invoice.paid') {
      return parseInvoicePaid(event.data.object as Stripe.Invoice);
    }
    // A card pays at once (checkout.session.completed, paid). A bank transfer
    // completes the checkout unpaid and pays when the money lands:
    // checkout.session.async_payment_succeeded, the same session, now paid.
    if (event.type === 'checkout.session.async_payment_failed') {
      return { kind: 'ignored', reason: 'async-payment-failed' };
    }
    if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') {
      return { kind: 'ignored', reason: `event-type:${event.type}` };
    }
    const session = event.data.object as Stripe.Checkout.Session;
    const purchase_id = session.metadata?.purchase_id;
    if (!purchase_id) {
      return { kind: 'ignored', reason: 'no-purchase-id-in-metadata' };
    }
    if (session.payment_status !== 'paid') {
      return { kind: 'ignored', reason: `payment-status:${session.payment_status}` };
    }
    return {
      kind: 'checkout-completed',
      driver_ref: session.id,
      purchase_id,
      amount_cents: session.amount_total ?? 0,
      currency: (session.currency ?? 'usd').toLowerCase(),
      ...(session.metadata?.product_id ? { product_id: session.metadata.product_id } : {}),
      ...(session.metadata?.buyer_agent_id ? { buyer_agent_id: session.metadata.buyer_agent_id } : {}),
      ...(lineOf(session) ? { line: lineOf(session) } : {}),
    };
  }
}

// invoice.paid carries three things we act on: an invoice we raised
// (billing_reason 'manual', our purchase_id in its metadata) — treated like a
// completed checkout; an invoice the operator made in the dashboard ('manual',
// no purchase_id, the payer named in the "Beach handle" field); and a
// subscription's later period ('subscription_cycle'). The
// first period ('subscription_create') is already handled by the checkout.
// Subscription metadata sits at invoice.subscription_details (API ≤ acacia)
// or invoice.parent.subscription_details (basil on); the webhook endpoint's
// own API version decides which, so read both.
export function parseInvoicePaid(invoice: Stripe.Invoice): WebhookEvent {
  const amount_cents = invoice.amount_paid ?? 0;
  const currency = (invoice.currency ?? 'usd').toLowerCase();
  const driver_ref = invoice.id ?? '';
  if (invoice.billing_reason === 'subscription_cycle') {
    const loose = invoice as unknown as {
      subscription_details?: { metadata?: Record<string, string> | null } | null;
      parent?: { subscription_details?: { metadata?: Record<string, string> | null } | null } | null;
    };
    const md = loose.parent?.subscription_details?.metadata ?? loose.subscription_details?.metadata ?? {};
    if (!md.product_id || !md.buyer_agent_id) {
      return { kind: 'ignored', reason: 'renewal-without-metadata' };
    }
    return { kind: 'renewal', driver_ref, product_id: md.product_id, buyer_agent_id: md.buyer_agent_id, amount_cents, currency };
  }
  if (invoice.billing_reason === 'manual') {
    const purchase_id = invoice.metadata?.purchase_id;
    if (purchase_id) {
      return {
        kind: 'checkout-completed',
        driver_ref,
        purchase_id,
        amount_cents,
        currency,
        ...(invoice.metadata?.product_id ? { product_id: invoice.metadata.product_id } : {}),
        ...(invoice.metadata?.buyer_agent_id ? { buyer_agent_id: invoice.metadata.buyer_agent_id } : {}),
      };
    }
    // Made by hand in the dashboard: the handle rides the "Beach handle" field.
    const field = (invoice.custom_fields ?? []).find((f) => BEACH_HANDLE_RE.test(f.name));
    const buyer_agent_id = (field?.value ?? invoice.metadata?.buyer_agent_id ?? '').trim();
    if (!buyer_agent_id) return { kind: 'ignored', reason: 'invoice:manual-without-beach-handle' };
    return {
      kind: 'dashboard-invoice',
      driver_ref,
      product_id: invoice.metadata?.product_id ?? null,
      buyer_agent_id,
      amount_cents,
      currency,
    };
  }
  return { kind: 'ignored', reason: `invoice:${invoice.billing_reason ?? 'unknown'}` };
}

// The buyer's own line, asked for at checkout by a register_buyer product:
// one line, trimmed, its newlines folded to spaces.
function lineOf(session: Stripe.Checkout.Session): string | undefined {
  const v = session.custom_fields?.find((f) => f.key === 'line')?.text?.value;
  const line = (v ?? '').replace(/\s+/g, ' ').trim();
  return line || undefined;
}
