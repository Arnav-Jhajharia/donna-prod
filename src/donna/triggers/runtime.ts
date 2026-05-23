import type { Trigger } from "./store.js";

// the fire handler is supplied by whichever surface is running (cli today,
// whatsapp/imessage/mobile later). it's responsible for turning the trigger
// into a real turn — calling runTurn with the action, rendering the result,
// updating history, marking the trigger as fired.
//
// keeping the handler external means the runtime knows nothing about
// MessageParam, rendering, or persistence — just timers.
export type FireHandler = (t: Trigger) => Promise<void>;

let fireHandler: FireHandler | null = null;
const scheduled = new Map<string, NodeJS.Timeout>();

export function setFireHandler(fn: FireHandler): void {
  fireHandler = fn;
}

// schedule a pending trigger. called by create_trigger after it adds the
// trigger to the store. if fireAt is in the past (or right now), setTimeout
// with a clamped 0 ms delay fires on the next tick — which is the right
// semantics for "fire as soon as possible."
export function schedule(t: Trigger): void {
  if (t.status !== "pending") return;
  const ms = Math.max(0, new Date(t.fireAt).getTime() - Date.now());
  const handle = setTimeout(async () => {
    scheduled.delete(t.id);
    if (!fireHandler) return;
    try {
      await fireHandler(t);
    } catch (err) {
      // a thrown fire handler shouldn't crash the process. log + move on;
      // the trigger's status is the fire handler's responsibility to set.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`trigger ${t.id} fire failed: ${msg}`);
    }
  }, ms);
  scheduled.set(t.id, handle);
}

// called by cancel_trigger after it flips status in the store. clears the
// pending setTimeout so the handler never fires. no-op if there's nothing
// scheduled (already fired, never scheduled, etc.).
export function unschedule(id: string): void {
  const handle = scheduled.get(id);
  if (!handle) return;
  clearTimeout(handle);
  scheduled.delete(id);
}
