import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../db.js";
import {
  users,
  chatMessages,
  inboundMessages,
  integrationAudit,
  donnaStateDrafts,
  executionRuns,
  donnaschedule,
  foodGoals,
  meals,
  mealAliases,
  integrations,
  userConsents,
  worldLedger,
  worldDailyCount,
} from "../db/schema.js";
import { getOrCreateUserByClerk } from "../users.js";
import { requireUser, userId } from "./auth.js";

// /api/account routes: the user's right-of-access + right-to-delete surface.
// these are GDPR / CCPA / DPDP requirements but they also exist because they
// are the right thing — donna holds a lot for the user, and the user should
// be able to walk away with their data or wipe it without asking anyone.

export const account = new Hono();

account.use("*", requireUser);

// DELETE /api/account/me — nuke everything we have about the caller.
//
// most user-keyed tables have ON DELETE CASCADE on users.id (see schema.ts),
// so deleting the users row sweeps them. a few tables don't (chat_messages,
// integration_audit, donna_state_drafts, plus inbound_messages which keys
// by phone) — we delete those explicitly first.
//
// the donna-browser per-user chromium profile lives on a separate ec2; if
// the path doesn't exist (e.g. running locally without the browser stack
// mounted) we ignore. when donna-browser is hosted separately, this would
// instead call its DELETE /users/{id}/sessions endpoint over the tunnel.
account.delete("/me", async (c) => {
  const clerkId = userId(c);
  const user = await getOrCreateUserByClerk(clerkId);

  // 1. tables without FK cascade. each returns the rows it nuked so we can
  //    report counts back to the caller (audit trail in the response itself).
  //    integrations is in here because it's a (user_id, provider) composite-pk
  //    table without an explicit FK to users — needs manual delete.
  const [delChat, delAudit, delDrafts, delIntegrations] = await Promise.all([
    db.delete(chatMessages).where(eq(chatMessages.userId, user.id)).returning({ id: chatMessages.id }),
    db.delete(integrationAudit).where(eq(integrationAudit.userId, user.id)).returning({ id: integrationAudit.id }),
    db.delete(donnaStateDrafts).where(eq(donnaStateDrafts.userId, user.id)).returning({ id: donnaStateDrafts.id }),
    db.delete(integrations).where(eq(integrations.userId, user.id)).returning({ provider: integrations.provider }),
  ]);

  // inbound_messages keys by phone (it's the wa webhook landing zone, no
  // user_id). resolve via the users row before we delete it.
  const userRow = await db
    .select({ phone: users.phone })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  const phone = userRow[0]?.phone ?? null;
  const delInbound = phone
    ? await db.delete(inboundMessages).where(eq(inboundMessages.phone, phone)).returning({ id: inboundMessages.id })
    : [];

  // 2. delete the users row. FK cascades take care of:
  //    execution_runs (which in turn cascades execution_events),
  //    donnaschedule, food_goals, meals (→ meal_items), meal_aliases,
  //    world_ledger, world_daily_count, user_consents.
  //    (integrations has no FK declared — left to the migration roadmap.)
  await db.delete(users).where(eq(users.id, user.id));

  // 3. donna-browser per-user chromium profile on the ec2 data dir.
  //    fire-and-forget: if the dir isn't mounted here (most likely on the
  //    api server) we move on. eventually this becomes a remote call to
  //    donna-browser's DELETE /users/{id}/sessions endpoint.
  const browserDataDir = process.env.DONNA_BROWSER_DATA_DIR ?? "/data/users";
  let browserCleaned = false;
  try {
    await rm(join(browserDataDir, user.id), { recursive: true, force: true });
    browserCleaned = true;
  } catch (err) {
    console.warn(`donna-browser data dir cleanup failed for ${user.id}:`, err);
  }

  // 4. ledger files (.donna/ledger/*.jsonl) are shared across users — a single
  //    day's file contains lines from many users' runs. wiping the whole file
  //    would lose unrelated audit data. for now we accept that ledger lines
  //    age out via retention (see scripts/prune-ledger.ts). granular per-user
  //    scrubbing is a future cron pass that walks files, drops lines whose
  //    config.userId matches a tombstone list, and rewrites the file.
  //    when that lands, this is where we'd append the userId to the tombstone.

  return c.json({
    ok: true,
    user_id: user.id,
    deleted: {
      chat_messages: delChat.length,
      inbound_messages: delInbound.length,
      integration_audit: delAudit.length,
      drafts: delDrafts.length,
      integrations: delIntegrations.length,
      donna_browser_dir: browserCleaned,
      cascade: [
        "execution_runs",
        "execution_events",
        "donnaschedule",
        "food_goals",
        "meals",
        "meal_items",
        "meal_aliases",
        "world_ledger",
        "world_daily_count",
        "user_consents",
      ],
      ledger_files: "preserved; age out via retention cron",
    },
  });
});

// GET /api/account/me/export — machine-readable dump of everything we have.
//
// GDPR art. 20 + CCPA: "right of data portability." returns json directly
// in the response. when the export grows past ~50 mb (it won't for the
// foreseeable future), we'd switch to "email a download link" with the
// payload uploaded to a short-lived signed url.
account.get("/me/export", async (c) => {
  const clerkId = userId(c);
  const user = await getOrCreateUserByClerk(clerkId);

  const [
    profile,
    chatMessages_,
    runs,
    audit,
    drafts,
    schedule,
    goals,
    userMeals,
    aliases,
    integrations_,
    consents,
    worldLedgerRows,
    worldDailyCountRows,
  ] = await Promise.all([
    db.select().from(users).where(eq(users.id, user.id)),
    db.select().from(chatMessages).where(eq(chatMessages.userId, user.id)),
    db.select().from(executionRuns).where(eq(executionRuns.userId, user.id)),
    db.select().from(integrationAudit).where(eq(integrationAudit.userId, user.id)),
    db.select().from(donnaStateDrafts).where(eq(donnaStateDrafts.userId, user.id)),
    db.select().from(donnaschedule).where(eq(donnaschedule.userId, user.id)),
    db.select().from(foodGoals).where(eq(foodGoals.userId, user.id)),
    db.select().from(meals).where(eq(meals.userId, user.id)),
    db.select().from(mealAliases).where(eq(mealAliases.userId, user.id)),
    db.select().from(integrations).where(eq(integrations.userId, user.id)),
    db.select().from(userConsents).where(eq(userConsents.userId, user.id)),
    db.select().from(worldLedger).where(eq(worldLedger.userId, user.id)),
    db.select().from(worldDailyCount).where(eq(worldDailyCount.userId, user.id)),
  ]);

  return c.json({
    exported_at: new Date().toISOString(),
    user_id: user.id,
    profile: profile[0] ?? null,
    chat_messages: chatMessages_,
    execution_runs: runs,
    integration_audit: audit,
    drafts,
    donnaschedule: schedule,
    food_goals: goals[0] ?? null,
    meals: userMeals,
    meal_aliases: aliases,
    integrations: integrations_,
    consents,
    world_ledger: worldLedgerRows,
    world_daily_count: worldDailyCountRows,
  });
});
