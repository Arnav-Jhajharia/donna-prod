# donna

donna is a whatsapp/imessage-native personal ai. she holds one person's life — remembers what they said, follows up, surfaces next moves before they ask. not "an assistant," not a thinking partner, not a productivity tool. closer to a sharp human chief of staff.

## architecture

a manual tool-call loop on the raw `@anthropic-ai/sdk` (no Claude Agent SDK). the model only ever speaks via the `send_burst` terminator — every turn ends with one `send_burst` tool call whose strings are the messages the user sees. raw assistant text is private reasoning and is never shown.

```
inbound (whatsapp/imessage webhook)
  → src/server.ts (verify, ack, dispatch)
  → resolve user (memory/users.ts)
  → load history (memory/chat.ts) — coalesces consecutive same-role rows
  → src/donna/brain.ts runTurn — manual loop, langsmith-traced
      ↳ tools/index.ts registers tools + handlers
      ↳ direct tools run in process; ptc-eligible tools run from python in
        anthropic's code_execution_20250825 sandbox
      ↳ integrations/service.ts is the gate for every external call
        (composio entity resolution, audit, mode enforcement)
  → terminator (send_burst) emits the user-visible bursts
  → save messages to chat_messages (mode=reactive|proactive)
  → deliver via WhatsAppChannel / IMessageChannel
  → execution_runs + execution_events capture the turn timeline
```

### key modules

- `src/donna/brain.ts` — the loop. `runTurn` (reactive) and `runProactiveTurn` (runtime triggers). wraps anthropic with langsmith via `argsConfigPath: [0, "langsmithExtra"]`. caches the trailing message block per request via `withTrailingCacheControl`.
- `src/donna/prompt.ts` — the system prompt. xml-tagged sections (`<why_you_exist>`, `<voice>`, `<whatsapp_rules>`, `<tools>`, `<orchestration>`, `<integration_lifecycle>`, `<inbox_copilot_intents>`). load-bearing — every word is doing work.
- `src/donna/tools/index.ts` — single registry for tool definitions, handlers, and the `PTC_ELIGIBLE` / `TERMINATORS` sets.
- `src/donna/tools/send_burst.ts` — the terminator. donna's only voice.
- `src/donna/tools/gmail.ts` — gmail read tools (ptc-callable). thin wrappers around `executeForUser(...)`.
- `src/donna/tools/integrations.ts` — connect / status / set_mode / disconnect (direct-only). `integration_connect` returns a redirect_url and fires a detached `waitForConnection` that delivers a proactive ack on success.
- `src/donna/integrations/service.ts` — readState / upsertState / executeForUser. every external call is audited.
- `src/donna/memory/chat.ts` — load/save persisted messages. coalesces consecutive same-role rows so storage can be non-alternating but the api always sees alternation.
- `src/donna/observability/execution.ts` — execution_runs + execution_events tables. visible at `/debug/runs` (requires `DONNA_OBSERVABILITY_TOKEN`).
- `src/donna/context.ts` — `AsyncLocalStorage`-backed turn context. handlers read userId / runId / source via `getTurnContext()`; do not thread these by hand.
- `src/server.ts` — http server. `/webhook` (whatsapp), `/imessage/webhook` (linq, hmac-verified), `/debug/runs` (bearer-auth).

### tool taxonomy

- **direct-only**: called by claude in the main loop. terminators (`send_burst`) and lifecycle/state-changing tools (`integration_connect`, `integration_status`, `integration_set_mode`, `integration_disconnect`, `get_current_time`).
- **ptc-callable**: declared with `allowed_callers: ["code_execution_20250825"]`. claude writes python that calls them via `asyncio.gather` for fan-out reads. all gmail and imessage read tools are here.

never call `send_burst` from inside python. never call lifecycle tools from inside python. they change user-visible state.

## scripts

```bash
npm run wa          # whatsapp server, hot-reload via tsx watch
npm run wa:once     # single-shot (no reload) — use when debugging restarts
npm run dev         # cli loop (uses DONNA_USER_ID)
npm run inspect     # print exactly what the brain would send to anthropic
npm run typecheck   # tsc --noEmit
npm run migrate     # supabase db push
```

`npm run inspect` mirrors `brain.ts` byte-for-byte (tools, system, messages, cache markers, ~token estimates). use it before claiming the prompt or message history is in a particular shape.

## data

postgres (supabase). `postgres@^3` (porsager). migrations in `supabase/migrations/`.

- `users(id, phone, profile_name, ...)` — canonical user, resolved by phone on inbound.
- `chat_messages(id, seq, user_id, role, content jsonb, mode, created_at)` — full conversation history. `mode = reactive | proactive | proactive_tier3`. storage allows non-alternating rows; the loader coalesces.
- `inbound_messages` — raw dedupe/audit trail of webhook payloads.
- `integrations(user_id, provider, status, mode, exclusions, config, composio_account_id, ...)` — per-(user, provider) state row. `(user_id, provider)` unique.
- `integration_audit` — every external call logged.
- `execution_runs(id, user_id, channel, mode, status, terminator, ...)` + `execution_events(run_id, ts, kind, label, meta jsonb)` — turn timeline.

never `git add -A` migrations without reviewing them. one migration per logical change.

## conventions

- voice: lowercase, no em dashes, no semicolons, no emojis, no markdown. always end with `send_burst`. never put reasoning inside burst strings — those are exactly what the user reads.
- code: small focused files (target 200-400 lines, hard ceiling 800). organize by feature/domain. immutable updates only — return new objects, never mutate.
- never change `chat_messages` storage shape without updating the coalesce logic in `memory/chat.ts`.
- the system prompt is steering, not boilerplate. before editing it, run `npm run inspect` and look at what the model is currently doing.
- prompt caching: the trailing message block carries `cache_control: ephemeral`; the system block also does. sonnet 4.6 needs ≥ 2048 tokens of prefix to actually cache — short conversations silently won't cache. inspect with `npm run inspect` and check `cache_read_input_tokens` in `execution_events`.
- before commit: `npm run typecheck`. tests are TBD per the testing rule.
- handler errors: throw — the brain catches and converts to `is_error: true` tool_results so the model can recover.

## env vars

required for `npm run wa`: `ANTHROPIC_API_KEY`, `DATABASE_URL`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `COMPOSIO_API_KEY`.
required for cli `npm run dev`: `ANTHROPIC_API_KEY`, `DATABASE_URL`, `DONNA_USER_ID`.
optional: `LANGSMITH_*` (leave `LANGSMITH_TRACING` unset to disable). `LINQ_*` for imessage. `DONNA_OBSERVABILITY_TOKEN` for `/debug/runs`.

`.env.example` is the source of truth for what's expected.

## sharp edges

- `scripts/connect-integration.ts` calls `composio.toolkits.authorize(provider, {alias})`, which reflects an older composio sdk. current sdk is `authorize(userId, toolkit)`. tool handler in `tools/integrations.ts` uses the correct signature; the cli script will fail at runtime until updated.
- prompt cache stays inactive until the prefix grows past ~2048 tokens. fresh users see no cache hits for the first several turns. don't conclude caching is broken without checking `cache_read_input_tokens` over multiple turns.
- the brain currently persists the model's full assistant content (including any leaked private-reasoning text blocks alongside `tool_use(send_burst)`). that text never reaches the user but it does poison future turns. there's an open todo to filter non-`send_burst`-input text before persisting.
- the trailing-block cache marker skips `thinking` / `redacted_thinking` blocks (the SDK forbids `cache_control` on those). don't remove that guard.
- `integration_connect` fires `waitForConnection` in a detached promise. server restarts during the oauth window lose the pending await — for production the right move is a composio webhook handler at `/composio/webhook` that does the same `upsertState` + `runProactiveTurn` work.

## adding things

- **new tool**: add the def + handler in `src/donna/tools/<name>.ts`, register in `tools/index.ts`, add to `PTC_ELIGIBLE` if it's pure read and benefits from fan-out, document in `<tools>` in `prompt.ts`.
- **new ingress channel**: parser in `src/donna/ingress/`, dispatcher in `src/server.ts` (mirror `dispatchPayload`/`dispatchImessagePayload`), delivery class in `src/donna/delivery/`, register source in `context.ts`.
- **new migration**: `supabase/migrations/YYYYMMDDhhmmss_<name>.sql`, then `npm run migrate`. always include a `down`-equivalent comment if it's not trivially reversible.
- **new integration provider**: add to `integrations/service.ts` if any provider-specific quirks; tools call `executeForUser(provider, slug, args, opts)`; the connect tool already handles oauth lifecycle generically.

## reference

- `borrow-from-old.md` — patterns lifted (or rejected) from the old python `donna_runtime/`. read before reinventing something the old codebase tried.
- `donna-architecture.excalidraw` — current architecture sketch.
- `insights.md` — observations from running the system.
