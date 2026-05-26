# handoff — current state

last updated: 2026-05-24

session-end snapshot. if you're picking this up cold, read this first. for the
broader product architecture see `docs/architecture-v2.html`; for the executor
pattern specifically see `docs/executors.html`; for the prior klavis-scoped
handoff see `docs/handoff-klavis.md`.

---

## one paragraph

donna's text loop is end-to-end wired on both whatsapp and the mobile app, with
a stateless research executor pattern in place. inbound messages route through
the railway-deployed prod donna (existing), which forwards any text from
`DEV_PHONE_NUMBERS` to a cloudflare tunnel pointing at the new server running
locally. the new server handles ingress (clerk auth on mobile, signature-light
on whatsapp), resolves to a user via phone or clerk_id, persists chat to
postgres via drizzle, runs the brain (now with a `dispatch_to_executor` tool
for web-search-heavy questions), and ships replies back through the whatsapp
cloud api or returns json to the mobile app. **the actual "text donna and get
a reply" verification is the next thing left to do** — everything is wired,
nothing has been clicked through in production.

---

## what works (committed, ready to test)

- **`npm run server`** → boots a hono server on `localhost:3000` with `/health`,
  `/api/whatsapp/webhook`, `/api/mobile/*`, `/api/pairing/*`, `/api/account`.
- **`npm run db:ping`** → verifies the postgres connection to supabase via the
  transaction pooler (port 6543).
- **`npm run dev`** → cli loop. dev user is sentinel uuid all-zeros; auto-upserts
  on boot; triggers persist via the `donnaschedule` table and reattach.
- **`npm run voice`** → livekit voice agent (separate process). less battle-tested.
- **cloudflare tunnel** → `dev.itsmedonna.com` resolves to the local `:3000`
  whenever `cloudflared` is running on the mac (installed as a launchd service).
- **railway prod donna** → has `DEV_RELAY_URL=https://dev.itsmedonna.com/api/whatsapp`
  and `DEV_PHONE_NUMBERS=<your phone>` set. forwards your test phone's webhooks
  to the local tunnel; other users go through prod as normal.

---

## what shipped this session

(commit hash · scope · description, oldest first)

| | hash | gist |
| --- | --- | --- |
| 1 | `fcda358` | hono server skeleton with `/health` |
| 2 | `71016b2` | users migration: phone nullable + clerk_id added |
| 3 | `dd26227` | drizzle + postgres + schema introspection setup |
| 4 | `71e93ac` | `getOrCreateUserByPhone` — whatsapp resolution primitive |
| 5 | `afbad19` | server ingress routes (clerk auth, whatsapp, mobile, pairing) |
| 6 | `2a2e713` | mobile pairing UI (phone screen + usePairing hook + api client) |
| 7 | `05ab26d` | voice agent (livekit + sesame csm tts + apns voip push) |
| 8 | `0f9ffdf` | triggers (in-memory cli-only) |
| 9 | `e9a36c7` | `docs/anthropic-sdk.html` (every sdk lever donna uses) |
| 10 | `f3911b9` | `chat.ts` — `loadRecentMessages` + `saveMessages` via drizzle |
| 11 | `8b848b6` | `delivery/whatsapp.ts` — `sendText` for meta cloud api |
| 12 | `d345177` | wire whatsapp ingress → brain (resolve, history, runTurn, save, send) |
| 13 | `b247b42` | inbound dedup via `inbound_messages` against meta retries |
| 14 | `873e6de` | `getOrCreateUserByClerk` — option-B identity linker (reads phone from clerk profile, merges with existing whatsapp row if present) |
| 15 | `0c0f59e` | mobile `/api/mobile/message` wired to brain, inline sends in json response |
| 16 | `4bd0c2e` | slim system prompt (drop duplicated vocabulary, ~250 cached tokens saved per turn + parallel-tool-emission nudge) |
| 17 | `673d3eb` | trigger persistence — `donnaschedule` table + AsyncLocalStorage context for userId + reattach-on-boot |
| 18 | `67b25b9` | first execution agent — stateless research executor (`dispatch_to_executor` tool + `researchBundle(task)` factory + `finalize_research` terminator + server tools wired) |

eighteen commits, end-to-end text loop on two surfaces + the executor pattern
for delegating research tasks.

---

## what's in the working tree (uncommitted)

- `docs/architecture-v2.html` — the full system map (uncommitted; sitting in
  working tree).
- `docs/executors.html` — the executor pattern doc (just written, uncommitted).
- `docs/handoff-klavis.md` — renamed from the prior `handoff.md`.
- `HANDOFF.md` — this file.
- `.env.example` additions for apns voip + donna_encryption_key + donna_browser_data_dir.
- `src/server.ts` `/api/account` route mount.
- `src/donna/ingress/account.ts` — new file (unread; user-side wip).
- `src/donna/ingress/mobile.ts` `/device-token` route + `getApnsVoipToken` in `/call/start`.
- `src/donna/users.ts` `setApnsVoipToken` / `getApnsVoipToken` raw-SQL helpers (note: they reference a column `apns_voip_token` not yet in `schema.ts`; there's a migration in flight or it needs writing + applying + `npm run db:pull`).
- `package.json` script additions (`prune-ledger`, `audit-compliance`, `voice:setup`) + apns/clerk-hono/livekit-server-sdk/ws deps.
- `mobile/` various screen tweaks (dashboard, onboarding/fork, withVoipPushNotification plugin).
- `iev.mp4` — 8mb screen recording, should be `.gitignore`'d.

most of the uncommitted stuff is user-side parallel work (apns voip, account
ingress, browser data dir) — none was assistant-led this session.

---

## key architectural decisions made this session

### 1. mobile and whatsapp ship together, not serial

original strategic question: surface coverage first or brain quality first?
landed on **surface coverage first** because brain improvements without a real
surface are vanity work. then within "surface coverage": both surfaces ship in
one project, not sequential, because the product thesis demands both.

### 2. brain emits messages, app owns its own UI (no llm-composed UI)

originally sketched a "render block" type that would let the brain push canvas
plans to the mobile app. user pushed back: too much overhead to maintain
schema sync across brain/web/mobile. **brain emits text + buttons + lists +
links; app's dashboard reads its own data from postgres and renders normally.**
the donna-affects-app pattern is: donna writes data → app reads data, not
donna pushes UI.

### 3. identity model: phone is the spine

one human = one row in `users`. `phone` and `clerk_id` are both nullable and
both unique. `getOrCreateUserByPhone` (whatsapp path) and
`getOrCreateUserByClerk` (mobile path) both resolve to the same row. the
clerk helper reads phone from the clerk user profile and links with an existing
whatsapp row when one matches. (option B from the design discussion.)

### 4. supabase free tier for now

free tier limits are non-binding at current volumes. plan to upgrade to pro
($25/mo) once data loss would actually hurt — i.e. once a user other than
yourself has put real data in and you've stopped editing the brain daily.

### 5. cloudflare for tunneling + dns

domain (`itsmedonna.com`) ported to cloudflare. zero trust tunnel running
locally via launchd. `dev.itsmedonna.com` is the dev tunnel; `donna.app` /
prod domain points at railway. universal links setup pending.

### 6. dual-routing via existing prod donna (testing trick)

instead of pointing meta webhook at the new dev tunnel directly, the old
railway prod donna's `_split_webhook_by_phone` + `_forward_webhook` pattern
is reused. set `DEV_RELAY_URL=https://dev.itsmedonna.com/api/whatsapp` and
`DEV_PHONE_NUMBERS=<test phone>` on railway. messages from the test phone get
peeled off and forwarded; other users continue to hit prod untouched. zero
disruption.

### 7. executor pattern: stateless per call (option A)

discussed three options (leaf-only / stateful-per-domain / hybrid with unified
memory). landed on **leaf-only stateless executors** for now. each
`dispatch_to_executor(task)` builds a fresh `researchBundle(task)` and runs
to completion. transcript discarded after; voice brain's chat history
naturally captures the dispatch + result via `tool_use` / `tool_result`
pairs. revisit when product needs change. full reasoning in
`docs/executors.html`.

### 8. anthropic memory tool / pgvector long-term memory deferred

still the right project, still deferred. doesn't block dogfooding. revisit
after a few weeks of real text-loop usage when concrete needs surface.

---

## the next concrete step (not done yet)

**verify the whatsapp text loop end-to-end.** instructions:

```bash
# terminal 1: local server
npm run server

# terminal 2: tunnel (already running if cloudflared is installed as a service)
# verify:
curl https://dev.itsmedonna.com/health
# expect: ok
```

from a phone in `DEV_PHONE_NUMBERS`, text the donna whatsapp number something
like:

- `"hey"` — trivial; voice brain replies with text only, no executor.
- `"what's the weather in seattle right now"` — should fire
  `dispatch_to_executor`. watch for nested langsmith spans.

watch the local `npm run server` terminal. expect:

1. POST `/api/whatsapp/webhook` hits with the message payload
2. claim-or-skip on `inbound_messages` (silent on success)
3. langsmith span / tool dispatch / `messages.create` logs
4. POST to `graph.facebook.com` when `sendText` ships the reply
5. reply lands in your whatsapp within seconds

if it breaks: paste the server log + whatever whatsapp shows.

---

## known issues / gotchas

- **`users.apns_voip_token` column**: the `setApnsVoipToken`/`getApnsVoipToken`
  helpers in `src/donna/users.ts` use raw SQL referring to this column. it's
  not in `schema.ts` yet, which means either:
  - the migration adding the column hasn't been written / applied yet, OR
  - it has been applied but `npm run db:pull` hasn't been run to regen
    `schema.ts`.
  before pushing apns voip flows, verify the column exists and refresh the
  schema.
- **dev cli triggers are scoped to `DEV_USER_ID` (all-zeros uuid)**. real users
  can't create triggers via any surface yet — the trigger tools are registered
  on the voice bundle, so once mobile/whatsapp's text loop hits the brain, a
  user could ask donna to "remind me at 4" and a real trigger would persist.
  but the server doesn't currently install a `setFireHandler`, so when those
  triggers fire, they no-op (mark fired, but nothing dispatches to the channel).
  fix: install a fire handler in `src/server.ts` boot that resolves the trigger's
  `user_id`, loads history, runs the brain, delivers via the right channel.
  **this is the next real piece of proactivity work.**
- **outbound whatsapp delivery is text-only.** `sendText` is all that's wired;
  the `OutboundMessage` types for buttons/list/cta_url/image are silently skipped
  with a `console.warn`. port from `_archive/delivery-dir/whatsapp.ts` when
  richer interactions are needed.
- **mobile app's chat composer isn't wired to `/api/mobile/message`.** the
  endpoint accepts requests, but the mobile `(tabs)/index.tsx` chat tab uses
  hardcoded `SEED` data and a local `send` function that doesn't call the api.
  ~10-min change when ready.
- **`iev.mp4`** (8MB screen recording) is in the working tree untracked. add
  to `.gitignore` whenever.

---

## open questions for future-you

1. **server-side trigger fire handler.** when a trigger fires server-side
   (user texted "remind me at 4"), who delivers the reply? needs:
   - resolve `user_id → channel` (which surface should we send to)
   - load history, run brain with the trigger's action as synthetic user input
   - render outbound via the right channel (whatsapp `sendText` / mobile push)
2. **second executor.** gmail or calendar most likely. requires composio +
   oauth machinery (see `docs/handoff-klavis.md` for the prior thinking).
3. **stateful executor evolution.** if the leaf-only pattern starts to feel
   limiting (cross-dispatch continuity friction, multi-step workflows), revisit
   the three options in `docs/executors.html` §5.
4. **mobile chat surface.** wire the chat composer to `/api/mobile/message`.
   simple, ~10 min, but the existing UI is good — don't overdesign.
5. **memory project.** still deferred. revisit when "donna remembers" patterns
   emerge from real usage.
6. **railway deploy.** still local-only. ship to railway when:
   - trigger persistence proves out (already done)
   - server-side fire handler exists (open)
   - whatsapp text loop verified end-to-end (pending step above)

---

## key files (quick reference)

- `src/server.ts` — the multi-channel http server
- `src/donna/brain.ts` — the `runTurn` loop
- `src/donna/agents/voice.ts` — voice bundle (the main donna)
- `src/donna/agents/research.ts` — research executor factory
- `src/donna/tools/index.ts` — voice's tool registry
- `src/donna/tools/dispatch_to_executor.ts` — the bridge to executors
- `src/donna/tools/send_burst.ts` — voice's terminator
- `src/donna/tools/finalize_research.ts` — research executor's terminator
- `src/donna/ingress/whatsapp.ts` — webhook handler, brain wire, sendText
- `src/donna/ingress/mobile.ts` — clerk-authed mobile loop
- `src/donna/ingress/pairing.ts` — claim a pairing code via whatsapp
- `src/donna/ingress/auth.ts` — clerk middleware + `userId(c)` helper
- `src/donna/db.ts` + `src/donna/db/schema.ts` — drizzle setup, introspected
- `src/donna/users.ts` — `getOrCreateUserByPhone` + `getOrCreateUserByClerk`
- `src/donna/chat.ts` — `loadRecentMessages` + `saveMessages`
- `src/donna/context.ts` — `AsyncLocalStorage` carrying `userId` to tools
- `src/donna/triggers/` — persistent triggers via `donnaschedule`
- `src/donna/delivery/whatsapp.ts` — outbound text via meta cloud api
- `src/index.ts` — cli entry point (dev user upsert + trigger reattach)
- `voice/agent.ts` — livekit voice agent (separate process)
- `docs/architecture-v2.html` — full system map
- `docs/executors.html` — executor pattern detail
- `docs/anthropic-sdk.html` — every sdk lever donna uses
- `docs/handoff-klavis.md` — prior klavis-specific handoff
- `docs/poke-architecture.html` — the inspiration for the executor split

---

## quickstart, if you've been gone a while

```bash
# 1. confirm env
cat .env  # DATABASE_URL, ANTHROPIC_API_KEY, CLERK_*, WHATSAPP_*, LIVEKIT_* etc.

# 2. confirm tunnel
curl https://dev.itsmedonna.com/health  # expect: ok

# 3. install + boot
npm install
npm run db:ping  # confirm postgres
npm run typecheck
npm run server   # boot the local server

# 4. (optional) cli loop
npm run dev      # if you want to chat in the terminal

# 5. (optional) voice
npm run voice    # separate terminal; livekit agent
```

picking up the work: read **§ "the next concrete step"** above. it's
verifying the whatsapp text loop. if it works → wire the server-side trigger
fire handler. then look at the second executor.
