import { startCooldownApprovalJob } from "./approve-expired-cooldown.js";
import { startMonthlyPayoutJob } from "./monthly-payout-batch.js";

/**
 * Centralized job scheduler. Register all background jobs here.
 * Currently schedules the daily cool-down approval cron and the monthly
 * payout batch. Designed for future expansion as new jobs are added.
 */
export function startJobs() {
  startCooldownApprovalJob();
  startMonthlyPayoutJob();
}
