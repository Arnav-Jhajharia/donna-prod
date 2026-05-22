// per-result silence-by-default judge. ~1 in 5 ships. weak pings cost trust.

import Anthropic from "@anthropic-ai/sdk";
import type { JudgeVerdict, ProactiveResult, WorldContext } from "./types.js";

const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `you are donna's silence-by-default judge. given a search result and the move that fetched it, decide whether to ping the user.

calibration: ~1 in 5 candidates ships. silence is safe.

ship only if all three:
- the result actually matches the hypothesis (not a near-miss)
- the user would say "yeah, glad you told me" (not "ok and?")
- the timing makes sense (urgent enough to interrupt now)

if shipping, write a draft donna would say. constraints:
- lowercase only
- no em-dashes, no semicolons, no emojis
- terse, fact-led, not framing-led
- include the most relevant url at the end if helpful

reply ONLY with valid json: {"decision": "send" | "silence", "draft": "...", "reason": "..."}`;

export async function judgeResult(
  ctx: WorldContext,
  result: ProactiveResult,
): Promise<JudgeVerdict> {
  if (result.status !== "ok" || result.results.length === 0) {
    return {
      decision: "silence",
      draft: "",
      reason: `pre-skip: status=${result.status}`,
    };
  }
  const anthropic = new Anthropic();
  const top = result.results.slice(0, 5);
  const payloadStr = top
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}\n${r.url}\n${(r.snippet ?? "").slice(0, 400)}`,
    )
    .join("\n\n");

  const userMsg = [
    `<profile>${ctx.profile_blurb || "(unknown)"}</profile>`,
    `<move>`,
    `  hypothesis: ${result.move.hypothesis}`,
    `  user_signal: ${result.move.user_signal}`,
    `  payoff_if_hit: ${result.move.payoff_if_hit}`,
    `  query: ${result.move.query}`,
    `  urgency: ${result.move.urgency}`,
    `</move>`,
    `<results>`,
    payloadStr,
    `</results>`,
    `<current_datetime>${ctx.current_datetime}</current_datetime>`,
    "",
    "decide. default to silence.",
  ].join("\n");

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMsg }],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return parseVerdict(text);
}

function parseVerdict(text: string): JudgeVerdict {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { decision: "silence", draft: "", reason: "judge: unparseable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { decision: "silence", draft: "", reason: "judge: invalid json" };
  }
  const r = parsed as Record<string, unknown>;
  const decision = r.decision === "send" ? "send" : "silence";
  const draft = typeof r.draft === "string" ? r.draft.trim() : "";
  const reason = typeof r.reason === "string" ? r.reason : "";
  if (decision === "send" && draft.length === 0) {
    return { decision: "silence", draft: "", reason: "judge: empty draft on send" };
  }
  return { decision, draft, reason };
}
