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

### what's next

parallel tool execution → async subagents → recall_chat → context builder → hooks → whatsapp ingress. each is its own brainstorm → spec → plan cycle.
