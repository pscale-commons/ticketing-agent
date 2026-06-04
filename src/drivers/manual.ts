// Manual driver — bank transfer or any out-of-band payment.
//
// Flow:
//   1. Buyer POSTs /buy/<product_id> with their buyer_agent_id.
//   2. Server creates a `pending` purchase row (driver=manual) and returns
//      the configured `instructions` text — usually bank-transfer details
//      and a reference number to put in the transfer memo (we use the
//      purchase id).
//   3. Operator reconciles the bank statement off-substrate.
//   4. Operator calls POST /admin/mark-paid/<purchase_id>; the route
//      issues the grain and marks the row paid.
//
// No Checkout, no webhook, no automated reconciliation. The "driver"
// here is mostly a placeholder so the dispatch in routes/purchase.ts is
// uniform; the route does the work.

import type {
  CreateCheckoutInput,
  CreateCheckoutResult,
  CreateRefundInput,
  CreateRefundResult,
  PaymentDriver,
  VerifyWebhookInput,
  WebhookEvent,
} from './types.js';

export class ManualDriver implements PaymentDriver {
  readonly name = 'manual';

  async createCheckout(_input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    throw new Error('ManualDriver.createCheckout: manual products do not use Checkout');
  }
  verifyWebhook(_input: VerifyWebhookInput): WebhookEvent {
    throw new Error('ManualDriver.verifyWebhook: manual driver has no webhook source');
  }
  async createRefund(_input: CreateRefundInput): Promise<CreateRefundResult> {
    // Out-of-band — operator returns the bank transfer themselves.
    return { refund_id: null };
  }
}
