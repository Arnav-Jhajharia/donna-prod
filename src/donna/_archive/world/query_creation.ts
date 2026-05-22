// haiku turns user signal into 0-3 proactive moves. forbidden: generic news,
// wellness, "you might like", and any move not anchored on concrete signal.

import Anthropic from "@anthropic-ai/sdk";
import type { ProactiveMove, WorldContext } from "./types.js";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_MOVES = 3;

const SYSTEM_PROMPT = `you are donna's world-watching strategist. given what we know about the user, emit 0-3 search-shaped proactive moves she should run RIGHT NOW.

every move is a bet: a hypothesis you are testing about the world, anchored on a concrete user signal (a quote, a profile fact, a watched entity).

forbidden:
- generic news ("ai news today", "tech updates")
- wellness or lifestyle angles
- "you might like" framing
- vague queries (under 4 meaningful tokens)
- moves not tied to specific user signal

prefer 0 moves over a weak move. silence is safe. weak pings cost trust.

each move must include:
- hypothesis: 1 sentence — what the world contains that matters
- user_signal: 1 sentence — the concrete fact justifying the bet
- payoff_if_hit: 1 sentence — why the user would thank donna
- query: search-shaped neural sentence (not keywords)
- urgency: 0..1 (0.5 ≈ this week, 1.0 ≈ today only)
- render_hint: short_text | long_text | card
- dedup_key: stable intent id, e.g. "watch:poke_launch" or "earnings:adbe_q1_2026". same intent = same key across ticks.

reply ONLY with valid json: {"moves": [...]}`;

export async function createMoves(ctx: WorldContext): Promise<ProactiveMove[]> {
  const anthropic = new Anthropic();
  const userMsg = [
    `<profile>${ctx.profile_blurb || "(unknown — only surface unambiguous signal)"}</profile>`,
    `<recent_thread>${ctx.recent_thread || "(empty)"}</recent_thread>`,
    `<current_datetime>${ctx.current_datetime}</current_datetime>`,
    `<trigger>${ctx.trigger}</trigger>`,
    "",
    `emit at most ${MAX_MOVES} moves. if user signal is thin, return {"moves": []}.`,
  ].join("\n");

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMsg }],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return parseMoves(text);
}

function parseMoves(text: string): ProactiveMove[] {
  const json = extractJson(text);
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const moves = (parsed as { moves?: unknown[] }).moves;
  if (!Array.isArray(moves)) return [];
  return moves
    .map(coerceMove)
    .filter((m): m is ProactiveMove => m !== null)
    .slice(0, MAX_MOVES);
}

function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function coerceMove(raw: unknown): ProactiveMove | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const hypothesis = strField(r.hypothesis);
  const userSignal = strField(r.user_signal);
  const payoff = strField(r.payoff_if_hit);
  const query = strField(r.query);
  const dedupKey = strField(r.dedup_key);
  if (!hypothesis || !userSignal || !payoff || !query || !dedupKey) return null;
  const urgency = clamp01(typeof r.urgency === "number" ? r.urgency : 0.5);
  const renderHint = isRenderHint(r.render_hint) ? r.render_hint : "short_text";
  return {
    hypothesis,
    user_signal: userSignal,
    payoff_if_hit: payoff,
    tool: "search",
    query,
    urgency,
    render_hint: renderHint,
    dedup_key: dedupKey,
  };
}

function strField(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function isRenderHint(v: unknown): v is "short_text" | "long_text" | "card" {
  return v === "short_text" || v === "long_text" || v === "card";
}
