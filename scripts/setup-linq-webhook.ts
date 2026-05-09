// one-shot setup: register a linq webhook subscription pointed at our server.
//
// usage:
//   LINQ_API_KEY=... LINQ_FROM_NUMBER=+1... \
//     npm run setup:imessage -- https://your-host.example/imessage/webhook
//
// prints the signing_secret. copy it into LINQ_WEBHOOK_SECRET in .env. linq
// returns the secret exactly once — there is no retrieval endpoint.

import "../src/donna/env.js";
import {
  createWebhookSubscription,
  listWebhookSubscriptions,
} from "../src/donna/integrations/linq.js";

const DEFAULT_EVENTS = [
  "message.sent",
  "message.received",
  "message.delivered",
  "message.read",
  "message.failed",
];

const WEBHOOK_VERSION = "2026-02-03";

async function main(): Promise<void> {
  const argUrl = process.argv[2];
  if (!argUrl) {
    console.error(
      "usage: npm run setup:imessage -- <public-webhook-url>\n" +
        "  e.g. https://your-host.example/imessage/webhook",
    );
    process.exit(1);
  }

  // pin the payload version so future linq schema bumps don't surprise us
  const targetUrl = argUrl.includes("?")
    ? `${argUrl}&version=${WEBHOOK_VERSION}`
    : `${argUrl}?version=${WEBHOOK_VERSION}`;

  console.log(`[linq] checking existing subscriptions...`);
  try {
    const existing = await listWebhookSubscriptions();
    const dupe = existing.data?.find((s) => s.target_url === targetUrl);
    if (dupe) {
      console.log(
        `[linq] subscription already exists (id=${dupe.id}). signing_secret was returned only at create time — recreate if you've lost it.`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[linq] could not list subscriptions: ${msg}`);
  }

  console.log(`[linq] creating subscription:`);
  console.log(`        target_url        = ${targetUrl}`);
  console.log(`        subscribed_events = ${DEFAULT_EVENTS.join(", ")}`);

  const sub = await createWebhookSubscription({
    target_url: targetUrl,
    subscribed_events: DEFAULT_EVENTS,
  });

  console.log("");
  console.log(`[linq] OK — subscription id: ${sub.id}`);
  console.log("");
  if (sub.signing_secret) {
    console.log(`copy this into your .env (it cannot be retrieved later):`);
    console.log("");
    console.log(`LINQ_WEBHOOK_SECRET=${sub.signing_secret}`);
    console.log("");
  } else {
    console.warn(
      "[linq] no signing_secret returned — the api may have changed. inspect the response.",
    );
    console.log(JSON.stringify(sub, null, 2));
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[linq] setup failed: ${msg}`);
  process.exit(1);
});
