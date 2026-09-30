// Payment driver interface — kept minimal so M6 (gift, manual) can slot in
// without a refactor. Each driver knows how to: create a checkout (return a
// URL the buyer is redirected to + a driver_ref to look the purchase up by
// later), and verify and parse a webhook payload.
//
// `gift` and `manual` will not implement createCheckout the same way (gift
// is a signed-message verification; manual returns bank-transfer
// instructions + an admin mark-paid endpoint). The interface here is shaped
// for the Stripe-style flow; M6 may widen it.

import type { Product } from '../types.js';

export type CreateCheckoutInput = {
  purchase_id: string;
  product: Product;
  buyer_agent_id: string;
  success_url: string;
  cancel_url: string;
};

export type CreateCheckoutResult = {
  checkout_url: string;
  driver_ref: string;
};

export type WebhookEvent =
  | {
      kind: 'checkout-completed';
      driver_ref: string;
      purchase_id: string;
      amount_cents: number;
      currency: string;
    }
  // A subscription's later period was paid: extend the buyer's ticket. The
  // subscription carries product and buyer in its own metadata, so no
  // pending purchase row exists for it.
  | {
      kind: 'renewal';
      driver_ref: string;
      product_id: string;
      buyer_agent_id: string;
      amount_cents: number;
      currency: string;
    }
  | { kind: 'ignored'; reason: string };

export type VerifyWebhookInput = {
  rawBody: string;
  signature: string | null;
};

export type CreateRefundInput = {
  driver_ref: string;
  reason?: string;
};

export type CreateRefundResult = {
  refund_id: string | null; // null for drivers with no payment to refund (gift/manual)
};

export type CreateInvoiceInput = {
  purchase_id: string;
  product: Product;
  buyer_agent_id: string;
  email: string;
  name?: string;
  amount_cents: number;
  description: string;
  send: boolean; // false leaves a draft to review and send from the Stripe dashboard
};

export type CreateInvoiceResult = {
  driver_ref: string;
  hosted_url: string | null; // the payer's page; null while a draft
};

export interface PaymentDriver {
  readonly name: string;
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;
  verifyWebhook(input: VerifyWebhookInput): WebhookEvent;
  createRefund(input: CreateRefundInput): Promise<CreateRefundResult>;
  createInvoice?(input: CreateInvoiceInput): Promise<CreateInvoiceResult>;
}

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}
