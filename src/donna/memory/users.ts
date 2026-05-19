// canonical user resolution. phone is the natural key for whatsapp/imessage;
// the user_identities table extends that so future surfaces (native app,
// browser, email-linked accounts) can resolve to the same canonical user.
//
// every inbound webhook calls getOrCreateUser; new surfaces resolve via
// getUserByIdentity / recordIdentity. updateActivity stamps the channel the
// user just spoke on so the router knows where to push proactive bursts.

import { getSql } from "../db.js";

export type ChannelKind = "whatsapp" | "imessage" | "app";
export type IdentityProvider =
  | "whatsapp_phone"
  | "imessage_phone"
  | "app_device"
  | "email";

export interface User {
  id: string;
  phone: string;
  profileName: string | null;
  preferredChannel: ChannelKind;
  lastActiveChannel: ChannelKind | null;
  lastActiveAt: Date | null;
}

interface ResolvedRow {
  id: string;
  phone: string;
  profile_name: string | null;
  preferred_channel: ChannelKind;
  last_active_channel: ChannelKind | null;
  last_active_at: string | null;
}

function normalizePhone(phone: string): string {
  return phone.replace(/^\+/, "").trim();
}

function toUser(row: ResolvedRow): User {
  return {
    id: row.id,
    phone: row.phone,
    profileName: row.profile_name,
    preferredChannel: row.preferred_channel,
    lastActiveChannel: row.last_active_channel,
    lastActiveAt: row.last_active_at ? new Date(row.last_active_at) : null,
  };
}

/**
 * Resolve a phone to a user. Creates the row on first contact; refreshes
 * profile_name when the platform provides a fresher one. Atomic via
 * insert ... on conflict — concurrent first-message races resolve to the
 * same user_id without creating duplicates. Also records a `whatsapp_phone`
 * identity row so the omnipresence router can resolve the user from any
 * surface that knows the phone.
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
    returning id, phone, profile_name, preferred_channel, last_active_channel, last_active_at
  `;

  const row = rows[0];
  if (!row) throw new Error("getOrCreateUser: no row returned");

  // mirror the phone as an identity. idempotent.
  await sql`
    insert into user_identities (user_id, provider, external_id)
    values (${row.id}, 'whatsapp_phone', ${normalized})
    on conflict (provider, external_id) do update
      set last_seen_at = now()
  `;

  return toUser(row);
}

/**
 * Resolve a user via any identity (whatsapp_phone, imessage_phone, app_device,
 * email). Returns null if the identity isn't recorded yet. Bumps last_seen_at
 * on hit so we know which identities are live.
 */
export async function getUserByIdentity(
  provider: IdentityProvider,
  externalId: string,
): Promise<User | null> {
  const sql = getSql();
  if (!externalId.trim()) return null;
  const rows = await sql<ResolvedRow[]>`
    update user_identities
      set last_seen_at = now()
    where provider = ${provider} and external_id = ${externalId}
    returning user_id
  `;
  const userId = (rows[0] as unknown as { user_id?: string } | undefined)?.user_id;
  if (!userId) return null;
  const userRows = await sql<ResolvedRow[]>`
    select id, phone, profile_name, preferred_channel, last_active_channel, last_active_at
    from users where id = ${userId} limit 1
  `;
  const row = userRows[0];
  return row ? toUser(row) : null;
}

/**
 * Link a new identity to an existing user. Idempotent: re-running with the
 * same (provider, external_id) just refreshes last_seen_at. Throws if the
 * identity is already owned by a different user — surfacing that explicitly
 * is safer than silently re-pointing it.
 */
export async function recordIdentity(args: {
  userId: string;
  provider: IdentityProvider;
  externalId: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const sql = getSql();
  const meta = args.metadata ?? {};
  const conflicting = await sql<Array<{ user_id: string }>>`
    select user_id from user_identities
    where provider = ${args.provider} and external_id = ${args.externalId}
    limit 1
  `;
  const existingOwner = conflicting[0]?.user_id;
  if (existingOwner && existingOwner !== args.userId) {
    throw new Error(
      `recordIdentity: ${args.provider}/${args.externalId} already owned by another user`,
    );
  }
  await sql`
    insert into user_identities (user_id, provider, external_id, metadata)
    values (${args.userId}, ${args.provider}, ${args.externalId},
            ${sql.json(meta as unknown as Parameters<typeof sql.json>[0])})
    on conflict (provider, external_id) do update
      set last_seen_at = now(),
          metadata     = excluded.metadata
  `;
}

/**
 * Stamp the channel the user just spoke on. Called from every inbound
 * dispatcher. The router reads last_active_channel to decide where to push
 * proactive bursts when there's no explicit source hint.
 */
export async function updateActivity(
  userId: string,
  channel: ChannelKind,
): Promise<void> {
  const sql = getSql();
  await sql`
    update users
      set last_active_channel = ${channel},
          last_active_at      = now(),
          updated_at          = now()
    where id = ${userId}
  `;
}

/**
 * Set the user's sticky channel preference. Onboarding flows or explicit
 * "always text me on imessage" commands write here.
 */
export async function setPreferredChannel(
  userId: string,
  channel: ChannelKind,
): Promise<void> {
  const sql = getSql();
  await sql`
    update users
      set preferred_channel = ${channel},
          updated_at        = now()
    where id = ${userId}
  `;
}
