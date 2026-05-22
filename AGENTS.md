<!-- gitnexus:start (manually softened — do not regenerate without rereading) -->
# gitnexus — code intelligence

this project is indexed as **donna-prod** (~2k symbols, ~3k edges, ~84 flows). gitnexus mcp tools and skills are available; use them when they pay for themselves, not by default.

> if any gitnexus tool warns the index is stale, run `npx gitnexus analyze`.

## when to reach for it

- **non-trivial code edits** to handlers, shared utils, the tool registry, the brain loop, or anything called from more than one place — run `gitnexus_impact({target, direction: "upstream"})` first and surface blast radius if non-obvious.
- **renames** — use `gitnexus_rename`, not find-and-replace.
- **exploring unfamiliar areas** — `gitnexus_query({query})` returns process-grouped results that beat grep for "how does X work".
- **deep dive on one symbol** — `gitnexus_context({name})` for callers, callees, flows.

## when to skip it

- prompt edits, copy tweaks, one-line tool description changes, sql drafting, env/config edits — overhead isn't worth it.
- pure additions (new file, new tool not yet wired) — nothing to impact-analyze yet.

## nice to have, not required

- `gitnexus_detect_changes()` before commit — run it when the diff spans >1 module or you're unsure what you affected. for small focused diffs, skip.

## resources

| resource | use for |
|----------|---------|
| `gitnexus://repo/donna-prod/context` | overview, check index freshness |
| `gitnexus://repo/donna-prod/clusters` | functional areas |
| `gitnexus://repo/donna-prod/processes` | execution flows |
| `gitnexus://repo/donna-prod/process/{name}` | step-by-step trace |

deeper workflow notes in `.claude/skills/gitnexus-*/SKILL.md`.

<!-- gitnexus:end -->
