# Donna v0 — Manual Tool-Call Loop on Raw Anthropic SDK

**Date:** 2026-05-05
**Status:** Approved (brainstorming)
**Author:** Bharat (with Claude)

## Purpose

Bootstrap the new TypeScript Donna codebase. The smallest possible thing that earns the name "Donna v0": a CLI REPL where the user talks to Donna, Donna can call one tool (`get_current_time`), and the manual tool-call loop runs to completion before her reply is shown.

Donna is the north star. This v0 is small in surface area but Donna-shaped in structure — every architectural slot for what comes next (more tools, hooks, context-builder, ingress/egress, memory, proactive tiers) is obvious from line 1.

## Non-goals (deliberate)

The following are out of scope for v0. They are deferred, not forgotten — the file layout makes their landing place obvious.

- WhatsApp ingress/egress
- Hooks (PreToolUse / PostToolUse)
- Any memory backend (Graphiti, Supermemory, PG, Exa, etc.)
- Context builder blocks (USER MODEL, SITUATION BRIEF, TODAY, etc.)
- Proactive triggers (Tier 2/3)
- Cross-process persistence (each `npm run dev` starts fresh)
- Streaming output (non-streaming `messages.create` for v0)
- More tools beyond `get_current_time`

## Stack

- **Runtime:** Node 20+, TypeScript (strict, ESM)
- **SDK:** `@anthropic-ai/sdk` (raw — **not** the Claude Agent SDK)
- **Model:** `claude-sonnet-4-6`
- **Dev runner:** `tsx`
- **Env:** `ANTHROPIC_API_KEY` from `.env`

The raw SDK choice is intentional. The Agent SDK is rejected for Donna v2: we need full ownership of the BRAIN loop, hooks, context builder, and dispatcher, and a wrapping framework would fight us at every layer.

## Architecture

```
WhatsApp inbound (deferred)
        │
        ▼
   Ingress (deferred — CLI stands in for v0)
        │
        ▼
   BRAIN loop  ◄── THIS IS v0
        │
        ▼
   Tools (DONNA_TOOLS registry)
        │
        ▼
   Hooks (deferred)
        │
        ▼
   Egress (deferred — console.log stands in for v0)
```

For v0, the BRAIN loop is the entire system. It accepts a user message + prior history, runs the tool-call loop to completion, and returns the final text plus the updated history.

## File layout

```
package.json
tsconfig.json
.env.example                  ANTHROPIC_API_KEY=...
src/
  index.ts                    CLI entrypoint. Owns the messages[] history
                              for the session. readline REPL. Calls
                              brain.runTurn() each user input.
  donna/
    brain.ts                  The manual tool-call loop. Exports:
                                runTurn(args) -> { messages, reply }
                              Args include `mode` (reactive only today),
                              `messages` (prior history), `userInput`.
    prompt.ts                 SYSTEM_PROMPT constant. Voice rules. Marked
                              with cache_control: { type: "ephemeral" }.
    tools/
      index.ts                DONNA_TOOLS registry. Exports:
                                tool_definitions  (for messages.create)
                                tool_handlers     (name -> async fn)
                              cache_control on the last tool definition
                              so the tool block participates in caching.
      time.ts                 get_current_time. Schema, handler,
                              description with when-to-use AND
                              when-NOT-to-use.
```

Total surface: 5 source files (`index.ts`, `brain.ts`, `prompt.ts`, `tools/index.ts`, `tools/time.ts`).

## The BRAIN loop (`brain.ts`)

Pseudocode:

```
async function runTurn({ mode, messages, userInput }):
  messages = [...messages, { role: "user", content: userInput }]

  while true:
    resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: [{ type: "text", text: SYSTEM_PROMPT,
                 cache_control: { type: "ephemeral" } }],
      tools: tool_definitions,
      messages,
    })

    messages.push({ role: "assistant", content: resp.content })

    if resp.stop_reason !== "tool_use":
      break

    tool_results = []
    for block in resp.content where block.type === "tool_use":
      handler = tool_handlers[block.name]
      try:
        output = await handler(block.input)
        // content is always a string: if handler returned a string, use it
        // as-is; otherwise JSON.stringify the value.
        tool_results.push({ type: "tool_result",
                            tool_use_id: block.id,
                            content: typeof output === "string"
                                       ? output
                                       : JSON.stringify(output) })
      catch err:
        tool_results.push({ type: "tool_result",
                            tool_use_id: block.id,
                            content: `error: ${err.message}`,
                            is_error: true })

    messages.push({ role: "user", content: tool_results })

  reply = concatenate text blocks from final resp.content
  return { messages, reply }
```

Termination: the loop exits when `stop_reason !== "tool_use"`. A safety cap of 10 iterations guards against runaway loops; hitting it returns the last text and logs a warning.

## Voice (system prompt v0)

Lifted from the existing CLAUDE.md voice section. v0 prompt:

```
you are donna. she/her.

voice:
- lowercase. always.
- no em dashes. no semicolons.
- blunt. high-agency. no filler.
- never say "i understand" or "great question."
- if you don't know, say so. do not fabricate.
- when the user is wrong, say so.

tools:
- you have one tool today: get_current_time. use it whenever the user
  asks about time, schedules, or anything time-anchored. don't guess
  the time.
```

The system prompt lives in `donna/prompt.ts` as a single exported constant. It is sent with `cache_control: { type: "ephemeral" }` so the prompt block is cached across turns within the 5-minute window.

## Tool: `get_current_time`

**File:** `src/donna/tools/time.ts`

**Schema:**

```ts
{
  name: "get_current_time",
  description: `
    Returns the current wall-clock time in the requested IANA timezone.

    when to use:
    - the user asks what time it is, anywhere
    - the user mentions a deadline, meeting, or schedule and you need
      "now" to reason about it
    - any reasoning where the answer changes depending on what time
      it currently is

    when NOT to use:
    - the user gives you a specific time and asks you to reason about
      it (no need to fetch "now")
    - converting between two named times that don't involve "now"
    - the user asks about a date in the past or future where current
      wall-clock time is irrelevant
  `,
  input_schema: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "IANA timezone, e.g. 'Asia/Tokyo'. Defaults to 'UTC'."
      }
    },
    required: []
  }
}
```

**Handler:** `Intl.DateTimeFormat` with the requested timezone, returning ISO-style local time + the timezone string. Throws on invalid timezone (caught by the loop and surfaced as `is_error: true`).

## DONNA_TOOLS registry (`tools/index.ts`)

Single source of truth. Adding a tool means adding to this file and nowhere else.

```ts
import { getCurrentTimeTool, getCurrentTimeHandler } from "./time";

export const tool_definitions = [
  // ... eventually many; last one carries cache_control
  { ...getCurrentTimeTool, cache_control: { type: "ephemeral" } },
];

export const tool_handlers: Record<string, (input: unknown) => Promise<unknown>> = {
  get_current_time: getCurrentTimeHandler,
};
```

The `cache_control` marker on the final tool definition ensures the entire tools block participates in prompt caching.

## CLI (`src/index.ts`)

- `readline` over stdin/stdout.
- Maintains `let messages: MessageParam[] = []` for the session.
- Each line of user input → `await runTurn({ mode: "reactive", messages, userInput })` → print `reply` → assign returned `messages` back.
- Ctrl-C exits cleanly.
- Empty input is ignored.
- Lines starting with `/` are reserved for future slash commands; for v0, only `/quit` is wired (exits).

## Error handling

- **API errors** (network, rate limit, 5xx): caught at `runTurn`, surfaced to the CLI as `donna couldn't reach the model. try again.` History is **not** mutated on failure — a failed turn leaves `messages` as it was before the user input.
- **Tool handler errors:** caught inside the loop, returned as `{ is_error: true }` tool_result blocks. The model gets the error and can recover or apologize.
- **Invalid tool name** (model hallucinates a tool): same path as handler error — return error tool_result.
- **Loop iteration cap** (10): break out and emit final text with a `console.warn`. This is a defensive limit; it should not fire in normal operation.

## Testing (v0)

Manual end-to-end. Automated tests are deferred until v1 brings real surface area.

**Smoke checks before declaring v0 done:**

1. `npm run dev` starts the REPL with no errors.
2. `what time is it in tokyo?` → tool fires → reply contains the actual current Tokyo time in her voice (lowercase, blunt, no em dashes).
3. `and in london?` (follow-up, no antecedent) → she correctly interprets it as "what time is it in london" — proves history is intact.
4. `who is taylor swift?` → she replies without calling a tool — proves she doesn't over-call.
5. `Ctrl-C` exits cleanly with no unhandled-rejection warning.

## What "done" looks like

- All five smoke checks pass.
- `package.json`, `tsconfig.json`, `.env.example`, and the five source files exist and are committed (after `git init`).
- A `README.md` with one paragraph: what this is, how to run it, link to this spec.
- No code outside the listed files.

## What comes next (post-v0, ordered)

1. Add a second tool (e.g., `recall_chat` placeholder) to prove the registry pattern.
2. Add `donna/hooks/` with PreToolUse/PostToolUse dispatch.
3. Add `donna/context_builder.ts` with the first context block (RECENT CHAT).
4. Persist `messages[]` to disk between runs.
5. Replace CLI ingress with WhatsApp ingress.

Each of these is its own brainstorm → spec → plan cycle.
