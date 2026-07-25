import cron from "node-cron";
import { logger } from "../utils/logger.js";
import { affiliateSupabase } from "../config.js";
import { payCommissions } from "../modules/payouts/payouts.service.js";
import { notifyAdminPayoutFailure } from "../modules/notifications/notifications.service.js";

/**
 * Monthly batch payout job.
 * Runs on the 14th of each month at 23:00 UTC (1 day before payout day 15th).
 * Pays out all commissions in 'approved' state.
 */
export function startMonthlyPayoutJob() {
  cron.schedule(
    "0 23 14 * *",
    async () => {
      logger.info("starting monthly payout batch");
      const start = Date.now();

      try {
        // Get all approved commissions
        const { data: approved, error } = await affiliateSupabase.from("commissions")
          .select("id")
          .eq("status", "approved");

        if (error) throw error;
        if (!approved || approved.length === 0) {
          logger.info("no approved commissions to pay");
          return;
        }

        const commissionIds = approved.map((c) => c.id);
        const results = await payCommissions(commissionIds);

        const successful = results.filter((r) => r.success).length;
        const failed = results.length - successful;
        const totalAmount = results
          .filter((r) => r.success)
          .reduce((sum, r) => sum + (r.totalAmount ?? 0), 0);

        logger.info(
          {
            total: results.length,
            successful,
            failed,
            totalAmount,
            durationMs: Date.now() - start,
          },
          "monthly payout batch complete"
        );

        // Notify admin of failures
        if (failed > 0) {
          logger.error(
            { failed, results: results.filter((r) => !r.success) },
            "monthly payout had failures"
          );
          await notifyAdminPayoutFailure({
            promoterId: "monthly-batch",
            error: `${failed} of ${results.length} payouts failed`,
          });
        }
      } catch (err) {
        logger.error({ err }, "monthly payout batch failed");
      }
    },
    { timezone: "UTC" }
  );

  logger.info("monthly payout cron scheduled (14th 23:00 UTC)");
}
