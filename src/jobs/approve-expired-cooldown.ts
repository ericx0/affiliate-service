import cron from "node-cron";
import { logger } from "../utils/logger.js";
import { approveExpiredCooldowns } from "../modules/commissions/commissions.service.js";

/**
 * Daily job that approves commissions whose 7-day cool-down has expired
 * and were not refunded. Runs at 00:00 UTC.
 */
export function startCooldownApprovalJob() {
  cron.schedule("0 0 * * *", async () => {
    logger.info("starting daily cool-down approval job");
    const start = Date.now();

    try {
      const approved = await approveExpiredCooldowns();
      logger.info({ approved, durationMs: Date.now() - start }, "cool-down approval job complete");
    } catch (err) {
      logger.error({ err }, "cool-down approval job failed");
    }
  }, { timezone: "UTC" });

  logger.info("cool-down approval cron scheduled (daily 00:00 UTC)");
}
