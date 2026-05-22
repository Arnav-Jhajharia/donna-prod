import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { MODEL, runTurn } from "./donna/brain.js";
import { loadRecentMessages, saveMessages } from "./donna/memory/chat.js";
import { getSql, closeDb } from "./donna/db.js";
import {
  createExecutionRun,
  finishExecutionRun,
  recordExecutionEvent,
} from "./donna/observability/execution.js";

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const dbUrl = process.env.DATABASE_URL;
  const userId = process.env.DONNA_USER_ID;

  if (!apiKey) {
    console.error(
      "error: ANTHROPIC_API_KEY not set. copy .env.example to .env and paste your key.",
    );
    process.exit(1);
  }
  if (!dbUrl) {
    console.error(
      "error: DATABASE_URL not set. add the session-pooler url to .env.",
    );
    process.exit(1);
  }
  if (!userId) {
    console.error(
      "error: DONNA_USER_ID not set. add a uuid to .env.",
    );
    process.exit(1);
  }

  // db health check
  try {
    const sql = getSql();
    await sql`select 1`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `donna can't reach her memory. fix the database url and try again. (${msg})`,
    );
    await closeDb();
    process.exit(1);
  }

  // load history
  let messages: MessageParam[];
  try {
    messages = await loadRecentMessages(userId, 50);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`donna couldn't load her memory. (${msg})`);
    await closeDb();
    process.exit(1);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });

  console.log("donna v0.1. type /quit to exit.\n");

  while (true) {
    let line: string;
    try {
      line = (await rl.question("you: ")).trim();
    } catch {
      // ctrl-c or stream close
      break;
    }

    if (!line) continue;
    if (line === "/quit") break;

    const runId = await createExecutionRun({
      userId,
      channel: "cli",
      mode: "reactive",
      model: MODEL,
      metadata: { input_preview: line.slice(0, 200) },
    });
    await recordExecutionEvent(runId, "inbound_received", "cli", {
      length: line.length,
    });

    let result;
    try {
      result = await runTurn({
        mode: "reactive",
        messages,
        userInput: line,
        userId,
        source: "cli",
        runId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `\ndonna couldn't reach the model. try again. (${msg})\n`,
      );
      await finishExecutionRun(runId, { status: "failed", error: msg });
      // do NOT mutate messages on failure
      continue;
    }

    messages = result.messages;

    // best-effort persist
    try {
      await saveMessages(userId, result.newMessages, "reactive");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`couldn't write to memory: ${msg}`);
    }

    await finishExecutionRun(runId, {
      status: "completed",
      terminator: result.terminator,
      finalSends: result.sends,
      voiceViolations: result.voiceViolations,
    });
    console.log(`\n[run ${runId.slice(0, 8)}] terminator=${result.terminator} iterations=${result.iterations} ptc=${result.ptcInvocations}`);

    // print each visible send on its own line, separated by a blank line
    for (const send of result.sends) {
      console.log(`\ndonna: ${send}`);
    }
    if (result.sends.length > 0) console.log();

    if (result.terminator === "cap_hit") {
      console.error("[cap_hit]");
    }
  }

  rl.close();
  await closeDb();
  console.log("\nbye.");
}

main().catch(async (err) => {
  console.error("fatal:", err);
  await closeDb();
  process.exit(1);
});
