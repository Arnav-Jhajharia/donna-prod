import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

// the multi-channel router. one server, many routes — whatsapp, mobile,
// imessage, debug — all calling the same brain. for now: just a health
// check, so we can confirm the server boots locally and on railway.
const app = new Hono();

// railway and any sensible deploy target hit this for liveness checks.
// returning 200 + "ok" is the minimum contract.
app.get("/health", (c) => c.text("ok"));

// railway injects PORT at deploy time. locally we default to 3000.
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`donna server listening on :${info.port}`);
});
