// scripts/subscriptions-track.ts
//
// builds a subscription tracker from the mined gmail metadata alone.
// no manual list of vendors — derived entirely from email patterns.
//
// signal types per vendor:
//   - welcome / signup        → "you have an account"
//   - receipt / invoice       → "you paid them recently"
//   - renewal reminder        → "they will charge you on date X"
//   - payment failed          → "the card didn't work"
//   - subscription paused     → "they cut you off"
//   - cancellation            → "you stopped"
//
// status is computed by precedence:
//   cancelled > paused > failed > active > trial(welcome only)
//
// writes: scripts/mining/subscriptions.json
// prints: markdown-style dashboard

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = "scripts/mining/gmail.sqlite";
const OUT_PATH = "scripts/mining/subscriptions.json";

interface Msg {
  id: string;
  from_addr: string;
  subject: string;
  date_iso: string;
  snippet: string;
  labels_json: string;
}

const db = new DatabaseSync(DB_PATH);
const all = db
  .prepare(
    `SELECT id, from_addr, subject, date_iso, snippet, labels_json FROM messages WHERE date_iso != '' ORDER BY date_iso ASC`,
  )
  .all() as Msg[];

// ─────────────────────────────────────────────────────────
// vendor canonicalization
// maps domain → canonical name. unknowns fall back to the
// second-level domain.
// ─────────────────────────────────────────────────────────
const KNOWN_VENDORS: Record<string, { name: string; category: string }> = {
  "claude.com": { name: "Anthropic / Claude", category: "AI/SaaS" },
  "anthropic.com": { name: "Anthropic / Claude", category: "AI/SaaS" },
  "mail.anthropic.com": { name: "Anthropic / Claude", category: "AI/SaaS" },
  "openai.com": { name: "OpenAI", category: "AI/SaaS" },
  "mem0.io": { name: "Mem0", category: "AI/SaaS" },
  "wispr.ai": { name: "Wispr Flow", category: "AI/SaaS" },
  "cloudinary.com": { name: "Cloudinary", category: "Infra" },
  "twilio.com": { name: "Twilio", category: "Infra" },
  "railway.app": { name: "Railway", category: "Infra" },
  "notify.railway.app": { name: "Railway", category: "Infra" },
  "vercel.com": { name: "Vercel", category: "Infra" },
  "figma.com": { name: "Figma", category: "SaaS" },
  "support+notifications@figma.com": { name: "Figma", category: "SaaS" },
  "todoist.com": { name: "Todoist", category: "SaaS" },
  "taskade.com": { name: "Taskade", category: "SaaS" },
  "linqapp.com": { name: "Linq", category: "Infra" },
  "google.com": { name: "Google Workspace", category: "SaaS" },
  "workspace-noreply@google.com": { name: "Google Workspace", category: "SaaS" },
  "payments-noreply@google.com": { name: "Google Workspace", category: "SaaS" },
  "github.com": { name: "GitHub", category: "Dev" },
  "notifications@github.com": { name: "GitHub", category: "Dev" },
  "coursera.org": { name: "Coursera", category: "Education" },
  "t.mail.coursera.org": { name: "Coursera", category: "Education" },
  "codecrafters.io": { name: "CodeCrafters", category: "Education" },
  "mail.codecrafters.io": { name: "CodeCrafters", category: "Education" },
  "mygreatlearning.com": { name: "Great Learning", category: "Education" },
  "learn.mygreatlearning.com": { name: "Great Learning", category: "Education" },
  "courses.codingninjas.com": { name: "Coding Ninjas", category: "Education" },
  "careercamp.codingninjas.com": { name: "Coding Ninjas", category: "Education" },
  "alerts@courses.codingninjas.com": { name: "Coding Ninjas", category: "Education" },
  "educative.io": { name: "Educative", category: "Education" },
  "itr.mail.codecademy.com": { name: "Codecademy", category: "Education" },
  "circles.life": { name: "Circles.Life (SG telecom)", category: "Telecom" },
  "happiness@circles.life": { name: "Circles.Life (SG telecom)", category: "Telecom" },
  "trustbank.sg": { name: "Trust Bank Singapore", category: "Banking" },
  "from_us@trustbank.sg": { name: "Trust Bank Singapore", category: "Banking" },
  "dbs.com": { name: "DBS Bank", category: "Banking" },
  "emktg@dbs.com": { name: "DBS Bank", category: "Banking" },
  "paypal.com.sg": { name: "PayPal SG", category: "Banking" },
  "service@paypal.com.sg": { name: "PayPal SG", category: "Banking" },
  "icicibank.com": { name: "ICICI Bank", category: "Banking" },
  "services@custcomm.icicibank.com": { name: "ICICI Bank", category: "Banking" },
  "services.icicisecurities.com": { name: "ICICI Securities", category: "Investing" },
  "info@services.icicisecurities.com": { name: "ICICI Securities", category: "Investing" },
  "qmailer.zerodha.com": { name: "Zerodha", category: "Investing" },
  "noreply-coin@qmailer.zerodha.com": { name: "Zerodha", category: "Investing" },
  "motilaloswal.com": { name: "Motilal Oswal", category: "Investing" },
  "vestedfinance.com": { name: "Vested Finance", category: "Investing" },
  "email.vestedfinance.com": { name: "Vested Finance", category: "Investing" },
  "uber.com": { name: "Uber", category: "Transport" },
  "grab.com": { name: "Grab", category: "Transport" },
  "foodpanda.sg": { name: "Foodpanda", category: "Food" },
  "mail.foodpanda.sg": { name: "Foodpanda", category: "Food" },
  "no-reply@foodpanda.sg": { name: "Foodpanda", category: "Food" },
  "info@mail.foodpanda.sg": { name: "Foodpanda", category: "Food" },
  "kuisine": { name: "Kuisine Koncepts (SG)", category: "Food" },
  "mail.eber.io": { name: "Kuisine Koncepts (SG)", category: "Food" },
  "carousell.com": { name: "Carousell (SG marketplace)", category: "Marketplace" },
  "thecarousell.com": { name: "Carousell (SG marketplace)", category: "Marketplace" },
  "propertyguru.com.sg": { name: "PropertyGuru (SG)", category: "Real estate" },
  "e.propertyguru.com.sg": { name: "PropertyGuru (SG)", category: "Real estate" },
  "luma.com": { name: "Luma", category: "Events" },
  "user.luma-mail.com": { name: "Luma", category: "Events" },
  "nytimes.com": { name: "New York Times", category: "Media" },
  "e.newyorktimes.com": { name: "New York Times", category: "Media" },
  "thedeepview.co": { name: "The Deep View", category: "Newsletter" },
  "the-ken.com": { name: "The Ken", category: "Newsletter" },
  "info@the-ken.com": { name: "The Ken", category: "Newsletter" },
  "thehindu.hindugroup.org.in": { name: "The Hindu", category: "Newsletter" },
  "morningbrew.com": { name: "Morning Brew", category: "Newsletter" },
  "economictimesnews.com": { name: "Economic Times", category: "Newsletter" },
  "mail.beehiiv.com": { name: "Beehiiv (newsletters)", category: "Newsletter" },
  "substack.com": { name: "Substack (newsletters)", category: "Newsletter" },
  "notification.insightfultraits.com": { name: "InsightfulTraits", category: "SaaS" },
  "admin@notification.insightfultraits.com": { name: "InsightfulTraits", category: "SaaS" },
  "ycombinator.com": { name: "Y Combinator (WAAS)", category: "Job platform" },
  "bandana.com": { name: "Bandana", category: "Job platform" },
  "kat@bandana.com": { name: "Bandana", category: "Job platform" },
  "internsg.com": { name: "InternSG", category: "Job platform" },
  "submission1@internsg.com": { name: "InternSG", category: "Job platform" },
  "apexearlycareers.com": { name: "SCALIS Early Careers", category: "Job platform" },
  "internships@apexearlycareers.com": { name: "SCALIS Early Careers", category: "Job platform" },
  "recruiting.aumovio.com": { name: "Aumovio (recruiting)", category: "Job platform" },
  "notification@recruiting.aumovio.com": { name: "Aumovio (recruiting)", category: "Job platform" },
  "indeed.com": { name: "Indeed", category: "Job platform" },
  "match.indeed.com": { name: "Indeed", category: "Job platform" },
  "bendingspoons.com": { name: "Bending Spoons (recruiter)", category: "Job platform" },
  "no-reply@bendingspoons.com": { name: "Bending Spoons (recruiter)", category: "Job platform" },
  "cal.com": { name: "Cal.com", category: "SaaS" },
  "hello@cal.com": { name: "Cal.com", category: "SaaS" },
  "sib": { name: "Sendinblue (transactional)", category: "Infra" },
  "freeletics.com": { name: "Freeletics", category: "Fitness" },
  "updates.freeletics.com": { name: "Freeletics", category: "Fitness" },
};

function extractDomain(rawFrom: string): string {
  const m = rawFrom.match(/<([^>]+)>/);
  const addr = (m ? m[1] : rawFrom).trim().toLowerCase();
  if (!addr.includes("@")) return rawFrom.toLowerCase();
  return addr.split("@")[1]!.replace(/>$/, "").trim();
}

function canonicalize(rawFrom: string): { name: string; category: string } {
  const d = extractDomain(rawFrom);
  if (KNOWN_VENDORS[d]) return KNOWN_VENDORS[d];
  // try second-level domain
  const parts = d.split(".");
  const sld = parts.length >= 2 ? parts.slice(-2).join(".") : d;
  if (KNOWN_VENDORS[sld]) return KNOWN_VENDORS[sld];
  // unknown — title-case the second-level
  return { name: sld.split(".")[0].replace(/^./, (c) => c.toUpperCase()), category: "Other" };
}

// ─────────────────────────────────────────────────────────
// signal classifiers
// ─────────────────────────────────────────────────────────

// every pattern is matched against the SUBJECT only — snippets are too noisy
// (they leak third-party content like "I cancelled my $200 plan" in a reddit
// digest, which made earlier passes fire false cancellations).
const PATTERNS = {
  welcome: /\b(welcome to|signing up|sign up|account.*(created|activated)|get(ting)? started|activate your|magic link|confirmation code)\b/i,
  receipt: /\b(receipt|invoice (available|is ready)|order (placed|confirmation)|thank you for (your )?(order|payment|purchase)|payment (received|successful)|here's your (order|receipt)|automatic payment.*(sent|paid))\b/i,
  renewal: /\b(renews? (in|on)|renewal (reminder|on)|upcoming (invoice|renewal|charge)|will (be )?renew|next (billing|charge|payment)|auto.?renew)\b/i,
  failed: /\b(payment (failed|unsuccessful|declined|couldn'?t|didn'?t|issue)|update.*billing|update.*payment method|transaction declined|reactivate.*(billing|workspace|account)|your products are at risk|payment (for your|wasn'?t))\b/i,
  cancelled: /\b(your (plan|subscription|recurring payment|order|membership) (will be |has been )?cancel(l?ed)?|cancellation (notification|confirmation)|we'?ve cancel|unsubscribed from)\b/i,
  paused: /\b(subscription access.*(paused|suspended)|access has been (paused|suspended)|(account|subscription) (has been )?(paused|suspended)|temporarily paused|on hold)\b/i,
};

interface Signal {
  type: keyof typeof PATTERNS;
  date: string;
  subject: string;
}

interface VendorRecord {
  name: string;
  category: string;
  domain: string;
  signals: Signal[];
  amounts: Array<{ amount: string; currency: string; date: string; from: string }>;
  renewal_dates: string[];
  first_seen: string;
  last_seen: string;
  message_count: number;
  example_subjects: string[];
}

// extract money strings from snippet+subject. handles $X.YZ, ₹X, S$X, USD X, INR X, etc.
function extractMoney(text: string): Array<{ amount: string; currency: string }> {
  const matches: Array<{ amount: string; currency: string }> = [];
  // patterns: $23.60, S$12, ₹450, USD 5, INR 99
  const re = /(?:(USD|INR|SGD|EUR|GBP)\s*)?([₹$€£]|S\$|Rs\.?)\s?(\d{1,3}(?:[,.]\d{3})*(?:\.\d{1,2})?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const sym = m[2];
    let currency = m[1] ?? "";
    if (!currency) {
      if (sym === "₹" || sym === "Rs" || sym === "Rs.") currency = "INR";
      else if (sym === "S$") currency = "SGD";
      else if (sym === "$") currency = "USD";
      else if (sym === "€") currency = "EUR";
      else if (sym === "£") currency = "GBP";
    }
    matches.push({ amount: m[3], currency });
  }
  return matches;
}

const vendors = new Map<string, VendorRecord>();

for (const msg of all) {
  if (msg.labels_json.includes('"SENT"')) continue;
  // gate: must mention something subscription-related in the SUBJECT.
  // this single check eliminates most false positives (newsletter content
  // that quotes payment language, breaking-news subjects, etc.)
  const subj = msg.subject ?? "";
  const subjectGate = /\b(subscription|invoice|receipt|payment|billing|charged|renew|cancel|paused|suspended|activate|welcome|confirm|order|plan|membership|verify|trial|reactivate|auto.?renew)\b/i;
  if (!subjectGate.test(subj)) continue;

  const found: Signal[] = [];
  for (const [type, pat] of Object.entries(PATTERNS)) {
    if (pat.test(subj)) {
      found.push({ type: type as keyof typeof PATTERNS, date: msg.date_iso, subject: msg.subject });
    }
  }
  if (found.length === 0) continue;

  const { name, category } = canonicalize(msg.from_addr);
  const domain = extractDomain(msg.from_addr);
  const key = `${name}::${category}`;
  if (!vendors.has(key)) {
    vendors.set(key, {
      name,
      category,
      domain,
      signals: [],
      amounts: [],
      renewal_dates: [],
      first_seen: msg.date_iso,
      last_seen: msg.date_iso,
      message_count: 0,
      example_subjects: [],
    });
  }
  const v = vendors.get(key)!;
  v.signals.push(...found);
  v.message_count++;
  if (msg.date_iso < v.first_seen) v.first_seen = msg.date_iso;
  if (msg.date_iso > v.last_seen) v.last_seen = msg.date_iso;
  if (v.example_subjects.length < 4) v.example_subjects.push(msg.subject);
  const moneyHits = extractMoney(msg.subject + " " + msg.snippet);
  for (const mh of moneyHits) {
    v.amounts.push({ ...mh, date: msg.date_iso, from: msg.subject.slice(0, 50) });
  }
}

// determine status per vendor by signal precedence
type Status = "cancelled" | "paused" | "failed" | "active" | "trial" | "unknown";

function deriveStatus(v: VendorRecord): { status: Status; reason: string } {
  const types = new Set(v.signals.map((s) => s.type));
  // find the latest signal of each type
  const latestByType = new Map<string, Signal>();
  for (const s of v.signals) {
    const cur = latestByType.get(s.type);
    if (!cur || s.date > cur.date) latestByType.set(s.type, s);
  }
  const cancelled = latestByType.get("cancelled");
  const paused = latestByType.get("paused");
  const failed = latestByType.get("failed");
  const receipt = latestByType.get("receipt");
  const renewal = latestByType.get("renewal");
  const welcome = latestByType.get("welcome");

  // recent payment receipt after a failed event = recovered
  if (cancelled && (!receipt || cancelled.date > receipt.date)) {
    return { status: "cancelled", reason: cancelled.subject };
  }
  if (paused && (!receipt || paused.date > receipt.date)) {
    return { status: "paused", reason: paused.subject };
  }
  if (failed && (!receipt || failed.date > receipt.date)) {
    return { status: "failed", reason: failed.subject };
  }
  if (receipt || renewal) {
    return {
      status: "active",
      reason: (receipt ?? renewal)!.subject,
    };
  }
  if (welcome) return { status: "trial", reason: welcome.subject };
  return { status: "unknown", reason: "" };
}

const result: Array<VendorRecord & { status: Status; reason: string }> = [];
for (const v of vendors.values()) {
  const { status, reason } = deriveStatus(v);
  result.push({ ...v, status, reason });
}

// rank: failures and paused first, then active by recency, then trials, then everything else
const STATUS_ORDER: Record<Status, number> = {
  paused: 0,
  failed: 1,
  cancelled: 2,
  active: 3,
  trial: 4,
  unknown: 5,
};
result.sort((a, b) => {
  if (STATUS_ORDER[a.status] !== STATUS_ORDER[b.status])
    return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  return b.last_seen.localeCompare(a.last_seen);
});

// write json
mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(result, null, 2));

// print dashboard
const range = db
  .prepare("SELECT min(date_iso) as o, max(date_iso) as n FROM messages")
  .get() as { o: string; n: string };
console.log("═".repeat(72));
console.log("  SUBSCRIPTION TRACKER (from gmail alone)");
console.log("═".repeat(72));
console.log(`  window:   ${range.o.slice(0, 10)}  →  ${range.n.slice(0, 10)}`);
console.log(`  vendors:  ${result.length}`);
console.log(`  by status:`);
const byStatus = new Map<Status, number>();
for (const r of result) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
for (const [s, n] of [...byStatus.entries()].sort((a, b) => STATUS_ORDER[a[0]] - STATUS_ORDER[b[0]])) {
  console.log(`    ${s.padEnd(10)} ${n}`);
}

function statusEmoji(s: Status): string {
  return {
    paused: "⏸ ",
    failed: "✗ ",
    cancelled: "⊘ ",
    active: "✓ ",
    trial: "○ ",
    unknown: "? ",
  }[s];
}

// group by category
const byCat = new Map<string, typeof result>();
for (const r of result) {
  if (!byCat.has(r.category)) byCat.set(r.category, []);
  byCat.get(r.category)!.push(r);
}
const catOrder = [
  "AI/SaaS", "SaaS", "Infra", "Dev", "Education",
  "Banking", "Investing", "Telecom", "Transport", "Food",
  "Real estate", "Marketplace", "Events", "Job platform",
  "Media", "Newsletter", "Fitness", "Other",
];
for (const cat of catOrder) {
  const rows = byCat.get(cat);
  if (!rows || rows.length === 0) continue;
  console.log("\n" + "─".repeat(72));
  console.log("  " + cat.toUpperCase());
  console.log("─".repeat(72));
  for (const r of rows) {
    // pick the most recent amount, if any
    const amounts = r.amounts.sort((a, b) => b.date.localeCompare(a.date));
    const amt = amounts[0] ? `${amounts[0].currency || "?"} ${amounts[0].amount}` : "—";
    const last = r.last_seen.slice(0, 10);
    const stEmoji = statusEmoji(r.status);
    console.log(
      `  ${stEmoji}${r.status.padEnd(9)}  last:${last}  ${amt.padEnd(10)}  ${r.name.slice(0, 30).padEnd(30)}  ${r.message_count}× msgs`,
    );
    if (r.reason && (r.status === "failed" || r.status === "paused" || r.status === "cancelled")) {
      console.log(`              ↳ ${r.reason.slice(0, 70)}`);
    }
  }
}

console.log("\n" + "═".repeat(72));
console.log(`  wrote: ${OUT_PATH}`);
db.close();
