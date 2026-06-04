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
  CreateRefundInput,
  CreateRefundResult,
  PaymentDriver,
  VerifyWebhookInput,
  WebhookEvent,
} from './types.js';
import { WebhookSignatureError } from './types.js';

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
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: input.product.price.stripe_price_id, quantity: 1 }],
      success_url: input.success_url,
      cancel_url: input.cancel_url,
      // The purchase_id round-trips via metadata so the webhook can find the row.
      metadata: {
        purchase_id: input.purchase_id,
        product_id: input.product.id,
        buyer_agent_id: input.buyer_agent_id,
      },
      // Stripe ties the payment to a customer email if supplied; for M3 we omit it.
    });
    if (!session.url) {
      throw new Error('Stripe Checkout Session created but had no url');
    }
    return { checkout_url: session.url, driver_ref: session.id };
  }

  async createRefund(input: CreateRefundInput): Promise<CreateRefundResult> {
    // driver_ref is the Checkout Session id. Refunds attach to the
    // payment_intent the session created — retrieve to find it.
    const session = await this.stripe.checkout.sessions.retrieve(input.driver_ref);
    if (!session.payment_intent) {
      throw new Error(`Stripe session ${input.driver_ref} has no payment_intent (was the session paid?)`);
    }
    const payment_intent =
      typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id;
    const refund = await this.stripe.refunds.create({
      payment_intent,
      ...(input.reason ? { metadata: { reason: input.reason } } : {}),
    });
    return { refund_id: refund.id };
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
    if (event.type !== 'checkout.session.completed') {
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
    };
  }
}
