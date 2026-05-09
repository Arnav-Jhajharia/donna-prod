// gmail source adapter for subscription detection. fetches receipt-shaped
// emails via the same executeForUser path used by the gmail tools (so audit
// + mode/exclusion enforcement flow naturally), normalizes them into
// Candidate{} for the classifier.

import { executeForUser } from "../../integrations/service.js";
import type { Candidate } from "./types.js";

// gmail query that pre-filters to receipt-shaped messages.
// kept generous on purpose — we'd rather classifier sees more and rejects than
// miss a real receipt. heavy-noise filtering happens downstream (heuristic +
// haiku judge) where we have more signal.
const RECEIPT_QUERY_BASE =
  '(subject:(invoice OR receipt OR subscription OR renewal OR "your order" OR "thanks for your payment" OR "payment received" OR "payment confirmation") OR from:(receipts OR billing OR invoices OR noreply@stripe.com OR auto-confirm OR payments))';

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

export interface FetchOptions {
  sinceDays: number;
  limit: number;
  batchSize?: number;
}

export async function fetchCandidatesGmail(
  opts: FetchOptions,
): Promise<Candidate[]> {
  const days = Math.max(1, Math.ceil(opts.sinceDays));
  const query = `${RECEIPT_QUERY_BASE} newer_than:${days}d`;
  const batchSize = opts.batchSize ?? 100;

  const out: Candidate[] = [];
  let pageToken: string | undefined;
  let pageNum = 0;

  while (out.length < opts.limit) {
    pageNum++;
    const remaining = opts.limit - out.length;
    const data = await executeForUser<FetchEmailsResponse>(
      "gmail",
      "GMAIL_FETCH_EMAILS",
      {
        query,
        max_results: Math.min(batchSize, remaining),
        ...(pageToken ? { page_token: pageToken } : {}),
      },
      {
        action: "subscriptions.candidate_fetch",
        meta: { query, page: pageNum, page_token: pageToken ?? null },
      },
    );

    const msgs = data.messages ?? [];
    for (const m of msgs) {
      const body = m.messageText ?? m.preview?.body ?? "";
      out.push({
        source_channel: "gmail",
        source_ref: m.messageId ?? null,
        raw: {
          from: m.sender ?? "",
          subject: m.subject ?? "",
          body,
          ts: m.messageTimestamp ?? new Date().toISOString(),
        },
      });
      if (out.length >= opts.limit) break;
    }

    const next = data.nextPageToken ?? data.next_page_token;
    if (!next || msgs.length === 0) break;
    pageToken = next;
  }

  return out;
}
