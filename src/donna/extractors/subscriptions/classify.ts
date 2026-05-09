// classifier — given a Candidate, decide whether it represents a recurring
// subscription charge and (if so) extract a DetectedCharge.
//
// pipeline:
//   stage 1 · cheap heuristic (regex + keyword scoring). returns a confidence
//             0..1 + best-guess extraction. zero llm calls.
//   stage 2 · haiku judge for the ambiguous middle (heuristic.confidence
//             between 0.3 and 0.7). batched to amortize cost.
//
// short-circuits aggressively: hard noise (no amount, no merchant signal) is
// dropped without calling haiku.

import Anthropic from "@anthropic-ai/sdk";
import type {
  Candidate,
  DetectedCharge,
  Recurrence,
} from "./types.js";

// ---------------------------------------------------------------------------
// patterns
// ---------------------------------------------------------------------------

// money: e.g. "$15.99", "USD 19.00", "S$5.00", "€12,50", "12.50 USD".
// captures: full match, currency hint, amount string.
const MONEY_RE =
  /(?:(?:USD|EUR|GBP|SGD|CAD|AUD|JPY|INR|HKD|CNY|MYR|THB)\s*)?([$€£¥₹]|S\$|HK\$|RM|฿)?\s*(\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{1,2})?)\s*(?:USD|EUR|GBP|SGD|CAD|AUD|JPY|INR|HKD|CNY|MYR|THB)?/g;

// strong subject signals — bumps confidence
const SUBJECT_SUBSCRIPTION_RE =
  /(subscription|renewed?|renewal|auto[\s-]?(?:pay|charge)|recurring|monthly\s+(?:charge|payment|bill|plan)|annual\s+(?:charge|payment|bill|plan)|membership|invoice|receipt|payment\s+(?:received|confirmation|successful)|your\s+order|payment\s+of)/i;

// strong sender signals — bumps confidence even more (stripe, billing@, etc)
const SENDER_BILLING_RE =
  /(?:billing|invoices?|receipts?|noreply|payments?|auto[\s-]?confirm|stripe|paypal)[@.]/i;

// noise filter — refunds, failed charges, marketing emails about subscriptions
const NEGATIVE_RE =
  /(refund(?:ed)?|chargeback|failed\s+(?:payment|charge)|payment\s+failed|cancellation\s+confirmed|trial\s+ending|free\s+trial|sign\s+up\s+(?:now|today)|upgrade\s+to)/i;

const CURRENCY_BY_SYMBOL: Record<string, string> = {
  $: "USD",
  "S$": "SGD",
  "HK$": "HKD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
  RM: "MYR",
  "฿": "THB",
};

// ---------------------------------------------------------------------------
// stage 1: heuristic
// ---------------------------------------------------------------------------

interface HeuristicResult {
  charge: DetectedCharge | null;
  confidence: number;        // 0..1
  reason: "no_amount" | "no_signal" | "negative" | "weak" | "moderate" | "strong";
}

function extractMoney(text: string): { cents: number; currency: string; quote: string } | null {
  const matches = [...text.matchAll(MONEY_RE)];
  if (matches.length === 0) return null;

  // pick the largest amount (common pattern: "$15.99 — was $19.99 — save $4")
  let best: { cents: number; currency: string; quote: string } | null = null;

  for (const m of matches) {
    const symbol = (m[1] ?? "").trim();
    const amountStr = (m[2] ?? "").replace(/[\s,](?=\d{3}\b)/g, "").replace(",", ".");
    const amount = parseFloat(amountStr);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000) continue;

    // currency: explicit ISO or symbol map; default USD
    let currency = "USD";
    const upperFull = m[0]!.toUpperCase();
    const isoMatch = upperFull.match(/(USD|EUR|GBP|SGD|CAD|AUD|JPY|INR|HKD|CNY|MYR|THB)/);
    if (isoMatch) currency = isoMatch[1]!;
    else if (symbol && CURRENCY_BY_SYMBOL[symbol]) currency = CURRENCY_BY_SYMBOL[symbol]!;

    const cents = Math.round(amount * 100);
    if (!best || cents > best.cents) {
      best = { cents, currency, quote: m[0]!.trim() };
    }
  }

  return best;
}

function extractMerchantFromSender(from: string): string {
  // "Netflix <billing@netflix.com>" → "Netflix"
  // "billing@stripe.com" → "stripe.com"
  // "Spotify <noreply@spotify.com>" → "Spotify"
  const trimmed = from.trim();
  const angle = trimmed.match(/^(.*?)\s*<([^>]+)>$/);
  if (angle && angle[1]?.trim()) return angle[1]!.trim();
  if (angle && angle[2]) {
    const domain = angle[2].split("@")[1] ?? angle[2];
    return domain.replace(/^(?:noreply|billing|receipts|invoices|payments|notifications)\./, "");
  }
  // bare email
  const at = trimmed.indexOf("@");
  if (at >= 0) {
    const domain = trimmed.slice(at + 1);
    return domain.replace(/^(?:noreply|billing|receipts|invoices|payments|notifications)\./, "");
  }
  return trimmed;
}

function recurrenceHintFromText(text: string): Recurrence | null {
  if (/monthly|month\b|\/mo\b|per month/i.test(text)) return "monthly";
  if (/annual|year(?:ly)?|\/yr\b|per year/i.test(text)) return "yearly";
  if (/quarterly|quarter\b/i.test(text)) return "quarterly";
  if (/weekly|week\b|\/wk\b/i.test(text)) return "weekly";
  return null;
}

export function classifyHeuristic(c: Candidate): HeuristicResult {
  const subject = c.raw.subject ?? "";
  const body = c.raw.body ?? "";
  const from = c.raw.from ?? "";
  const ts = c.raw.ts ?? new Date().toISOString();

  const haystack = `${subject}\n${body}`;

  // hard negative: refunds, cancellations, marketing
  if (NEGATIVE_RE.test(haystack)) {
    return { charge: null, confidence: 0, reason: "negative" };
  }

  const money = extractMoney(haystack);
  if (!money) {
    return { charge: null, confidence: 0, reason: "no_amount" };
  }

  // confidence scoring
  let conf = 0.2;
  if (SUBJECT_SUBSCRIPTION_RE.test(subject)) conf += 0.35;
  if (SUBJECT_SUBSCRIPTION_RE.test(body))    conf += 0.15;
  if (SENDER_BILLING_RE.test(from))           conf += 0.25;
  if (recurrenceHintFromText(haystack))       conf += 0.10;

  conf = Math.min(1, conf);

  if (conf < 0.2) {
    return { charge: null, confidence: conf, reason: "no_signal" };
  }

  const merchant = extractMerchantFromSender(from);
  const charge: DetectedCharge = {
    merchant_raw: merchant,
    amount_cents: money.cents,
    currency: money.currency,
    charged_at: ts,
    evidence_quote: truncate(money.quote + (subject ? ` — ${subject}` : ""), 280),
    recurrence_hint: recurrenceHintFromText(haystack),
    category_hint: null,
    confidence: conf,
    source_channel: c.source_channel,
    source_ref: c.source_ref,
  };

  const reason: HeuristicResult["reason"] =
    conf >= 0.7 ? "strong" : conf >= 0.3 ? "moderate" : "weak";

  return { charge, confidence: conf, reason };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// ---------------------------------------------------------------------------
// stage 2: haiku judge for the ambiguous middle (batched)
// ---------------------------------------------------------------------------

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const AMBIGUOUS_LOW = 0.3;
const AMBIGUOUS_HIGH = 0.7;
const HAIKU_BATCH_SIZE = 25;

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

interface HaikuVerdict {
  is_subscription: boolean;
  merchant?: string;
  amount_cents?: number;
  currency?: string;
  recurrence?: Recurrence;
  category?: string;
  confidence: number;
}

async function judgeBatch(candidates: Candidate[]): Promise<HaikuVerdict[]> {
  if (candidates.length === 0) return [];

  const blocks = candidates.map((c, i) => {
    const subj = (c.raw.subject ?? "").slice(0, 200);
    const from = c.raw.from ?? "";
    const body = (c.raw.body ?? "").slice(0, 800);
    return `--- ITEM ${i} ---\nFROM: ${from}\nSUBJECT: ${subj}\nBODY:\n${body}`;
  }).join("\n\n");

  const prompt = `For each ITEM below, decide whether it represents a CHARGE (money successfully taken) for a recurring subscription, membership, or auto-pay service. Single one-off purchases should be marked NOT a subscription. Refunds, failed charges, marketing, and free trials are NOT subscriptions.

For each ITEM (in the same order), return a JSON object on its own line:
{"i": <index>, "yes": <bool>, "merchant": "<name>", "amount_cents": <int>, "currency": "<ISO3>", "recurrence": "monthly"|"yearly"|"weekly"|"quarterly"|"unknown", "category": "<one of: entertainment|software|news|fitness|ai|cloud|shopping|other>", "confidence": <0..1>}

If "yes" is false, only include {"i", "yes": false, "confidence": <0..1>}.

Only output the JSON lines, one per item, no prose.

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

  const verdicts: HaikuVerdict[] = candidates.map(() => ({ is_subscription: false, confidence: 0 }));
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const i = typeof obj.i === "number" ? obj.i : -1;
      if (i < 0 || i >= candidates.length) continue;
      const yes = Boolean(obj.yes);
      verdicts[i] = {
        is_subscription: yes,
        merchant: typeof obj.merchant === "string" ? obj.merchant : undefined,
        amount_cents: typeof obj.amount_cents === "number" ? obj.amount_cents : undefined,
        currency: typeof obj.currency === "string" ? obj.currency : undefined,
        recurrence: typeof obj.recurrence === "string" ? (obj.recurrence as Recurrence) : undefined,
        category: typeof obj.category === "string" ? obj.category : undefined,
        confidence: typeof obj.confidence === "number" ? obj.confidence : (yes ? 0.85 : 0.15),
      };
    } catch {
      // skip malformed line; verdict stays as default-no
    }
  }
  return verdicts;
}

// ---------------------------------------------------------------------------
// public: classify a list of candidates end-to-end
// ---------------------------------------------------------------------------

export interface ClassifyResult {
  charges: DetectedCharge[];
  haiku_calls: number;
  decided_yes: number;
  decided_no: number;
}

export async function classify(candidates: Candidate[]): Promise<ClassifyResult> {
  const result: ClassifyResult = { charges: [], haiku_calls: 0, decided_yes: 0, decided_no: 0 };

  // partition by heuristic verdict
  const accepted: DetectedCharge[] = [];   // strong + included
  const ambiguousIdx: number[] = [];       // need haiku
  const ambiguousCharges: DetectedCharge[] = [];

  for (const c of candidates) {
    const h = classifyHeuristic(c);
    if (!h.charge) {
      result.decided_no++;
      continue;
    }
    if (h.confidence >= AMBIGUOUS_HIGH) {
      accepted.push(h.charge);
      continue;
    }
    if (h.confidence >= AMBIGUOUS_LOW) {
      ambiguousIdx.push(candidates.indexOf(c));
      ambiguousCharges.push(h.charge);
      continue;
    }
    result.decided_no++;
  }

  // batch the ambiguous middle through haiku
  for (let i = 0; i < ambiguousIdx.length; i += HAIKU_BATCH_SIZE) {
    const batchIdx = ambiguousIdx.slice(i, i + HAIKU_BATCH_SIZE);
    const batchCands = batchIdx.map((idx) => candidates[idx]!);
    let verdicts: HaikuVerdict[] = [];
    try {
      verdicts = await judgeBatch(batchCands);
      result.haiku_calls++;
    } catch (err) {
      // haiku call failed — fall back to heuristic charges as-is for this batch
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[subscriptions/classify] haiku batch failed: ${msg}`);
      for (let j = 0; j < batchCands.length; j++) {
        accepted.push(ambiguousCharges[i + j]!);
      }
      continue;
    }

    for (let j = 0; j < batchCands.length; j++) {
      const v = verdicts[j];
      const heuristicCharge = ambiguousCharges[i + j]!;
      if (!v || !v.is_subscription) {
        result.decided_no++;
        continue;
      }
      // merge: prefer haiku's structured fields, fall back to heuristic
      accepted.push({
        ...heuristicCharge,
        merchant_raw: v.merchant ?? heuristicCharge.merchant_raw,
        amount_cents: v.amount_cents ?? heuristicCharge.amount_cents,
        currency: v.currency ?? heuristicCharge.currency,
        recurrence_hint: v.recurrence ?? heuristicCharge.recurrence_hint ?? null,
        category_hint: v.category ?? heuristicCharge.category_hint ?? null,
        confidence: Math.max(heuristicCharge.confidence, v.confidence),
      });
    }
  }

  result.charges = accepted;
  result.decided_yes = accepted.length;
  return result;
}
