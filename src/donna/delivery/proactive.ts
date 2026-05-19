// deliver runtime-triggered bursts (oauth completed, commitment overdue,
// backfill done, etc) to wherever the user actually lives. delegates to the
// channel router so whatsapp / imessage / app all work, with automatic
// fallback if the primary channel fails.

import { deliverBurst } from "./router.js";
import type { TurnSource } from "../context.js";

export interface DeliveryResult {
  channel: "whatsapp" | "imessage" | "app" | "none";
  delivered: number;
  externalIds: string[];
}

export interface DeliverOptions {
  source?: TurnSource;
  runId?: string | null;
}

export async function deliverBurstToUser(
  userId: string,
  bursts: string[],
  opts: DeliverOptions = {},
): Promise<DeliveryResult> {
  const result = await deliverBurst(userId, bursts, {
    sourceHint: opts.source,
    runId: opts.runId,
  });
  const externalIds = result.attempts
    .filter((a) => a.ok && a.externalId)
    .map((a) => a.externalId as string);
  return {
    channel: result.channel,
    delivered: result.delivered,
    externalIds,
  };
}
