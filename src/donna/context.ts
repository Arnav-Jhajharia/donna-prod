import { AsyncLocalStorage } from "node:async_hooks";

// per-turn context made available to tool handlers without threading it
// through every signature. brain.ts wraps the loop in `run(ctx, ...)`;
// tools that need userId call `userId()`.
//
// the alternative — adding (input, ctx) to every handler signature — was
// rejected because most tools don't need it and the noise compounds. this
// keeps the simple cases simple and lets only the needful tools opt in.

export interface TurnContext {
  userId: string;
  runId: string;
}

const storage = new AsyncLocalStorage<TurnContext>();

export function run<T>(ctx: TurnContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function current(): TurnContext | undefined {
  return storage.getStore();
}

// throws if called outside a runTurn context. tools that depend on userId
// (triggers, future per-user state) call this; the throw is a clear error
// signal that some caller forgot to set TurnConfig.userId.
export function userId(): string {
  const ctx = storage.getStore();
  if (!ctx) throw new Error("context.userId() called outside runTurn");
  return ctx.userId;
}
