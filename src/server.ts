import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { clerkAuth } from "./donna/ingress/auth.js";
import { mobile } from "./donna/ingress/mobile.js";
import { pairing } from "./donna/ingress/pairing.js";
import { whatsapp } from "./donna/ingress/whatsapp.js";
import { reattachPending } from "./donna/triggers/runtime.js";

// the multi-channel router. one server, many routes — whatsapp, mobile,
// imessage, debug — all calling the same brain. clerk middleware runs on
// every request so authenticated routes can read getAuth(c).userId.
const app = new Hono();

app.use("*", clerkAuth);

// railway and any sensible deploy target hit this for liveness checks.
// returning 200 + "ok" is the minimum contract.
app.get("/health", (c) => c.text("ok"));

app.route("/api/mobile", mobile);
app.route("/api/pairing", pairing);
app.route("/api/whatsapp", whatsapp);

// railway injects PORT at deploy time. locally we default to 3000.
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, async (info) => {
  console.log(`donna server listening on :${info.port}`);
  // reattach any triggers that were pending when the previous process died.
  // safe to call before any user has signed in — this just re-arms timers.
  // when a fire actually happens, the host (which would be the ingress
  // route that handles "trigger fired" events) needs to call markFired,
  // load the user's history, and dispatch — that's a follow-up; for now
  // fires from server-side triggers no-op (no setFireHandler installed).
  try {
    const reattached = await reattachPending();
    if (reattached > 0) {
      console.log(`reattached ${reattached} pending trigger(s)`);
    }
  } catch (err) {
    console.error("trigger reattach failed:", err);
  }
});
