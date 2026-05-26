# handoff — klavis adapter

scope: how to build donna's klavis integration. only klavis. not the broader
oauth strategy, not the compliance work, not donna-browser — read the linked
artifacts if you need that context.

## the goal in one paragraph

donna needs OAuth-driven access to gmail, calendar, drive, notion, and spotify
on a single user's behalf. instead of donna registering its own OAuth apps and
eating google's 2–4 month CASA + verification clock, we route everything
through klavis as the OAuth runtime. klavis owns the verified apps, the token
vault, the refresh logic; donna calls klavis's MCP endpoints with a per-user
identifier and gets back tool calls already authorised. when donna later
wants to migrate to its own OAuth apps (after files own verification), klavis
supports white-label — same code, swapped credentials, no user reauth.

## the OAuth set (locked, do not expand)

four user-facing connections. **do not add a fifth without explicit decision.**
the [oauth-surface memory](.claude/projects/-Users-jhajh-donna-prod/memory/feedback_oauth_surface_small_nail_it.md)
governs this — breadth comes from apify, donna-browser, and public-API tools.

| user clicks | what it covers | klavis service slug |
|---|---|---|
| connect google | gmail + calendar + drive (single google oauth, three scopes) | `gmail`, `google_calendar`, `google_drive` |
| connect notion | pages, databases, blocks | `notion` |
| connect spotify | playback control, library, listening history | `spotify` |

readwise (api token, not oauth) and oura/whoop are not in this commit's scope.

## why klavis specifically (and not composio/pipedream)

decided already. don't relitigate. the trade-offs were:

- klavis is OSS — if pricing or posture changes we self-host with the same
  code path. composio is closed source, no escape.
- klavis ships a white-label endpoint that lets us swap to our own google
  oauth app without making users reauth. composio does not.
- klavis's catalogue (~98 providers) covers our four with margin to spare; we
  don't need the 3000-app long tail composio/pipedream offer.
- klavis is anthropic's MCP-native architecture; donna's brain already speaks
  MCP via the @anthropic-ai/sdk.

the [private-cloud framing](.claude/projects/-Users-jhajh-donna-prod/memory/project_donna_private_cloud_framing.md)
applies: klavis is a tenanted runtime, not part of donna's brain. tokens never
touch donna's database. memory and orchestration stay donna's.

## architecture

```
                              donna brain (src/donna/brain.ts)
                                          │
                            (tool call: e.g. gmail_search)
                                          │
                                          ▼
        src/donna/tools/gmail.ts  ──┐
        src/donna/tools/calendar.ts ─┼─►  src/donna/integrations/klavis.ts
        src/donna/tools/drive.ts ────┘            (thin client)
        src/donna/tools/notion.ts ───┐                   │
        src/donna/tools/spotify.ts ──┘    HTTPS + bearer token
                                                         │
                                                         ▼
                              klavis MCP gateway (mcp.klavis.ai)
                                                         │
                                          (klavis-vault refresh + call)
                                                         │
                                                         ▼
                                            google / notion / spotify apis
```

three layers of code we own:

1. **`src/donna/integrations/klavis.ts`** — single-file adapter. one
   instantiation per server boot. holds the klavis api key, exposes the
   methods listed below.
2. **`src/donna/tools/{gmail,calendar,drive,notion,spotify}.ts`** — one file
   per surface. each exports a tool def + handler. handlers are 5–10 lines
   that delegate to `klavis.callTool(...)`.
3. **`src/donna/ingress/connect.ts`** (new) — the connect-flow webhook
   endpoint that handles the klavis OAuth callback. inserts into
   `user_consents`.

## the adapter interface

minimum surface for v1. extend as needed; don't preemptively generalise.

```ts
// src/donna/integrations/klavis.ts

export interface KlavisClient {
  // start an oauth flow for a given user × service. returns a hosted url
  // the user opens in their browser; klavis handles the consent screen,
  // captures the token, and posts to our callback when done.
  startConnect(args: {
    userId: string;             // our user.id (uuid)
    service: KlavisService;     // 'gmail' | 'notion' | 'spotify' | ...
    redirectUrl: string;        // where klavis sends the user post-grant
  }): Promise<{ authUrl: string; connectionId: string }>;

  // does this user have an active connection for this service?
  hasConnection(args: {
    userId: string;
    service: KlavisService;
  }): Promise<boolean>;

  // list every service this user has connected. used to decide which tools
  // get injected into the brain's tool list per turn.
  listConnections(args: {
    userId: string;
  }): Promise<Array<{ service: KlavisService; connectedAt: string }>>;

  // call a specific MCP tool through klavis. donna's tools/*.ts files all
  // funnel through here. the brain never sees this method.
  callTool(args: {
    userId: string;
    service: KlavisService;
    tool: string;               // e.g. 'gmail.list_messages'
    input: unknown;             // tool-specific
  }): Promise<unknown>;

  // revoke a connection. fired by our /api/account/me delete flow and
  // also reachable from settings UI when shipped.
  revoke(args: {
    userId: string;
    service: KlavisService;
  }): Promise<void>;
}

export type KlavisService =
  | 'gmail'
  | 'google_calendar'
  | 'google_drive'
  | 'notion'
  | 'spotify';
```

implementation notes:

- klavis api key lives in env as `KLAVIS_API_KEY`. add to `.env.example`
  under a new "integrations" section.
- pass `userId` as klavis's `entity_id`. this is how they tenant; our
  internal uuid is opaque to them, fine to expose.
- never persist tokens locally. klavis returns connection metadata
  (connection id, granted scopes, expiry) — we store connection id
  associated with user + service in our db only if needed for revoke. the
  refresh and access tokens never come out of klavis.
- all calls are HTTPS to klavis's hosted endpoint. handle 401 (we're
  unauthorised — log + alert) and 403 (user lost the integration —
  surface a reauth nudge through donna's voice).

## the first concrete slice — gmail list_recent end-to-end

build this before anything else. it's the minimum viable path that exercises
every layer.

1. user has signed up, has a clerk session, lands on a "connect google"
   button in the (future) onboarding UI.
2. button hits a new endpoint `POST /api/connect/google` which:
   a. resolves `getOrCreateUserByClerk(clerkId) → user.id`.
   b. calls `klavis.startConnect({ userId, service: 'gmail', redirectUrl: '<our callback>' })`.
   c. returns `authUrl` to the client; client opens it.
3. user grants in klavis's consent ui.
4. klavis posts to our callback `POST /api/connect/google/callback`. handler:
   a. validates klavis signature.
   b. inserts a row into `user_consents` with `consent_type='oauth_google'`,
      scopes from klavis's payload, `policy_version` = current app version.
   c. redirects user to a success page.
5. donna brain on the next turn now sees the gmail tool. on first use:
   `tools/gmail.ts.list_messages({ q: 'is:unread', count: 10 })` →
   `klavis.callTool({ userId, service: 'gmail', tool: 'gmail.list_messages', input: { q, count } })`
   → klavis hits gmail → returns array.

after that works end-to-end, copy-paste the pattern for calendar, drive,
notion, spotify. each should take 30–60 min once gmail is wired.

## tool design — what tools to expose

start with the **read** surface only. write operations (drafting, calendar
event creation, drive uploads, playlist edits) wait until the read paths feel
solid. better to ship a careful read-only donna than a hasty write-capable one.

| surface | tools v1 (read) | tools v2 (write, later) |
|---|---|---|
| gmail | `list_messages`, `get_message`, `search` | `draft_reply`, `create_draft` (gmail.modify scope only via klavis later) |
| calendar | `list_events`, `get_event`, `find_free_slots` | `create_event`, `update_event` |
| drive | `list_files`, `get_file_content`, `search` | (no v2 write planned) |
| notion | `list_pages`, `get_page`, `search` | `append_block`, `create_page` |
| spotify | `currently_playing`, `recently_played`, `top_tracks` | `add_to_playlist`, `play` |

every tool def lives in a single file under `src/donna/tools/{surface}.ts`,
matches the existing tool-def pattern in `src/donna/tools/send_burst.ts`, and
gets registered in `src/donna/tools/index.ts` as a non-terminator.

## what to NOT do

these are easy mistakes that violate the architecture. if you catch yourself
about to do one, stop and re-read this section.

- **don't add a sixth oauth integration** in this work. the surface is
  locked at four user-facing connections. new ones go through a separate
  decision, not a code review.
- **don't bypass klavis** "for convenience" — e.g. by calling the gmail
  api directly with a token klavis exposed. tokens never come out of klavis
  in our codepath. if klavis can't do something we need, that's a feature
  request to klavis (or a vendor evaluation), not a workaround.
- **don't cache tool results across users.** every klavis call is scoped
  to a specific `userId`. caching is per-user only.
- **don't write callbacks to public endpoints.** the klavis callback must
  be authenticated by klavis-signed payload (HMAC verification). copy the
  signature-verification pattern from `src/donna/ingress/whatsapp.ts` if
  you need a template.
- **don't add tools without registering them in `src/donna/tools/index.ts`**
  and matching the existing terminator/non-terminator split.
- **don't skip `user_consents` on connect.** every grant or revoke
  creates a row. the compliance audit (`npm run audit-compliance`) will
  catch this when integrated, but the policy is here anyway.

## open questions to resolve before coding starts

these need answers from klavis docs or a manual test on a free klavis
account. resolve before writing the adapter:

1. **is klavis's gateway MCP-over-HTTP or MCP-over-stdio?** affects whether
   we use their typescript sdk or just `fetch`.
2. **does klavis's free tier cover our four integrations end-to-end?** if
   not, what's the floor of paid? note: gmail/calendar/drive count as
   three klavis "services" even though they're one google oauth.
3. **what's the exact signature-verification scheme for klavis callbacks?**
   HMAC SHA-256 with the api key? a separate webhook secret?
4. **how does klavis represent multi-scope consent?** e.g. when a user
   connects google for gmail+calendar+drive in one consent screen, does
   klavis return one connection or three?
5. **can we revoke per-service or only per-google-account?** important
   for account-delete behaviour and for users who want to disconnect just
   drive but keep gmail.
6. **does klavis support white-label oauth credentials today?** how do we
   switch our app's google client id later? needed for migration planning.
7. **what's the rate-limit posture for klavis api calls?** affects whether
   we need a queue / backoff layer in the adapter.

## files to create / touch (the punch list)

new files:

```
src/donna/integrations/klavis.ts            # the adapter
src/donna/tools/gmail.ts                    # tool def + handler
src/donna/tools/calendar.ts                 # ditto
src/donna/tools/drive.ts                    # ditto
src/donna/tools/notion.ts                   # ditto
src/donna/tools/spotify.ts                  # ditto
src/donna/ingress/connect.ts                # /api/connect/* routes
```

edit:

```
src/donna/tools/index.ts                    # register new tools
src/server.ts                               # mount /api/connect route
src/donna/ingress/account.ts                # add klavis.revoke for each
                                            # service before deleting users
docs/subprocessors.html                     # add klavis row + DPA link
docs/privacy.html                           # mention klavis in §7 + §8
.env.example                                # KLAVIS_API_KEY + base url
```

migrations (only if open question #4 forces a schema change):

```
supabase/migrations/<date>_klavis_connections.sql   # if we need a local
                                                    # connection-id store
```

## tests to write alongside

minimum bar:

- `klavis.ts` has a fake mode (`KLAVIS_MODE=fake`) that returns canned
  responses for `callTool` so the brain loop can be exercised without
  hitting klavis in unit tests.
- one e2e test on the connect flow: clerk-authed user, mocks klavis
  startConnect, asserts the `user_consents` row lands on callback.
- one e2e test on account-delete: connected user, asserts klavis.revoke
  is called for every service before users-row is deleted.

## pointers — read these first

- this conversation's decisions: [feedback_oauth_surface_small_nail_it](.claude/projects/-Users-jhajh-donna-prod/memory/feedback_oauth_surface_small_nail_it.md)
  (note the may-2026 runtime update about klavis being the chosen runtime).
- private-cloud framing: [project_donna_private_cloud_framing](.claude/projects/-Users-jhajh-donna-prod/memory/project_donna_private_cloud_framing.md)
- own-the-layer thesis: [feedback_donna_memory_own_layer](.claude/projects/-Users-jhajh-donna-prod/memory/feedback_donna_memory_own_layer.md)
- the brain loop: [src/donna/brain.ts](src/donna/brain.ts)
- tool registry pattern: [src/donna/tools/index.ts](src/donna/tools/index.ts)
- existing terminator example: [src/donna/tools/send_burst.ts](src/donna/tools/send_burst.ts)
- existing non-terminator example: [src/donna/tools/time.ts](src/donna/tools/time.ts)
- account delete (needs klavis revoke added): [src/donna/ingress/account.ts](src/donna/ingress/account.ts)
- klavis docs: https://docs.klavis.ai

## stop criteria

you're done when:

- a fresh user signing up can tap "connect google," complete klavis's oauth,
  and on the very next message donna can read their inbox (`gmail.list_messages`
  succeeds end-to-end).
- the same flow works for notion + spotify.
- `npm run audit-compliance` still passes (no new drift introduced).
- account-delete cleanly revokes all four connections in klavis before
  nuking the user row.
- no token, no refresh token, no oauth-derived secret has touched donna's
  postgres or filesystem at any point in the flow.

write-path tools (drafting, sending, creating events, appending blocks,
adding to playlists) are out of scope for this handoff. that's a separate
piece of work after read-path donna has been used by a real human for at
least a week.

---

# appendix · the broader MCP landscape (context)

this section is the background that justifies the klavis decision above.
read it if you're picking up the work cold and want to know why the OAuth
surface is only four, why klavis specifically, and what the rest of donna's
tool surface looks like outside klavis's scope.

the canonical, browseable version of this catalog is
[docs/donna-tool-surface.html](docs/donna-tool-surface.html) — 151 individual
tool entries across 13 capability clusters. what follows is the executive
view.

## scale

four parallel research agents mapped the MCP ecosystem in may 2026. the
numbers:

| number | what |
|---|---|
| ~25,000 | MCP servers indexed across major registries (Smithery, Glama, mcp.so, PulseMCP, mcp.directory) |
| ~400-500 | genuinely production-grade |
| 414 | vetted by Anthropic in the Claude Connectors Directory |
| ~300 | relevant to donna |
| 151 | catalogued in our doc |
| ~80 | tagged "magical for donna" |
| ~12 | shortlisted to ship in donna's first weeks |

## the 8-layer architecture (target state)

donna doesn't wire each integration directly. she stacks meta-platforms.
each platform is one integration job; each delivers dozens-to-thousands of
tools.

```
1. klavis hosted              ~98 oauth integrations   ← THIS HANDOFF
2. anthropic connectors      414 vetted oauth          (gap-fillers, later)
3. composio                  ~250 toolkits, 20k tools  (long-tail oauth, later)
4. pipedream MCP            3000 apps, 10k tools       (deepest long tail, later)
5. apify MCP                3000 scrapers              (web that has no api)
6. donna-browser              1 universal browser      (logged-in actions)
7. browser fallbacks          5 stackable free tiers   (Browser Use, Steel,
                                                        Hyperbrowser, TinyFish,
                                                        Browserbase)
8. custom magic tools        ~12 hand-built             (no MCP exists)
```

**only klavis ships as a meta-platform today.** 2 through 4 are deferred
until a user need explicitly justifies adding them. 5–8 cover breadth
without consuming any of the OAuth surface budget.

## why klavis, not the others

evaluated five integration platforms in depth:

| platform | catalogue | OSS? | white-label? | day-1 cost | verdict |
|---|---|---|---|---|---|
| **Klavis** | ~98 oauth | yes | yes | free tier | **chosen** |
| Composio | ~250 toolkits | no | no | free 20k calls/mo → $29/mo | closed-source = no escape if pricing/posture changes |
| Pipedream Connect | 3000 apps | partial | no | free dev → per-user + credits | being acquired by Workday (jan 2026); product risk |
| Arcade.dev | ~145 servers | no | enterprise only | free hobby → $25/mo | smallest catalogue; auth-first posture, donna doesn't need that today |
| Nango | 800+ APIs | yes | yes (full self-host) | free → $50/mo | OSS + clean; **viable alternative** if klavis ever falls through |

klavis won on: OSS escape hatch, white-label support (lets us swap our
own google oauth credentials later without making users reauth),
MCP-native architecture, and catalogue coverage of our four chosen
services with margin.

## the 13 capability clusters (what donna does, not what tech)

each cluster is one slice of donna's behaviour. the bold entries are the
day-1 shortlist; everything else is shortly-mappable when its time comes.

### A. donna knows your body (~12 tools)
Oura · Whoop · Garmin · Apple Health · Withings · Fitbit · Strava ·
Intervals.icu · Eight Sleep (DIY) · Dexcom/Levels (DIY) · Function Health
· Open Wearables

### B. donna manages your money (~17)
**Plaid** · Mercury · Brex · Ramp · Lunch Money · Monarch · Teller (DIY)
· Cash App · Privacy.com · QuickBooks · Xero · SEC EDGAR · Alpha Vantage
· Yahoo Finance · CoinGecko · DeFiLlama · **Wolfram Alpha**

### C. donna runs your home (~7)
**Home Assistant** (the killer) · ha-mcp · OpenHue · LIFX · Nest · Ecobee
· OctoEverywhere

### D. donna handles communication (~14)
**Gmail** · Outlook · **Google Calendar** · Fantastical/Cron/Vimcal ·
**WhatsApp Business** · iMessage · Telegram · Slack/Discord/Teams ·
Twilio · **Vapi/Bland/Retell** ·
Granola/Otter/Fireflies/Fathom/tl;dv/MeetGeek · Krisp · Inbox Zero ·
Superhuman

### E. donna acts in the world (~15)
Resy + sniper · OpenTable · Uber · Uber Eats · Instacart · DoorDash ·
Booking.com · Expedia · Kiwi · Turkish Airlines · AllTrails · Taskrabbit ·
Thumbtack · **Apify scrapers** · **donna-browser** · StubHub/Ticket
Tailor · Camelcamelcamel · 17track (community MCP `iamfiro/parcel-tracking-mcp`)

### F. donna IDs anything (~8)
**PlantNet** · **iNaturalist** · **eBird+Merlin** · **AudD** · Plant.id ·
PaddleOCR · DINO-X · PimEyes

### G. donna senses the world (~15)
Open-Meteo · Purpleair/IQAir · NWS · USGS Earthquake · **GDELT** · GTFS
transit · **OpenSky** · **FlightAware** · NASA APIs · OpenStreetMap/Overpass
· JPL Horizons · OpenFDA · Bluesky Jetstream · Mastodon streaming · Hacker
News API

### H. donna knows your taste (~11)
**Readwise** · **Spotify** · Last.fm · Audible · Splice · TMDb+JustWatch ·
Trakt · Letterboxd · Goodreads · Pocket · MusicBrainz

### I. donna brings world knowledge (~14)
Wikipedia · **Wolfram Alpha** · **DeepL** · PubMed · Consensus/Scite ·
**Tavily** · **Perplexity** · **Exa** · Brave/Kagi · **Firecrawl** ·
Context7 · arXiv · ToolUniverse · Government data (FRED/Census/Data.gov)
· Court records (CourtListener)

### J. donna handles the small joys (~9)
**Bandsintown** · Songkick · **Setlist.fm** · Ticketmaster+StubHub ·
Eventbrite+Luma+Meetup+Fever · **ESPN** · TheSportsDB/FotMob/FBref/Statmuse
· Flaim (fantasy) · OP.GG

### K. donna creates (~14)
**Replicate** · fal.ai · Modal · Runway · Pika · **ElevenLabs** ·
**Cartesia** · Deepgram/Whisper · HeyGen · Adobe Creative · Canva ·
Gamma/SlideSpeak · **MarkItDown** · PaddleOCR · Blender MCP

### L. donna's soul (~7)
NASA APOD · ISS pass · **RoxyAPI** (astrology/tarot/I-Ching) · AstroMCP ·
Stellarium · JPL Horizons · Dice Roller/Tarot/I-Ching

### M. donna's notes & tasks (~12)
**Notion** · Obsidian · Logseq/Tana/Capacities/Reflect/Roam/Mem.ai ·
**Linear** · Todoist/TickTick/Things · Routine ·
Drafts/Bear/Craft/Noteplan · Anki/Rember · Apple Photos

## the auth-tier split (matters for onboarding)

### auth-free (~50 tools) — donna uses these before the user grants anything

every tool in cluster F (ID anything), most of G (sensing), all of I
(knowledge), L (soul), the dev-side keys in D (Vapi, Twilio, ElevenLabs),
and most of K (creating). **donna ships with these powers from minute
one** — no oauth, no consent screen, no waiting. design onboarding so
donna demonstrates real magic before asking for any auth.

### tier A — clean OAuth (~70 tools available, 4 used in v1)
gmail, calendar, drive, notion, spotify (locked v1 set). fitness/banking/
comms long-tail when added later.

### tier B — personal access token (~15 tools)
readwise, lunch money, last.fm, telegram, garmin, intervals.icu,
etherscan, home assistant, apple health (file upload), eight sleep,
dexcom — user generates a token, pastes once.

### tier C — username/password scraped session (~6 tools)
monarch, letterboxd, goodreads, instagram, tiktok, doordash personal
account. **avoid; route through donna-browser logged-in sessions
instead.**

### tier D — local-only (~6 tools)
imessage, apple photos/shortcuts, obsidian/logseq local vault,
drafts/bear/craft/noteplan — needs user's device.

## alt platforms and what each adds beyond klavis

(for future evaluation, not for this commit)

| platform | unique surface beyond klavis |
|---|---|
| **Composio** | HR/recruiting (Ashby, Lever, BambooHR, Workable, SAP SuccessFactors), finance long-tail (Alpha Vantage, Brex, Ramp, Razorpay), sales tooling (Apollo, ZoomInfo, Clay) |
| **Pipedream** | newsletter platforms (Beehiiv, Substack, Ghost, ConvertKit), real estate (Zillow, Buildium), healthcare practice (Cliniko, SimplePractice), education (Teachable, Kajabi), government data (FRED, USPTO, SEC EDGAR), HR/payroll (Gusto, Rippling, Deel) |
| **Arcade.dev** | Granola, Miro, Twitch, E2B, Daytona, Google Finance/Flights/Hotels/Shopping |
| **Apify** | Instagram, TikTok, X, Reddit, LinkedIn, Google Maps, Amazon, eBay, Zillow, Booking, Yelp, Glassdoor scrapers — anywhere the web has no clean api |

## the magical 7 (build-first picks beyond the klavis OAuth set)

these aren't klavis. they're custom tools donna gets in the first weeks
of work after klavis ships. ranked by impact-per-hour:

| # | tool | time | the wow moment |
|---|---|---|---|
| 1 | **AudD** | 30 min | song ID from voice note in WhatsApp |
| 2 | **PlantNet + iNaturalist** | 1 hr | user photographs anything alive → donna IDs it |
| 3 | **OpenSky** | 20 min | "what's that plane that woke me at 6am?" |
| 4 | **Oura** (or Whoop) | 1.5 hr | "you slept badly, moving your 9am to 11am" |
| 5 | **Vapi** | 2 hr | donna actually calls the dentist for you |
| 6 | **FlightAware** | 1 hr | donna reschedules around your dad's late flight |
| 7 | **Home Assistant** | — | runs the whole house |

~7 hours total = one focused weekend after klavis is wired.

## the keystone insights from the research

1. **production tier is small.** ~400 servers across ~25k catalog entries;
   everything else is registry noise. vendor-maintained beats community
   by a wide margin for reliability.
2. **apify MCP is a force multiplier.** one endpoint, ~3000 actors.
   anywhere the web has no API, apify already has a scraper. pair with
   donna-browser (logged-in actions) and firecrawl (clean markdown of any
   URL) for universal web reach.
3. **the OAuth platform you depend on is a structural liability.**
   composio/klavis hold one verified app for all customers; if any
   customer abuses the integration, google penalises the whole platform.
   we accept this risk for shipping speed today, mitigated by klavis's
   white-label path for migration when we file our own google
   verification later.
4. **search/scrape stack** for donna: Tavily (cited research) + Exa
   (semantic) + Firecrawl (clean markdown of any URL) + Apify (specific
   sites) + donna-browser (logged-in actions). that's the universal-reach
   stack; no single tool does all five jobs.

## things noticed but not pursued

- **vector DBs as MCPs** — Pinecone, Weaviate, Qdrant, Chroma, Milvus
  exist. relevant when donna exposes her memory as a tool surface.
- **virtual computer / sandbox MCPs** — Toolhouse, E2B, Daytona,
  ForeverVM, Modal. relevant when donna writes custom code to run on
  user's behalf in their private cloud (see [project_donna_private_cloud_framing](.claude/projects/-Users-jhajh-donna-prod/memory/project_donna_private_cloud_framing.md)).
- **agent-frameworks-as-MCP** — n8n, Make, Workato. mostly enterprise
  iPaaS; wrong shape for donna.
- **17track package tracking** — the gap you flagged. `iamfiro/parcel-tracking-mcp`
  is the community MCP, free tier 100 trackings/month covers personal use.
  add to cluster E "donna acts in the world" when it matters.
- **vector retrieval / tool-RAG** — the >50-tools-in-context problem.
  pattern is: hot-path tools always in prompt, meta-tools for the long
  tail (`pipedream_call(app, action, params)`), retrieval over tool
  descriptions as fallback. not relevant until donna has >50 tools loaded.

## source-of-truth pointers

- the catalogue: [docs/donna-tool-surface.html](docs/donna-tool-surface.html)
- compliance audit + drift checks: [scripts/audit-compliance.ts](scripts/audit-compliance.ts)
- the four legal docs (need klavis added as sub-processor when you
  begin):
  - [docs/privacy.html](docs/privacy.html)
  - [docs/terms.html](docs/terms.html)
  - [docs/subprocessors.html](docs/subprocessors.html)
  - [docs/limited-use-policy.html](docs/limited-use-policy.html)
- the compliance code already in place (extend, don't bypass):
  - [src/donna/crypto.ts](src/donna/crypto.ts)
  - [src/donna/ingress/account.ts](src/donna/ingress/account.ts)
  - [supabase/migrations/20260524000001_user_consents.sql](supabase/migrations/20260524000001_user_consents.sql)
- donna-browser (deployment pending): https://github.com/Arnav-Jhajharia/donna-browser
