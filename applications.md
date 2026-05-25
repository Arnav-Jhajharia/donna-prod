# Donna — credit & grant application working file

What I researched, what's open in your browser, what's blocked, and the draft content you can paste.

---

## TL;DR — state of the world

| Program | Status | Award | Time to apply | Action |
|---|---|---|---|---|
| **Microsoft for Startups Founders Hub** | Open | Up to $150k Azure + OpenAI credits | ~30 min | Apply now |
| **Anthropic for Startups** | Open, but **requires VC equity backing** for credits | API credits + priority rate limits | 2 min | Apply for community tier always; credits only if VC-backed |
| **Twilio AI Startup Searchlight 2026** | Open, rolling, deadline **Sept 11 2026** | $5k Twilio + $2.5k OpenAI ($10k Twilio for mature) | ~1 hour | Apply now — Donna is dead-on thesis |
| **Cloudflare for Startups** | Open | $250+ credits, Workers AI free tier, custom for VC-backed | 20 min | Apply now |
| **Emergent Ventures (Mercatus)** | Open | $5k–$50k cash grant, no equity | ~2 hours (write proposal) | Apply this week — high fit |
| **AI Grant (Nat Friedman + Daniel Gross)** | **Batch 4 closed** | $250k | — | Email support@aigrant.org to ask Batch 5 timing |
| **Cartesia / Deepgram / ElevenLabs startup tiers** | Open | Voice/STT credits | DM + 15 min form each | DM their devrel teams |
| **Modal** | Open | $30/mo free + startup credits | ~10 min | Sign up + email |
| **Neon** | Open | Free tier huge, startup tier on app | ~10 min | Free signup, apply for startup tier |
| **Supabase Launch Week submission** | Quarterly | Featured = ~$10–50k of effective reach + sometimes credits | Build a demo | Watch their site for next launch week |
| **Helicone** | Open | Free OSS proxy with cache layer | ~5 min | Sign up + drop into existing stack |

---

## I need these from you to finalize the drafts

Fill these in once and they go into every application:

- **Founder name:** [YOUR NAME]
- **Legal entity:** [LLC / C-Corp / Not yet incorporated]
- **Incorporation state / country:** [DELAWARE / US / OTHER]
- **Company website / demo URL:** [URL or "private beta"]
- **GitHub URL (personal or org):** [URL]
- **Demo video URL (any rough recording):** [URL or "can record in 24h"]
- **VC funding raised:** [None / $X from Y]
- **# users today:** [0 / N beta users / N waitlist]
- **MRR:** [$0 / $X]
- **LinkedIn:** [URL]

If any of these are blockers (no entity, no demo video, no GitHub), tell me which — I'll route around them.

---

## The reusable pitch (paste into every form)

### One-liner
> Donna is a personal AI that lives across your phone, WhatsApp, and iMessage. She remembers what you said, follows up, and surfaces next moves before you ask — closer to a sharp chief of staff than a chatbot.

### 30-second pitch (≈100 words)
> Most "AI assistants" are chat apps. Donna is built around the conversational surfaces people already live in — iMessage, WhatsApp, voice — and the discipline of a human chief of staff: she remembers, she follows up, she acts before being asked. She runs on a manual tool-call loop over Claude, with a memory layer designed to compound per user and trigger primitives that let her schedule her own follow-ups. The product is omnipresent on purpose: app, widget, messaging, voice — not just another bot you have to open.

### Why now (the durable reason)
> The model layer is finally good enough for tool use, memory, and voice to feel inevitable rather than embarrassing. The bottleneck isn't intelligence anymore — it's *integration into the user's actual life*. Whoever wins personal AI wins on surface presence, memory quality, and proactivity, not on chat UX.

### Tech stack (one paragraph)
> TypeScript + Node.js core. Anthropic Claude (Sonnet 4.6) as the reasoning layer via the raw SDK with a manual tool-call loop — no LangChain. Mobile is Expo + React Native. Voice surface via Cartesia for TTS, Deepgram for STT (in design). Messaging via Twilio/WhatsApp Business + iMessage native. Memory layer is pgvector-based, owned in-house. Observability through LangSmith. Hosted infra on [STACK].

### What we'd do with credits
> Donna's economics are dominated by inference cost on the voice/planner agent (Claude Sonnet 4.6) plus voice infra (Cartesia TTS + Deepgram STT). Credits extend our runway for closed beta and let us spend on memory-quality experiments — the part of the product that compounds.

---

## Per-program drafts

### 1. Microsoft for Startups Founders Hub — $150k credits

**Why this is #1:** No VC requirement. No accelerator requirement. Form takes ~30 min. Largest single credit grant available to solo founders.

**What they ask:**
- Company info (name, website, entity)
- What you're building (paste the 30-second pitch)
- Stage (idea / build / launched)
- Team size
- Tech needs (which Microsoft services you'd use)

**Microsoft-specific framing — tweak the pitch to mention:**
> We're evaluating Azure OpenAI for redundancy on our reasoning layer, and Azure Container Apps / Cosmos DB for our memory store. Founders Hub credits would let us run a production-grade cross-region deployment from beta.

**Action:** Tab open. Apply today.

---

### 2. Anthropic for Startups — credits + community

**Important constraint they confirmed:** *To qualify for credits, the startup must have received equity funding from an institutional investor, be founded within the last 4 years, and not have previously received Anthropic startup credits.*

**If you ARE VC-backed:** Apply for credits. Form is ~2 min.

**If you're NOT VC-backed:** Still apply for the community tier — hackathons, Founder Days, AMAs, priority rate limits. Worth doing.

**What to write in the "what are you building" field:**
> Donna is a personal AI built on Claude — she lives on the user's phone, WhatsApp, and iMessage as their personal chief of staff. Voice agent runs on Sonnet 4.6 via the raw SDK; we're scaling toward an executor + specialist sub-agent architecture, all on Claude. We expect to be one of the highest-quality consumer demos of Claude's tool-use + memory capabilities in 2026.

**Action:** Tab open. Apply today regardless of VC status.

---

### 3. Twilio AI Startup Searchlight 2026 — $5k + $2.5k OpenAI

**Why this fits Donna perfectly:** Twilio's pitch is "communications + AI." Donna's surface is WhatsApp + iMessage + voice. You ARE the case study they want to platform.

**Deadline:** Friday Sept 11, 2026. Rolling review — apply early for better signal.

**They explicitly ask:** how you're using Twilio creatively, your AI integration, what makes you a flagship build.

**Suggested narrative:**
> Donna treats Twilio as her core nervous system: WhatsApp Business + Programmable Messaging for the dominant messaging surface, Voice + Voice Intelligence for the conversational voice surface, and Verify for identity. The product thesis is that personal AI wins by being omnipresent, not by being a separate app you open — which means messaging and voice infrastructure is the moat, not a side feature. We're building a voice agent that responds in sub-2s with persistent memory, and Twilio is the substrate.

**Action:** Apply this week. Bias toward applying *with* a demo video.

---

### 4. Cloudflare for Startups

**Tiers:** A modest base tier you can self-apply for (Workers + R2 + Vectorize free tier, $250–$1.5k in credits depending on stage), and a richer tier if you're backed by a participating VC/accelerator.

**Best use for Donna:** Workers AI + Vectorize + D1 could replace several paid services for the memory layer and trigger evaluation worker.

**What to write:**
> Donna's background workers (trigger evaluator, memory consolidator, proactive nudge engine) are well-suited to Workers — short-lived, latency-tolerant, agent-style. Vectorize replaces a paid vector DB; D1 handles per-user state; Workers AI gives us a fallback model layer.

**Action:** Apply today. The free tier alone is real money.

---

### 5. Emergent Ventures (Mercatus / Tyler Cowen)

**Format:** Open-ended written proposal, no template. They fund "unusually ambitious" individuals doing zero-to-one work.

**Why Donna fits their taste:** Their portfolio loves individual builders working on consequential problems with strong personal narrative. Personal AI as infrastructure for one human ("she holds one person's life") is exactly the framing Cowen has written about.

**Proposal structure (1-2 pages):**
1. **Who you are** — one paragraph. Background, what you've shipped, why you specifically.
2. **What you're building** — Donna pitch, but emphasize the *philosophical* angle: personal infrastructure, agency-augmentation, the compounding of memory.
3. **Why now** — model quality + messaging surfaces + the fact that most "AI assistants" miss the point.
4. **What the grant unlocks** — be specific. Months of runway? Voice infra spend? A specific experiment?
5. **What success looks like in 6 months** — concrete, measurable. "N users using Donna daily; voice latency <2s p95; demonstrable memory compounding."

**Draft opening paragraph:**
> Most products in the "AI assistant" category are chatbots wearing a different shirt. Donna is the opposite bet: that the winning personal AI looks less like ChatGPT and more like a sharp human chief of staff, defined by memory quality, follow-through, and presence across the surfaces people actually live in. I'm building her solo, line by line. The bet is that one well-instrumented person's life is a richer training ground for a memory architecture than a hundred half-engaged users — and that the right product surfaces (iMessage, WhatsApp, voice, widget) make AI feel inevitable rather than imposed.

**Action:** Block 2 hours this weekend. This is high-EV cash with no equity dilution.

**Link:** [mercatus.org/emergent-ventures](https://www.mercatus.org/emergent-ventures)

---

### 6. AI Grant — BATCH 4 CLOSED

**Status:** Closed. Email **support@aigrant.org** asking when Batch 5 opens. Watch their site + Nat Friedman's Twitter.

**When it reopens:** This is a 1-page application, $250k, perfectly on-thesis for Donna. Highest-priority application of any program here.

**Draft of the 1-pager so you're ready when Batch 5 drops:**

> **What we're building:** Donna, a personal AI that lives on iMessage, WhatsApp, and the user's phone — a chief of staff in messaging form, not another chatbot.
>
> **Why it's defensible:** Personal AI wins on memory quality, follow-through, and surface presence — none of which are commodified by frontier models. Our architecture is built around those primitives from day zero: in-house memory layer on pgvector, trigger system for proactivity, three-tier voice/executor/specialist agent design.
>
> **Why us:** [YOUR NAME]. [1-2 lines of credible background]. Building Donna line-by-line in production daily; she IS my chief of staff.
>
> **Why now:** Tool-use + memory + voice in Claude 4.x is finally good enough that the bottleneck has shifted from intelligence to integration. The window to define personal AI is ~12-18 months; after that, defaults set.
>
> **What we'd do with $250k:** Twelve months of inference + voice infra runway, two engineers I want to bring on, and the freedom to optimize for memory quality (the thing that compounds) over short-term feature velocity.
>
> **Demo:** [DEMO VIDEO URL]

---

### 7. Voice infra startup tiers — Cartesia, Deepgram, ElevenLabs, Rime

Each of these has a startup program; some are form-based, most respond best to a **direct DM/email to their DevRel** with a demo video.

**Cartesia:** DM `@cartesia_ai` on Twitter or email `hi@cartesia.ai`. Mention Donna's sub-2s voice latency target as the case study angle.

**Deepgram for Startups:** $200 free credit auto; startup program at `deepgram.com/startup-program` adds significantly more. Apply through the page.

**ElevenLabs:** Less generous on credits but they pay for hackathon wins and case studies. Already covered.

**Rime:** Email `hello@rime.ai`. They're hungry for case studies and *cheaper than ElevenLabs* — better margin for you.

**Cold email template (reusable for all four):**
> Subject: building Donna on [PROVIDER], would love to chat
>
> Hi team — I'm [NAME], building Donna, a personal AI that lives on iMessage, WhatsApp, and the phone. Voice is the next surface I'm wiring up and [PROVIDER] is my top pick for [TTS/STT] because of [LATENCY/QUALITY/PRICE].
>
> I'd love to apply for your startup program if one exists, and happy to do a case study/co-marketing piece when Donna's voice surface ships in [TIMEFRAME].
>
> Short demo: [URL]
> What I've built so far: [GITHUB]
>
> [NAME]

---

### 8. Modal — $30/mo free + startup credits

**What it unlocks:** GPU compute for self-hosting embeddings, rerankers, STT — the part of your stack that's "always on per turn." Replacing OpenAI embeddings with self-hosted BGE on Modal is a real win.

**Action:** Sign up free, then email `founders@modal.com` mentioning what you're building. They'll typically extend credits.

---

### 9. Neon — free tier + startup tier

**Why:** Postgres-compatible (works with pgvector for memory), free tier is 10 GiB, startup program extends storage + compute.

**Action:** Sign up free, fill startup form linked from console.

---

### 10. Helicone — free OSS LLM proxy

**Why:** Drops in front of Anthropic, adds caching, observability, and routing for free. Their cache can layer on top of Anthropic's prompt cache for cross-session reuse — additional cost reduction.

**Action:** Sign up, point your `Anthropic` base URL through Helicone's proxy, done.

---

## What's also worth a quick application this week

- **Stripe Atlas** (if not incorporated yet) — incorporation + bundle of ~$50k in partner credits (AWS, Notion, Segment, Mercury, etc.) at [stripe.com/atlas](https://stripe.com/atlas)
- **Mercury** account if not already — comes with Mercury Raise perks bundle
- **R&D tax credit via MainStreet/Neo.tax** — contingency-based; they only get paid if you do. ~10–14% of dev spend back as cash.
- **NVIDIA Inception** — free to join, future-useful for self-hosted ML
- **Polar.sh / GitHub Sponsors** — set up the *receiving* end so any OSS visibility converts to sponsorship money

---

## My recommended order of attack (this week, ranked by EV / hour)

1. **Microsoft Founders Hub** — 30 min, $150k expected value if accepted. Do today.
2. **Anthropic for Startups** — 2 min form. Do today.
3. **Twilio Searchlight** — 1 hour. Worth it for the case-study angle alone.
4. **Cloudflare for Startups** — 20 min. Worth it for Workers + Vectorize.
5. **Emergent Ventures proposal** — 2 hours over the weekend. High-EV cash.
6. **DM Cartesia + Deepgram + Rime devrel** — 15 min total. Reply rates are good.
7. **Helicone + Modal + Neon signups** — 30 min total. Free, immediate.
8. **R&D tax credit intake call** (MainStreet/Neo.tax/Kruze) — 30 min. Passive money.
9. **Email aigrant.org** asking Batch 5 timing — 1 min.

Total: ~6 hours of focused application work. Expected unlock: $200k–$500k in credits + grants + cash refunds, plus 3-5 devrel relationships that compound.
