import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { clerkAuth } from "./donna/ingress/auth.js";
import { mobile } from "./donna/ingress/mobile.js";
import { pairing } from "./donna/ingress/pairing.js";
import { whatsapp } from "./donna/ingress/whatsapp.js";

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

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`donna server listening on :${info.port}`);
});
