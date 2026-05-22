// seed expenses for smoke-testing the expense tracker + subscription detection.
// drops ~5 months of mixed expenses: recurring monthly (netflix, spotify, gym,
// chatgpt) so get_recurring_charges has something to detect, plus everyday
// food/transport noise so daily/monthly summaries are non-trivial.
//
// usage:
//   tsx scripts/seed-expenses.ts --user-id <uuid>
//   tsx scripts/seed-expenses.ts --user-id <uuid> --reset   # clears prior seed rows first
//
// all seeded rows are marked `notes = '[seed]'` so --reset can find them and
// nothing else gets touched.

import "dotenv/config";
import { closeDb, getSql } from "../src/donna/db.js";
import { insertExpense } from "../src/donna/expenses/expenses.js";
import { upsertBudget } from "../src/donna/expenses/goals.js";
import type { ExpenseSource, Parser } from "../src/donna/expenses/types.js";

interface Args {
  userId: string;
  reset: boolean;
}

function parseArgs(argv: string[]): Args {
  let userId: string | undefined;
  let reset = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user-id" && argv[i + 1]) {
      userId = argv[++i];
      continue;
    }
    if (a === "--reset") {
      reset = true;
      continue;
    }
  }
  userId = userId ?? process.env.DONNA_USER_ID;
  if (!userId) {
    throw new Error("--user-id required (or set DONNA_USER_ID env)");
  }
  return { userId, reset };
}

interface SeedRow {
  daysAgo: number;
  merchant: string | null;
  amountCents: number;
  category: string | null;
  sourceKind: ExpenseSource;
  parser: Parser;
  rawInput?: string;
}

function monthlyRecurring(
  merchant: string,
  amountCents: number,
  category: string,
  monthsBack: number,
): SeedRow[] {
  // one charge per month for the last `monthsBack` months, on day 5 of each
  // month (approximate — exact day doesn't matter for detection).
  const out: SeedRow[] = [];
  for (let m = 0; m < monthsBack; m++) {
    // ~30 days per month, +/- 1 to wobble timing slightly (still inside the
    // monthly bucket per the detector's 25-35 day tolerance).
    const wobble = m % 2 === 0 ? 0 : 1;
    out.push({
      daysAgo: 30 * m + wobble,
      merchant,
      amountCents,
      category,
      sourceKind: "gmail",
      parser: "gmail",
      rawInput: `${merchant} renewal`,
    });
  }
  return out;
}

function oneOff(
  daysAgo: number,
  merchant: string | null,
  amountCents: number,
  category: string,
): SeedRow {
  return {
    daysAgo,
    merchant,
    amountCents,
    category,
    sourceKind: "text",
    parser: "llm",
  };
}

function buildSeedRows(): SeedRow[] {
  const rows: SeedRow[] = [];

  // recurring monthly (4 charges each, ≥3 → detector trips)
  rows.push(...monthlyRecurring("Netflix", 1549, "subscriptions", 4));
  rows.push(...monthlyRecurring("Spotify", 1199, "subscriptions", 5));
  rows.push(...monthlyRecurring("Equinox", 26500, "health", 3));
  rows.push(...monthlyRecurring("ChatGPT Plus", 2000, "subscriptions", 4));
  rows.push(...monthlyRecurring("iCloud+", 299, "subscriptions", 5));

  // single yearly — won't trip the monthly detector (correct behavior)
  rows.push(oneOff(45, "Amazon Prime", 13900, "subscriptions"));

  // everyday noise across the last 30 days
  rows.push(oneOff(1, "Uber", 1840, "transport"));
  rows.push(oneOff(1, "Blue Bottle", 580, "food"));
  rows.push(oneOff(2, "Whole Foods", 6720, "groceries"));
  rows.push(oneOff(2, "Joe's Pizza", 2400, "food"));
  rows.push(oneOff(3, "Uber", 1230, "transport"));
  rows.push(oneOff(4, "Trader Joe's", 8410, "groceries"));
  rows.push(oneOff(5, "Blue Bottle", 580, "food"));
  rows.push(oneOff(5, "Lyft", 2100, "transport"));
  rows.push(oneOff(6, "Sushi Yasaka", 4800, "food"));
  rows.push(oneOff(7, "CVS Pharmacy", 1850, "health"));
  rows.push(oneOff(8, "Trader Joe's", 5630, "groceries"));
  rows.push(oneOff(9, "Blue Bottle", 580, "food"));
  rows.push(oneOff(10, "Uber", 2150, "transport"));
  rows.push(oneOff(12, "Trader Joe's", 7240, "groceries"));
  rows.push(oneOff(13, "Pret a Manger", 1450, "food"));
  rows.push(oneOff(14, "Levain Bakery", 800, "food"));
  rows.push(oneOff(15, "Apple Store", 12900, "shopping"));
  rows.push(oneOff(17, "Trader Joe's", 4960, "groceries"));
  rows.push(oneOff(18, "Uber", 1780, "transport"));
  rows.push(oneOff(20, "Citi Bike", 1900, "transport"));
  rows.push(oneOff(21, "Blue Bottle", 580, "food"));
  rows.push(oneOff(22, "Sweetgreen", 1620, "food"));
  rows.push(oneOff(24, "Trader Joe's", 6810, "groceries"));
  rows.push(oneOff(25, "Uniqlo", 4200, "shopping"));
  rows.push(oneOff(28, "Hertz", 24500, "transport"));

  // last month — same patterns, different days
  rows.push(oneOff(33, "Trader Joe's", 5980, "groceries"));
  rows.push(oneOff(35, "Sushi Yasaka", 4400, "food"));
  rows.push(oneOff(37, "Uber", 1530, "transport"));
  rows.push(oneOff(40, "Brooklyn Roasting", 720, "food"));
  rows.push(oneOff(44, "Pizza Suprema", 2200, "food"));
  rows.push(oneOff(48, "Whole Foods", 8210, "groceries"));
  rows.push(oneOff(52, "Lyft", 1900, "transport"));
  rows.push(oneOff(58, "Uniqlo", 6500, "shopping"));

  return rows;
}

async function clearSeedRows(userId: string): Promise<number> {
  const sql = getSql();
  const result = await sql`
    delete from expenses
    where user_id = ${userId}
      and notes = '[seed]'
    returning id
  `;
  return result.length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const sql = getSql();
  await sql`select 1`; // connection check

  if (args.reset) {
    const removed = await clearSeedRows(args.userId);
    console.log(`reset: removed ${removed} prior seed rows`);
  }

  // baseline budget so summaries are interesting
  await upsertBudget({
    userId: args.userId,
    monthlyTotalCents: 300000,
    dailyTotalCents: null,
    perCategoryMonthlyCents: {
      food: 50000,
      groceries: 60000,
      transport: 25000,
      subscriptions: 8000,
      shopping: 30000,
      health: 35000,
    },
    currency: "USD",
    proactiveNudges: true,
    timezone: "America/New_York",
  });
  console.log("baseline budget set: $3000/mo with category caps");

  const rows = buildSeedRows();
  let inserted = 0;
  for (const r of rows) {
    const occurredAt = new Date(Date.now() - r.daysAgo * 24 * 60 * 60 * 1000);
    await insertExpense({
      userId: args.userId,
      occurredAt,
      merchant: r.merchant,
      amountCents: r.amountCents,
      currency: "USD",
      category: r.category,
      sourceKind: r.sourceKind,
      sourceMessageId: null,
      rawInput: r.rawInput ?? null,
      visionDescription: null,
      confidence: "high",
      parser: r.parser,
      notes: "[seed]",
      items: [],
    });
    inserted++;
  }
  console.log(`inserted ${inserted} expense rows for user ${args.userId}`);

  // quick sanity: print rough monthly + recurring counts
  const [{ total_cents }] = await sql<Array<{ total_cents: number }>>`
    select coalesce(sum(amount_cents), 0)::bigint as total_cents
    from expenses
    where user_id = ${args.userId} and not is_deleted and notes = '[seed]'
  `;
  console.log(`seeded total: $${(Number(total_cents) / 100).toFixed(2)}`);

  await closeDb();
}

main().catch(async (err) => {
  console.error("seed failed:", err);
  await closeDb();
  process.exit(1);
});
