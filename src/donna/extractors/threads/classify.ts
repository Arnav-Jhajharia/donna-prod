// thread state classifier.
//
// stage 1 · heuristic. cheap. handles the obvious cases (last msg from user
//          → awaiting_other; bot/notification sender → fyi; explicit "thanks
//          let's close this out" → closed). zero llm calls.
//
// stage 2 · haiku judge for the ambiguous ones (real human counterparty,
//          recent inbound, unclear what they want). batched.
//
// also produces a one_line_summary which is what donna actually shows the
// user when surfacing open threads.

import Anthropic from "@anthropic-ai/sdk";
import type { ThreadCandidate, ClassifiedThread, ThreadState, BallInCourt } from "./types.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const HAIKU_BATCH_SIZE = 12;

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

// ──────────────────────────────────────────────────────────────────────────
// heuristics
// ──────────────────────────────────────────────────────────────────────────

const BOT_EMAIL_RE =
  /^(?:noreply|no-reply|notifications?|notify|alerts?|donotreply|do-not-reply|mailer|mailman|postmaster|hello|hi|team|support|info|news|newsletter|digest|reply\+)/i;

const BOT_DOMAIN_RE =
  /(?:mailgun|sendgrid|amazonses|email\.|notify\.|notifications\.|mail\.)/i;

const QUESTION_RE = /\?\s*$|(?:^|\s)(?:can you|could you|would you|will you|please|let me know|wdyt|thoughts\?|any update|when can|by when)/i;

const CLOSE_RE = /^\s*(?:thanks|thank you|appreciate it|got it|sounds good|perfect|will do|received|done|cheers|👍|🙏)/i;

const SCHEDULED_RE = /\b(?:calendar invite|see you (?:at|on)|see u|booked|confirmed for|scheduled for|invitation:)/i;

function isBotSender(email: string): boolean {
  if (!email || !email.includes("@")) return false;
  const [local, domain] = email.split("@");
  return BOT_EMAIL_RE.test(local!) || (domain ? BOT_DOMAIN_RE.test(domain) : false);
}

interface HeuristicVerdict {
  classified: ClassifiedThread | null;     // null = need haiku
  reason: string;
}

export function classifyHeuristic(c: ThreadCandidate): HeuristicVerdict {
  const last = c.last_message;
  const counterparties = c.participants.filter((p) => p && p !== c.user_email);

  // case 1: every participant is a bot → fyi, no ball, low importance.
  if (counterparties.length === 0 || counterparties.every(isBotSender)) {
    return {
      classified: {
        state: "fyi",
        ball_in_court: null,
        one_line_summary: truncate(last.subject || "(no subject)", 120),
        importance_score: 0.1,
        judge_confidence: 0.95,
      },
      reason: "all_bots",
    };
  }

  // case 2: last message from user → awaiting other side, ball with them.
  if (last.is_from_user) {
    return {
      classified: {
        state: "awaiting_other",
        ball_in_court: "other",
        one_line_summary: truncate(`waiting on ${primaryCounterparty(counterparties)} re: ${last.subject || "thread"}`, 120),
        importance_score: 0.5,
        judge_confidence: 0.9,
      },
      reason: "last_from_user",
    };
  }

  // case 3: short close-out from counterparty → closed.
  const trimmed = last.body_preview.trim();
  if (CLOSE_RE.test(trimmed) && trimmed.length < 200 && !QUESTION_RE.test(trimmed)) {
    return {
      classified: {
        state: "closed",
        ball_in_court: null,
        one_line_summary: truncate(`closed: ${last.subject || "(no subject)"}`, 120),
        importance_score: 0.05,
        judge_confidence: 0.85,
      },
      reason: "closeout",
    };
  }

  // case 4: scheduling language → scheduled, ball with no one.
  if (SCHEDULED_RE.test(trimmed) || /^(?:invitation|invite|cal:)/i.test(last.subject || "")) {
    return {
      classified: {
        state: "scheduled",
        ball_in_court: null,
        one_line_summary: truncate(`scheduled: ${last.subject || "(no subject)"}`, 120),
        importance_score: 0.4,
        judge_confidence: 0.8,
      },
      reason: "scheduled",
    };
  }

  // case 5: clear question → awaiting user, high importance.
  if (QUESTION_RE.test(trimmed)) {
    return {
      classified: {
        state: "awaiting_user",
        ball_in_court: "user",
        one_line_summary: truncate(`${primaryCounterparty(counterparties)} asked: ${snippet(last.subject, trimmed)}`, 120),
        importance_score: 0.65,
        judge_confidence: 0.75,
      },
      reason: "question",
    };
  }

  // ambiguous: real human, last message inbound, no clear question. punt to haiku.
  return { classified: null, reason: "ambiguous" };
}

// ──────────────────────────────────────────────────────────────────────────
// haiku judge for ambiguous cases
// ──────────────────────────────────────────────────────────────────────────

interface HaikuVerdict {
  state: ThreadState;
  ball_in_court: BallInCourt;
  summary: string;
  importance: number;          // 0..1
  confidence: number;          // 0..1
}

async function judgeBatch(items: ThreadCandidate[]): Promise<HaikuVerdict[]> {
  if (items.length === 0) return [];

  const blocks = items.map((c, i) => {
    const recent = c.recent_messages
      .map((m) => `  [${m.is_from_user ? "user" : m.from_email}] ${truncate(m.body_preview, 300)}`)
      .join("\n");
    return `--- ITEM ${i} ---
SUBJECT: ${truncate(c.last_message.subject, 200)}
FROM: ${c.last_message.from_email}
TO_USER: ${c.user_email}
PARTICIPANTS: ${c.participants.join(", ")}
RECENT (oldest→newest):
${recent}`;
  }).join("\n\n");

  const prompt = `You classify the state of an email thread for a personal assistant. For each ITEM:

- "state" is one of: awaiting_user (counterparty needs/asked something from the user), awaiting_other (user sent the latest, waiting on them), scheduled (something is set, no action needed), closed (resolved/done), fyi (information only, no action).
- "ball_in_court" is "user" | "other" | null.
- "summary" is one short lowercase line (no markdown, ≤100 chars) describing what's open. e.g. "raj asked for the deck by friday".
- "importance" is 0..1: how much the user should care. Real questions from real humans = high. Notifications/digests = low.
- "confidence" is 0..1.

Output exactly one JSON object per item, in order, one per line, no prose:
{"i": <index>, "state": "...", "ball_in_court": "user"|"other"|null, "summary": "...", "importance": 0..1, "confidence": 0..1}

${blocks}`;

  const resp = await getAnthropic().messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const text = resp.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");

  const verdicts: HaikuVerdict[] = items.map(() => ({
    state: "awaiting_user",
    ball_in_court: "user",
    summary: "",
    importance: 0.5,
    confidence: 0,
  }));

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const i = typeof obj.i === "number" ? obj.i : -1;
      if (i < 0 || i >= items.length) continue;
      verdicts[i] = {
        state: (obj.state as ThreadState) ?? "awaiting_user",
        ball_in_court: (obj.ball_in_court as BallInCourt) ?? "user",
        summary: typeof obj.summary === "string" ? obj.summary.slice(0, 200) : "",
        importance: clamp01(typeof obj.importance === "number" ? obj.importance : 0.5),
        confidence: clamp01(typeof obj.confidence === "number" ? obj.confidence : 0.5),
      };
    } catch {
      // leave default
    }
  }
  return verdicts;
}

// ──────────────────────────────────────────────────────────────────────────
// public: classify a list of candidates
// ──────────────────────────────────────────────────────────────────────────

export interface ThreadsClassifyResult {
  classifications: Array<{ candidate: ThreadCandidate; classified: ClassifiedThread }>;
  haiku_calls: number;
}

export async function classifyThreads(
  candidates: ThreadCandidate[],
): Promise<ThreadsClassifyResult> {
  const out: ThreadsClassifyResult["classifications"] = [];
  const ambiguous: ThreadCandidate[] = [];

  for (const c of candidates) {
    const h = classifyHeuristic(c);
    if (h.classified) {
      out.push({ candidate: c, classified: h.classified });
    } else {
      ambiguous.push(c);
    }
  }

  let haikuCalls = 0;
  for (let i = 0; i < ambiguous.length; i += HAIKU_BATCH_SIZE) {
    const batch = ambiguous.slice(i, i + HAIKU_BATCH_SIZE);
    let verdicts: HaikuVerdict[];
    try {
      verdicts = await judgeBatch(batch);
      haikuCalls++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[threads/classify] haiku batch failed: ${msg}`);
      // fallback: treat as awaiting_user with medium importance
      verdicts = batch.map(() => ({
        state: "awaiting_user" as const,
        ball_in_court: "user" as const,
        summary: "",
        importance: 0.5,
        confidence: 0.3,
      }));
    }
    for (let j = 0; j < batch.length; j++) {
      const c = batch[j]!;
      const v = verdicts[j]!;
      const summary = v.summary || `${primaryCounterparty(c.participants.filter((p) => p !== c.user_email))} re: ${c.last_message.subject || "thread"}`;
      out.push({
        candidate: c,
        classified: {
          state: v.state,
          ball_in_court: v.ball_in_court,
          one_line_summary: truncate(summary, 120),
          importance_score: v.importance,
          judge_confidence: v.confidence,
        },
      });
    }
  }

  return { classifications: out, haiku_calls: haikuCalls };
}

// ──────────────────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function primaryCounterparty(emails: string[]): string {
  const e = emails.find((x) => !!x);
  if (!e) return "(unknown)";
  return e.split("@")[0] ?? e;
}

function snippet(subject: string, body: string): string {
  return subject || body.slice(0, 80);
}
