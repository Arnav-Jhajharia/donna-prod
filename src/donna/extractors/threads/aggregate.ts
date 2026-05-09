// aggregator + writer for the threads pipeline.
//
// for each (candidate, classified) pair:
//   1. update gmail_people for every counterparty (counts, last_seen, salience)
//   2. upsert gmail_threads with the new state, ball_in_court, awaiting_since
//   3. if importance is high enough or state changed meaningfully, audit it
//
// ball_in_court state machine:
//   - new thread → set awaiting_since = last_event_at of current ball
//   - same ball as before → keep awaiting_since (still sitting)
//   - ball flipped → reset awaiting_since to now
//   - ball cleared (closed/scheduled/fyi) → awaiting_since = null

import { getSql } from "../../db.js";
import { audit } from "../../integrations/service.js";
import { displayNameFromAddress } from "./source_gmail.js";
import type {
  ThreadCandidate,
  ClassifiedThread,
  ThreadState,
  BallInCourt,
} from "./types.js";

interface ExistingThread {
  id: string;
  state: ThreadState;
  ball_in_court: BallInCourt;
  awaiting_since: string | null;
  importance_score: number;
  user_pinned: boolean;
}

interface ExistingPerson {
  id: string;
  inbound_count_30d: number;
  outbound_count_30d: number;
  inbound_count_total: number;
  outbound_count_total: number;
  reply_rate: number | null;
  is_bot_likely: boolean;
}

const BOT_LOCAL_RE =
  /^(?:noreply|no-reply|notifications?|notify|alerts?|donotreply|do-not-reply|mailer|postmaster|news|newsletter|digest|reply\+)/i;

function isLikelyBot(email: string): boolean {
  if (!email || !email.includes("@")) return true;
  const local = email.split("@")[0]!;
  return BOT_LOCAL_RE.test(local);
}

// salience: capped human-vs-bot signal × engagement × recency.
// rough but useful — will refine once we see real data.
function computeSalience(args: {
  inbound30d: number;
  outbound30d: number;
  replyRate: number | null;
  isBot: boolean;
  daysSinceInbound: number | null;
}): number {
  if (args.isBot) return 0.05;
  // engagement: outbound is the strongest "i care about this person" signal
  const engagement = Math.min(1, (args.outbound30d * 0.15) + (args.inbound30d * 0.05));
  // reply rate amplifies if you do reply
  const replyMult = args.replyRate == null ? 0.6 : 0.4 + 0.6 * args.replyRate;
  // recency: people you haven't heard from in months matter less
  const recencyMult = args.daysSinceInbound == null
    ? 0.5
    : args.daysSinceInbound <= 7 ? 1.0
    : args.daysSinceInbound <= 30 ? 0.85
    : args.daysSinceInbound <= 90 ? 0.6
    : 0.35;
  return clamp01(engagement * replyMult * recencyMult);
}

// importance of a thread = base from classifier × salience of primary counterparty.
function blendImportance(base: number, counterpartySalience: number, isPinned: boolean): number {
  if (isPinned) return Math.max(base, 0.85);
  // counterparty salience is the multiplier — a strong question from a stranger
  // is medium; a question from your boss is high.
  return clamp01(0.3 * base + 0.7 * (base * (0.4 + 0.6 * counterpartySalience)));
}

// ──────────────────────────────────────────────────────────────────────────
// people upsert
// ──────────────────────────────────────────────────────────────────────────

interface PeopleUpsertOutcome {
  inserted: boolean;
  updated: boolean;
  salience: number;
}

async function upsertPerson(args: {
  userId: string;
  email: string;
  displayName: string | null;
  isInboundEvent: boolean;       // counterparty sent → +inbound
  isOutboundEvent: boolean;      // user sent → +outbound
  eventTs: string;
}): Promise<PeopleUpsertOutcome> {
  const sql = getSql();
  const email = args.email.toLowerCase();
  const domain = email.split("@")[1] ?? null;
  const isBot = isLikelyBot(email);

  const existingRows = await sql<ExistingPerson[]>`
    select id, inbound_count_30d, outbound_count_30d,
           inbound_count_total, outbound_count_total,
           reply_rate, is_bot_likely
    from gmail_people
    where user_id = ${args.userId} and email = ${email}
    limit 1
  `;
  const existing = existingRows[0];

  if (!existing) {
    const inbound30 = args.isInboundEvent ? 1 : 0;
    const outbound30 = args.isOutboundEvent ? 1 : 0;
    const salience = computeSalience({
      inbound30d: inbound30,
      outbound30d: outbound30,
      replyRate: null,
      isBot,
      daysSinceInbound: args.isInboundEvent ? 0 : null,
    });
    await sql`
      insert into gmail_people (
        user_id, email, display_name, domain,
        last_inbound_at, last_outbound_at,
        inbound_count_30d, outbound_count_30d,
        inbound_count_total, outbound_count_total,
        reply_rate, salience_score, is_bot_likely
      ) values (
        ${args.userId}, ${email}, ${args.displayName}, ${domain},
        ${args.isInboundEvent ? args.eventTs : null},
        ${args.isOutboundEvent ? args.eventTs : null},
        ${inbound30}, ${outbound30},
        ${args.isInboundEvent ? 1 : 0}, ${args.isOutboundEvent ? 1 : 0},
        ${null}, ${salience}, ${isBot}
      )
    `;
    return { inserted: true, updated: false, salience };
  }

  // increment counters
  const newInbound30 = existing.inbound_count_30d + (args.isInboundEvent ? 1 : 0);
  const newOutbound30 = existing.outbound_count_30d + (args.isOutboundEvent ? 1 : 0);
  const newInboundTotal = existing.inbound_count_total + (args.isInboundEvent ? 1 : 0);
  const newOutboundTotal = existing.outbound_count_total + (args.isOutboundEvent ? 1 : 0);

  // reply_rate: outbound / inbound (capped at 1).
  const replyRate = newInboundTotal === 0
    ? null
    : Math.min(1, newOutboundTotal / Math.max(1, newInboundTotal));

  const salience = computeSalience({
    inbound30d: newInbound30,
    outbound30d: newOutbound30,
    replyRate,
    isBot: existing.is_bot_likely || isBot,
    daysSinceInbound: args.isInboundEvent ? 0 : null,
  });

  await sql`
    update gmail_people set
      display_name = coalesce(${args.displayName}, display_name),
      last_inbound_at = case
        when ${args.isInboundEvent}
        then greatest(coalesce(last_inbound_at, ${args.eventTs}::timestamptz), ${args.eventTs}::timestamptz)
        else last_inbound_at
      end,
      last_outbound_at = case
        when ${args.isOutboundEvent}
        then greatest(coalesce(last_outbound_at, ${args.eventTs}::timestamptz), ${args.eventTs}::timestamptz)
        else last_outbound_at
      end,
      inbound_count_30d = ${newInbound30},
      outbound_count_30d = ${newOutbound30},
      inbound_count_total = ${newInboundTotal},
      outbound_count_total = ${newOutboundTotal},
      reply_rate = ${replyRate},
      salience_score = ${salience},
      is_bot_likely = ${existing.is_bot_likely || isBot},
      updated_at = now()
    where id = ${existing.id}
  `;
  return { inserted: false, updated: true, salience };
}

// ──────────────────────────────────────────────────────────────────────────
// threads upsert
// ──────────────────────────────────────────────────────────────────────────

interface ThreadUpsertOutcome {
  inserted: boolean;
  updated: boolean;
}

async function upsertThread(args: {
  userId: string;
  candidate: ThreadCandidate;
  classified: ClassifiedThread;
  primaryCounterpartySalience: number;
}): Promise<ThreadUpsertOutcome> {
  const sql = getSql();
  const c = args.candidate;
  const cls = args.classified;
  const lastInboundFrom = c.last_message.is_from_user ? null : c.last_message.from_email;

  const existingRows = await sql<ExistingThread[]>`
    select id, state, ball_in_court, awaiting_since, importance_score, user_pinned
    from gmail_threads
    where user_id = ${args.userId} and gmail_thread_id = ${c.gmail_thread_id}
    limit 1
  `;
  const existing = existingRows[0];

  // ball_in_court state machine: only reset awaiting_since when ball changes.
  let awaitingSince: string | null;
  if (cls.ball_in_court == null) {
    awaitingSince = null;
  } else if (existing && existing.ball_in_court === cls.ball_in_court && existing.awaiting_since) {
    awaitingSince = existing.awaiting_since;
  } else {
    // new thread or ball flipped → reset to last_event_at of new state
    awaitingSince = c.last_message.ts;
  }

  const importance = blendImportance(
    cls.importance_score,
    args.primaryCounterpartySalience,
    existing?.user_pinned ?? false,
  );

  if (!existing) {
    await sql`
      insert into gmail_threads (
        user_id, gmail_thread_id, subject, participants,
        last_inbound_from, message_count,
        state, ball_in_court, awaiting_since,
        one_line_summary, importance_score,
        last_inbound_at, last_outbound_at, last_event_at
      ) values (
        ${args.userId}, ${c.gmail_thread_id}, ${c.subject || null}, ${c.participants},
        ${lastInboundFrom}, ${c.message_count},
        ${cls.state}, ${cls.ball_in_court}, ${awaitingSince},
        ${cls.one_line_summary}, ${importance},
        ${c.last_inbound_at}, ${c.last_outbound_at}, ${c.last_message.ts}
      )
    `;
    return { inserted: true, updated: false };
  }

  await sql`
    update gmail_threads set
      subject = ${c.subject || null},
      participants = ${c.participants},
      last_inbound_from = ${lastInboundFrom},
      message_count = ${c.message_count},
      state = ${cls.state},
      ball_in_court = ${cls.ball_in_court},
      awaiting_since = ${awaitingSince},
      one_line_summary = ${cls.one_line_summary},
      importance_score = ${importance},
      last_inbound_at = ${c.last_inbound_at},
      last_outbound_at = ${c.last_outbound_at},
      last_event_at = ${c.last_message.ts},
      updated_at = now()
    where id = ${existing.id}
  `;
  return { inserted: false, updated: true };
}

// ──────────────────────────────────────────────────────────────────────────
// public: aggregate a batch
// ──────────────────────────────────────────────────────────────────────────

export interface AggregateThreadsResult {
  threads_inserted: number;
  threads_updated: number;
  people_inserted: number;
  people_updated: number;
}

export async function aggregateThreads(
  userId: string,
  classifications: Array<{ candidate: ThreadCandidate; classified: ClassifiedThread }>,
): Promise<AggregateThreadsResult> {
  let threads_inserted = 0;
  let threads_updated = 0;
  let people_inserted = 0;
  let people_updated = 0;

  for (const { candidate, classified } of classifications) {
    // people first — we need the salience of the primary counterparty to
    // blend importance into the thread row.
    const counterparties = candidate.participants.filter((p) => p && p !== candidate.user_email);
    const primary = counterparties[0] ?? "";
    let primarySalience = 0.4;

    for (const email of counterparties) {
      // event direction for this person:
      // - if last message is from them, that's an inbound event
      // - if last message is from user but we haven't tracked an outbound event for them yet, count one
      const isInbound = !candidate.last_message.is_from_user && candidate.last_message.from_email === email;
      const isOutbound = candidate.last_message.is_from_user && counterparties.length > 0;
      const displayName = email === candidate.last_message.from_email
        ? displayNameFromAddress(candidate.last_message.from)
        : null;

      try {
        const outcome = await upsertPerson({
          userId,
          email,
          displayName,
          isInboundEvent: isInbound,
          isOutboundEvent: isOutbound,
          eventTs: candidate.last_message.ts,
        });
        if (outcome.inserted) people_inserted++;
        if (outcome.updated) people_updated++;
        if (email === primary) primarySalience = outcome.salience;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[threads/aggregate] person upsert failed for ${email}: ${msg}`);
      }
    }

    try {
      const outcome = await upsertThread({
        userId,
        candidate,
        classified,
        primaryCounterpartySalience: primarySalience,
      });
      if (outcome.inserted) threads_inserted++;
      if (outcome.updated) threads_updated++;

      await audit({
        userId,
        provider: "gmail",
        action: outcome.inserted ? "threads.inserted" : "threads.updated",
        itemRef: candidate.gmail_thread_id,
        ok: true,
        meta: {
          state: classified.state,
          ball_in_court: classified.ball_in_court,
          importance: classified.importance_score,
          judge_confidence: classified.judge_confidence,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[threads/aggregate] thread upsert failed for ${candidate.gmail_thread_id}: ${msg}`);
      await audit({
        userId,
        provider: "gmail",
        action: "threads.upsert_failed",
        itemRef: candidate.gmail_thread_id,
        ok: false,
        meta: { error: msg },
      });
    }
  }

  return { threads_inserted, threads_updated, people_inserted, people_updated };
}

// ──────────────────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
