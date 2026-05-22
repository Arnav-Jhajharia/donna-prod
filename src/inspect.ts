// "show me exactly what would be sent to anthropic." no api call, no
// completion — just the payload, printed as json. you can't claim granular
// control over a request you can't see; this is how you see it.
//
// usage:
//   npm run inspect -- "what's on my plate today"
//   npm run inspect < transcript.json
//
// the second form expects a JSON array of MessageParam objects on stdin and
// shows exactly what runTurn would build from that history.

import "dotenv/config";
import { readFileSync } from "node:fs";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { buildPayload } from "./donna/brain.js";

function readStdinIfPiped(): string {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function loadHistory(): MessageParam[] {
  const stdin = readStdinIfPiped().trim();
  if (stdin) {
    const parsed: unknown = JSON.parse(stdin);
    if (!Array.isArray(parsed)) {
      throw new Error("stdin must be a JSON array of MessageParam");
    }
    return parsed as MessageParam[];
  }
  const arg = process.argv.slice(2).join(" ").trim();
  if (!arg) {
    console.error(
      'usage: npm run inspect -- "<message>"  |  npm run inspect < transcript.json',
    );
    process.exit(1);
  }
  return [{ role: "user", content: arg }];
}

const history = loadHistory();
const payload = buildPayload(history);
const json = JSON.stringify(payload, null, 2);

// payload to stdout (json), summary to stderr (so `npm run inspect | jq` works)
console.log(json);
console.error(
  `\n[payload: ${json.length.toLocaleString()} chars, ${payload.messages.length} message(s), ${Array.isArray(payload.tools) ? payload.tools.length : 0} tool(s)]`,
);
