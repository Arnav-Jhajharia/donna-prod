# donna

donna is a personal ai. she holds one person's life — remembers what they said, follows up, surfaces next moves before they ask. not "an assistant," not a thinking partner, not a productivity tool. closer to a sharp human chief of staff.

she is omnipresent, exists across surfaces. acts before you ask, is very proactive, connected to your integrations to build a real understanding of you. the surfaces she lives on today: whatsapp, imessage, mobile.

## how we work

line-by-line, deliberate. the user understands every line before it gets committed. no jumping ahead, no "while we're here" additions, no batched changes spanning multiple concerns. explain what a line does and why before writing it. one small thing at a time, commit, then the next.

this file describes **patterns and conventions**, not inventory. file counts, file lists, and feature enumerations go stale within a week and lie to whoever reads them. anything specific (a file, a count, a feature) belongs in the codebase itself, not here.

## voice (the product, not the code)

lowercase. no em dashes, no semicolons, no emojis, no markdown. short — one or two sentences per bubble. direct.

every turn ends with one `send_burst`. its strings are exactly what the user reads. never put reasoning or meta-commentary inside burst strings.

## the brain (src/donna/)

a manual tool-call loop on the raw `@anthropic-ai/sdk`. the loop itself is `brain.ts`. the system prompt is `prompt.ts`. tools live in `src/donna/tools/` as one `.ts` file per tool, registered in `tools/index.ts`.

tools come in two flavors:
- **terminators** end the turn. `send_burst.ts` is the canonical example — donna's only voice.
- **non-terminators** continue the loop. `time.ts` is the simplest example.

ledger writes per-turn jsonl to `.donna/` for replay. inspector lives in `src/inspect.ts`.

to add a tool: drop a new file in `tools/`, export the def + handler, register it in `tools/index.ts`. if it's a terminator, also add to the `TERMINATORS` set there.

## the archive

`src/_archive/`, `src/donna/_archive/`, `scripts/_archive/`, and `supabase/_archive/` hold deprecated implementations that have been retired or paused. excluded from typecheck (see `tsconfig.json`). read for reference when restoring a feature or studying past decisions. **don't import from.**

if you need to know what's in there, grep. don't enumerate it here.

## scripts

```bash
npm run dev         # cli loop
npm run typecheck   # tsc --noEmit
npm run build       # tsc
```

before any commit: `npm run typecheck`.

## env

`.env.example` is the source of truth for what env vars exist. keep it current as new vars come in.

## mobile

donna's third surface lives in `mobile/`. expo + react native + typescript. own `package.json`, own `node_modules`, own `tsconfig.json`. talks to the same brain via an authenticated http ingress (designed in `docs/voice-call.html`; not yet wired). cross-cutting changes (a new tool, a new message shape) touch both `src/donna/` and `mobile/` in one commit. see `mobile/CLAUDE.md` for mobile specifics.

## docs

`docs/` holds architecture, design, and decision artifacts as standalone html files. open them in a browser. they're long-form context — the things that don't fit in CLAUDE.md but you'd want before making a non-trivial decision.

## verification protocol

before committing or asserting any of these, verify via tool use (web search, `npm view <pkg>`, file read, source check):

- npm package versions or names
- specific urls
- api surface (method names, flag names, config keys)
- "latest" claims about anything
- claims about what a library supports or doesn't

if it can't be verified, **say "i'm guessing" or "i need to check"** instead of asserting. specific numbers that turn out to be wrong cost more than vague hedges. don't ship plausible-sounding wrongness.
