# Donna v2

> **Last reconciled against code: 2026-05-05.** Update this file when tools, memory backends, services, or directory layout change. Stale CLAUDE.md poisons every session.

WhatsApp-native personal AI. She/her. **The AI that feels human.**

Donna is a presence, not an assistant. She holds your life — what's going on, what you said, what you're meant to do. She remembers, follows up, tracks habits/health/people, and reaches out. The dashboard is the canvas she paints on, not the place where she lives.

**Donna is not:** a thinking partner who debates you, a productivity tool, a therapist, or an "AI assistant." Never use that phrase.

## Non-negotiables

- Single tool-use loop via Claude Agent SDK. No LangGraph. No Perceive-Act. No pre-computed situational briefs.
- Main model: Sonnet 4.6 across all reactive/proactive BRAIN turns and the dashboard composer. Haiku 4.5 in declared lanes only (post-turn user-facts extractor, Tier 2 proactive judge, awareness scoring, image captioning). Opus only inside justified subagents.
- Context builder (`donna_runtime/context_builder.py`) renders the wrapped user prompt at the start of every turn. Reactive blocks: USER MODEL, SITUATION BRIEF, TODAY (calendar / observations / open loops / attentions), DONNA TODAY (recent fires + calendar slice), PENDING NOTES, ATTENTIONS WAITING, RECENT CHAT. Proactive Tier 3 (`mode="proactive_tier3"`) uses a fat-contract context with USER MODEL, USER STATE NOW (with quiet-hours signal), DAY view, PRIOR TOUCHES, PENDING NOTES. Not auto-reloaded mid-turn.
- Every capability is a tool. Every deterministic side-effect is a hook. External integrations via Composio.
- LLM calls outside the BRAIN loop are only allowed in (a) declared subagents or (b) async post-turn hooks. Anything else is drift — flag it.

## Reliability is the brand

Donna's promise is "she holds your life." Every silent failure is brand-damaging. A reminder that doesn't fire is a betrayal. A voice note not indexed is her not having heard you. Reliability gates everything else.

- A `DonnaSchedule` row not fired by `fire_at + 60s` is an alert.
- Synthesis jobs that haven't run for an active user in >24h is an alert.
- Missing voice / photo content from the searchable memory index is a regression.
- Day 1 must work end-to-end, not "after the user texts again."

## Voice

- She/her pronouns. Always.
- Lowercase register. No em dashes. No semicolons.
- Blunt. High-agency. No filler.
- Never "I understand" or "Great question."
- When the user is anxious: acknowledge briefly, then be useful. Do not perform empathy.
- When the user is wrong: say so.
- When she does not know: say so. Do not fabricate.
- Confrontation flavor exists for a reason — but never on a user who reads as fragile or in crisis. Soften and route.

## Architecture

WhatsApp inbound → Ingress (deterministic) → BRAIN loop (SDK tool-use loop) → tools → hooks (PreToolUse guards | PostToolUse side-effects) → Egress (WhatsApp out + memory writes). Proactive triggers invoke the same loop with `mode="proactive"` (Tier 2 reuses reactive context) or `mode="proactive_tier3"` (Tier 3 fat-contract escalation, currently shadow/counterfactual — not user-visible until promoted).

Tools live in the `donna_runtime/tools/` package (verified 2026-05-05) — split across `retrieval`, `action`, `attention`, `auth`, `dashboard`, `features`, `integrations`, `media`, `reminders`, `terminators`, `web`. The full BRAIN registry is `DONNA_TOOLS` in `donna_runtime/tools/__init__.py`. **Every tool description must include when-to-use AND when-NOT-to-use clauses.** Audit periodically — drift here is silent. Adapter files for `recall_episodic` / `recall_graph` exist in `backend/memory/tools/` but are NOT registered in `DONNA_TOOLS` and NOT in the recall fanout — wire them or delete them. `schedule_reminder` is internal: BRAIN uses `remind`, which calls `donna.attention.firing.schedule_reminder` under the hood. `dig_deeper` and `compile_brief` are still ghosts. Only true terminator is `send_burst`.

### Proactive brain

Tier 2 (Haiku 4.5, `proactive/judge.py`): speech-act-aware judge with `channel_hint` and `reclassify_speech_act`. Decides whether to escalate. Tier 3 (Sonnet 4.6, `mode="proactive_tier3"`, dedicated system prompt at `donna_runtime/prompt_tier3.py`): fat-contract LLM with its own context block builders and a 6-tool registry — `quick_check`, `read_external`, `send_burst` (push + surface_at quadrant matrix), `skip`, `kill_attention`, `reshape_attention`. Dispatcher (`proactive/dispatcher.py`) wires the real Tier 3 call as counterfactual today; telemetry lands in `proactive_dispatch_telemetry`. Conditional `fresh_signal` pre-fetcher runs before the LLM. Source adapters use `infer_speech_act` to seed events.

## Memory

11 active backends: Graphiti (FalkorDB), Supermemory (episodic + document chunks), Procedural rules (PG, 3 tiers), Observations (PG), Open loops (PG), User facts / Living Profile (PG JSONB), Chat messages (PG), Calendar (PG synced from Google), Web (Exa), Bitemporal facts (PG, unused — ship readers or delete). Plus `user_days` (PG, migrations 0021/0022) — the per-day situational layer (yesterday/today/tomorrow) populated by the `upsert_today_record` hook and the `day_calendar` job.

- Unified read: `recall(query, purpose=auto)` — fanout + RRF rerank in `backend/memory/retrieval/fanout.py`. **Procedural rules, user-facts/Living Profile, bitemporal facts, and user_days are NOT in the fanout** — separate tools or context-builder only. Coverage gap acknowledged.
- Unified write: `remember(kind=...)`. Profile facts off-limits — those go through the post-turn extractor hook.

## Features substrate

Reactive features live in `backend/features/` (`registry`, `manifest`, `lifecycle`, `install`, `state`, `handlers`, `hook_dispatcher`, `dashboard_cards`, `library/`). Feature lifecycle: install → active → paused/archived. BRAIN tools: `install_feature`, `pause_feature`, `resume_feature`, `archive_feature`, `list_features`, `update_feature_config`. First features shipped: pushup tracker (subscriber-observation), gratitude practice (Tier B reference manifest). Cron + `post_observation` dispatch via `hook_dispatcher`.

## What Donna must hold reliably

If any of these is silent or partial, fix that before anything new:

- **Reminders** — user-set and system-spawned. Fire on time, in user's TZ, with the right message.
- **Open loops** — never silently drop. Re-surface with age in user's voice.
- **Trackers** — habits and health, longitudinal. Streaks, drift, narrative-over-time.
- **People** — names + dynamics. Last touch. What's pending.
- **Voice notes** — transcribed AND chunked into searchable memory.
- **Photos** — captioned AND indexed.
- **Documents** — chunked, embedded, recallable.
- **Day view** — `user_days` per-day record (yesterday + today + tomorrow). Calendar-synced via `day_calendar` job; observations/attentions rolled up via `upsert_today_record` hook. This is the real situational-awareness layer Donna pulls from in the TODAY block.

## Never do

- Never rebuild Perceive-Act.
- Never add LangGraph or LangChain.
- Never wrap the SDK in a second framework.
- Never pre-generate a situational brief before the loop.
- Never inject memory into context without a tool call (only exceptions: the context-builder blocks listed in Non-negotiables — USER MODEL, SITUATION BRIEF, TODAY, DONNA TODAY, PENDING NOTES, ATTENTIONS WAITING, RECENT CHAT for reactive; USER STATE NOW, DAY view, PRIOR TOUCHES, PENDING NOTES for Tier 3).
- Never call Donna an "AI assistant."
- Never use em dashes in her voice.
- Never ship a tool without when-NOT-to-use.
- Never let a `DonnaSchedule` row miss its fire silently.
- Never claim "she holds X" if the read surface or storage doesn't actually fuse X.
- Never ship hardening on confrontation/reflection without register-detection / safety route.

## Cost & process

Per-turn cost on Sonnet 4.6 with caching should stay in low single-digit cents for reactive turns. If higher: bloated USER MODEL, RECENT CHAT too long, max_turns hit, redundant tool calls, or `recall` invoked when USER MODEL/SITUATION BRIEF already had the answer. Diagnose root cause; do not paper over with a smaller model.

When adding a tool: write description first (when-to-use + when-NOT-to-use + schema), decide agency level (L0/L1/L2), decide render target, implement in the right submodule under `donna_runtime/tools/` (or create a new submodule + re-export from `__init__.py` and append to `DONNA_TOOLS`), add a unit test, update `primitives.md`. When fixing a behavior: diagnose layer (tool description / system prompt / missing tool) and fix there — do not add a pipeline stage. When unsure: stop and ask. Never invent framework abstractions.

## Production

5 Railway services on `abundant-vision`, branch `phase-1-usable`: `donna` (api+webhook+dashboard), `donna-attention`, `donna-synthesis`, `donna-reminders`, `FalkorDB`. Service split via `DONNA_PROCESS_ROLE` env var (see `Dockerfile`). Proactive dispatcher runs in-process today.

`phase-1-usable` is prod. `main` is ~20 commits behind and was broken since 2026-04-25. Either merge forward or retarget docs.

For full topology details (env vars, deploy commands, Vercel domains): see `docs/ops/topology.md`.

## graphify

Knowledge graph at `graphify-out/`.

- Before answering architecture or codebase questions, read `graphify-out/GRAPH_REPORT.md` for god nodes and community structure.
- If `graphify-out/wiki/index.md` exists, navigate it instead of reading raw files.
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep.
- After modifying code in this session, run `graphify update .` to keep the graph current (AST-only, no API cost).
s