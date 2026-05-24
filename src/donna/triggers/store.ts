import { and, desc, eq } from "drizzle-orm";
import { db } from "../db.js";
import { donnaschedule } from "../db/schema.js";

// trigger persistence. write-through to the donnaschedule table so triggers
// survive process restarts; reattach-on-boot (runtime.ts) re-arms the
// setTimeouts after a deploy or crash.
//
// the runtime + tool surface stays unchanged from the in-memory version —
// callers see the same Trigger shape and the same set of verbs.

export interface Trigger {
  id: string;
  userId: string;
  // ISO 8601 string. comparisons stay string-safe.
  fireAt: string;
  // the prompt the loop will receive when this fires. as detailed as a
  // user message would be — future-self has no other context.
  action: string;
  status: "pending" | "fired" | "cancelled";
  createdAt: string;
}

type Row = typeof donnaschedule.$inferSelect;

function fromRow(row: Row): Trigger {
  return {
    id: row.id,
    userId: row.userId,
    fireAt: row.fireAt,
    action: row.instruction ?? "",
    status: row.status as Trigger["status"],
    createdAt: row.createdAt,
  };
}

export async function addTrigger(input: {
  userId: string;
  fireAt: string;
  action: string;
}): Promise<Trigger> {
  const rows = await db
    .insert(donnaschedule)
    .values({
      userId: input.userId,
      fireAt: input.fireAt,
      // cause_kind + created_by are NOT NULL. for model-issued triggers
      // these are static; future trigger sources (cron jobs, webhook
      // reactions) will use different values.
      causeKind: "model_initiated",
      causePayload: {},
      instruction: input.action,
      createdBy: "brain",
    })
    .returning();
  return fromRow(rows[0]!);
}

// per-user. each user only sees their own triggers; never cross-user.
export async function listTriggers(userId: string): Promise<Trigger[]> {
  const rows = await db
    .select()
    .from(donnaschedule)
    .where(eq(donnaschedule.userId, userId))
    .orderBy(desc(donnaschedule.createdAt));
  return rows.map(fromRow);
}

// returns true if the trigger was pending AND owned by this user AND is now
// cancelled. the ownership guard prevents one user's tool call from cancelling
// another user's trigger.
export async function cancelTrigger(
  id: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .update(donnaschedule)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(donnaschedule.id, id),
        eq(donnaschedule.userId, userId),
        eq(donnaschedule.status, "pending"),
      ),
    )
    .returning({ id: donnaschedule.id });
  return rows.length > 0;
}

// called by the runtime when a setTimeout elapses. only transitions
// pending → fired. cancelled triggers were torn down by unschedule already
// and a stale setTimeout would no-op here. returns the row so the fire
// handler can use its action.
export async function markFired(id: string): Promise<Trigger | undefined> {
  const rows = await db
    .update(donnaschedule)
    .set({ status: "fired", firedAt: new Date().toISOString() })
    .where(
      and(eq(donnaschedule.id, id), eq(donnaschedule.status, "pending")),
    )
    .returning();
  return rows[0] ? fromRow(rows[0]) : undefined;
}

// load all currently-pending triggers. used by reattachPending on boot to
// re-arm setTimeouts for triggers that outlived the previous process.
export async function loadPending(): Promise<Trigger[]> {
  const rows = await db
    .select()
    .from(donnaschedule)
    .where(eq(donnaschedule.status, "pending"));
  return rows.map(fromRow);
}
