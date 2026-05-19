import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { ProactiveCause } from "./cause.js";

export type ArbiterDecision =
  | { allow: true }
  | { allow: false; reason: string; reschedule_at?: string };

export interface ArbitrateArgs {
  user_id: string;
  cause: ProactiveCause;
  recent_messages: MessageParam[];
  last_assistant_at?: Date;
  now: Date;
  user_tz: string;
}

const QUIET_HOURS_START = 23; // 23:00 user-local
const QUIET_HOURS_END = 7; // 07:00 user-local
const COOLDOWN_MINUTES = 30;

function getHourInTz(date: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const hour = parseInt(hourStr, 10);
  if (!Number.isFinite(hour)) return 0;
  // Intl returns 24 for midnight in some locales — normalize to 0
  return hour === 24 ? 0 : hour;
}

function isQuietHours(now: Date, tz: string): boolean {
  const hour = getHourInTz(now, tz);
  // window wraps midnight: 23:00-07:00 means hour >= 23 OR hour < 7
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

function nextSevenAm(now: Date, tz: string): Date {
  // step forward an hour at a time until we hit the next 07:00 in user TZ
  const d = new Date(now.getTime());
  d.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 48; i++) {
    d.setUTCHours(d.getUTCHours() + 1);
    if (getHourInTz(d, tz) === QUIET_HOURS_END) return new Date(d.getTime());
  }
  // safety fallback: 8h from now
  return new Date(now.getTime() + 8 * 3600_000);
}

// causes that bypass quiet hours / cooldown — user-initiated events where
// silence is worse than the interrupt. integration_oauth_complete fires
// because the user just finished an oauth flow and is staring at their
// phone waiting for confirmation. holding it for quiet hours would be a
// betrayal of the omnipresence contract.
const ALWAYS_ALLOW = new Set<string>(["integration_oauth_complete"]);

export function arbitrate(args: ArbitrateArgs): ArbiterDecision {
  if (ALWAYS_ALLOW.has(args.cause.kind)) {
    return { allow: true };
  }
  if (isQuietHours(args.now, args.user_tz)) {
    return {
      allow: false,
      reason: "quiet hours (23:00-07:00 user-local)",
      reschedule_at: nextSevenAm(args.now, args.user_tz).toISOString(),
    };
  }

  if (args.last_assistant_at) {
    const elapsedMs = args.now.getTime() - args.last_assistant_at.getTime();
    const cooldownMs = COOLDOWN_MINUTES * 60_000;
    if (elapsedMs < cooldownMs) {
      const reschedule = new Date(
        args.last_assistant_at.getTime() + cooldownMs
      );
      return {
        allow: false,
        reason: `cooldown — last send ${Math.floor(elapsedMs / 60_000)}min ago`,
        reschedule_at: reschedule.toISOString(),
      };
    }
  }

  return { allow: true };
}
