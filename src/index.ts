import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { runTurn } from "./donna/brain.js";

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "error: ANTHROPIC_API_KEY not set. copy .env.example to .env and paste your key.",
    );
    process.exit(1);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  let messages: MessageParam[] = [];

  console.log("donna v0. type /quit to exit.\n");

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

    try {
      const result = await runTurn({
        mode: "reactive",
        messages,
        userInput: line,
      });
      messages = result.messages;
      console.log(`\ndonna: ${result.reply}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `\ndonna couldn't reach the model. try again. (${msg})\n`,
      );
      // do NOT mutate messages on failure — leave history as it was
    }
  }

  rl.close();
  console.log("\nbye.");
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
