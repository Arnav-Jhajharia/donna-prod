// omnipresence guard — donna must never go silent on a reactive turn.
//
// the brain itself already handles the common silent path: when the model
// ends without calling a terminator, it emits CAP_HIT_FALLBACK via send_burst.
// what it doesn't handle is:
//   - thrown exceptions inside the loop (network errors, tool throws caught
//     by the SDK rather than by handlers, etc)
//   - the user-side gap where the chosen channel is unreachable
//
// this module wraps the dispatch path so:
//   1. any thrown error from runTurn is caught and converted to a fallback
//      burst that still lands on the user's surface
//   2. the burst is delivered through the channel router, so even if the
//      primary surface is down, the burst reaches the app outbox
//
// the existing per-channel dispatchers in src/server.ts keep using direct
// channel send for the happy path (so reply-to threading and typing
// indicators work correctly). this guard only fires when the happy path
// throws or empties.

const FALLBACK_BURST =
  "having trouble on my end right now. give me a minute and try again.";

export interface SilenceGuardArgs {
  userId: string;
  runId?: string | null;
  source?: "whatsapp" | "imessage" | "app";
  error?: unknown;
}

export async function deliverSilenceFallback(args: SilenceGuardArgs): Promise<void> {
  // dynamic import to break the cycle: router → memory/chat → … → brain →
  // this module. only loaded when an actual silence-prevention fire happens.
  const { deliverBurst } = await import("./router.js");
  try {
    const result = await deliverBurst(args.userId, [FALLBACK_BURST], {
      sourceHint: args.source,
      runId: args.runId ?? null,
      persistHistory: false,
    });
    if (result.delivered === 0) {
      console.error(
        `[omnipresence] silence fallback could not land for user=${args.userId.slice(0, 8)}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[omnipresence] silence fallback crashed: ${msg}`);
  }
}
