import type { Tool } from "@anthropic-ai/sdk/resources/messages";

// the research executor's terminator. when the research agent has gathered
// enough information, it calls this with a structured answer. the parent
// (voice brain) reads the answer from the tool_use input and turns it into
// a user-facing reply in its own voice.
//
// the executor itself is not user-facing — the prompt makes clear that
// `answer` is for the parent agent, not for the user. terse, factual.
// sources go to the ledger; the voice brain decides whether to surface them.
export const finalizeResearchTool: Tool = {
  name: "finalize_research",
  description: `terminate the research turn with your final structured answer. call this exactly once when you've gathered enough information.

your output is NOT user-facing. the parent agent (voice) will frame it for the user. focus on:
- factual, specific statements
- precise numbers, names, urls when relevant
- terse — no fluff, no hedging, no "based on my research"

include sources (urls) when the answer rests on specific pages.`,
  input_schema: {
    type: "object",
    properties: {
      answer: {
        type: "string",
        description: "1-3 sentences. factual, specific, no framing.",
      },
      sources: {
        type: "array",
        items: { type: "string" },
        description: "optional urls the answer relies on. surfaced to the parent for the ledger; the parent agent may not show them to the user.",
      },
    },
    required: ["answer"],
  },
};

interface FinalizeResearchInput {
  answer: string;
  sources?: string[];
}

// the handler just acks. the answer lives in the assistant's tool_use input;
// the parent agent's dispatch handler reads it from there, not from the
// tool_result. keeping the tool_result minimal avoids re-encoding the answer.
export async function finalizeResearchHandler(input: unknown): Promise<string> {
  const { answer } = (input ?? {}) as FinalizeResearchInput;
  return `acknowledged: ${answer ? answer.slice(0, 80) : "(no answer)"}`;
}
