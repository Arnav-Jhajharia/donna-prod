// gmail source adapter for the threads extractor.
//
// strategy: fetch recent inbox messages, group by thread_id, then for each
// thread pull the full thread via GMAIL_FETCH_MESSAGE_BY_THREAD_ID. heavier
// than the subscriptions path (one extra call per thread) but the thread
// payload is what we model — single messages aren't enough to compute
// ball-in-court.
//
// caps: --since-days (default 30) and --limit (default 200 threads). first
// backfill is bounded; later updates are per-event via the push lane.

import { executeForUser } from "../../integrations/service.js";
import type { ThreadCandidate } from "./types.js";

interface RawGmailMessage {
  messageId?: string;
  threadId?: string;
  sender?: string;
  to?: string;
  subject?: string;
  messageText?: string;
  preview?: { body?: string };
  labelIds?: string[];
  messageTimestamp?: string;
}

interface FetchEmailsResponse {
  messages?: RawGmailMessage[];
  nextPageToken?: string;
  next_page_token?: string;
}

interface FetchThreadResponse {
  threadId?: string;
  messages?: RawGmailMessage[];
}

export interface FetchOptions {
  userEmail: string;
  sinceDays: number;
  limit: number;            // max threads
  batchSize?: number;       // gmail page size
}

// "Name <email>" → "email" (lower)
export function emailFromAddress(addr: string | undefined | null): string {
  if (!addr) return "";
  const angle = addr.match(/<([^>]+)>/);
  const raw = angle ? angle[1]! : addr;
  return raw.trim().toLowerCase();
}

export function displayNameFromAddress(addr: string | undefined | null): string | null {
  if (!addr) return null;
  const angle = addr.match(/^(.*?)\s*<[^>]+>$/);
  if (angle && angle[1]?.trim()) return angle[1]!.trim().replace(/^"|"$/g, "");
  return null;
}

export async function fetchThreadCandidatesGmail(
  opts: FetchOptions,
): Promise<ThreadCandidate[]> {
  const days = Math.max(1, Math.ceil(opts.sinceDays));
  const userEmail = opts.userEmail.toLowerCase();
  const batchSize = opts.batchSize ?? 100;

  // first pass: list recent messages, collect unique thread ids in arrival order.
  const seenThreadIds = new Set<string>();
  const threadIdsInOrder: string[] = [];
  let pageToken: string | undefined;
  let pageNum = 0;

  while (threadIdsInOrder.length < opts.limit) {
    pageNum++;
    const resp = await executeForUser<FetchEmailsResponse>(
      "gmail",
      "GMAIL_FETCH_EMAILS",
      {
        query: `newer_than:${days}d -in:chats`,
        max_results: batchSize,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
      {
        action: "threads.candidate_fetch",
        meta: { page: pageNum, page_token: pageToken ?? null, since_days: days },
      },
    );

    const msgs = resp.messages ?? [];
    for (const m of msgs) {
      const tid = m.threadId;
      if (!tid || seenThreadIds.has(tid)) continue;
      seenThreadIds.add(tid);
      threadIdsInOrder.push(tid);
      if (threadIdsInOrder.length >= opts.limit) break;
    }

    const next = resp.nextPageToken ?? resp.next_page_token;
    if (!next || msgs.length === 0) break;
    pageToken = next;
  }

  // second pass: fetch each thread and assemble a ThreadCandidate.
  const out: ThreadCandidate[] = [];
  for (const tid of threadIdsInOrder) {
    let raw: FetchThreadResponse;
    try {
      raw = await executeForUser<FetchThreadResponse>(
        "gmail",
        "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
        { thread_id: tid },
        { action: "threads.fetch_one", itemRef: tid },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[threads/source_gmail] thread ${tid} fetch failed: ${msg}`);
      continue;
    }
    const cand = candidateFromThread(raw, userEmail);
    if (cand) out.push(cand);
  }

  return out;
}

// shared by source adapter (backfill) and the push handler.
export function candidateFromThread(
  raw: FetchThreadResponse,
  userEmail: string,
): ThreadCandidate | null {
  const tid = raw.threadId;
  const msgs = raw.messages ?? [];
  if (!tid || msgs.length === 0) return null;

  const sortedMsgs = [...msgs].sort((a, b) => {
    const ta = new Date(a.messageTimestamp ?? 0).getTime();
    const tb = new Date(b.messageTimestamp ?? 0).getTime();
    return ta - tb;
  });

  const last = sortedMsgs[sortedMsgs.length - 1]!;
  const lastFromEmail = emailFromAddress(last.sender);
  const isFromUser = lastFromEmail === userEmail.toLowerCase();

  const participants = Array.from(
    new Set(
      sortedMsgs.flatMap((m) => [emailFromAddress(m.sender), emailFromAddress(m.to)])
        .filter((e) => e && e !== userEmail.toLowerCase()),
    ),
  );

  // last in/out timestamps.
  let lastInbound: string | null = null;
  let lastOutbound: string | null = null;
  for (const m of sortedMsgs) {
    const e = emailFromAddress(m.sender);
    const ts = m.messageTimestamp ?? null;
    if (!ts) continue;
    if (e === userEmail.toLowerCase()) lastOutbound = ts;
    else lastInbound = ts;
  }

  // a small slice of recent context for the haiku judge.
  const recent_messages = sortedMsgs.slice(-4).map((m) => ({
    from_email: emailFromAddress(m.sender),
    is_from_user: emailFromAddress(m.sender) === userEmail.toLowerCase(),
    body_preview: (m.messageText ?? m.preview?.body ?? "").slice(0, 600),
    ts: m.messageTimestamp ?? "",
  }));

  return {
    source: "gmail",
    gmail_thread_id: tid,
    subject: last.subject ?? "",
    participants,
    user_email: userEmail.toLowerCase(),
    last_message: {
      from: last.sender ?? "",
      from_email: lastFromEmail,
      is_from_user: isFromUser,
      subject: last.subject ?? "",
      body_preview: (last.messageText ?? last.preview?.body ?? "").slice(0, 800),
      ts: last.messageTimestamp ?? new Date().toISOString(),
    },
    recent_messages,
    message_count: sortedMsgs.length,
    last_inbound_at: lastInbound,
    last_outbound_at: lastOutbound,
  };
}

// helper for the push handler: fetch ONE thread fresh.
export async function fetchSingleThread(
  threadId: string,
  userEmail: string,
): Promise<ThreadCandidate | null> {
  const raw = await executeForUser<FetchThreadResponse>(
    "gmail",
    "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
    { thread_id: threadId },
    { action: "threads.push_fetch", itemRef: threadId },
  );
  return candidateFromThread(raw, userEmail);
}
