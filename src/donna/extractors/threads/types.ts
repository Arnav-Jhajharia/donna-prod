// shared types for the gmail threads pipeline. multi-source by design — gmail
// today, future channels (slack DMs, imessage threads) plug in by emitting the
// same ThreadCandidate shape.

export type ThreadSource = "gmail";

export type ThreadState =
  | "awaiting_user"   // counterparty asked something / sent latest msg, ball is on user
  | "awaiting_other"  // user replied last, waiting on counterparty
  | "scheduled"       // a meeting/event was set; nothing to do until it fires
  | "closed"          // the thread is done — explicit "thanks" / resolved / archived
  | "fyi";            // information only, no action expected (newsletters, notifications)

export type BallInCourt = "user" | "other" | null;

// raw input from the source adapter.
export interface ThreadCandidate {
  source: ThreadSource;
  gmail_thread_id: string;
  subject: string;
  participants: string[];           // normalized lowercase emails on the thread
  user_email: string;               // owner's email — needed to figure out direction
  // most recent message (for state classification)
  last_message: {
    from: string;                   // raw "Name <email>" or bare email
    from_email: string;             // normalized lowercase
    is_from_user: boolean;          // direction
    subject: string;
    body_preview: string;           // first ~800 chars
    ts: string;                     // iso 8601
  };
  // for context. small. used by haiku judge if needed.
  recent_messages: Array<{
    from_email: string;
    is_from_user: boolean;
    body_preview: string;
    ts: string;
  }>;
  // counts come from gmail
  message_count: number;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
}

export interface ClassifiedThread {
  state: ThreadState;
  ball_in_court: BallInCourt;
  one_line_summary: string;
  importance_score: number;        // 0..1, set by aggregator with people salience
  // judge confidence, used to decide when to defer to haiku vs trust heuristic
  judge_confidence: number;
}

export interface ThreadView {
  id: string;
  user_id: string;
  gmail_thread_id: string;
  subject: string | null;
  participants: string[];
  last_inbound_from: string | null;
  message_count: number;
  state: ThreadState;
  ball_in_court: BallInCourt;
  awaiting_since: string | null;
  one_line_summary: string | null;
  importance_score: number;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_event_at: string;
  user_dismissed: boolean;
  user_pinned: boolean;
  created_at: string;
  updated_at: string;
}

export interface PersonView {
  email: string;
  display_name: string | null;
  domain: string | null;
  inbound_count_30d: number;
  outbound_count_30d: number;
  reply_rate: number | null;
  salience_score: number;
  is_bot_likely: boolean;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
}

export interface ThreadsBackfillResult {
  threads_seen: number;
  threads_inserted: number;
  threads_updated: number;
  people_inserted: number;
  people_updated: number;
  haiku_calls: number;
  duration_ms: number;
}
