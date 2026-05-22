// scripts/setup-composio-mcp.ts
//
// stands up a hosted composio MCP server scoped to this user's gmail and
// prints the `claude mcp add` command to register it with claude code.
//
// reuses the existing oauth grant (no fresh google sign-in) via the
// COMPOSIO_GOOGLE_AUTH_CONFIG_ID already in .env. idempotent — if a server
// named SERVER_NAME already exists for this user, regenerates the URL
// instead of creating a duplicate.
//
// usage:
//   npx tsx scripts/setup-composio-mcp.ts
//
// read-only by design. tool scope = list/read inbox + threads + labels only.
// no write/send/modify actions surfaced (those come in a separate setup pass
// once we're ready for autonomous maintenance).

import "dotenv/config";
import { Composio } from "@composio/core";

const SERVER_NAME = "donna-mining";
const TOOLKIT = "gmail";

// read-only tool catalog for the mining run.
// keep this tight — every tool we add expands the blast radius if claude
// misbehaves. we add write tools in a later setup pass.
const ALLOWED_TOOLS = [
  "GMAIL_FETCH_EMAILS",
  "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
  "GMAIL_LIST_LABELS",
  "GMAIL_GET_PROFILE",
];

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`${name} not set in env`);
  }
  return v;
}

async function main() {
  const apiKey = requireEnv("COMPOSIO_API_KEY");
  const authConfigId = requireEnv("COMPOSIO_GOOGLE_AUTH_CONFIG_ID");
  const userId = requireEnv("DONNA_USER_ID");

  const composio = new Composio({ apiKey });

  // 1. find existing server with our name (idempotency)
  let serverId: string | null = null;
  try {
    const list = (await composio.mcp.list({})) as unknown;
    const items = Array.isArray(list)
      ? list
      : (list as { items?: unknown[] })?.items ?? [];
    for (const raw of items as Array<{ id?: string; name?: string }>) {
      if (raw?.name === SERVER_NAME && typeof raw.id === "string") {
        serverId = raw.id;
        break;
      }
    }
  } catch (err) {
    console.warn(
      "[setup-composio-mcp] mcp.list failed, proceeding to create:",
      (err as Error).message,
    );
  }

  // 2. create if missing
  if (!serverId) {
    console.log(`[setup-composio-mcp] creating server "${SERVER_NAME}"...`);
    const created = (await composio.mcp.create(SERVER_NAME, {
      toolkits: [{ authConfigId, toolkit: TOOLKIT }],
      allowedTools: ALLOWED_TOOLS,
    } as unknown as Parameters<typeof composio.mcp.create>[1])) as {
      id?: string;
    };
    if (!created?.id) {
      throw new Error("mcp.create returned no id");
    }
    serverId = created.id;
    console.log(`[setup-composio-mcp] created server id=${serverId}`);
  } else {
    console.log(`[setup-composio-mcp] reusing existing server id=${serverId}`);
  }

  // 3. generate user-bound URL
  console.log(
    `[setup-composio-mcp] generating user-bound URL for user_id=${userId}...`,
  );
  const instance = (await composio.mcp.generate(
    userId,
    serverId,
  )) as unknown as { url?: string };

  if (!instance?.url) {
    throw new Error(
      `mcp.generate returned no url: ${JSON.stringify(instance)}`,
    );
  }

  console.log("");
  console.log("=".repeat(72));
  console.log("MCP URL ready. add it to claude code with:");
  console.log("");
  console.log(
    `  claude mcp add --transport http gmail-composio "${instance.url}"`,
  );
  console.log("");
  console.log("then /exit and reopen claude code so the MCP loads.");
  console.log("=".repeat(72));
}

main().catch((err) => {
  console.error("[setup-composio-mcp] failed:", err);
  process.exit(1);
});
