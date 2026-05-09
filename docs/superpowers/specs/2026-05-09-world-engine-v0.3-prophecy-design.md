# Donna v0.3 — World Engine: Prophecy Mode

## Problem

The v0.2 world engine (`src/donna/world/`) calls Exa search on a cadence and judges whether to ping. It works, but Exa alone caps the magic at "what an LLM with a good search tool can find." The user wants the **prophecy** moment — Donna pings *before* the user would have found out themselves: "your investor just signal-boosted a Claude launch," "the senator on the Armed Services Committee just bought $LMT," "your competitor's private repo just went public."

The prophecy moment requires **source breadth + freshness** that web search cannot provide on its own. We need many push-shaped firehoses, an entity-aware filter that ties events to *this user's* graph, and silence-by-default delivery.

## Goal

Ship a v0.3 world engine that:

1. Ingests events from 30+ free push/poll sources via **one normalized webhook handler**.
2. Resolves entities in each event against the user's `contact_graph`.
3. Matches against per-user `user_subscriptions`.
4. Routes survivors through the existing tier-2 judge → `runProactiveTurn` → `send_burst` pipeline.
5. Lets the brain create / detect / offer subscriptions inline (the `subscriptions_onboarding` and `subscription_detected` cause kinds already in `cause.ts`).

Cost target: **≤ $20/mo all-in** (sources + Haiku entity extraction + Exa on-demand). No Twitter Pro, no Polygon WS, no Diffbot, no Harmonic.

## Non-goals

- First-class Twitter / X coverage (skip; use Bluesky + RSSHub fallback for specific accounts).
- Sub-second equity tick prophecy (waits for Polygon when revenue justifies).
- Multi-step Exa research lane (already in v0.2, untouched).
- Watch-by-image / multimodal (later).
- Web UI (later — this spec is data-plane only).

## Architecture

```
                Composio Triggers (already in stack)  ──┐
                Pipedream free tier                    ──┤
                Self-hosted RSSHub (free Render/Fly tier — RSSHub needs Node)  ──┤
                Native APIs:                            ──┤
                  Bluesky Jetstream WS                  ──┤
                  GH Archive hourly cron                ──┤
                  EDGAR Atom poller                     ──┤
                  arXiv / RSS / etc                     ──┤
                                                          ↓
                                              Hookdeck free tier
                                          (HMAC verify, retry, replay)
                                                          ↓
                                                /webhook/world
                                                          ↓
                                              world_events (raw, indexed)
                                                          ↓
                                       Haiku entity extraction
                                       (only on events that pre-pass keyword/topic filter)
                                                          ↓
                                  contact_graph + user_subscriptions match
                                                          ↓
                                          tier-2 Haiku judge
                                          (default-silence, per existing pattern)
                                                          ↓
                                  runProactiveTurn(cause: world_signal)
                                                          ↓
                                              send_burst → user
```

The bus is **one webhook handler**. New sources are configuration (subscription rows + adapter functions), not new HTTP endpoints.

## Data model

### `world_events`
Raw normalized event envelope. Indexed by source, occurred_at, dedup_key, and entity refs.

```sql
create table world_events (
  id              uuid primary key default gen_random_uuid(),
  source          text not null,           -- 'bluesky' | 'gh_archive' | 'edgar' | ...
  source_event_id text,                    -- upstream id for dedup
  occurred_at     timestamptz not null,
  ingested_at     timestamptz not null default now(),
  payload         jsonb not null,          -- raw upstream
  text_blob       text,                    -- extracted text for entity pass
  url             text,
  entities        jsonb not null default '[]'::jsonb,  -- [{kind, name, canonical_id}]
  topics          text[] not null default '{}',
  status          text not null default 'pending'
                    check (status in ('pending', 'extracted', 'matched', 'judged', 'shipped', 'silenced', 'errored')),
  unique (source, source_event_id)
);

create index world_events_status_ingested on world_events (status, ingested_at);
create index world_events_entities_gin on world_events using gin (entities);
create index world_events_topics_gin on world_events using gin (topics);
```

### `contact_graph`
The user's people + companies + things-they-care-about, keyed by canonical ids when known.

```sql
create table contact_graph (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  kind            text not null check (kind in ('person', 'company', 'product', 'topic', 'place', 'other')),
  display_name    text not null,
  canonical_ids   jsonb not null default '{}'::jsonb,  -- {wikidata, lei, linkedin_urn, github_login, twitter_handle, bluesky_did, ...}
  attributes      jsonb not null default '{}'::jsonb,  -- {role, company, relation_to_user, ...}
  source          text not null,                       -- 'inferred' | 'user_added' | 'enriched'
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index contact_graph_user_kind on contact_graph (user_id, kind);
create index contact_graph_canonical_ids_gin on contact_graph using gin (canonical_ids);
```

### `user_subscriptions`
Durable watch intent. The thing that didn't exist in the old python codebase — first-class.

```sql
create table user_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  intent_key      text not null,                       -- stable id, e.g. 'watch:adobe_earnings'
  description     text not null,                       -- human readable
  match_spec      jsonb not null,                      -- { sources: [], topics: [], entities: [contact_graph_id, ...], keywords: [] }
  cadence_hint    text not null default 'realtime'    -- 'realtime' | 'daily' | 'weekly'
                    check (cadence_hint in ('realtime','daily','weekly')),
  status          text not null default 'active'
                    check (status in ('active','paused','expired')),
  source          text not null check (source in ('user_asked','donna_offered','derived')),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz,
  last_match_at   timestamptz,
  match_count     integer not null default 0,
  unique (user_id, intent_key)
);

create index user_subscriptions_active on user_subscriptions (user_id) where status = 'active';
create index user_subscriptions_match_spec_gin on user_subscriptions using gin (match_spec);
```

## The pipeline (per event)

1. **Ingest** — `/webhook/world` receives a normalized envelope `{ source, source_event_id, occurred_at, payload, text_blob?, url? }`. Adapters per source (`adapters/bluesky.ts`, `adapters/gh_archive.ts`, `adapters/edgar.ts`, etc.) translate raw upstream to this shape. Hookdeck handles HMAC, retries, replay. Insert into `world_events` (status: `pending`). Source+source_event_id unique constraint dedupes.

2. **Pre-filter** — cheap deterministic check before paying for Haiku:
   - Does `text_blob` contain any keyword from any active `user_subscriptions.match_spec.keywords` for any user?
   - Does the source match any subscription's `match_spec.sources`?
   - If neither: status → `silenced`, done. (Most events die here. Bluesky alone is 100M+/day; we keep ~1% for processing.)

3. **Entity extraction** — Haiku reads `text_blob`, returns `{ entities: [{kind, name, canonical_id?}], topics: [...] }`. Cost: ~$0.0003/call. Cache by `text_blob` hash to avoid re-extracting on retries. Status → `extracted`.

4. **Entity resolution** — for each extracted entity, try canonical id resolution via Wikidata SPARQL or Google KG (free 100k/day). If resolved, attempt match against any user's `contact_graph` by canonical_id.

5. **Subscription match** — for each user with active `user_subscriptions`, check if event matches: any of (source ∈ spec.sources) AND (entities ∩ spec.entities) AND (topics ∩ spec.topics) AND (text contains any spec.keywords). Status → `matched` if any user matches.

6. **Judge** — for each (user, event, matched_subscription) tuple, call the existing tier-2 Haiku judge with: user profile blurb (from existing `buildWorldContext`), the event, the matching subscription, prior touches on this `intent_key`. Default silence. Status → `judged`.

7. **Deliver** — on `decision: send`, `runProactiveTurn` with cause:
   - `kind: 'subscription_detected'` if the match came from a `user_subscriptions` row
   - `kind: 'world_tick'` if it's a derived/serendipitous match (matched contact_graph but no subscription)
   - `instruction`: judge.draft
   - `payload`: `{ event_id, subscription_id?, source, url, entities }`
   The brain composes the user-facing burst via `send_burst`. Status → `shipped`.
   Bump `world_daily_count` and `world_ledger` (existing infra). Update `user_subscriptions.last_match_at` + `match_count`.

## Source map (Tier 0, free, v0.3 baseline)

Lock-in for first ship; everything else is configuration after the bus is proven.

**Social**: Bluesky Jetstream WS, HN Algolia, Reddit personal-use API, Lobsters RSS, Telethon (Telegram public channels).
**Dev**: GH Archive (hourly gz, BQ free tier), npm `_changes` stream, HF Hub poller, Anthropic/OpenAI/Google/OpenRouter changelog feeds.
**News**: GDELT 2.0 — query the latest 15-min slice only on each cron tick (`lastupdate.txt` pointer), not full-table scans, to stay inside BQ's 1TB/mo free tier. Techmeme RSS, Memeorandum.
**Finance**: SEC EDGAR Atom, Quiver Capitol Trades GH dump, FRED, Polymarket CLOB WS, Kalshi, Manifold.
**Gov**: UK Companies House streaming, CourtListener webhooks, Federal Register, Congress.gov, USAspending, OpenSanctions.
**Safety**: USGS, GDACS, NASA EONET, NOAA NWS.
**Travel**: OpenSky Network, National Rail UK, SNCF FR.
**Science**: arXiv per-category RSS, bioRxiv, OpenAlex, Semantic Scholar (free key), ClinicalTrials.gov v2, NIH RePORTER, USPTO PatentsView.
**Culture**: PodcastIndex.org, YouTube WebSub (free push), Spotify artist albums, Letterboxd per-user RSS, Apple App Store RSS, curated Substack/Beehiiv OPML.
**Hiring**: Greenhouse public boards, Lever public boards, Layoffs.fyi.
**Entity resolvers**: Wikidata SPARQL, Google KG (100k/day free).
**On-demand search**: existing Exa integration (`src/donna/world/exa.ts`) — used by judge or brain when an event needs enrichment.

## Brain integration — subscription tooling

Add three direct-only tools (not PTC-eligible) so the brain can manage subscriptions inline during reactive turns:

- **`subscription_create`** — `{ description, match_spec }` → upserts a `user_subscriptions` row. Brain calls when user says "watch X for me."
- **`subscription_list`** — returns active subscriptions for the user.
- **`subscription_pause`** / **`subscription_resume`** / **`subscription_delete`** — lifecycle.

Onboarding flow uses the existing cause kinds:
- `subscriptions_onboarding` — fires on first reactive turn after user signup; brain offers to bootstrap a few canonical watches based on `chat_messages` + supermemory.
- `subscription_detected` — fires from `runProactiveTurn` when a world event matches an active subscription. Brain composes the ping; on user reaction, can refine `match_spec`.

## Migration from v0.2

The current `src/donna/world/` runs Exa search on a cadence and ships findings via `runProactiveTurn`. v0.3 adds the bus alongside it, doesn't replace it.

- `world_ledger` and `world_daily_count` (v0.2) keep their role for the cadence-driven Exa loop.
- New tables `world_events`, `contact_graph`, `user_subscriptions` for the bus.
- `runProactiveTurn` already handles the new `subscription_detected` and `subscriptions_onboarding` cause kinds (added to `cause.ts`).
- `donnaschedule` cause_kind constraint needs the two new kinds added (one new migration).
- The proactive worker (`src/donna/world/worker.ts`) gets a new dispatch branch for `subscriptions_onboarding` rows; `subscription_detected` fires straight from `/webhook/world`, no schedule row needed.

## Cost shape

| Layer | Monthly |
|---|---|
| Source APIs (all Tier 0) | $0 |
| RSSHub (Cloudflare Workers free tier) | $0 |
| Hookdeck free tier (100k events/mo) | $0 |
| Pipedream / Composio Triggers | already in stack |
| Haiku entity extraction (~10k events/mo after pre-filter) | $3–10 |
| Haiku judge (~1k matched events/mo) | $1–3 |
| Exa on-demand (existing) | $5–10 |
| **Total** | **~$10–25/mo** |

Paid sources stay tier-2; we add Polygon / Benzinga / Diffbot / Harmonic only when a paying user explicitly needs them.

## Risks and what's deliberately deferred

- **Bluesky firehose volume** — at full volume Jetstream is huge. v0.3 rule: only open a Jetstream subscription when at least one user has a watched Bluesky DID, and pass that DID set as `wantedDids` filter on the WS. Topic-keyword matching against the full unfiltered firehose is deferred to v0.4 — it's a real cost question, not a config tweak.
- **GH Archive lag** — ~1 hour. Acceptable for "competitor went public" but not for "watched user just pushed." For real-time per-user watching, fall back to GitHub Events API (`/users/{u}/events`, 5000 req/hr authed).
- **Entity resolution will be wrong sometimes.** Wikidata + Google KG miss niche people. Mitigation: store the unresolved `display_name` in `contact_graph.canonical_ids = {}` and let the brain confirm via reactive turn (`subscription_detected` cause includes the ambiguous entity).
- **Bluesky DIDs ≠ Twitter handles.** No automatic social-graph carryover. User has to add Bluesky DIDs explicitly.
- **No Twitter / X coverage.** Documented constraint of the cost target. RSSHub fallback for specific watched accounts only.
- **No web UI.** Subscriptions managed inline through the brain. Dashboard comes later.
- **No per-user TZ for daily budget.** Inherited from v0.2 (UTC), still flagged.

## Success criteria for v0.3

1. A user adds a watch via WhatsApp ("watch anthropic releases for me") and the brain creates a `user_subscriptions` row.
2. An Anthropic blog post lands → enters world_events via RSSHub → Haiku extracts entities → matches the subscription → judge ships → user gets a `send_burst` ping within ~5 minutes.
3. At least 5 of the Tier 0 sources are wired and feeding `world_events`.
4. Total monthly cost ≤ $25.
5. False-positive rate (user marks a ping as noise) below 30% by week 4.

## Implementation plan

To be authored by `superpowers:writing-plans` skill in the next step.
