import { Request, Response } from "express";
import Stripe from "stripe";
import { stripe, supabase, affiliateSupabase, env } from "../../config.js";
import { logger } from "../../utils/logger.js";
import {
  notifyAdminDispute,
  notifyAdminPayoutFailure,
  notifyKolDisputed,
  notifyAdminDisputeResolved,
  notifyAdminDisputeReversalFailed,
} from "../notifications/notifications.service.js";
import { calculateRefundDeduction } from "../commissions/refund-helpers.js";
import { writeAuditLog } from "../admin/audit.service.js";

// Sentinel UUID for audit rows written by the Stripe webhook (no human
// actor — must satisfy NOT NULL UUID on audit_logs.target_id and actor_id).
const SYSTEM_WEBHOOK_ACTOR_ID = "00000000-0000-0000-0000-000000000001";

// Task 1.1 (PR-1): safe-mode switch for paid-commission refund reversal.
// When true, skip Stripe transfer.createReversal + DB status flip and
// only log an audit row. Ops flips to false after ≥3 days of dry_run
// confirms cumulative math is correct on production traffic.
const isRefundReverseDryRun = process.env.REFUND_REVERSE_DRY_RUN === "true";

async function reversePaidCommission(commissionId: string): Promise<void> {
  const { data: comm } = await affiliateSupabase
    .from("commissions")
    .select("id, status, commission_amount, cumulative_refunded_amount, stripe_transfer_id, order_id")
    .eq("id", commissionId)
    .single();
  if (!comm || comm.status !== "paid") return;

  const { data: order } = await affiliateSupabase
    .from("orders")
    .select("id, refund_amount, original_amount")
    .eq("id", comm.order_id)
    .single();
  if (!order) return;

  const alreadyRefunded = Number(comm.cumulative_refunded_amount ?? 0);
  const incrementalRefund = Math.max(0, Number(order.refund_amount ?? 0) - alreadyRefunded);
  if (incrementalRefund === 0) return;

  const { deductAmount } = calculateRefundDeduction({
    orderAmount: Number(order.original_amount),
    commissionAmount: Number(comm.commission_amount),
    refundAmount: incrementalRefund,
  });

  if (isRefundReverseDryRun) {
    await writeAuditLog({
      actorId: SYSTEM_WEBHOOK_ACTOR_ID,
      actorEmail: "system@stripe-webhook",
      action: "commission_reverse",
      targetType: "commission",
      targetId: commissionId,
      afterState: { deduct_amount: deductAmount, mode: "dry_run" },
      reason: `REFUND_REVERSE_DRY_RUN=true; incremental_refund=${incrementalRefund}c`,
    });
    logger.info({ commissionId, deductAmount }, "DRY_RUN reverse commission");
    return;
  }

  if (comm.stripe_transfer_id) {
    await stripe.transfers.createReversal(comm.stripe_transfer_id, { amount: deductAmount });
  }

  const newCumulative = alreadyRefunded + deductAmount;
  const isFullyReversed = newCumulative >= Number(comm.commission_amount);

  await affiliateSupabase
    .from("commissions")
    .update({
      cumulative_refunded_amount: newCumulative,
      status: isFullyReversed ? "reversed" : comm.status,
      reversed_at: isFullyReversed ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", commissionId);

  await writeAuditLog({
    actorId: SYSTEM_WEBHOOK_ACTOR_ID,
    actorEmail: "system@stripe-webhook",
    action: "commission_reverse",
    targetType: "commission",
    targetId: commissionId,
    afterState: { deduct_amount: deductAmount, mode: "live" },
    reason: `incremental_refund=${incrementalRefund}c`,
  });
}

export async function handleStripeWebhook(req: Request, res: Response) {
  const sig = req.headers["stripe-signature"];
  if (!sig) {
    return res.status(400).send("Missing stripe-signature header");
  }

  let event: Stripe.Event;
  try {
    // The webhook route is mounted with express.raw() (see src/index.ts),
    // so the unparsed payload is in req.body as a Buffer. req.rawBody is
    // only populated by the express.json() verify hook, which never runs
    // for this route — reading it here silently broke every event.
    event = stripe.webhooks.constructEvent(
      req.body as Buffer,
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
          const { error: revErr } = await affiliateSupabase.from("commissions")
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
        const { error: accErr } = await affiliateSupabase.from("promoters")
          .update({
            stripe_onboarding_completed: account.details_submitted && account.charges_enabled,
            updated_at: new Date().toISOString(),
          })
          .eq("stripe_account_id", account.id);
        if (accErr) throw accErr;

        logger.info({ accountId: account.id, onboardingCompleted: account.details_submitted }, "Stripe account updated");
        break;
      }

      // Task 2: Stripe sent a chargeback/dispute against a charge that
      // originated from a KOL-referred order. Freeze the commission to
      // status='disputed' so payouts skip it until resolution. The
      // charge.dispute.closed handler resolves it via the matrix below.
      // Idempotent via partial unique index on dispute_id.
      case "charge.dispute.created": {
        const dispute = event.data.object as Stripe.Dispute;
        const chargeId = typeof dispute.charge === "string"
          ? dispute.charge
          : dispute.charge?.id;
        const commissionId = dispute.metadata?.commissionId
          ?? (typeof (dispute as any).charge !== "string" ? (dispute.charge as any)?.metadata?.commissionId : undefined);

        logger.error(
          {
            disputeId: dispute.id,
            chargeId,
            amount: dispute.amount,
            reason: dispute.reason,
            commissionId,
          },
          "Stripe charge.dispute.created - freeze commission until dispute resolves",
        );

        if (commissionId) {
          // Idempotent: partial unique index on dispute_id catches re-delivery.
          // If dispute_id already set on this commission, no-op (re-delivery).
          const { data: existing } = await affiliateSupabase
            .from("commissions")
            .select("id, dispute_id, status, commission_amount, promoter_id")
            .eq("id", commissionId)
            .maybeSingle();

          if (existing && existing.dispute_id === dispute.id) {
            logger.info({ commissionId, disputeId: dispute.id }, "dispute.created already applied; idempotent skip");
          } else if (existing) {
            const now = new Date().toISOString();
            const { error: updErr } = await affiliateSupabase
              .from("commissions")
              .update({
                status: "disputed",
                disputed_at: now,
                dispute_id: dispute.id,
                dispute_status: "open",
                updated_at: now,
              })
              .eq("id", commissionId);
            if (updErr) throw updErr;

            await writeAuditLog({
              actorId: SYSTEM_WEBHOOK_ACTOR_ID,
              actorEmail: "system@stripe-webhook",
              action: "commission_dispute_freeze",
              targetType: "commission",
              targetId: commissionId,
              afterState: { dispute_id: dispute.id, status: "disputed" },
              reason: `stripe_dispute=${dispute.id}; reason=${dispute.reason ?? "unknown"}`,
            });

            await notifyKolDisputed({
              promoterId: existing.promoter_id ?? "",
              commissionId,
              // R1 final review Fix 1: commission_amount is stored as
              // integer cents (see migration 20260713000002). Convert
              // here at the cents→display boundary so the notification
              // helper stays display-naive (no /100 knowledge). Without
              // this, the KOL email showed e.g. "5000.00 USD" for a $50
              // chargeback.
              amount: ((Number(existing.commission_amount ?? 0)) / 100).toFixed(2),
              disputeReason: dispute.reason ?? "cardholder dispute",
            }).catch((e) =>
              logger.error({ error: (e as Error).message }, "notifyKolDisputed failed"),
            );
          }
        }

        // Always alert ops (best-effort).
        await notifyAdminDispute({
          commissionId: chargeId || dispute.id,
          reason: dispute.reason || "unknown",
        });
        break;
      }

      // Task 2: dispute resolved. Apply the resolution matrix
      // (user ruling 2026-08-08):
      //   won  + wasPaid  → paid     (un-freeze; money already went out)
      //   won  + !wasPaid → approved (un-freeze; eligible for next payout)
      //   lost + wasPaid  → reversed (claw back via stripe.transfers.createReversal)
      //   lost + !wasPaid → voided   (cancel pending commission)
      // Idempotent on dispute_closed_at IS NOT NULL.
      case "charge.dispute.closed": {
        const dispute = event.data.object as Stripe.Dispute;
        const commissionId = dispute.metadata?.commissionId
          ?? (typeof (dispute as any).charge !== "string" ? (dispute.charge as any)?.metadata?.commissionId : undefined);

        if (!commissionId) {
          logger.warn({ disputeId: dispute.id }, "charge.dispute.closed missing commissionId metadata");
          break;
        }

        const { data: existing } = await affiliateSupabase
          .from("commissions")
          .select("id, status, dispute_id, dispute_closed_at, paid_at, stripe_transfer_id")
          .eq("id", commissionId)
          .maybeSingle();
        if (!existing) {
          logger.warn({ disputeId: dispute.id, commissionId }, "charge.dispute.closed: commission not found");
          break;
        }
        if (existing.dispute_closed_at) {
          logger.info({ commissionId, disputeId: dispute.id }, "dispute.closed already applied; idempotent skip");
          break;
        }

        const won = dispute.status === "won";
        const wasPaid = !!existing.paid_at;
        let targetStatus: "approved" | "paid" | "reversed" | "voided";
        if (won) {
          targetStatus = wasPaid ? "paid" : "approved";
        } else {
          targetStatus = wasPaid ? "reversed" : "voided";
        }

        // R1 final review Fix 3: attempt Stripe transfer reversal FIRST
        // for lost+wasPaid. If it fails, leave the commission in
        // 'disputed' state and alert ops — do NOT flip the status to
        // 'reversed' (which would silently drop the unpaid transfer).
        // The pre-fix code flipped status before the reversal attempt
        // and swallowed the reversal error → commission marked
        // 'reversed' but KOL's Stripe balance never clawed back.
        if (!won && wasPaid && existing.stripe_transfer_id) {
          try {
            await stripe.transfers.createReversal(existing.stripe_transfer_id, {
              metadata: {
                commissionId,
                disputeId: dispute.id,
                reason: "dispute_lost",
              },
            });
            logger.info(
              { commissionId, transferId: existing.stripe_transfer_id },
              "Stripe transfer reversed on dispute.lost",
            );
          } catch (revErr) {
            const errMsg = (revErr as Error).message ?? String(revErr);
            logger.error(
              { err: revErr, commissionId, transferId: existing.stripe_transfer_id },
              "transfer reversal failed; leaving commission in 'disputed' for manual ops follow-up",
            );
            await writeAuditLog({
              actorId: SYSTEM_WEBHOOK_ACTOR_ID,
              actorEmail: "system@stripe-webhook",
              action: "commission_reversal_failed",
              targetType: "commission",
              targetId: commissionId,
              afterState: { transfer_id: existing.stripe_transfer_id, status: "disputed" },
              reason: `stripe_dispute=${dispute.id}; reversal_error=${errMsg}`,
            });
            await notifyAdminDisputeReversalFailed({
              commissionId,
              transferId: existing.stripe_transfer_id,
              error: errMsg,
            }).catch((e) =>
              logger.error({ error: (e as Error).message }, "notifyAdminDisputeReversalFailed failed"),
            );
            // Skip the rest of the resolution: status stays 'disputed',
            // admin gets a separate ops alert (NOT a 'resolved' email).
            break;
          }
        }

        const now = new Date().toISOString();

        // R1 final review Fix 4: conditional UPDATE — only flip if the
        // commission is still in 'disputed' status. Without the .in()
        // guard, a re-delivered event (or a concurrent admin resolve)
        // could race-resolve a row that was already settled.
        const { data: updatedRows, error: updErr } = await affiliateSupabase
          .from("commissions")
          .update({
            status: targetStatus,
            dispute_status: dispute.status,
            dispute_closed_at: now,
            updated_at: now,
            // won: keep disputed_at as historical record (don't update);
            // lost: clear it (dispute is finalized, no longer "open")
            ...(won ? {} : { disputed_at: null }),
          })
          .eq("id", commissionId)
          .in("status", ["disputed"])
          .select("id");
        if (updErr) throw updErr;
        if (!updatedRows || updatedRows.length === 0) {
          logger.warn(
            { commissionId, disputeId: dispute.id },
            "charge.dispute.closed: commission no longer 'disputed' (race lost); skipping resolve",
          );
          break;
        }

        logger.warn(
          { commissionId, disputeId: dispute.id, status: targetStatus, disputeStatus: dispute.status },
          "Stripe charge.dispute.closed - commission resolved",
        );

        await writeAuditLog({
          actorId: SYSTEM_WEBHOOK_ACTOR_ID,
          actorEmail: "system@stripe-webhook",
          action: "commission_dispute_resolve",
          targetType: "commission",
          targetId: commissionId,
          afterState: { dispute_id: dispute.id, status: targetStatus, dispute_status: dispute.status },
          reason: `stripe_dispute_closed; outcome=${dispute.status}`,
        });

        await notifyAdminDisputeResolved({
          commissionId,
          action: won ? "won" : "lost",
          note: `stripe_dispute=${dispute.id}`,
        }).catch((e) =>
          logger.error({ error: (e as Error).message }, "notifyAdminDisputeResolved failed"),
        );
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
        await notifyAdminPayoutFailure({
          promoterId: String(payout.destination || payout.id),
          error: payout.failure_message || payout.failure_code || "unknown",
        });
        break;
      }

      // AS-P2-5: KOL disconnected their Stripe Connect account from
      // our platform. Mark the promoter as suspended so payouts stop
      // attempting to use the disconnected account.
      case "account.application.deauthorized": {
        const account = event.data.object as Stripe.Application;
        const { error: deauthErr } = await affiliateSupabase.from("promoters")
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

      // Task 1.1 (PR-1): charge.refunded lands here from the Stripe
      // dashboard webhook (refund issued outside the affiliate flow).
      // Pull commissionId off the charge.metadata (set when the order
      // was created), then run reversePaidCommission — which honors
      // REFUND_REVERSE_DRY_RUN.
      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        const commissionId = charge.metadata?.commissionId;
        if (!commissionId) {
          logger.warn({ chargeId: charge.id }, "charge.refunded missing commissionId metadata");
          break;
        }
        await reversePaidCommission(commissionId);
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
