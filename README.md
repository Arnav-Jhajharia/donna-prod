# donna

whatsapp-native personal ai. she/her. **the ai that feels human.**

this repo is donna v2 — a fresh typescript codebase. the old python `donna_runtime/` lives on in `CLAUDE.md` as reference for what donna is.

## v0.1

cli bootstrap of the brain loop with supabase persistence and the send_burst terminator. one tool: `get_current_time`. proves the manual tool-call loop on the raw `@anthropic-ai/sdk` works end-to-end with chat history persisted across restarts.

### setup

```bash
cp .env.example .env
# fill in:
#   ANTHROPIC_API_KEY  - from console.anthropic.com
#   DATABASE_URL       - session-pooler url from supabase project settings
#   DONNA_USER_ID      - any uuid (uuidgen / crypto.randomUUID())

npm install

# one-time supabase CLI setup
npx supabase login
npx supabase link --project-ref <your-project-ref>

# apply the chat_messages migration
npm run migrate

# go
npm run dev
```

### what works today

- cli repl with full conversation history persisted in supabase
- one tool: `get_current_time(timezone?)`
- one terminator tool: `send_burst({ messages: string[] })` — donna's only way to talk
- voice rules in the system prompt (lowercase, blunt, no em dashes)
- prompt caching on the system prompt and tools block
- last 50 messages loaded as context on each startup

### design + plan

- spec: `docs/superpowers/specs/2026-05-05-donna-v0.1-supabase-persistence-design.md`
- plan: `docs/superpowers/plans/2026-05-06-donna-v0.1-supabase-and-burst.md`

### whatsapp (preview)

ports the old repo's ingress + delivery split to ts. single-user mode for now.

```bash
# add to .env:
#   WHATSAPP_TOKEN              - meta cloud api token
#   WHATSAPP_PHONE_NUMBER_ID    - meta cloud api phone number id
#   WHATSAPP_VERIFY_TOKEN       - any string, must match the meta dashboard
#   PORT                        - default 3000

npm run wa
# expose with: cloudflared tunnel --url http://localhost:3000
# point meta webhook → https://<tunnel>/webhook
```

each sender is resolved to a row in the `users` table on first contact, keyed by phone — every conversation history (`chat_messages.user_id`) hangs off that. no allow-list; whoever messages the bot's number gets their own thread.

text inbound goes straight into `runTurn`; each `send_burst` item lands as a separate text bubble (first one quote-replies the inbound). voice/image/document inbound is acked with a 👋 reaction for now — brain hookup for those lands later.

dedup is two-layered: an in-memory 5min ttl cache for burst retries, and a durable `inbound_messages` table with `unique (wa_message_id)` for cross-restart safety. claim is atomic (`insert ... on conflict do nothing`), so concurrent retries can't both win the race.

### observability — langsmith

every turn is traced. the anthropic client is wrapped with `wrapAnthropic`, so each `messages.create` call shows up as a span (full prompt, response, token counts, cache reads/writes, latency, cost). `runTurn` itself is wrapped with `traceable`, making each turn a parent trace with the LLM calls + tool runs nested underneath. for WA inbounds, `server.ts` attaches `user_id`, `phone`, `profile_name`, `wa_message_id`, and `source` as metadata so traces are filterable per-user.

```bash
# .env
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=ls_...
LANGSMITH_PROJECT=donna
```

leave `LANGSMITH_TRACING` unset to no-op the wrappers (zero overhead, no network calls). traces land at https://smith.langchain.com → your project.

### what's next

parallel tool execution → async subagents → recall_chat → context builder → hooks → wa media-into-brain. each is its own brainstorm → spec → plan cycle.
