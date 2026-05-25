// compliance audit. catches drift between the codebase and what we promise
// users in our legal docs + delete/export endpoints.
//
// runs in CI on every PR (fails the build on any failure) and can be run
// locally: `npm run audit-compliance`.
//
// six checks:
//   1. every user-keyed table either has FK cascade OR is explicitly deleted
//      in account.ts. orphan data on delete is the worst compliance failure.
//   2. every user-keyed table is in the data export. exports that omit data
//      we hold are a GDPR Art. 15/20 violation.
//   3. every secret-shaped env var has a matching sub-processor disclosure.
//      undisclosed vendors are the second-worst compliance failure.
//   4. DONNA_ENCRYPTION_KEY is set and round-trips encrypt/decrypt cleanly.
//      a broken key means every previously-encrypted secret is dead.
//   5. legal docs (privacy, terms, sub-processors, limited-use-policy) exist
//      and carry a "last updated" date in the right shape.
//   6. ledger retention is healthy — oldest file is younger than 90 days.
//
// the script is intentionally text-parsing (regex) rather than reflecting on
// imported TS modules — it works without a db, without env (mostly), and
// without compiling. cheap to run, easy to read.
//
// when a check produces results that look wrong, fix the codebase (correct
// answer) rather than weakening the check. that's the whole point.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const SCHEMA_PATH = join(ROOT, "src/donna/db/schema.ts");
const ACCOUNT_PATH = join(ROOT, "src/donna/ingress/account.ts");
const ENV_EXAMPLE_PATH = join(ROOT, ".env.example");
const SUBPROCESSORS_PATH = join(ROOT, "docs/subprocessors.html");
const LEDGER_DIR = process.env.DONNA_LEDGER_DIR ?? join(ROOT, ".donna/ledger");

const LEGAL_DOCS = [
  "docs/privacy.html",
  "docs/terms.html",
  "docs/subprocessors.html",
  "docs/limited-use-policy.html",
];

// secret-shaped env var names. used in check 3.
const SECRET_VAR_RE = /^([A-Z][A-Z0-9_]*?(?:KEY|TOKEN|SECRET|PASSPHRASE|PASSWORD|CREDENTIAL))(?:=|$)/m;

// env vars that look secret but aren't a vendor relationship (our own
// internal secrets). these don't need sub-processor entries.
const SECRET_VAR_INTERNAL = new Set([
  "DONNA_ENCRYPTION_KEY",
  "DONNA_BROWSER_TOKEN",
  "WHATSAPP_VERIFY_TOKEN",  // we set it; meta echoes it back
  "WHATSAPP_APP_SECRET",     // for verifying meta's webhook signature
]);

// known sub-processor name → env var prefix(es) we accept as evidence the
// vendor is wired. used to map "this env var corresponds to that vendor."
// when we add a new sub-processor, also add a row here (the same edit, easy
// to remember).
const SECRET_PREFIX_TO_VENDOR: Record<string, string> = {
  ANTHROPIC: "Anthropic",
  CLERK: "Clerk",
  DATABASE_URL: "Supabase",
  SUPABASE: "Supabase",
  LIVEKIT: "LiveKit",
  DEEPGRAM: "Deepgram",
  ELEVENLABS: "ElevenLabs",
  CARTESIA: "Cartesia",
  MODAL: "Modal",
  SESAME: "Modal",  // sesame csm runs on modal
  APNS: "Apple",
  WHATSAPP: "Meta",
  META: "Meta",
  CLOUDFLARE: "Cloudflare",
  LANGSMITH: "LangSmith",
  KLAVIS: "Klavis",
  COMPOSIO: "Composio",
  PIPEDREAM: "Pipedream",
  APIFY: "Apify",
  AWS: "AWS",
  GOOGLE: "Google",
  NOTION: "Notion",
  SPOTIFY: "Spotify",
};

// ─── results plumbing ─────────────────────────────────────────────────────

type Severity = "pass" | "warn" | "fail";

interface Result {
  check: string;
  severity: Severity;
  message: string;
}

const results: Result[] = [];

function pass(check: string, message: string): void {
  results.push({ check, severity: "pass", message });
}
function warn(check: string, message: string): void {
  results.push({ check, severity: "warn", message });
}
function fail(check: string, message: string): void {
  results.push({ check, severity: "fail", message });
}

// ─── parsing helpers ──────────────────────────────────────────────────────

// extract every `export const FOO = pgTable("foo_name", { ... })` block.
// returns { constName, dbName, body } for each table.
interface TableDef {
  constName: string;
  dbName: string;
  body: string;
  hasUserId: boolean;
  hasUsersFkCascade: boolean;
}

function parseSchema(): TableDef[] {
  const src = readFileSync(SCHEMA_PATH, "utf-8");
  const tables: TableDef[] = [];
  // greedy match of every export const X = pgTable("name", { ... }, [...]);
  // we cheat by splitting on `export const ` and finding pgTable blocks.
  const blocks = src.split(/export const /g).slice(1);
  for (const block of blocks) {
    const sigMatch = block.match(/^(\w+)\s*=\s*pgTable\(\s*"([^"]+)"/);
    if (!sigMatch) continue;
    const constName = sigMatch[1]!;
    const dbName = sigMatch[2]!;
    // find this table's end — first `]);` that comes after a `(table) =>` or
    // failing that, the first `});`. messy but works for the current shape.
    const endIdx = block.search(/\n\}\);|\n\]\);/);
    const body = endIdx > 0 ? block.slice(0, endIdx) : block;
    tables.push({
      constName,
      dbName,
      body,
      hasUserId: /\buserId:\s*uuid\("user_id"\)/.test(body),
      hasUsersFkCascade:
        /foreignColumns:\s*\[users\.id\]/.test(body) &&
        /\.onDelete\(\s*"cascade"\s*\)/.test(body),
    });
  }
  return tables;
}

// extract everything inside account.ts that looks like an explicit delete.
function parseAccountDeletes(): { explicit: Set<string>; cascade: Set<string>; exports: Set<string> } {
  const src = readFileSync(ACCOUNT_PATH, "utf-8");
  const explicit = new Set<string>();
  const cascade = new Set<string>();
  const exports = new Set<string>();

  // `db.delete(tableName)` — the actual delete calls
  for (const m of src.matchAll(/db\.delete\((\w+)\)/g)) {
    explicit.add(m[1]!);
  }
  // the response cascade list — a string array of DB names that we
  // documented as deleted via cascade in the response payload
  const cascadeMatch = src.match(/cascade:\s*\[([^\]]+)\]/);
  if (cascadeMatch) {
    for (const m of cascadeMatch[1]!.matchAll(/"([^"]+)"/g)) {
      cascade.add(m[1]!);
    }
  }
  // export: every `from(tableConst)` inside the /me/export handler.
  // we look for any `.from(X)` since the export uses Promise.all.
  // narrow to the export handler block.
  const exportBlock = src.match(/account\.get\(\s*"\/me\/export"[\s\S]*?\}\);\n/);
  if (exportBlock) {
    for (const m of exportBlock[0].matchAll(/\.from\((\w+)\)/g)) {
      exports.add(m[1]!);
    }
  }

  return { explicit, cascade, exports };
}

function parseEnvExample(): string[] {
  const src = readFileSync(ENV_EXAMPLE_PATH, "utf-8");
  const vars: string[] = [];
  for (const line of src.split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)\s*=/);
    if (!m) continue;
    if (!SECRET_VAR_RE.test(m[1]!) && !["DATABASE_URL"].includes(m[1]!)) continue;
    vars.push(m[1]!);
  }
  return vars;
}

function parseSubprocessorsHtml(): string {
  try {
    return readFileSync(SUBPROCESSORS_PATH, "utf-8");
  } catch {
    return "";
  }
}

// ─── checks ───────────────────────────────────────────────────────────────

function check1_tableCleanup(): void {
  const tables = parseSchema();
  const { explicit, cascade } = parseAccountDeletes();

  const userKeyed = tables.filter((t) => t.hasUserId);

  for (const t of userKeyed) {
    if (t.hasUsersFkCascade) {
      pass("1. cleanup", `${t.dbName} — FK cascade from users`);
    } else if (explicit.has(t.constName)) {
      pass("1. cleanup", `${t.dbName} — explicit delete in account.ts`);
    } else if (cascade.has(t.dbName)) {
      // listed in the response cascade array even though no FK declared in
      // schema — likely declared in raw SQL migration. accept but warn so
      // drift to the schema gets flagged.
      warn("1. cleanup", `${t.dbName} — claimed as FK cascade in account.ts but no FK in schema.ts (verify migration)`);
    } else {
      fail("1. cleanup", `${t.dbName} — user-keyed but NO FK cascade AND NOT explicitly deleted. account-delete leaves orphan rows.`);
    }
  }

  // users table itself
  pass("1. cleanup", "users — cascade root");
}

function check2_exportCoverage(): void {
  const tables = parseSchema();
  const { exports } = parseAccountDeletes();

  // every user-keyed table (and the users table itself) should be in the
  // export. tables that are user-keyed via phone (inbound_messages) are
  // intentionally excluded — those are surface-level webhook payloads, not
  // donna-mediated user data.
  const expectShouldBeExported = tables.filter((t) => t.hasUserId || t.constName === "users");

  for (const t of expectShouldBeExported) {
    if (exports.has(t.constName)) {
      pass("2. export", `${t.dbName} — in export`);
    } else {
      fail("2. export", `${t.dbName} — user data exists but NOT in /me/export. GDPR Art. 15/20 violation.`);
    }
  }
}

function check3_subprocessorDisclosure(): void {
  const envVars = parseEnvExample();
  const html = parseSubprocessorsHtml();
  if (!html) {
    fail("3. subprocessors", "docs/subprocessors.html missing");
    return;
  }

  for (const v of envVars) {
    if (SECRET_VAR_INTERNAL.has(v)) {
      pass("3. subprocessors", `${v} — internal secret (no vendor)`);
      continue;
    }
    // find the vendor prefix this env belongs to
    const prefix = Object.keys(SECRET_PREFIX_TO_VENDOR).find((p) => v.startsWith(p));
    if (!prefix) {
      warn("3. subprocessors", `${v} — no known vendor prefix; add to SECRET_PREFIX_TO_VENDOR if it's a sub-processor`);
      continue;
    }
    const vendor = SECRET_PREFIX_TO_VENDOR[prefix]!;
    // case-insensitive substring search in the html
    if (html.toLowerCase().includes(vendor.toLowerCase())) {
      pass("3. subprocessors", `${v} → ${vendor} — listed`);
    } else {
      fail("3. subprocessors", `${v} → ${vendor} — env var present but vendor NOT listed in docs/subprocessors.html`);
    }
  }
}

async function check4_encryptionKey(): Promise<void> {
  if (!process.env.DONNA_ENCRYPTION_KEY) {
    warn("4. crypto", "DONNA_ENCRYPTION_KEY not set in this environment (ok locally if you don't need to encrypt; required in prod)");
    return;
  }
  try {
    const { encrypt, decrypt } = await import("../src/donna/crypto.js");
    const plain = "audit-fixture-" + Date.now();
    const ct = encrypt(plain);
    const rt = decrypt(ct);
    if (rt !== plain) {
      fail("4. crypto", "encrypt/decrypt round-trip mismatch — key may be wrong or library broken");
    } else {
      pass("4. crypto", "encrypt/decrypt round-trips cleanly");
    }
  } catch (err) {
    fail("4. crypto", `crypto util failed: ${(err as Error).message}`);
  }
}

function check5_legalDocs(): void {
  for (const path of LEGAL_DOCS) {
    try {
      const src = readFileSync(join(ROOT, path), "utf-8");
      // we expect "Last updated" with an ISO date in the doc somewhere.
      const dateMatch = src.match(/last[\s-]*updated[^0-9]*(\d{4}-\d{2}-\d{2})/i);
      if (dateMatch) {
        pass("5. docs", `${path} (last updated ${dateMatch[1]})`);
      } else {
        warn("5. docs", `${path} exists but no "Last updated <ISO date>" found`);
      }
    } catch {
      fail("5. docs", `${path} missing`);
    }
  }
}

function check6_ledgerRetention(): void {
  let files: string[];
  try {
    files = readdirSync(LEDGER_DIR).filter((f) => f.endsWith(".jsonl"));
  } catch {
    pass("6. retention", `ledger dir ${LEDGER_DIR} does not exist yet (no data to age out)`);
    return;
  }
  if (files.length === 0) {
    pass("6. retention", "no ledger files present");
    return;
  }
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const old = files.filter((f) => statSync(join(LEDGER_DIR, f)).mtimeMs < cutoff);
  if (old.length === 0) {
    pass("6. retention", `${files.length} ledger file(s) present, none older than 90 days`);
  } else {
    fail("6. retention", `${old.length} ledger file(s) older than 90 days — retention cron not running. run: npm run prune-ledger`);
  }
}

// ─── orchestrator ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`donna compliance audit · ${today}\n`);

  check1_tableCleanup();
  check2_exportCoverage();
  check3_subprocessorDisclosure();
  await check4_encryptionKey();
  check5_legalDocs();
  check6_ledgerRetention();

  const byCheck = new Map<string, Result[]>();
  for (const r of results) {
    if (!byCheck.has(r.check)) byCheck.set(r.check, []);
    byCheck.get(r.check)!.push(r);
  }

  for (const [check, items] of byCheck) {
    console.log(`[${check}]`);
    for (const r of items) {
      const sigil = r.severity === "pass" ? "  ✓" : r.severity === "warn" ? "  ⚠" : "  ✗";
      console.log(`${sigil} ${r.message}`);
    }
    console.log();
  }

  const failures = results.filter((r) => r.severity === "fail").length;
  const warnings = results.filter((r) => r.severity === "warn").length;
  const passes = results.filter((r) => r.severity === "pass").length;

  console.log(`result: ${passes} pass, ${warnings} warn, ${failures} fail`);
  if (failures > 0) {
    console.error(
      "\nfix the failures above. compliance drift left to fester turns into " +
        "a user-data incident later. correct answer is to fix the codebase, not " +
        "to weaken the audit.",
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("audit crashed:", err);
  process.exit(2);
});
