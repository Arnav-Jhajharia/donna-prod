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
