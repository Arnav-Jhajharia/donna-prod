// scripts/intelligence-pass.ts
//
// looks past the noise. excludes everything covered by the auto-archive rules,
// then surfaces what's actually interesting:
//   - real humans who've talked to you in this window
//   - things you sent and never heard back on (open balls)
//   - things people sent you that you never replied to (your ghosts)
//   - threads with 2+ messages where the last word is theirs (your turn)
//   - recurring topics across your real correspondence
//
// run:  npx tsx scripts/intelligence-pass.ts

import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";

const DB_PATH = "scripts/mining/gmail.sqlite";
const RULES_PATH = "scripts/mining/rules.json";

interface Rule {
  predicate:
    | { kind: "sender_domain"; domain: string }
    | { kind: "sender_addr"; addr: string };
}

const db = new DatabaseSync(DB_PATH);
const rules: Rule[] = existsSync(RULES_PATH)
  ? (JSON.parse(readFileSync(RULES_PATH, "utf8")) as Rule[])
  : [];

const noisyDomains = new Set<string>();
const noisyAddrs = new Set<string>();
for (const r of rules) {
  if (r.predicate.kind === "sender_domain")
    noisyDomains.add(r.predicate.domain.toLowerCase());
  else if (r.predicate.kind === "sender_addr")
    noisyAddrs.add(r.predicate.addr.toLowerCase());
}

// also exclude common auto-pattern domains the rules might miss in short data
const knownNoise = new Set([
  "linkedin.com",
  "facebookmail.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "mail.beehiiv.com",
  "substack.com",
  "googlegroups.com",
  "notify.bitbucket.org",
  "noreply.github.com",
]);
for (const d of knownNoise) noisyDomains.add(d);

interface Msg {
  id: string;
  thread_id: string;
  from_addr: string;
  to_addr: string;
  subject: string;
  date_iso: string;
  snippet: string;
  labels_json: string;
}

function isNoise(from: string): boolean {
  const m = from.match(/<([^>]+)>/);
  const addr = (m ? m[1] : from).trim().toLowerCase();
  if (!addr.includes("@")) return false;
  if (noisyAddrs.has(addr)) return true;
  const domain = addr.split("@")[1]!;
  if (noisyDomains.has(domain)) return true;
  // generic broadcast patterns
  if (/no.?reply|noreply|notification|alerts?|hello@|info@|news@|hi@|updates?@|automated|system@|do.?not.?reply/i.test(addr)) return true;
  return false;
}

function isSent(labels: string): boolean {
  return labels.includes('"SENT"');
}

function isPromo(labels: string): boolean {
  return labels.includes('"CATEGORY_PROMOTIONS"') || labels.includes('"CATEGORY_UPDATES"');
}

function header(s: string) {
  console.log("\n" + "─".repeat(72));
  console.log("  " + s);
  console.log("─".repeat(72));
}

function extractEmail(rawSender: string): string {
  const m = rawSender.match(/<([^>]+)>/);
  return (m ? m[1] : rawSender).trim().toLowerCase();
}

function name(rawSender: string): string {
  const m = rawSender.match(/^(.+?)\s*<.+?>/);
  return m ? m[1].trim().replace(/^"|"$/g, "") : extractEmail(rawSender);
}

// pull all messages, classify as noise or signal once
const all = db.prepare(`
  SELECT id, thread_id, from_addr, to_addr, subject, date_iso, snippet, labels_json
  FROM messages
  WHERE date_iso != ''
  ORDER BY date_iso ASC
`).all() as Msg[];

const signal: Msg[] = [];
for (const m of all) {
  if (isSent(m.labels_json)) {
    signal.push(m);  // always keep your sent
    continue;
  }
  if (isPromo(m.labels_json)) continue;
  if (isNoise(m.from_addr)) continue;
  signal.push(m);
}

const range = db.prepare(
  "SELECT min(date_iso) as oldest, max(date_iso) as newest FROM messages",
).get() as { oldest: string; newest: string };

console.log("═".repeat(72));
console.log("  INTELLIGENCE PASS");
console.log("═".repeat(72));
console.log(`  window: ${range.oldest.slice(0,10)} → ${range.newest.slice(0,10)}`);
console.log(`  total msgs: ${all.length}`);
console.log(`  filtered to signal (humans only): ${signal.length}  (${((signal.length/all.length)*100).toFixed(0)}%)`);
console.log(`  noise filtered out:               ${all.length - signal.length}`);

// ─────────────────────────────────────────────────────────────────────────
// 1. REAL HUMANS — top inbound senders that aren't broadcast
// ─────────────────────────────────────────────────────────────────────────
header("REAL HUMANS who've messaged you (top 15, non-broadcast)");
const senderCounts = new Map<string, { n: number; last: string; latest_subject: string; sample_addr: string }>();
for (const m of signal) {
  if (isSent(m.labels_json)) continue;
  const key = extractEmail(m.from_addr);
  const cur = senderCounts.get(key);
  if (!cur || m.date_iso > cur.last) {
    senderCounts.set(key, {
      n: (cur?.n ?? 0) + 1,
      last: m.date_iso,
      latest_subject: m.subject,
      sample_addr: m.from_addr,
    });
  } else {
    cur.n++;
  }
}
const topHumans = [...senderCounts.entries()]
  .sort((a, b) => b[1].n - a[1].n)
  .slice(0, 15);
for (const [_, v] of topHumans) {
  console.log(`  ${String(v.n).padStart(3)}x  last: ${v.last.slice(0,10)}  ${name(v.sample_addr).slice(0,28).padEnd(28)}  ${v.latest_subject.slice(0, 48)}`);
}

// ─────────────────────────────────────────────────────────────────────────
// 2. YOU SENT — and what happened next
// ─────────────────────────────────────────────────────────────────────────
header("YOU SENT — with reply status");
const sent = signal.filter((m) => isSent(m.labels_json));
const threadById = new Map<string, Msg[]>();
for (const m of all) {
  if (!m.thread_id) continue;
  if (!threadById.has(m.thread_id)) threadById.set(m.thread_id, []);
  threadById.get(m.thread_id)!.push(m);
}

for (const s of sent) {
  const thread = threadById.get(s.thread_id) ?? [];
  thread.sort((a, b) => a.date_iso.localeCompare(b.date_iso));
  const idxOfYours = thread.findIndex((m) => m.id === s.id);
  const after = thread.slice(idxOfYours + 1);
  const repliedFromOther = after.find((m) => !isSent(m.labels_json));
  const userReplyAfter = after.find((m) => isSent(m.labels_json));
  let status: string;
  if (after.length === 0) {
    status = "no reply yet";
  } else if (repliedFromOther && !userReplyAfter) {
    status = `replied (${repliedFromOther.date_iso.slice(0,10)})`;
  } else if (userReplyAfter) {
    status = `you sent more (${userReplyAfter.date_iso.slice(0,10)})`;
  } else {
    status = "?";
  }
  console.log(`  ${s.date_iso.slice(0,10)}  →  ${s.to_addr.slice(0,30).padEnd(30)}  ${s.subject.slice(0,40).padEnd(40)}  [${status}]`);
}

// ─────────────────────────────────────────────────────────────────────────
// 3. YOUR TURN — threads where last word is theirs
// ─────────────────────────────────────────────────────────────────────────
header("YOUR TURN — non-broadcast threads with someone waiting on you");
const yourTurn: Array<{ thread_id: string; last: Msg; thread_len: number }> = [];
for (const [tid, msgs] of threadById) {
  msgs.sort((a, b) => a.date_iso.localeCompare(b.date_iso));
  const last = msgs[msgs.length - 1];
  if (isSent(last.labels_json)) continue;
  if (isPromo(last.labels_json)) continue;
  if (isNoise(last.from_addr)) continue;
  // only show threads where YOU have ever participated (otherwise it's just inbound newsletter-y stuff)
  const hasYourReply = msgs.some((m) => isSent(m.labels_json));
  const recentEnough = msgs.length >= 2 && hasYourReply;
  if (!recentEnough) continue;
  yourTurn.push({ thread_id: tid, last, thread_len: msgs.length });
}
yourTurn.sort((a, b) => b.last.date_iso.localeCompare(a.last.date_iso));
if (yourTurn.length === 0) {
  console.log("  (none in window — either you're caught up or threads-with-you are rare in 21d)");
}
for (const t of yourTurn.slice(0, 20)) {
  const days = Math.floor((Date.now() - new Date(t.last.date_iso).getTime()) / 86400000);
  console.log(`  ${days}d ago  thread=${t.thread_len} msgs  ${name(t.last.from_addr).slice(0,28).padEnd(28)}  ${t.last.subject.slice(0, 44)}`);
}

// ─────────────────────────────────────────────────────────────────────────
// 4. GHOSTED — humans who emailed you and never got a reply
// ─────────────────────────────────────────────────────────────────────────
header("GHOSTED — real humans you never replied to (only 1 msg, no reply, > 3d old)");
const cutoff = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
const ghosted: Msg[] = [];
for (const [tid, msgs] of threadById) {
  if (msgs.length !== 1) continue;
  const m = msgs[0];
  if (isSent(m.labels_json)) continue;
  if (isPromo(m.labels_json)) continue;
  if (isNoise(m.from_addr)) continue;
  if (m.date_iso > cutoff) continue;
  ghosted.push(m);
}
ghosted.sort((a, b) => b.date_iso.localeCompare(a.date_iso));
console.log(`  (${ghosted.length} total — showing 20 most recent)`);
for (const m of ghosted.slice(0, 20)) {
  const days = Math.floor((Date.now() - new Date(m.date_iso).getTime()) / 86400000);
  console.log(`  ${days}d ago  ${name(m.from_addr).slice(0,28).padEnd(28)}  ${m.subject.slice(0, 50)}`);
}

// ─────────────────────────────────────────────────────────────────────────
// 5. RECURRING TOPICS — subject keywords in your signal corpus
// ─────────────────────────────────────────────────────────────────────────
header("ON YOUR MIND — recurring keywords in non-noise subjects");
const stopwords = new Set([
  "re", "fwd", "the", "to", "for", "of", "and", "a", "in", "on", "at", "is", "are",
  "your", "you", "with", "from", "this", "that", "an", "or", "be", "we", "i",
  "it", "as", "by", "but", "if", "so", "no", "not", "do", "have", "has", "was",
  "will", "can", "my", "me", "us", "our",
]);
const wordCount = new Map<string, number>();
for (const m of signal) {
  if (!m.subject) continue;
  const s = m.subject.replace(/^(re|fwd|fw):\s*/i, "");
  const words = s.toLowerCase().split(/[^a-zA-Z]+/).filter(Boolean);
  for (const w of words) {
    if (w.length < 4 || w.length > 20) continue;
    if (stopwords.has(w)) continue;
    wordCount.set(w, (wordCount.get(w) ?? 0) + 1);
  }
}
const topWords = [...wordCount.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 25);
for (const [w, n] of topWords) {
  if (n < 3) break;
  console.log(`  ${String(n).padStart(3)}  ${w}`);
}

console.log("\n" + "═".repeat(72));
db.close();
