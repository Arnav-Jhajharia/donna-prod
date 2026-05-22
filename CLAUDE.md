# donna

donna is a whatsapp/imessage-native personal ai. she holds one person's life — remembers what they said, follows up, surfaces next moves before they ask. not "an assistant," not a thinking partner, not a productivity tool. closer to a sharp human chief of staff.

she is omnipresent, exists everywhere. acts (not literally) before you ask, is very proactive, connected really well to all your integrations to have a sense of understanding of you

w

## how we work

line-by-line, deliberate. the user understands every line before it gets committed. no jumping ahead, no "while we're here" additions, no batched changes spanning multiple concerns. explain what a line does and why before writing it. one small thing at a time, commit, then the next.

this file grows back as the codebase does. when a new piece lands and the user understands it, it earns a line here. nothing aspirational, nothing about archived code.

## what's in src/ right now

a minimal cli tool-loop on the raw `@anthropic-ai/sdk`. five files, ~315 lines.

- `src/index.ts` — stdin readline cli, in-memory history, one `runTurn` per line.
- `src/donna/brain.ts` — manual tool-call loop. asks the model, runs handlers, returns when a terminator fires or after `MAX_ITERATIONS`.
- `src/donna/prompt.ts` — system prompt. voice rules + the `send_burst` contract.
- `src/donna/tools/index.ts` — single registry: tool defs, handlers, `TERMINATORS` set.
- `src/donna/tools/send_burst.ts` — the terminator. donna's only voice. strings inside are exactly what the user reads.
- `src/donna/tools/time.ts` — `get_current_time(timezone?)`. example of a non-terminator tool.

everything else (whatsapp/imessage ingress, integrations, calorie tracker, observability, supabase, langsmith, proactive worker, world engine) is archived under `src/_archive/`, `src/donna/_archive/`, `scripts/_archive/`, `supabase/_archive/`. it doesn't run, doesn't typecheck (excluded in `tsconfig.json`), and isn't the current architecture. read it for reference only.

## voice (the product, not the code)

lowercase. no em dashes, no semicolons, no emojis, no markdown. short — one or two sentences per bubble. direct.

every turn ends with one `send_burst`. its strings are exactly what the user reads. never put reasoning or meta-commentary inside burst strings.

## scripts

```bash
npm run dev         # cli loop
npm run typecheck   # tsc --noEmit
npm run build       # tsc
```

before any commit: `npm run typecheck`.

## env

only `ANTHROPIC_API_KEY` is read. `.env.example` is the source of truth — keep it that way as new vars come in.

## mobile

donna's third surface (after whatsapp and imessage) lives in `mobile/`. expo + react native + typescript. own `package.json`, own `node_modules`, own `tsconfig.json`. talks to the same brain — the mobile ingress endpoint is the next thing to design on this side, and it lives in `src/server.ts` when it lands. cross-cutting changes (a new tool, a new message shape) touch both `src/donna/` and `mobile/src/` in one commit. see `mobile/CLAUDE.md` for the mobile-side specifics.
