import { createClerkClient } from "@clerk/backend";
import { and, eq, isNull } from "drizzle-orm";
import { db, sql } from "./db.js";
import { users } from "./db/schema.js";

// the canonical identity primitive. every ingress (whatsapp, mobile, imessage)
// resolves to a `user_id` via one of these helpers before the brain sees a
// turn. the brain itself only ever takes the id.

export interface User {
  id: string;
}

// lazy clerk client. instantiated on first call, reused after. throws if
// CLERK_SECRET_KEY is missing — getOrCreateUserByClerk requires it.
let _clerk: ReturnType<typeof createClerkClient> | null = null;
function clerk() {
  if (_clerk) return _clerk;
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error("CLERK_SECRET_KEY required for clerk auth");
  _clerk = createClerkClient({ secretKey });
  return _clerk;
}

// upsert by phone. one-shot insert with on-conflict-do-update set to a no-op
// (set the same value back) so RETURNING fires on conflict too — a plain
// do-nothing would swallow the return when the row already exists.
//
// caller is responsible for canonicalising the phone (e.164 without leading
// "+", matching what whatsapp puts in messages[i].from). enforced at the
// ingress boundary, not here.
export async function getOrCreateUserByPhone(phone: string): Promise<User> {
  const rows = await db
    .insert(users)
    .values({ phone })
    .onConflictDoUpdate({
      target: users.phone,
      set:    { phone },
    })
    .returning({ id: users.id });
  return { id: rows[0]!.id };
}

// mobile resolution. fetches the clerk user profile, reads phone if present,
// and links to an existing whatsapp-only row when one matches.
//
// flow:
//   1. ask clerk for the user (gets phoneNumbers[]).
//   2. if a phone is on the clerk profile AND a users row exists with that
//      phone + null clerk_id: UPDATE that row to attach clerk_id → return it.
//      this is option-B identity linking (one human = one row across surfaces).
//   3. otherwise: upsert by clerk_id, also setting phone if we have one.
//
// edge case: two clerk users somehow share a phone. step 3 will hit the
// unique(phone) constraint and throw. unlikely; refine when we hit it.
export async function getOrCreateUserByClerk(clerkId: string): Promise<User> {
  const clerkUser = await clerk().users.getUser(clerkId);
  const phone = clerkUser.phoneNumbers[0]?.phoneNumber ?? null;

  // try to merge into an existing whatsapp-only row.
  if (phone) {
    const linked = await db
      .update(users)
      .set({ clerkId })
      .where(and(eq(users.phone, phone), isNull(users.clerkId)))
      .returning({ id: users.id });
    if (linked[0]) return { id: linked[0].id };
  }

  // otherwise upsert by clerk_id. no-op set so RETURNING fires on conflict.
  const rows = await db
    .insert(users)
    .values({ clerkId, phone })
    .onConflictDoUpdate({
      target: users.clerkId,
      set:    { clerkId },
    })
    .returning({ id: users.id });
  return { id: rows[0]!.id };
}

// store the apns voip device token for a user. mobile POSTs it from voipCall
// once pushkit hands one out. raw SQL because the column isn't in schema.ts
// until you run `npm run db:pull` after applying the migration — and we want
// this code working before that.
export async function setApnsVoipToken(
  userId: string,
  token: string,
): Promise<void> {
  await sql`update users set apns_voip_token = ${token} where id = ${userId}`;
}

// look up the user's apns voip token. used by /call/start when donna rings
// a user without the mobile app having to pass the token in the request body
// (i.e. backend-initiated proactive calls).
export async function getApnsVoipToken(
  userId: string,
): Promise<string | null> {
  const rows = await sql<
    { apns_voip_token: string | null }[]
  >`select apns_voip_token from users where id = ${userId} limit 1`;
  return rows[0]?.apns_voip_token ?? null;
}
