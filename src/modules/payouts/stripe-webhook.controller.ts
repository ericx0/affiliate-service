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
    // AS-P1-3 fix: do NOT return the raw Stripe SDK error to the
    // caller. Error strings can include HTTP body fragments, internal
    // Stripe endpoints, or hints about secret names. Log internally;
    // return a generic 400.
    logger.error({ err }, "Stripe webhook signature verification failed");
    return res.status(400).send("Webhook signature verification failed");
  }

  // Idempotency (CLAUDE.md §3): claim this event before processing.
  // A duplicate delivery collides on the primary key and is skipped.
  // Failure must NOT be silently swallowed - Stripe retries on non-2xx.
  const { error: claimErr } = await supabase
    .from("processed_stripe_events")
    .insert({ event_id: event.id, endpoint: "affiliate-stripe-webhook" });
  if (claimErr) {
    if (claimErr.code === "23505") {
      // unique_violation - already processed
      return res.json({ received: true, duplicate: true });
    }
    logger.error({ err: claimErr, eventId: event.id }, "failed to claim stripe event");
    return res.status(500).json({ error: "idempotency claim failed" });
  }

  try {
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
          const { error: revErr } = await supabase
            .from("affiliate.commissions")
            .update({
              status: "reversed",
              refunded_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", commissionId);
          if (revErr) throw revErr;

          logger.warn({ commissionId, transferId: transfer.id }, "transfer reversed by Stripe");
        }
        break;
      }

      case "account.updated": {
        const account = event.data.object as Stripe.Account;
        // Update promoter onboarding status
        const { error: accErr } = await supabase
          .from("affiliate.promoters")
          .update({
            stripe_onboarding_completed: account.details_submitted && account.charges_enabled,
            updated_at: new Date().toISOString(),
          })
          .eq("stripe_account_id", account.id);
        if (accErr) throw accErr;

        logger.info({ accountId: account.id, onboardingCompleted: account.details_submitted }, "Stripe account updated");
        break;
      }

      // AS-P2-5: Stripe sent a chargeback/dispute against a charge that
      // originated from a KOL-referred order. Alert operations so a
      // human can review the dispute and decide whether to claw back
      // the KOL commission. Without this handler, disputes go unnoticed
      // until the KOL's next payout reconciliation - by which point the
      // commission may already have been paid out.
      case "charge.dispute.created": {
        const dispute = event.data.object as Stripe.Dispute;
        const chargeId = typeof dispute.charge === "string"
          ? dispute.charge
          : dispute.charge?.id;
        logger.error(
          {
            disputeId: dispute.id,
            chargeId,
            amount: dispute.amount,
            reason: dispute.reason,
          },
          "Stripe charge.dispute.created - investigate and decide commission clawback",
        );
        // TODO: write to admin_alerts table + send Slack/email.
        // Deferred; for now we log loudly so it appears in alerts.
        break;
      }

      // AS-P2-5: KOL payout failed - money didn't reach their Stripe
      // Connect account. Without this, KOLs silently lose payouts and
      // only notice at month-end reconciliation. Log + alert so
      // operations can manually re-trigger.
      case "payout.failed": {
        const payout = event.data.object as Stripe.Payout;
        logger.error(
          {
            payoutId: payout.id,
            amount: payout.amount,
            currency: payout.currency,
            failureCode: payout.failure_code,
            failureMessage: payout.failure_message,
            arrivalDate: payout.arrival_date,
          },
          "Stripe payout.failed - KOL did not receive funds",
        );
        // TODO: write to admin_alerts + Slack.
        break;
      }

      // AS-P2-5: KOL disconnected their Stripe Connect account from
      // our platform. Mark the promoter as suspended so payouts stop
      // attempting to use the disconnected account.
      case "account.application.deauthorized": {
        const account = event.data.object as Stripe.Application;
        const { error: deauthErr } = await supabase
          .from("affiliate.promoters")
          .update({
            status: "suspended",
            suspended_reason: "stripe_disconnected",
            suspended_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("stripe_account_id", account.id);
        if (deauthErr) throw deauthErr;

        logger.warn(
          { accountId: account.id },
          "KOL deauthorized Stripe Connect; promoter auto-suspended",
        );
        break;
      }

      default:
        logger.debug({ type: event.type }, "unhandled Stripe webhook event");
    }

    res.json({ received: true });
  } catch (procErr) {
    // Release the claim so a Stripe retry can reprocess this event.
    // Fail loudly (500) so Stripe retries - never silently swallow
    // (CLAUDE.md §3: 失败必须 throw,不可静默吞).
    await supabase
      .from("processed_stripe_events")
      .delete()
      .eq("event_id", event.id);
    logger.error(
      { err: procErr, eventId: event.id, eventType: event.type },
      "stripe webhook processing failed - releasing claim for retry",
    );
    res.status(500).json({ error: "processing failed" });
  }
}
