// manual world-engine tick. dev/debug entry.
//
// usage:
//   DONNA_USER_ID=<uuid> WORLD_PROFILE_BLURB="..." \
//     npx tsx scripts/world-tick.ts
//
// no worker yet — this is the v0.2 minimum. wire to cron once stable.

import "dotenv/config";
import type {
  ContentBlockParam,
  MessageParam,
} from "@anthropic-ai/sdk/resources/messages";
import { closeDb } from "../src/donna/db.js";
import { loadRecentMessages } from "../src/donna/memory/chat.js";
import { runWorldTick } from "../src/donna/world/runner.js";
import type { WorldContext } from "../src/donna/world/types.js";

async function main(): Promise<void> {
  const userId = process.env.DONNA_USER_ID;
  if (!userId) {
    throw new Error("DONNA_USER_ID not set");
  }
  const profileBlurb = process.env.WORLD_PROFILE_BLURB ?? "";

  const recent = await loadRecentMessages(userId);
  const recentText = recent
    .slice(-10)
    .map((m) => `${m.role}: ${flatten(m.content)}`)
    .join("\n");

  const ctx: WorldContext = {
    user_id: userId,
    profile_blurb: profileBlurb,
    recent_thread: recentText,
    current_datetime: new Date().toISOString(),
    trigger: "manual",
  };

  const result = await runWorldTick({ context: ctx, source: "cli" });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  await closeDb();
}

function flatten(content: MessageParam["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlockParam[])
    .map((b) => (b.type === "text" ? b.text : ""))
    .join(" ");
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`world-tick failed: ${msg}\n`);
  process.exit(1);
});
