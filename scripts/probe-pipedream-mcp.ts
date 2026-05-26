// hands-on probe of pipedream's MCP gateway. designed to be runnable once you
// have a free pipedream account + project + oauth credentials, so you can feel
// the developer experience before committing pipedream to the architecture.
//
// what it does:
//   1. authenticates against pipedream's OAuth (client credentials grant)
//   2. opens an MCP session against remote.mcp.pipedream.net for one specific
//      app (default: beehiiv — a newsletter platform klavis doesn't cover,
//      so a realistic "why we'd ever use pipedream" test case)
//   3. lists the available tools and prints the schemas
//   4. times the round-trip
//
// what it does NOT do:
//   - actually connect a user's beehiiv account (that's a per-user OAuth flow
//     you'd wire in your /api/connect/* ingress)
//   - call any tool that requires an authed connection — those will 4xx and
//     that's the expected outcome; we're feeling out the surface, not
//     proving end-to-end connectivity
//
// env required:
//   PIPEDREAM_CLIENT_ID         from pipedream.com/settings/oauth-apps
//   PIPEDREAM_CLIENT_SECRET     same place
//   PIPEDREAM_PROJECT_ID        proj_xxx from your project settings
//   PIPEDREAM_ENVIRONMENT       'development' or 'production'  (default: development)
//   PIPEDREAM_TEST_APP_SLUG     slug to probe, default 'beehiiv'
//   PIPEDREAM_EXTERNAL_USER_ID  any string you choose; pipedream tenants on this. default 'donna-probe'

import { performance } from "node:perf_hooks";

const CLIENT_ID = req("PIPEDREAM_CLIENT_ID");
const CLIENT_SECRET = req("PIPEDREAM_CLIENT_SECRET");
const PROJECT_ID = req("PIPEDREAM_PROJECT_ID");
const ENV = process.env.PIPEDREAM_ENVIRONMENT ?? "development";
const APP_SLUG = process.env.PIPEDREAM_TEST_APP_SLUG ?? "beehiiv";
const EXTERNAL_USER_ID = process.env.PIPEDREAM_EXTERNAL_USER_ID ?? "donna-probe";

const MCP_URL = "https://remote.mcp.pipedream.net";

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env ${name}. see header comment.`);
    process.exit(1);
  }
  return v;
}

// step 1 — exchange client credentials for an access token
async function getAccessToken(): Promise<string> {
  const r = await fetch("https://api.pipedream.com/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!r.ok) {
    throw new Error(`token exchange failed: ${r.status} ${await r.text()}`);
  }
  const j = await r.json() as { access_token: string; token_type: string };
  return j.access_token;
}

// step 2 — fire a single MCP rpc call against the gateway
async function rpc(token: string, body: unknown): Promise<unknown> {
  const r = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      "x-pd-project-id": PROJECT_ID,
      "x-pd-environment": ENV,
      "x-pd-external-user-id": EXTERNAL_USER_ID,
      "x-pd-app-slug": APP_SLUG,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`rpc ${r.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    // streaming response — return as-is, caller can parse
    return text;
  }
}

async function main(): Promise<void> {
  console.log(`pipedream MCP probe · app=${APP_SLUG} env=${ENV}\n`);

  const t0 = performance.now();
  const token = await getAccessToken();
  console.log(`✓ token exchange  (${(performance.now() - t0).toFixed(0)}ms)`);

  // initialize
  const t1 = performance.now();
  const init = await rpc(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "donna-probe", version: "0.1" },
    },
  });
  console.log(`✓ initialize      (${(performance.now() - t1).toFixed(0)}ms)`);
  console.log("  server:", JSON.stringify((init as any)?.result?.serverInfo ?? init).slice(0, 200));

  // list tools
  const t2 = performance.now();
  const tools = await rpc(token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const list = (tools as any)?.result?.tools ?? [];
  console.log(`✓ tools/list      (${(performance.now() - t2).toFixed(0)}ms) — ${list.length} tools available for ${APP_SLUG}`);

  // print the first 5 tool names + descriptions to feel the catalog shape
  for (const t of list.slice(0, 5)) {
    const name = t.name ?? "(unnamed)";
    const desc = (t.description ?? "").split("\n")[0]?.slice(0, 90) ?? "";
    console.log(`   • ${name} — ${desc}`);
  }

  if (list.length === 0) {
    console.log("\n(empty tool list usually means the user isn't connected to this app yet — that's expected)");
  }

  console.log(`\ntotal end-to-end: ${(performance.now() - t0).toFixed(0)}ms`);
}

main().catch((err) => {
  console.error("\nfailed:", err.message);
  process.exit(1);
});
