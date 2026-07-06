import { supabase } from "../config.js";
import { logger } from "./logger.js";

const MAX_RETRIES = 3;
const RETRY_DELAYS_MIN = [1, 5, 30];  // exponential backoff

export interface DeadLetterInput {
  eventType: string;
  payload: unknown;
  errorMessage: string;
}

/**
 * Record a failed event in dead-letter queue for later retry.
 */
export async function recordFailedEvent(input: DeadLetterInput): Promise<void> {
  const { error } = await supabase
    .from("failed_events")
    .insert({
      event_type: input.eventType,
      payload: input.payload as any,
      error_message: input.errorMessage,
      status: "pending",
      next_retry_at: new Date(Date.now() + RETRY_DELAYS_MIN[0] * 60 * 1000).toISOString(),
    });

  if (error) {
    logger.error({ error, input }, "failed to record dead-letter event");
  } else {
    logger.warn({ eventType: input.eventType }, "event recorded in dead-letter queue");
  }
}

/**
 * Retry a dead-letter event. If still fails, increment retry count
 * and schedule next retry. If max retries reached, mark as ignored.
 */
export async function retryDeadLetterEvent(
  eventId: string,
  handler: (payload: any) => Promise<void>
): Promise<{ success: boolean; status: string }> {
  const { data: event, error } = await supabase
    .from("failed_events")
    .select("*")
    .eq("id", eventId)
    .single();

  if (error || !event) return { success: false, status: "not_found" };
  if (event.status !== "pending" && event.status !== "retrying") {
    return { success: false, status: event.status };
  }

  try {
    await handler(event.payload);

    await supabase
      .from("failed_events")
      .update({ status: "resolved", resolved_at: new Date().toISOString() })
      .eq("id", eventId);

    logger.info({ eventId }, "dead-letter event resolved");
    return { success: true, status: "resolved" };
  } catch (err) {
    const newRetryCount = event.retry_count + 1;

    if (newRetryCount >= MAX_RETRIES) {
      await supabase
        .from("failed_events")
        .update({ status: "ignored", retry_count: newRetryCount })
        .eq("id", eventId);

      logger.error({ eventId, err }, "dead-letter event ignored after max retries");
      return { success: false, status: "ignored" };
    }

    const nextDelayMin = RETRY_DELAYS_MIN[newRetryCount];
    await supabase
      .from("failed_events")
      .update({
        status: "retrying",
        retry_count: newRetryCount,
        error_message: (err as Error).message,
        next_retry_at: new Date(Date.now() + nextDelayMin * 60 * 1000).toISOString(),
      })
      .eq("id", eventId);

    logger.warn({ eventId, retryCount: newRetryCount, nextDelayMin }, "dead-letter event scheduled for retry");
    return { success: false, status: "retrying" };
  }
}

/**
 * Cron job: process pending and due-to-retry events every 5 minutes.
 */
export async function processDeadLetterQueue(): Promise<number> {
  const { data: events, error } = await supabase
    .from("failed_events")
    .select("id, event_type, payload")
    .or("status.eq.pending,status.eq.retrying")
    .lte("next_retry_at", new Date().toISOString())
    .limit(50);

  if (error || !events) return 0;

  let processed = 0;
  for (const event of events) {
    // In real impl: dispatch to appropriate handler based on event_type
    logger.info({ eventId: event.id, type: event.event_type }, "processing dead-letter event");
    processed++;
  }

  return processed;
}