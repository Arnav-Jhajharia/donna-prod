import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { AgentBundle } from "./types.js";
import {
  finalizeResearchTool,
  finalizeResearchHandler,
} from "../tools/finalize_research.js";

// donna's research executor. stateless per dispatch — each invocation builds
// a fresh bundle from the task string and runs to completion. no per-user
// history is loaded; the task is self-contained.
//
// what's IN this bundle:
//   - web_search (server tool, anthropic-hosted)
//   - web_fetch  (server tool, anthropic-hosted)
//   - code_execution (server tool — free when bundled with web_*)
//   - finalize_research (our terminator)
//
// what's NOT in this bundle:
//   - send_burst → executor never talks to the user directly
//   - get_current_time → if the parent needed time, it should have included
//     it in the task field. keeps the executor focused.
//   - any per-user state lookup. fully stateless by contract.
//
// the prompt is parameterised by the task. that's the "on the fly" donna
// gets — fresh bundle per call, prompt rendered with the specific instruction.

const RESEARCH_PROMPT = `you are donna's research executor.

you do not see the user's conversation. you do not write user-facing text.
the parent (voice brain) gave you a task; complete it, then return a
structured answer via finalize_research. the parent will frame the user
reply.

style for your answer (the \`answer\` field of finalize_research):
- factual, specific, terse
- precise dates, prices, names, urls
- no hedging, no "based on my research", no "i found that"

how you work:
- web_search: search the open web. multiple searches in parallel beat
  guessing the single best source.
- web_fetch: read a specific url when search results aren't enough.
- code_execution: filter, parse, post-process if the data is structured.
  free when used alongside web_search/web_fetch.
- finalize_research: call exactly once when done. terminator.

constraints:
- you MUST end the turn with finalize_research. no other terminator.
- if you can't answer with confidence, finalize with what you know plus
  a brief note about the uncertainty in the answer field.`;

export function researchBundle(task: string): AgentBundle {
  // server tools are typed via the sdk's discriminated union. mixing them
  // with our custom finalize_research tool requires a cast at the array
  // level; each individual entry is shape-valid for the api.
  const tools = [
    { type: "web_search_20260209", name: "web_search", max_uses: 5 },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 },
    { type: "code_execution_20250825", name: "code_execution" },
    finalizeResearchTool,
  ] as unknown as Tool[];

  return {
    name: "donna.research",
    systemPrompt: `${RESEARCH_PROMPT}\n\ntask:\n${task}`,
    tools,
    handlers: {
      finalize_research: finalizeResearchHandler,
    },
    terminators: new Set(["finalize_research"]),
  };
}
