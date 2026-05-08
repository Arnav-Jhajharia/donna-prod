import { AsyncLocalStorage } from "node:async_hooks";

// per-turn context flowing through async boundaries. brain.ts wraps the loop
// in `withTurnContext({...}, () => ...)`; tool handlers (and anything they
// call) read the current context via `getTurnContext()`. lets handlers reach
// userId / runId without threading them through every signature.
export interface TurnContext {
  userId: string;
  runId: string | null;
  source: "cli" | "whatsapp" | "imessage";
}

const als = new AsyncLocalStorage<TurnContext>();

export function withTurnContext<T>(ctx: TurnContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

// throws if called outside a turn. that's intentional — every handler should
// only run inside a turn, and a missing context indicates a wiring bug we
// want to surface fast rather than silently degrade.
export function getTurnContext(): TurnContext {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error("getTurnContext: no active turn context (handler called outside withTurnContext?)");
  }
  return ctx;
}

export function maybeTurnContext(): TurnContext | undefined {
  return als.getStore();
}
