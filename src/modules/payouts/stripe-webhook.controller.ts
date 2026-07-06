import { Request, Response } from "express";
import Stripe from "stripe";
import { stripe, supabase, env } from "../../config.js";
import { logger } from "../../utils/logger.js";

export async function handleStripeWebhook(req: Request, res: Response) {
  const sig = req.headers["stripe-signature"];
  if (!sig) {
    return res.status(400).send("Missing stripe-signature header");
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      (req as any).rawBody,
      sig as string,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    logger.error({ err }, "Stripe webhook signature verification failed");
    return res.status(400).send(`Webhook Error: ${(err as Error).message}`);
  }

  switch (event.type) {
    case "transfer.created":
    case "transfer.reversed": {
      const transfer = event.data.object as Stripe.Transfer;
      const commissionId = transfer.metadata?.commissionId;

      if (!commissionId) {
        logger.warn({ transferId: transfer.id }, "transfer webhook missing commissionId metadata");
        break;
      }

      if (event.type === "transfer.reversed") {
        // Mark commission as reversed
        await supabase
          .from("commissions")
          .update({
            status: "reversed",
            refunded_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", commissionId);

        logger.warn({ commissionId, transferId: transfer.id }, "transfer reversed by Stripe");
      }
      break;
    }

    case "account.updated": {
      const account = event.data.object as Stripe.Account;
      // Update promoter onboarding status
      await supabase
        .from("promoters")
        .update({
          stripe_onboarding_completed: account.details_submitted && account.charges_enabled,
          updated_at: new Date().toISOString(),
        })
        .eq("stripe_account_id", account.id);

      logger.info({ accountId: account.id, onboardingCompleted: account.details_submitted }, "Stripe account updated");
      break;
    }

    default:
      logger.debug({ type: event.type }, "unhandled Stripe webhook event");
  }

  res.json({ received: true });
}