// minimal cli loop. reads a line from stdin, runs one brain turn, renders any
// send_burst output. conversation history lives in memory for the process
// lifetime — no persistence yet.
//
// run with: npm run dev
// exits on "exit", "quit", or ctrl-d.

import "dotenv/config";
import { createInterface } from "node:readline";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { runTurn } from "./donna/brain.js";
import type { OutboundMessage } from "./donna/messages.js";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const history: MessageParam[] = [];

// the cli is one of three render targets for OutboundMessage (alongside
// whatsapp and the mobile app, later). it prints plain-text stubs that show
// what claude chose. delay is honored — `delay` items actually sleep.
async function render(msg: OutboundMessage): Promise<void> {
  switch (msg.type) {
    case "text":
      console.log(`donna: ${msg.text}`);
      return;
    case "buttons": {
      const btns = msg.buttons
        .map((b) => `${b.label} [${b.id}]`)
        .join("  |  ");
      console.log(`donna: ${msg.text}\n        ⟦ ${btns} ⟧`);
      return;
    }
    case "list": {
      const lines: string[] = [];
      for (const section of msg.sections) {
        if (section.title) lines.push(`        — ${section.title} —`);
        for (const row of section.rows) {
          const desc = row.description ? ` — ${row.description}` : "";
          lines.push(`        · ${row.title}${desc}  [${row.id}]`);
        }
      }
      console.log(
        `donna: ${msg.text}\n        ⟦ list: ${msg.button_label} ⟧\n${lines.join("\n")}`,
      );
      return;
    }
    case "cta_url":
      console.log(`donna: ${msg.text}\n        ⟦ ${msg.label} → ${msg.url} ⟧`);
      return;
    case "image":
      console.log(
        `donna: 🖼  ${msg.url}${msg.caption ? `\n        caption: ${msg.caption}` : ""}`,
      );
      return;
    case "document":
      console.log(
        `donna: 📄 ${msg.filename} (${msg.url})${msg.caption ? `\n        caption: ${msg.caption}` : ""}`,
      );
      return;
    case "video":
      console.log(
        `donna: 🎞  ${msg.url}${msg.caption ? `\n        caption: ${msg.caption}` : ""}`,
      );
      return;
    case "audio":
      console.log(`donna: 🔊 ${msg.url}`);
      return;
    case "delay":
      console.log(`donna: … (pause ${msg.seconds}s)`);
      await new Promise((r) => setTimeout(r, msg.seconds * 1000));
      return;
  }
}

function ask(): void {
  rl.question("you: ", async (line) => {
    const text = line.trim();
    if (!text) return ask();
    if (text === "exit" || text === "quit") {
      rl.close();
      return;
    }

    history.push({ role: "user", content: text });

    try {
      const result = await runTurn(history);
      history.push(...result.newMessages);
      for (const msg of result.sends) {
        await render(msg);
      }
      if (result.terminator === null) {
        console.log("(no terminator — model didn't call send_burst this turn)");
      }
      console.log(`(run: ${result.runId})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`error: ${msg}`);
    }

    ask();
  });
}

rl.on("close", () => process.exit(0));
ask();
