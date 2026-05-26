import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { runTurn } from "../brain.js";
import { researchBundle } from "../agents/research.js";
import { userId } from "../context.js";

// the bridge from voice brain to execution agents. one dispatch = one
// stateless executor invocation. result is returned to voice brain as the
// tool_result it can consume.
//
// today only one executor type exists (research). when gmail / calendar /
// drafting executors land, this tool grows a `type` enum and a factory
// switch — the dispatch shape itself stays the same.

export const dispatchToExecutorTool: Tool = {
  name: "dispatch_to_executor",
  description: `delegate a research task to an executor agent that has web search + web fetch + code execution. use when answering requires current external information you don't have — weather, hours / availability of a place, news, prices, anything time-sensitive or outside your training.

do NOT use for:
- things you already know
- the current time (use get_current_time)
- vague open-ended tasks ("what should i do today" — that's a conversation, not research)

the executor does NOT see this conversation. write \`task\` as a complete, self-contained instruction with all relevant context (location, dates, specific names) embedded. include only what the executor needs to answer; not the whole history.

the executor is stateless — each dispatch is independent. if you need to follow up ("now sort by price"), include the prior findings in the new task field.

multiple dispatches in one turn are fine — emit them as parallel tool calls when the lookups don't depend on each other.`,
  input_schema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "a complete, self-contained instruction the executor can act on without other context. e.g. 'find current opening hours for blue bottle coffee at 66 mint plaza, san francisco'.",
      },
    },
    required: ["task"],
  },
};

interface DispatchInput {
  task: string;
}

interface DispatchResult {
  answer: string;
  sources: string[];
  runId: string;
}

// run the research executor with the task, extract its final answer from
// the assistant's finalize_research tool_use, return as a clean object.
//
// we read the answer from the assistant's tool_use input (the structured
// arguments the model passed to finalize_research), not from the
// tool_result. the tool_result is just an ack — the actual answer is in
// the tool_use input.
export async function dispatchToExecutorHandler(
  input: unknown,
): Promise<string> {
  const { task } = (input ?? {}) as DispatchInput;
  if (!task) throw new Error("dispatch_to_executor: task required");

  const bundle = researchBundle(task);
  const result = await runTurn(
    [{ role: "user", content: task }],
    { agent: bundle, userId: userId() },
  );

  if (result.terminator !== "finalize_research") {
    return JSON.stringify({
      answer: "",
      sources: [],
      runId: result.runId,
      error: `executor did not finalize (terminator=${result.terminator ?? "none"})`,
    });
  }

  // find the finalize_research tool_use block across the executor's
  // assistant messages. there should be exactly one; we take the last
  // (defensive — the loop should have terminated on the first).
  const finalize = result.newMessages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter(
      (b): b is { type: "tool_use"; name: string; input: unknown; id: string } =>
        typeof b === "object" &&
        b !== null &&
        "type" in b &&
        b.type === "tool_use" &&
        "name" in b &&
        b.name === "finalize_research",
    )
    .pop();

  if (!finalize) {
    return JSON.stringify({
      answer: "",
      sources: [],
      runId: result.runId,
      error: "no finalize_research call in executor transcript",
    });
  }

  const { answer = "", sources = [] } = (finalize.input ?? {}) as {
    answer?: string;
    sources?: string[];
  };

  const payload: DispatchResult = {
    answer,
    sources,
    runId: result.runId,
  };
  return JSON.stringify(payload);
}
