# Donna v0 — Tool-Call Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap the new TypeScript Donna codebase with a CLI REPL that runs a manual tool-call loop on the raw Anthropic SDK and exposes one tool (`get_current_time`).

**Architecture:** A single BRAIN function (`runTurn`) drives the manual loop: send messages → receive response → if `stop_reason === "tool_use"`, run handlers and feed `tool_result` blocks back → repeat until the model stops calling tools. The CLI owns the per-session `messages[]` array. Layout mirrors the eventual Donna shape: `donna/brain.ts`, `donna/prompt.ts`, `donna/tools/{index,time}.ts`.

**Tech Stack:** Node 20+, TypeScript (strict, ESM), `@anthropic-ai/sdk` (raw — not the Agent SDK), `tsx` for dev, `dotenv` for env loading. Model: `claude-sonnet-4-6`.

**Spec:** `docs/superpowers/specs/2026-05-05-donna-v0-tool-loop-design.md`

**Note on testing:** The spec defers automated tests until v1. Each task verifies via `npm run typecheck` (compile-time correctness) plus, where relevant, a `node -e` smoke check. End-to-end verification happens in Task 7's smoke checks. When v1 brings hooks/memory/proactive, that plan will introduce the test harness.

---

## File Map

| Path | Purpose |
|---|---|
| `package.json` | Deps, scripts (`dev`, `typecheck`) |
| `tsconfig.json` | Strict TS, ESM, `bundler` resolution |
| `.env.example` | `ANTHROPIC_API_KEY=` placeholder |
| `.env` | Real key, gitignored |
| `src/index.ts` | CLI REPL, owns session `messages[]` |
| `src/donna/brain.ts` | The manual tool-call loop. Exports `runTurn` |
| `src/donna/prompt.ts` | `SYSTEM_PROMPT` constant (voice rules) |
| `src/donna/tools/index.ts` | `DONNA_TOOLS` registry — `tool_definitions` + `tool_handlers` |
| `src/donna/tools/time.ts` | `get_current_time` schema + handler |
| `README.md` | One paragraph: what it is, how to run it, link to spec |

---

## Task 1: Project Scaffold

Set up the Node/TypeScript project, install deps, create empty source dirs.

**Files:**
- Create: `/Users/i3dlab/Documents/NUS/donna/package.json`
- Create: `/Users/i3dlab/Documents/NUS/donna/tsconfig.json`
- Create: `/Users/i3dlab/Documents/NUS/donna/.env.example`
- Create: `/Users/i3dlab/Documents/NUS/donna/.env` (gitignored)

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "donna",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "description": "donna v2 — whatsapp-native personal ai. v0: cli tool-loop bootstrap.",
  "scripts": {
    "dev": "tsx src/index.ts",
    "typecheck": "tsc --noEmit",
    "build": "tsc"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write `.env.example`**

```
ANTHROPIC_API_KEY=
```

- [ ] **Step 4: Write `.env`** (real key — gitignored, never committed)

```
ANTHROPIC_API_KEY=<paste real key here>
```

Verify `.env` is ignored:

```bash
cd /Users/i3dlab/Documents/NUS/donna && git check-ignore -v .env
```

Expected: prints `.gitignore:11:.env	.env` (or similar). If it does NOT print a line, STOP — `.env` is not ignored and we must fix `.gitignore` before continuing.

- [ ] **Step 5: Install runtime dependencies**

```bash
cd /Users/i3dlab/Documents/NUS/donna && npm install @anthropic-ai/sdk dotenv
```

Expected: `package-lock.json` created, `node_modules/` populated, `package.json` gains `"dependencies"` block with both packages.

- [ ] **Step 6: Install dev dependencies**

```bash
cd /Users/i3dlab/Documents/NUS/donna && npm install -D typescript tsx @types/node
```

Expected: `package.json` gains `"devDependencies"` block with all three.

- [ ] **Step 7: Verify typecheck script runs (no source files yet)**

```bash
cd /Users/i3dlab/Documents/NUS/donna && mkdir -p src && printf 'export {};\n' > src/placeholder.ts && npm run typecheck && rm src/placeholder.ts
```

Expected: exits 0. (We use `placeholder.ts` rather than a dotfile because the TS `include: ["src/**/*"]` glob skips dotfiles, which would cause `TS18003: No inputs were found`.)

- [ ] **Step 8: Commit**

```bash
cd /Users/i3dlab/Documents/NUS/donna && git add package.json package-lock.json tsconfig.json .env.example && git commit -m "chore: scaffold node+typescript project with anthropic sdk"
```

Verify `.env` is NOT in the commit:

```bash
cd /Users/i3dlab/Documents/NUS/donna && git show --stat HEAD
```

Expected: file list shows `package.json`, `package-lock.json`, `tsconfig.json`, `.env.example` only. **No `.env`.**

---

## Task 2: `get_current_time` Tool

Implement the only tool: schema with when-to-use AND when-NOT-to-use, handler using `Intl.DateTimeFormat`.

**Files:**
- Create: `/Users/i3dlab/Documents/NUS/donna/src/donna/tools/time.ts`

- [ ] **Step 1: Write `src/donna/tools/time.ts`**

```ts
import type { Tool } from "@anthropic-ai/sdk/resources/messages";

export const getCurrentTimeTool: Tool = {
  name: "get_current_time",
  description: `returns the current wall-clock time in the requested IANA timezone.

when to use:
- the user asks what time it is, anywhere
- the user mentions a deadline, meeting, or schedule and you need "now" to reason about it
- any reasoning where the answer changes depending on what time it currently is

when NOT to use:
- the user gives you a specific time and asks you to reason about it (no need to fetch "now")
- converting between two named times that don't involve "now"
- the user asks about a date in the past or future where current wall-clock time is irrelevant`,
  input_schema: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "IANA timezone, e.g. 'Asia/Tokyo'. Defaults to 'UTC'.",
      },
    },
  },
};

interface GetCurrentTimeInput {
  timezone?: string;
}

export async function getCurrentTimeHandler(input: unknown): Promise<string> {
  const { timezone = "UTC" } = (input ?? {}) as GetCurrentTimeInput;

  // throws RangeError on invalid IANA timezone — caller catches and surfaces
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date());
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const iso = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;

  return `${iso} (${timezone})`;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/i3dlab/Documents/NUS/donna && npm run typecheck
```

Expected: exits 0, no errors.

- [ ] **Step 3: Smoke-test the handler in isolation**

```bash
cd /Users/i3dlab/Documents/NUS/donna && npx tsx -e "import('./src/donna/tools/time.ts').then(async (m) => { console.log(await m.getCurrentTimeHandler({ timezone: 'Asia/Tokyo' })); console.log(await m.getCurrentTimeHandler({})); })"
```

Expected: two lines, e.g.:
```
2026-05-06T03:08:42 (Asia/Tokyo)
2026-05-05T18:08:42 (UTC)
```
The Tokyo time should be ~9 hours ahead of UTC. Date and time should be plausible "now."

- [ ] **Step 4: Smoke-test the error path**

```bash
cd /Users/i3dlab/Documents/NUS/donna && npx tsx -e "import('./src/donna/tools/time.ts').then(async (m) => { try { await m.getCurrentTimeHandler({ timezone: 'Not/A/Real/Zone' }); console.log('UNEXPECTED: no throw'); } catch (e) { console.log('threw as expected:', e.message); } })"
```

Expected: `threw as expected: Invalid time zone specified: Not/A/Real/Zone` (or similar `RangeError` message).

- [ ] **Step 5: Commit**

```bash
cd /Users/i3dlab/Documents/NUS/donna && git add src/donna/tools/time.ts && git commit -m "feat(tools): add get_current_time with IANA timezone support"
```

---

## Task 3: `DONNA_TOOLS` Registry

Centralize tool definitions and handlers in one place. Mark the last tool def with `cache_control` so the entire tools block is cached.

**Files:**
- Create: `/Users/i3dlab/Documents/NUS/donna/src/donna/tools/index.ts`

- [ ] **Step 1: Write `src/donna/tools/index.ts`**

```ts
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { getCurrentTimeTool, getCurrentTimeHandler } from "./time.js";

type ToolWithCache = Tool & {
  cache_control?: { type: "ephemeral" };
};

const tools: ToolWithCache[] = [getCurrentTimeTool];

// mark the LAST tool definition with cache_control: ephemeral.
// per anthropic docs, this caches the entire tools block up to and
// including this tool. as we add tools, the cache_control assignment
// stays on the last entry — this loop keeps it correct.
const lastIdx = tools.length - 1;
tools[lastIdx] = {
  ...tools[lastIdx]!,
  cache_control: { type: "ephemeral" },
};

export const tool_definitions: ToolWithCache[] = tools;

export const tool_handlers: Record<
  string,
  (input: unknown) => Promise<unknown>
> = {
  get_current_time: getCurrentTimeHandler,
};
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/i3dlab/Documents/NUS/donna && npm run typecheck
```

Expected: exits 0, no errors.

- [ ] **Step 3: Smoke-test the registry shape**

```bash
cd /Users/i3dlab/Documents/NUS/donna && npx tsx -e "import('./src/donna/tools/index.ts').then((m) => { console.log('tool count:', m.tool_definitions.length); console.log('last has cache_control:', !!m.tool_definitions[m.tool_definitions.length-1].cache_control); console.log('handler names:', Object.keys(m.tool_handlers)); })"
```

Expected:
```
tool count: 1
last has cache_control: true
handler names: [ 'get_current_time' ]
```

- [ ] **Step 4: Commit**

```bash
cd /Users/i3dlab/Documents/NUS/donna && git add src/donna/tools/index.ts && git commit -m "feat(tools): add DONNA_TOOLS registry with prompt caching"
```

---

## Task 4: System Prompt

Lift Donna's voice rules from CLAUDE.md into a single exported constant.

**Files:**
- Create: `/Users/i3dlab/Documents/NUS/donna/src/donna/prompt.ts`

- [ ] **Step 1: Write `src/donna/prompt.ts`**

```ts
export const SYSTEM_PROMPT = `you are donna. she/her.

voice:
- lowercase. always.
- no em dashes. no semicolons.
- blunt. high-agency. no filler.
- never say "i understand" or "great question."
- if you don't know, say so. do not fabricate.
- when the user is wrong, say so.

tools:
- you have one tool today: get_current_time. use it whenever the user asks about time, schedules, or anything time-anchored. don't guess the time.`;
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/i3dlab/Documents/NUS/donna && npm run typecheck
```

Expected: exits 0, no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/i3dlab/Documents/NUS/donna && git add src/donna/prompt.ts && git commit -m "feat(prompt): add donna v0 system prompt with voice rules"
```

---

## Task 5: BRAIN Loop

The manual tool-call loop. Stays under `donna/brain.ts`. Exports `runTurn({ mode, messages, userInput }) -> { messages, reply }`. Mode param exists for future `proactive` / `proactive_tier3`; today only `reactive` is wired.

**Files:**
- Create: `/Users/i3dlab/Documents/NUS/donna/src/donna/brain.ts`

- [ ] **Step 1: Write `src/donna/brain.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlock,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { tool_definitions, tool_handlers } from "./tools/index.js";
import { SYSTEM_PROMPT } from "./prompt.js";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2048;
const MAX_LOOP_ITERATIONS = 10;

export type BrainMode = "reactive" | "proactive" | "proactive_tier3";

export interface RunTurnArgs {
  mode: BrainMode;
  messages: MessageParam[];
  userInput: string;
}

export interface RunTurnResult {
  messages: MessageParam[];
  reply: string;
}

const client = new Anthropic();

export async function runTurn({
  mode,
  messages,
  userInput,
}: RunTurnArgs): Promise<RunTurnResult> {
  if (mode !== "reactive") {
    throw new Error(`brain mode '${mode}' not implemented yet`);
  }

  // never mutate the caller's messages array. work on a fresh copy.
  const working: MessageParam[] = [
    ...messages,
    { role: "user", content: userInput },
  ];

  let iterations = 0;
  let finalContent: ContentBlock[] = [];

  while (iterations < MAX_LOOP_ITERATIONS) {
    iterations++;

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: tool_definitions,
      messages: working,
    });

    working.push({ role: "assistant", content: resp.content });
    finalContent = resp.content;

    if (resp.stop_reason !== "tool_use") {
      break;
    }

    const toolResults: ToolResultBlockParam[] = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;

      const handler = tool_handlers[block.name];
      if (!handler) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `error: unknown tool '${block.name}'`,
          is_error: true,
        });
        continue;
      }

      try {
        const output = await handler(block.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content:
            typeof output === "string" ? output : JSON.stringify(output),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `error: ${msg}`,
          is_error: true,
        });
      }
    }

    working.push({ role: "user", content: toolResults });
  }

  if (iterations >= MAX_LOOP_ITERATIONS) {
    console.warn(
      `[brain] hit max iterations (${MAX_LOOP_ITERATIONS}) — returning last text`,
    );
  }

  const reply = finalContent
    .filter(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    )
    .map((b) => b.text)
    .join("\n")
    .trim();

  return { messages: working, reply };
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/i3dlab/Documents/NUS/donna && npm run typecheck
```

Expected: exits 0, no errors. If errors mention import paths, double-check the `.js` extensions (TS bundler resolution requires them for ESM).

- [ ] **Step 3: Commit**

```bash
cd /Users/i3dlab/Documents/NUS/donna && git add src/donna/brain.ts && git commit -m "feat(brain): add manual tool-call loop on raw anthropic sdk"
```

---

## Task 6: CLI REPL

The entrypoint. Loads `.env`, owns the session `messages[]`, prompts in a loop, hands each user line to `runTurn`, prints the reply, repeats.

**Files:**
- Create: `/Users/i3dlab/Documents/NUS/donna/src/index.ts`

- [ ] **Step 1: Write `src/index.ts`**

```ts
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
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/i3dlab/Documents/NUS/donna && npm run typecheck
```

Expected: exits 0, no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/i3dlab/Documents/NUS/donna && git add src/index.ts && git commit -m "feat(cli): add donna v0 repl entrypoint"
```

---

## Task 7: README + End-to-End Smoke Checks

Document how to run it and gate "done" on all five smoke checks from the spec passing.

**Files:**
- Create: `/Users/i3dlab/Documents/NUS/donna/README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# donna

whatsapp-native personal ai. she/her. **the ai that feels human.**

this repo is donna v2 — a fresh typescript codebase. the old python `donna_runtime/` lives on in `CLAUDE.md` as reference for what donna is. it is not running here.

## v0

tiny cli bootstrap of the brain loop. one tool: `get_current_time`. proves the manual tool-call loop on the raw `@anthropic-ai/sdk` works end-to-end.

### run it

```bash
cp .env.example .env
# paste your ANTHROPIC_API_KEY into .env
npm install
npm run dev
```

### what works today

- cli repl with conversation history within the session
- one tool: `get_current_time(timezone?)`
- voice rules in the system prompt (lowercase, blunt, no em dashes)
- prompt caching on the system prompt and tools block

### design + plan

- spec: `docs/superpowers/specs/2026-05-05-donna-v0-tool-loop-design.md`
- plan: `docs/superpowers/plans/2026-05-05-donna-v0-tool-loop.md`

### what's next

second tool → hooks → context builder → persistence → whatsapp ingress. each is its own brainstorm → spec → plan cycle.
```

- [ ] **Step 2: Final typecheck**

```bash
cd /Users/i3dlab/Documents/NUS/donna && npm run typecheck
```

Expected: exits 0, no errors.

- [ ] **Step 3: Smoke check 1 — REPL starts cleanly**

```bash
cd /Users/i3dlab/Documents/NUS/donna && npm run dev
```

Expected output (then waits at `you: ` prompt):
```
donna v0. type /quit to exit.

you:
```

If you see `error: ANTHROPIC_API_KEY not set`, fix `.env` and retry. Leave the REPL running for the next checks.

- [ ] **Step 4: Smoke check 2 — tool call works**

In the running REPL, type:
```
what time is it in tokyo?
```

Expected:
- A noticeable delay (1-3 sec) while the model calls `get_current_time` and gets a response.
- Reply printed under `donna:` containing the actual current Tokyo wall-clock time.
- Voice: lowercase. No em dashes. No semicolons. No "I understand" / "Great question." Blunt.

If she replies without calling the tool (no delay, made-up time): the system prompt is not steering tool use enough. Fix Task 4's prompt to be more emphatic.

- [ ] **Step 5: Smoke check 3 — conversation history is intact**

Without restarting, type:
```
and in london?
```

Expected: She interprets "and in london?" as "what time is it in london?" — she calls `get_current_time` with timezone `Europe/London` and replies with the actual London time. This proves the `messages[]` array is being threaded through correctly.

If she asks "what about london?" or doesn't understand the antecedent: the history isn't being passed back to `runTurn`. Re-check `src/index.ts` — the `messages = result.messages` reassignment after each turn.

- [ ] **Step 6: Smoke check 4 — she doesn't over-call tools**

Type:
```
who is taylor swift?
```

Expected: She replies immediately (no tool-call delay, no time data) with a brief blunt answer in her voice. No `get_current_time` call. This proves the when-NOT-to-use clause is doing its job.

- [ ] **Step 7: Smoke check 5 — clean exit**

In the running REPL, type `/quit`:

Expected:
- REPL exits.
- Final line printed: `bye.`
- No unhandled promise rejection warnings, no stack traces.
- Shell prompt returns.

Then start the REPL again and press `Ctrl-C` at the `you: ` prompt:

Expected:
- Process exits within ~1 second (Node may need a second `Ctrl-C` on some terminals — that's acceptable).
- No unhandled promise rejection warnings or stack traces in the output.
- Shell prompt returns.

- [ ] **Step 8: Commit README and tag v0**

```bash
cd /Users/i3dlab/Documents/NUS/donna && git add README.md && git commit -m "docs: add v0 readme" && git tag v0.0.1
```

Verify:

```bash
cd /Users/i3dlab/Documents/NUS/donna && git log --oneline && git tag
```

Expected: 8 commits (init + 7 task commits), tag `v0.0.1` on the latest.

---

## Definition of Done

- All five smoke checks above pass.
- `npm run typecheck` exits 0.
- All ten files from the File Map exist with the contents above.
- `.env` is gitignored and never committed.
- `git log --oneline` shows the expected commits, one per task.

## What this plan deliberately does NOT include

(Cross-reference with spec § Non-goals.)

- WhatsApp ingress / egress
- Hooks (PreToolUse / PostToolUse)
- Memory backends (Graphiti, Supermemory, PG, etc.)
- Context builder blocks
- Proactive Tier 2 / Tier 3
- Cross-process persistence
- Streaming output
- Automated test suite (deferred to v1)
- Tools beyond `get_current_time`

Each lands in its own future spec + plan.
