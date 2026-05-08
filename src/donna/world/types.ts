// world engine — donna actively looks at the world (vs reactive webhooks).
// minimum viable shape: search lane only, postgres-backed dedup + daily budget,
// delivery routed through runProactiveTurn so voice stays in send_burst.

export type ExaLane = "search";

export interface ProactiveMove {
  // 1-sentence bet: "there's a new poke launch"
  hypothesis: string;
  // 1-sentence justification grounded in concrete user signal
  user_signal: string;
  // 1-sentence why the user would thank donna
  payoff_if_hit: string;
  tool: ExaLane;
  query: string;
  // 0..1. 0.5 ≈ this week, 1.0 ≈ today only.
  urgency: number;
  render_hint: "short_text" | "long_text" | "card";
  // stable id; same intent same key. used for dedup across ticks.
  dedup_key: string;
}

export type MoveStatus = "ok" | "no_hits" | "degraded" | "skipped";

export interface ExaSearchResult {
  title: string;
  url: string;
  snippet: string;
  published?: string;
  author?: string;
}

export interface ProactiveResult {
  move: ProactiveMove;
  status: MoveStatus;
  results: ExaSearchResult[];
  elapsed_ms: number;
  skipped_reason?: string;
}

export type Decision = "send" | "silence";

export interface JudgeVerdict {
  decision: Decision;
  // donna-voice draft. used as the brain's trigger string when decision=send.
  draft: string;
  reason: string;
}

export interface WorldContext {
  user_id: string;
  // narrative blurb for haiku — facts about the user, projects, watches.
  // empty string is OK; query_creation degrades to a no-op.
  profile_blurb: string;
  // last few user/assistant lines, for grounding moves to recent signal.
  recent_thread: string;
  current_datetime: string;
  // "manual" | "morning" | "drain:<source>" — informational only.
  trigger: string;
}

export interface DroppedMove {
  move: ProactiveMove;
  reason: string;
}

export interface WorldTickResult {
  user_id: string;
  trigger: string;
  moves_emitted: ProactiveMove[];
  moves_dropped: DroppedMove[];
  results: ProactiveResult[];
  verdicts: Array<{ result: ProactiveResult; verdict: JudgeVerdict }>;
  delivered: number;
  elapsed_ms: number;
}
