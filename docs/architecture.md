# donna · architecture

last updated: 2026-05-08

mermaid diagrams render natively on github. for local preview, use any markdown viewer with mermaid support (vs code: "markdown preview mermaid support").

---

## 1 · system overview

```mermaid
flowchart TB
    subgraph User["user surfaces"]
        WA["whatsapp client"]
        CLI["cli (npm run dev)"]
    end

    subgraph Ingress["ingress"]
        Webhook["server.ts<br/>POST /webhook"]
        WAParse["ingress/whatsapp.ts<br/>parseWebhook"]
        IMParse["ingress/imessage.ts"]
        IndexCli["index.ts<br/>readline loop"]
        Resolve["memory/users.ts<br/>getOrCreateUser(phone)"]
    end

    subgraph Brain["brain (sonnet 4.6 + ptc)"]
        RunTurn["brain.ts:runTurn<br/>mode: reactive | proactive"]
        Context["context.ts<br/>AsyncLocalStorage<br/>{userId, runId, source}"]
        Loop["sdk loop<br/>messages.create + tool dispatch"]
        Composer["wrapped user msg<br/>(future: living_profile,<br/>day, donna_state)"]
    end

    subgraph Tools["tool registry"]
        DirectTools["direct tools<br/>get_current_time<br/>send_burst<br/>integration_status<br/>integration_set_mode<br/>integration_disconnect"]
        PtcTools["ptc-callable<br/>gmail_list_recent<br/>gmail_search<br/>gmail_list_sent<br/>gmail_read_thread<br/>imessage_*"]
        CodeExec["code_execution_20250825<br/>(server tool)"]
    end

    subgraph IntegrationLayer["integration service"]
        Service["integrations/service.ts<br/>readState · upsertState<br/>executeForUser · audit<br/>setMode · disconnect"]
        StateTable[("integrations<br/>(user, provider, status,<br/>mode, exclusions,<br/>composio_account_id)")]
        AuditTable[("integration_audit<br/>(action, item_ref,<br/>caller, ok, ms, meta)")]
    end

    subgraph External["external services"]
        ComposioApi["composio platform<br/>(holds gmail oauth)"]
        GmailApi["gmail api"]
        Anthropic["anthropic api<br/>messages.create<br/>+ python sandbox"]
    end

    subgraph Egress["egress"]
        VoiceFilter["voice_filter.ts"]
        WAChannel["delivery/whatsapp.ts<br/>WhatsAppChannel.send"]
        Proactive["delivery/proactive.ts<br/>deliverBurstToUser"]
    end

    subgraph Persistence["persistence (postgres)"]
        ChatMsgs[("chat_messages<br/>history")]
        Users[("users<br/>phone → id")]
        Inbound[("inbound_messages<br/>dedup")]
        ExecRuns[("execution_runs")]
        ExecEvents[("execution_events<br/>code_start, tool_start<br/>w/ caller tag")]
        DraftsState[("donna_state_drafts<br/>(future)")]
    end

    subgraph Observability["observability"]
        LangSmith["langsmith<br/>wrapAnthropic + traceable"]
        DebugApi["GET /debug/runs<br/>GET /debug/runs/:id/events"]
    end

    WA -->|message| Webhook
    Webhook --> WAParse
    Webhook --> IMParse
    WAParse --> Resolve
    IMParse --> Resolve
    CLI --> IndexCli
    IndexCli --> Resolve

    Resolve --> RunTurn
    RunTurn --> Context
    Context --> Loop
    Composer -. assembles per turn .-> Loop

    Loop -->|tools + system + messages| Anthropic
    Anthropic -->|content blocks| Loop

    Loop --> DirectTools
    Loop --> PtcTools
    Loop -. server tool .-> CodeExec
    CodeExec -.|sandbox calls back<br/>via tool_use w/ caller| PtcTools

    PtcTools --> Service
    DirectTools --> Service
    Service --> StateTable
    Service --> AuditTable
    Service --> ComposioApi
    ComposioApi --> GmailApi

    Loop --> VoiceFilter
    VoiceFilter --> WAChannel
    WAChannel -->|burst| WA

    Loop --> ExecRuns
    Loop --> ExecEvents
    Loop --> ChatMsgs
    Loop -. trace .-> LangSmith

    Resolve --> Users
    WAParse --> Inbound
```

---

## 2 · ptc orchestration loop (one reactive turn)

```mermaid
sequenceDiagram
    participant User
    participant Server as server.ts
    participant Brain as brain.ts
    participant API as anthropic api
    participant Sandbox as anthropic python sandbox
    participant Service as IntegrationService
    participant Composio as composio + gmail

    User->>Server: "anything important from overnight?"
    Server->>Brain: runTurn({mode:"reactive", userId, ...})
    Brain->>Brain: withTurnContext({userId, runId, source})

    rect rgba(220,235,250,0.4)
    note over Brain,API: iter 1 — model decides to write code
    Brain->>API: messages.create<br/>(system + tools + working)
    API-->>Brain: server_tool_use(code_execution, code)<br/>+ tool_use(gmail_list_recent, caller=code_exec)<br/>+ tool_use(gmail_list_sent, caller=code_exec)
    Brain->>Brain: emit code_start (full python)<br/>tag tool_start w/ caller=code_execution

    par fan-out (asyncio.gather inside sandbox)
        Brain->>Service: gmailListRecentHandler(input)
        Service->>Service: readState(userId, "gmail")
        Service->>Composio: tools.execute(GMAIL_FETCH_EMAILS,...)
        Composio-->>Service: messages[]
        Service->>Service: audit row (read.list, ok, ms)
        Service-->>Brain: NormalizedMessage[]
    and
        Brain->>Service: gmailListSentHandler(input)
        Service->>Composio: tools.execute(GMAIL_FETCH_EMAILS, in:sent)
        Composio-->>Service: sent[]
        Service-->>Brain: NormalizedMessage[]
    end
    Brain->>API: tool_results (both)
    end

    rect rgba(245,235,220,0.4)
    note over Brain,API: iter 2 — sandbox finishes, model composes
    API->>Sandbox: resume w/ tool_results
    Sandbox-->>API: stdout(digest json)
    API-->>Brain: code_execution_tool_result(stdout)<br/>+ tool_use(send_burst, [...])
    Brain->>Brain: emit code_end (stdout preview)<br/>send_burst caller=direct, terminator
    end

    Brain->>Brain: voice_filter.filterSends
    Brain-->>Server: RunTurnResult{sends, terminator, ptcInvocations}
    Server->>User: WhatsAppChannel.send (per burst)
```

---

## 3 · integration lifecycle

```mermaid
stateDiagram-v2
    [*] --> NotConfigured

    NotConfigured --> Pending: connect-integration.ts<br/>composio.toolkits.authorize<br/>(prints redirectUrl)
    Pending --> Connected: cr.waitForConnection()<br/>upsertState({status:"connected",<br/>composio_account_id, mode})
    Pending --> Error: timeout / oauth declined

    Connected --> Connected: integration_set_mode<br/>(updates row.mode)
    Connected --> Connected: gmail tools call<br/>executeForUser → audit row

    Connected --> Revoked: integration_disconnect<br/>composio.connectedAccounts.delete<br/>+ status='revoked'
    Connected --> Expired: token expired<br/>(future: detected by error monitor)

    Expired --> Pending: re-run connect-integration.ts
    Revoked --> Pending: re-run connect-integration.ts
    Error --> NotConfigured

    Connected --> Connected: post-connect proactive ack:<br/>runProactiveTurn(trigger:"gmail connected")<br/>→ deliverBurstToUser → whatsapp

    note right of Connected
        every read writes to integration_audit:
        action, item_ref, ok, duration_ms, meta
    end note
```

---

## 4 · proactive notification flow

```mermaid
flowchart LR
    subgraph Triggers["triggers (current + planned)"]
        Connect["oauth completed<br/>(connect-integration.ts) ✓"]
        Backfill["backfill done<br/>(planned)"]
        Overdue["commitment overdue<br/>(planned)"]
        Expired["token expired<br/>(planned)"]
        Inbox["inbox urgent<br/>(planned)"]
    end

    subgraph Pipeline["proactive pipeline"]
        Helper["brain.ts:runProactiveTurn<br/>{userId, source, trigger, messages?}"]
        Synth["synthetic user message:<br/>'[runtime trigger, not from user]:<br/>&lt;trigger&gt;... acknowledge in voice'"]
        Brain2["_runTurn (mode='proactive')<br/>same loop, tools, voice filter"]
        Burst["RunTurnResult.sends[]"]
    end

    subgraph Delivery["delivery/proactive.ts"]
        Lookup["lookup users.phone"]
        Send["WhatsAppChannel.send<br/>per burst"]
        Persist["saveMessages<br/>mode='proactive'"]
    end

    subgraph FuturePieces["NOT yet built"]
        Arbiter["arbiter<br/>quiet hours<br/>cooldown<br/>daily quota"]
        Dispatcher["dispatcher<br/>watches events<br/>fires runProactiveTurn"]
        Tier3["proactive_tier3 mode<br/>haiku-judge gate"]
    end

    Connect --> Helper
    Backfill -.-> Helper
    Overdue -.-> Helper
    Expired -.-> Helper
    Inbox -.-> Helper

    Helper --> Synth
    Synth --> Brain2
    Brain2 --> Burst
    Burst --> Lookup
    Lookup --> Send
    Send --> Persist

    Helper -. should pass through .-> Arbiter
    Triggers -. should be routed by .-> Dispatcher
    Brain2 -. could escalate to .-> Tier3

    style FuturePieces stroke-dasharray: 5 5,opacity:0.7
    style Arbiter stroke-dasharray: 5 5
    style Dispatcher stroke-dasharray: 5 5
    style Tier3 stroke-dasharray: 5 5
```

---

## 5 · memory architecture (current + planned)

```mermaid
flowchart TB
    subgraph Context["per-turn context (the only thing the model reads)"]
        SystemPrompt["system_prompt<br/>(static, cached 1h)"]
        ToolDefs["tools<br/>(static, cached 1h)"]
        Wrapped["wrapped user message"]
        Messages["messages<br/>(chat history, cached)"]
        UserInput["user input"]
    end

    subgraph WrappedInner["composer (planned)"]
        Living["LIVING PROFILE<br/>narrative paragraph<br/>(synthesized nightly)"]
        Day["USER'S DAY<br/>today's situational picture<br/>(refreshed every 5min)"]
        State["DONNA'S STATE<br/>her working memory<br/>(read+written every turn)"]
    end

    subgraph Slabs["slabs — sources of truth (planned)"]
        Identity[("identity<br/>name, location, family")]
        StateSlab[("state<br/>current life situation")]
        Patterns[("patterns<br/>rhythms, decision style")]
        Relationships[("relationships<br/>per-person model")]
        Commitments[("commitments<br/>open promises")]
        Voice[("voice_profiles<br/>per recipient + channel")]
        Preferences[("preferences<br/>explicit rules")]
        Sensitivities[("sensitivities<br/>handle-with-care")]
        Goals[("goals<br/>what user moves toward")]
    end

    subgraph BuiltToday["built today"]
        Drafts[("donna_state_drafts<br/>(table only,<br/>no writers yet)")]
        ChatHistory[("chat_messages<br/>persisted per turn")]
    end

    subgraph Workers["writers (planned)"]
        PostTurn["post-turn extractor<br/>(haiku, async)"]
        Hourly["hourly nudge worker"]
        Nightly["nightly synthesis<br/>(02:00 user-local)"]
    end

    subgraph RawData["raw / recall (some built)"]
        Gmail["gmail (live via composio) ✓"]
        IMessage["imessage (live via linq) ✓"]
        SuperMemory["supermemory<br/>(needle-in-haystack RAG, planned)"]
    end

    SystemPrompt --> Wrapped
    ToolDefs --> Wrapped
    Wrapped --> WrappedInner
    Messages --> Wrapped
    UserInput --> Wrapped

    Slabs -.-> Living
    Slabs -.-> State
    Day -.-> Wrapped
    Living -.-> Wrapped
    State -.-> Wrapped
    Drafts -.-> State

    PostTurn -.-> Slabs
    Hourly -.-> Commitments
    Nightly -.-> Slabs
    Nightly -.-> Living

    Gmail -.-> PostTurn
    IMessage -.-> PostTurn
    Gmail -.-> SuperMemory

    ChatHistory --> Messages

    style Slabs stroke-dasharray: 5 5
    style WrappedInner stroke-dasharray: 5 5
    style Workers stroke-dasharray: 5 5
    style SuperMemory stroke-dasharray: 5 5
```

legend: solid = built today. dashed = planned (designed, not yet implemented).

---

## 6 · file map

| layer | file | role |
|---|---|---|
| ingress | `src/server.ts` | http server, webhook verify+receive, dispatch (whatsapp + imessage) |
| ingress | `src/index.ts` | cli readline loop |
| ingress | `src/donna/ingress/whatsapp.ts` | parse meta payload → IngressPayload |
| ingress | `src/donna/ingress/imessage.ts` | parse linq payload |
| identity | `src/donna/memory/users.ts` | `getOrCreateUser(phone)` |
| identity | `src/donna/memory/inbound.ts` | dedup table for inbound message ids |
| brain | `src/donna/brain.ts` | `runTurn`, `runProactiveTurn`, ptc loop, caller tagging |
| brain | `src/donna/context.ts` | `AsyncLocalStorage<TurnContext>` (userId, runId, source) |
| brain | `src/donna/prompt.ts` | SYSTEM_PROMPT (voice + orchestration + inbox_copilot_intents + integration_lifecycle) |
| brain | `src/donna/voice_filter.ts` | egress regex filter on send_burst |
| tools | `src/donna/tools/index.ts` | registry: code_execution + 4 gmail + 3 imessage + 3 integration_* + send_burst + time |
| tools | `src/donna/tools/gmail.ts` | 4 ptc-callable, all route through `executeForUser` |
| tools | `src/donna/tools/imessage.ts` | 3 ptc-callable, route through linq |
| tools | `src/donna/tools/integrations.ts` | 3 direct lifecycle tools (status, set_mode, disconnect) |
| tools | `src/donna/tools/send_burst.ts` | direct-only terminator |
| tools | `src/donna/tools/time.ts` | direct-only single-shot |
| integration | `src/donna/integrations/service.ts` | `IntegrationService`: state crud, audit, `executeForUser`, lifecycle |
| integration | `src/donna/integrations/composio.ts` | composio client wrapper (legacy entrypoint) |
| integration | `src/donna/integrations/linq.ts` | linq imessage client |
| memory | `src/donna/memory/chat.ts` | load/save `chat_messages` (modes: reactive, proactive) |
| delivery | `src/donna/delivery/whatsapp.ts` | `WhatsAppChannel.send` |
| delivery | `src/donna/delivery/proactive.ts` | `deliverBurstToUser` (whatsapp + persist + log) |
| delivery | `src/donna/delivery/messages.ts` | TextMessage / OutboundMessage types |
| observability | `src/donna/observability/execution.ts` | `execution_runs`, `execution_events`, list/finish |
| persistence | `src/donna/db.ts` | postgres client |
| config | `src/donna/config.ts` | env-loaded settings |
| scripts | `scripts/connect-integration.ts` | oauth dance + post-connect proactive ack |
| scripts | `scripts/bootstrap-integration.ts` | seed integrations row from env (legacy) |
| scripts | `scripts/inspect-context.ts` | prompt/cache audit helper |
| migrations | `supabase/migrations/20260505_chat_messages.sql` | history table |
| migrations | `supabase/migrations/20260506_inbound_messages.sql` | dedup table |
| migrations | `supabase/migrations/20260506_users.sql` | users table |
| migrations | `supabase/migrations/20260507_execution_observability.sql` | execution_runs + execution_events |
| migrations | `supabase/migrations/20260507_integrations.sql` | integrations + integration_audit + donna_state_drafts |

---

## 7 · key invariants

1. **the model only reads what's in context.** every memory layer earns its keep by reaching the prompt. storage is upstream and irrelevant to reads.
2. **handlers run inside `withTurnContext`.** every tool can read `getTurnContext().userId`. no thread-through of user identity.
3. **`executeForUser` is the only way provider apis are called.** auth, audit, mode/exclusion enforcement live there. handlers don't talk to composio directly.
4. **send_burst is direct-only.** never marked as `allowed_callers`. voice filter runs on its egress. terminator semantics enforced in brain loop.
5. **`audit` failures never break user flow.** logged + swallowed.
6. **proactive bursts go through the same brain loop, voice filter, and persistence** as reactive bursts. just a different entry point + synthetic trigger message.
7. **integration state is the source of truth for "is gmail working."** brain queries it via `integration_status`. composio's actual state is checked when the lifecycle tool fires (disconnect, future health-check).

---

## 8 · trust + privacy boundaries

```
donna's server holds:
  ANTHROPIC_API_KEY · COMPOSIO_API_KEY · WHATSAPP_TOKEN · DATABASE_URL

donna's server NEVER sees:
  user's gmail oauth tokens (composio holds)
  user's google refresh token

anthropic NEVER sees:
  composio api key
  the postgres database
  raw user data EXCEPT what flows through tool_result blocks
  (which DO appear in conversation context — careful with sensitive content)

every read is auditable:
  integration_audit(action, item_ref, ok, duration_ms, meta)
  → "what did donna touch this week"
```

---

## 9 · what's built vs not

✓ built today:
- ingress (whatsapp, imessage, cli)
- brain loop with ptc + caller-tagged events
- gmail tools via composio with audit
- imessage tools via linq
- integration lifecycle: connect cli + 3 in-conversation tools (status, set_mode, disconnect)
- proactive primitive: `runProactiveTurn` + `deliverBurstToUser`
- post-connect proactive ack (whatsapp delivery)
- observability: execution_runs/events with caller tagging, langsmith tracing

✗ not yet built:
- proactive event lane (dispatcher, arbiter, tier3 judge)
- backfill / sync workers (composio webhooks or polling)
- error → proactive (token expired, sync gap)
- memory slabs (relationships, commitments, voice, identity, state, ...)
- synthesis layer (nightly worker, living_profile, today_shape)
- composer for wrapped user message (today: just the user's message)
- supermemory recall layer
- write tools (gmail_create_draft, gmail_send, gmail_modify_labels)
- exclusion mutation tools
- forget / wipe (purge derived data on disconnect)
