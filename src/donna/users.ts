import { db } from "./db.js";
import { users } from "./db/schema.js";

// the canonical identity primitive. every ingress (whatsapp, mobile, imessage)
// resolves to a `user_id` via one of these helpers before the brain sees a
// turn. the brain itself only ever takes the id.

export interface User {
  id: string;
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
