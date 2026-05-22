// canonical user resolution. phone is the natural key for whatsapp; this
// module turns a (phone, profile_name?) pair into the user_id used by the
// rest of the system (chat_messages.user_id, future tables, etc).

import { getSql } from "../db.js";

export interface User {
  id: string;
  phone: string;
  profileName: string | null;
}

interface ResolvedRow {
  id: string;
  phone: string;
  profile_name: string | null;
}

function normalizePhone(phone: string): string {
  return phone.replace(/^\+/, "").trim();
}

/**
 * Resolve a phone to a user. Creates the row on first contact; refreshes
 * profile_name when the platform provides a fresher one. Atomic via
 * insert ... on conflict — concurrent first-message races resolve to the
 * same user_id without creating duplicates.
 */
export async function getOrCreateUser(
  phone: string,
  profileName: string | null = null,
): Promise<User> {
  const sql = getSql();
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error("getOrCreateUser: empty phone");

  const rows = await sql<ResolvedRow[]>`
    insert into users (phone, profile_name)
    values (${normalized}, ${profileName})
    on conflict (phone) do update
      set profile_name = coalesce(excluded.profile_name, users.profile_name),
          updated_at   = now()
    returning id, phone, profile_name
  `;

  const row = rows[0];
  if (!row) throw new Error("getOrCreateUser: no row returned");

  return {
    id: row.id,
    phone: row.phone,
    profileName: row.profile_name,
  };
}
