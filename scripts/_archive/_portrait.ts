// Pulls deeper signals from the mined sqlite + fetches full bodies of sent
// emails and the few real-human threads, so we can form a profile.
//
// run: npx tsx scripts/_portrait.ts

import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { Composio } from "@composio/core";
import { readFileSync } from "node:fs";

const state = JSON.parse(readFileSync("scripts/.composio-mining.json", "utf8"));
const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY! });
const db = new DatabaseSync("scripts/mining/gmail.sqlite");

function header(s: string) {
  console.log("\n" + "═".repeat(72));
  console.log("  " + s);
  console.log("═".repeat(72));
}

// ────────────────────────────────────────────────────────
// 1. all sent emails — full bodies
// ────────────────────────────────────────────────────────
header("SENT — every email, full body");
const sentMsgs = db.prepare(`
  SELECT id, thread_id, to_addr, subject, date_iso, snippet
  FROM messages
  WHERE labels_json LIKE '%"SENT"%'
  ORDER BY date_iso ASC
`).all() as Array<{ id: string; thread_id: string; to_addr: string; subject: string; date_iso: string; snippet: string }>;

console.log(`  ${sentMsgs.length} sent emails total`);
for (const s of sentMsgs) {
  // fetch full body via composio
  try {
    const r = (await composio.tools.execute("GMAIL_FETCH_MESSAGE_BY_THREAD_ID", {
      userId: state.user_id,
      connectedAccountId: state.connected_account_id,
      dangerouslySkipVersionCheck: true,
      arguments: { thread_id: s.thread_id },
    } as never)) as { data?: { messages?: Array<{ messageId?: string; messageText?: string }> } };
    const msg = r.data?.messages?.find((m) => m.messageId === s.id);
    const body = (msg?.messageText ?? s.snippet).slice(0, 600);
    console.log("\n  " + "─".repeat(60));
    console.log(`  ${s.date_iso}`);
    console.log(`  to:      ${s.to_addr.slice(0, 60)}`);
    console.log(`  subject: ${s.subject}`);
    console.log("  body:");
    for (const line of body.split("\n").slice(0, 10)) {
      console.log("    " + line);
    }
  } catch (e) {
    console.log(`    (fetch failed for ${s.subject}: ${(e as Error).message})`);
  }
}

// ────────────────────────────────────────────────────────
// 2. inbound from non-broadcast humans — names + first-line snippets
// ────────────────────────────────────────────────────────
header("HUMAN INBOUND — every non-broadcast sender, with snippet");
const humanRows = db.prepare(`
  SELECT from_addr, subject, date_iso, snippet, labels_json
  FROM messages
  WHERE labels_json NOT LIKE '%"SENT"%'
    AND labels_json NOT LIKE '%CATEGORY_PROMOTIONS%'
    AND labels_json NOT LIKE '%CATEGORY_UPDATES%'
    AND from_addr NOT LIKE '%noreply%'
    AND from_addr NOT LIKE '%no-reply%'
    AND from_addr NOT LIKE '%notification%'
    AND from_addr NOT LIKE '%news@%'
    AND from_addr NOT LIKE '%newsletter%'
    AND from_addr NOT LIKE '%digest%'
    AND from_addr NOT LIKE '%alerts%'
    AND from_addr NOT LIKE '%@beehiiv%'
    AND from_addr NOT LIKE '%@substack%'
    AND from_addr NOT LIKE '%linkedin%'
  ORDER BY date_iso DESC
`).all() as Array<{ from_addr: string; subject: string; date_iso: string; snippet: string }>;

console.log(`  ${humanRows.length} candidate human messages`);
for (const r of humanRows.slice(0, 40)) {
  console.log(`  ${r.date_iso.slice(0,10)}  ${r.from_addr.slice(0, 40).padEnd(40)}  ${r.subject.slice(0, 45)}`);
  console.log(`    ${r.snippet.slice(0, 100).replace(/\n/g, " ")}`);
}

// ────────────────────────────────────────────────────────
// 3. signup / onboarding mails (welcome / verify / confirm)
// ────────────────────────────────────────────────────────
header("SIGNUP / ACCOUNT — what services you've touched");
const signups = db.prepare(`
  SELECT from_addr, subject, date_iso, snippet
  FROM messages
  WHERE labels_json NOT LIKE '%"SENT"%'
    AND (
      lower(subject) LIKE '%welcome%'
      OR lower(subject) LIKE '%verify%'
      OR lower(subject) LIKE '%confirm%'
      OR lower(subject) LIKE '%sign in%'
      OR lower(subject) LIKE '%signing in%'
      OR lower(subject) LIKE '%magic link%'
      OR lower(subject) LIKE '%activate%'
      OR lower(subject) LIKE '%password%'
    )
  ORDER BY date_iso DESC
`).all() as Array<{ from_addr: string; subject: string; date_iso: string; snippet: string }>;
console.log(`  ${signups.length} signup/auth-style mails`);
const uniqueServices = new Map<string, { count: number; subject: string }>();
for (const r of signups) {
  const m = r.from_addr.match(/@([^>]+)/);
  const domain = m ? m[1].replace(/>$/, "") : r.from_addr;
  const cur = uniqueServices.get(domain);
  if (!cur) uniqueServices.set(domain, { count: 1, subject: r.subject });
  else cur.count++;
}
for (const [domain, info] of [...uniqueServices.entries()].sort((a,b) => b[1].count - a[1].count)) {
  console.log(`  ${String(info.count).padStart(3)}× ${domain.padEnd(40)}  e.g. "${info.subject.slice(0,50)}"`);
}

// ────────────────────────────────────────────────────────
// 4. financial / transactional signals (receipts, payments)
// ────────────────────────────────────────────────────────
header("FINANCIAL / TRANSACTIONAL");
const financial = db.prepare(`
  SELECT from_addr, subject, date_iso, snippet
  FROM messages
  WHERE labels_json NOT LIKE '%"SENT"%'
    AND (
      lower(subject) LIKE '%receipt%'
      OR lower(subject) LIKE '%invoice%'
      OR lower(subject) LIKE '%payment%'
      OR lower(subject) LIKE '%order%'
      OR lower(subject) LIKE '%booking%'
      OR lower(subject) LIKE '%confirmation%'
      OR lower(subject) LIKE '%subscription%'
      OR lower(subject) LIKE '%charged%'
      OR lower(subject) LIKE '%paid%'
      OR lower(subject) LIKE '%transaction%'
    )
  ORDER BY date_iso DESC
  LIMIT 30
`).all() as Array<{ from_addr: string; subject: string; date_iso: string; snippet: string }>;
for (const r of financial) {
  console.log(`  ${r.date_iso.slice(0,10)}  ${r.from_addr.slice(0,40).padEnd(40)}  ${r.subject.slice(0, 55)}`);
}

// ────────────────────────────────────────────────────────
// 5. job / career / education signals
// ────────────────────────────────────────────────────────
header("CAREER / EDUCATION");
const career = db.prepare(`
  SELECT from_addr, subject, date_iso, snippet
  FROM messages
  WHERE labels_json NOT LIKE '%"SENT"%'
    AND (
      lower(subject) LIKE '%application%'
      OR lower(subject) LIKE '%intern%'
      OR lower(subject) LIKE '%offer%'
      OR lower(subject) LIKE '%interview%'
      OR lower(subject) LIKE '%candidate%'
      OR lower(subject) LIKE '%resume%'
      OR lower(subject) LIKE '%opportunity%'
      OR lower(subject) LIKE '%recruit%'
      OR lower(subject) LIKE '%job%'
      OR lower(subject) LIKE '%course%'
    )
  ORDER BY date_iso DESC
  LIMIT 30
`).all() as Array<{ from_addr: string; subject: string; date_iso: string; snippet: string }>;
for (const r of career) {
  console.log(`  ${r.date_iso.slice(0,10)}  ${r.from_addr.slice(0,40).padEnd(40)}  ${r.subject.slice(0, 55)}`);
}

// ────────────────────────────────────────────────────────
// 6. travel signals
// ────────────────────────────────────────────────────────
header("TRAVEL");
const travel = db.prepare(`
  SELECT from_addr, subject, date_iso, snippet
  FROM messages
  WHERE labels_json NOT LIKE '%"SENT"%'
    AND (
      lower(subject) LIKE '%flight%'
      OR lower(subject) LIKE '%booking%'
      OR lower(subject) LIKE '%itinerary%'
      OR lower(subject) LIKE '%hotel%'
      OR lower(subject) LIKE '%airbnb%'
      OR lower(subject) LIKE '%check-in%'
      OR lower(subject) LIKE '%boarding%'
      OR lower(subject) LIKE '%uber%'
      OR lower(subject) LIKE '%lyft%'
      OR lower(subject) LIKE '%trip%'
      OR lower(subject) LIKE '%departure%'
    )
  ORDER BY date_iso DESC
  LIMIT 30
`).all() as Array<{ from_addr: string; subject: string; date_iso: string; snippet: string }>;
console.log(`  ${travel.length} candidates`);
for (const r of travel.slice(0, 15)) {
  console.log(`  ${r.date_iso.slice(0,10)}  ${r.from_addr.slice(0,40).padEnd(40)}  ${r.subject.slice(0, 55)}`);
}

// ────────────────────────────────────────────────────────
// 7. social / event invites (luma, partiful, eventbrite)
// ────────────────────────────────────────────────────────
header("EVENTS / SOCIAL");
const events = db.prepare(`
  SELECT from_addr, subject, date_iso, snippet
  FROM messages
  WHERE labels_json NOT LIKE '%"SENT"%'
    AND (
      from_addr LIKE '%luma%'
      OR from_addr LIKE '%partiful%'
      OR from_addr LIKE '%eventbrite%'
      OR from_addr LIKE '%meetup%'
      OR lower(subject) LIKE '%invitation%'
      OR lower(subject) LIKE '%rsvp%'
      OR lower(subject) LIKE '%you''re invited%'
      OR lower(subject) LIKE '%event %'
    )
  ORDER BY date_iso DESC
  LIMIT 20
`).all() as Array<{ from_addr: string; subject: string; date_iso: string; snippet: string }>;
for (const r of events) {
  console.log(`  ${r.date_iso.slice(0,10)}  ${r.from_addr.slice(0,40).padEnd(40)}  ${r.subject.slice(0, 50)}`);
}

// ────────────────────────────────────────────────────────
// 8. all unique people-domains (not auto)
// ────────────────────────────────────────────────────────
header("UNIQUE PEOPLE DOMAINS (potential individuals)");
const personalDomains = db.prepare(`
  SELECT
    substr(from_addr, instr(from_addr,'@')+1) as raw,
    count(*) as n
  FROM messages
  WHERE instr(from_addr,'@') > 0
    AND labels_json NOT LIKE '%"SENT"%'
  GROUP BY raw
  ORDER BY n DESC
`).all() as Array<{ raw: string; n: number }>;
let shown = 0;
for (const r of personalDomains) {
  const d = r.raw.replace(/>$/, "");
  // skip obvious automation
  if (/(beehiiv|substack|mailgun|sendgrid|noreply|notify|info\.|newsletter|digest|recruitiee|hubspot|sib\d+|mailchimp|mailerlite|amazonses|sparkpostmail|mailtrap|mandrill|postmarkapp|sendinblue)/.test(d)) continue;
  if (/^(gmail|hotmail|yahoo|outlook|icloud|protonmail)\.com$/.test(d)) {
    console.log(`  ${String(r.n).padStart(3)}× ${d} (personal mail provider — multiple individuals)`);
    continue;
  }
  console.log(`  ${String(r.n).padStart(3)}× ${d}`);
  shown++;
  if (shown >= 40) break;
}

db.close();
