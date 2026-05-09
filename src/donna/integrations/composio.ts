import { Composio } from "@composio/core";

let _client: Composio | null = null;

function init(): Composio {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new Error("COMPOSIO_API_KEY not set");
  }
  return new Composio({ apiKey });
}

export function getComposio(): Composio {
  if (!_client) _client = init();
  return _client;
}

export function getComposioUserId(): string {
  const id = process.env.COMPOSIO_USER_ID;
  if (!id) {
    throw new Error(
      "COMPOSIO_USER_ID not set — this is the composio entity id with gmail connected",
    );
  }
  return id;
}

// the gmail "new message arrived" trigger slug. composio normalizes gmail's
// users.watch + pub/sub push behind this; they handle watch renewal.
// override via env if composio renames it later.
export const GMAIL_TRIGGER_SLUG =
  process.env.COMPOSIO_GMAIL_TRIGGER_SLUG ?? "GMAIL_NEW_GMAIL_MESSAGE";

// resolve the user's gmail address. cached in integrations.config.gmail_email
// after the first call so the threads pipeline doesn't re-fetch on every event.
export async function resolveGmailUserEmail(userId: string): Promise<string | null> {
  const { getSql } = await import("../db.js");
  const sql = getSql();

  const cached = await sql<Array<{ email: string | null }>>`
    select coalesce(config->>'gmail_email', null) as email
    from integrations
    where user_id = ${userId} and provider = 'gmail' and status = 'connected'
    limit 1
  `;
  const cachedEmail = cached[0]?.email;
  if (cachedEmail) return cachedEmail.toLowerCase();

  // fetch profile via composio (audited path)
  const { executeForUser } = await import("./service.js");
  try {
    const profile = await executeForUser<{ emailAddress?: string; email?: string }>(
      "gmail",
      "GMAIL_GET_PROFILE",
      {},
      { action: "profile.get" },
    );
    const email = (profile.emailAddress ?? profile.email ?? "").toLowerCase();
    if (!email) return null;

    type JsonArg = Parameters<typeof sql.json>[0];
    const patch = { gmail_email: email } as unknown as JsonArg;
    await sql`
      update integrations
      set config = config || ${sql.json(patch)},
          updated_at = now()
      where user_id = ${userId} and provider = 'gmail'
    `;
    return email;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[integrations] gmail profile fetch failed for ${userId.slice(0, 8)}: ${msg}`);
    return null;
  }
}

// enable a provider trigger for a specific connected account. idempotent —
// composio's create method upserts under the hood, so re-running on an
// already-enabled trigger doesn't error.
//
// composioUserId is the alias passed during oauth (donna's user_id), not the
// connected_account id. composio resolves the right account via the alias.
export async function enableProviderTrigger(args: {
  composioUserId: string;
  triggerSlug: string;
  connectedAccountId?: string;
  triggerConfig?: Record<string, unknown>;
}): Promise<{ triggerId: string } | { error: string }> {
  try {
    const composio = getComposio();
    const resp = await composio.triggers.create(
      args.composioUserId,
      args.triggerSlug,
      {
        connectedAccountId: args.connectedAccountId,
        triggerConfig: args.triggerConfig,
      },
    );
    return { triggerId: resp.triggerId };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function disableTriggerInstance(
  triggerId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await getComposio().triggers.delete(triggerId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface ComposioExecuteResponse {
  successful?: boolean;
  data?: unknown;
  error?: string | null;
}

export async function executeAction<T = unknown>(
  slug: string,
  args: Record<string, unknown>,
): Promise<T> {
  const composio = getComposio();
  const userId = getComposioUserId();

  const resp = (await composio.tools.execute(slug, {
    userId,
    arguments: args,
  })) as ComposioExecuteResponse;

  if (resp.successful === false) {
    throw new Error(`composio ${slug} failed: ${resp.error ?? "unknown"}`);
  }
  return resp.data as T;
}
