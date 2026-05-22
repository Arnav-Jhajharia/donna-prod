import { Composio } from "@composio/core";
import { getSql } from "../db.js";
import { maybeTurnContext } from "../context.js";

// state-owning service for stateful integrations.
//
// shape:
//   readState / upsertState  → manage the integrations table
//   audit                    → write every read/write to integration_audit
//   executeWithAudit         → the load-bearing call: runs a composio action
//                              for the current user, audits it, returns data.
//
// caller-tagging (direct vs code_execution) flows through automatically via
// the turn context — handlers don't need to know whether they were invoked
// directly or from inside the python sandbox.

export type IntegrationMode = "search_only" | "smart_index" | "full";
export type IntegrationStatus = "connected" | "expired" | "revoked" | "error";

export interface IntegrationState {
  user_id: string;
  provider: string;
  status: IntegrationStatus;
  mode: IntegrationMode;
  exclusions: Record<string, boolean>;
  config: Record<string, unknown>;
  composio_account_id: string | null;
  last_sync_at: string | null;
  connected_at: string;
}

let _client: Composio | null = null;

function getComposio(): Composio {
  if (_client) return _client;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY not set");
  _client = new Composio({ apiKey });
  return _client;
}

interface ComposioExecuteResponse {
  successful?: boolean;
  data?: unknown;
  error?: string | null;
}

export async function readState(
  userId: string,
  provider: string,
): Promise<IntegrationState | null> {
  const sql = getSql();
  const rows = await sql<IntegrationState[]>`
    select user_id, provider, status, mode, exclusions, config,
           composio_account_id, last_sync_at, connected_at
    from integrations
    where user_id = ${userId} and provider = ${provider}
    limit 1
  `;
  return rows[0] ?? null;
}

export async function listForUser(userId: string): Promise<IntegrationState[]> {
  const sql = getSql();
  const rows = await sql<IntegrationState[]>`
    select user_id, provider, status, mode, exclusions, config,
           composio_account_id, last_sync_at, connected_at
    from integrations
    where user_id = ${userId}
    order by provider asc
  `;
  return [...rows];
}

export async function setMode(
  userId: string,
  provider: string,
  mode: IntegrationMode,
): Promise<IntegrationState | null> {
  const sql = getSql();
  await sql`
    update integrations
    set mode = ${mode}, updated_at = now()
    where user_id = ${userId} and provider = ${provider}
  `;
  return readState(userId, provider);
}

// disconnect: revoke at composio, mark our row revoked. does NOT wipe audit
// or downstream-derived data (slabs, supermemory) — those need a separate
// `forget` call once they exist.
export async function disconnectIntegration(
  userId: string,
  provider: string,
): Promise<{ ok: boolean; composioAccountId: string | null; error?: string }> {
  const state = await readState(userId, provider);
  if (!state) return { ok: false, composioAccountId: null, error: "not_configured" };

  let composioError: string | null = null;
  if (state.composio_account_id) {
    try {
      await getComposio().connectedAccounts.delete(state.composio_account_id);
    } catch (err) {
      // composio delete failed — keep going, mark our row revoked anyway. user
      // can re-trigger via the connect cli if state ever gets out of sync.
      composioError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[integrations] composio delete failed for ${state.composio_account_id}: ${composioError}`,
      );
    }
  }

  const sql = getSql();
  await sql`
    update integrations
    set status = 'revoked', updated_at = now()
    where user_id = ${userId} and provider = ${provider}
  `;

  await audit({
    userId,
    provider,
    action: "lifecycle.disconnect",
    itemRef: state.composio_account_id,
    ok: composioError === null,
    meta: composioError ? { error: composioError } : {},
  });

  return {
    ok: composioError === null,
    composioAccountId: state.composio_account_id,
    error: composioError ?? undefined,
  };
}

export interface UpsertStateArgs {
  userId: string;
  provider: string;
  status?: IntegrationStatus;
  mode?: IntegrationMode;
  exclusions?: Record<string, boolean>;
  config?: Record<string, unknown>;
  composio_account_id?: string | null;
  last_sync_at?: string | null;
}

export async function upsertState(args: UpsertStateArgs): Promise<void> {
  const sql = getSql();
  await sql`
    insert into integrations (
      user_id, provider, status, mode, exclusions, config,
      composio_account_id, last_sync_at, updated_at
    ) values (
      ${args.userId},
      ${args.provider},
      ${args.status ?? "connected"},
      ${args.mode ?? "smart_index"},
      ${sql.json((args.exclusions ?? { banking: true, medical: true, legal: true }) as Parameters<typeof sql.json>[0])},
      ${sql.json((args.config ?? {}) as Parameters<typeof sql.json>[0])},
      ${args.composio_account_id ?? null},
      ${args.last_sync_at ?? null},
      now()
    )
    on conflict (user_id, provider) do update set
      status = excluded.status,
      mode = excluded.mode,
      exclusions = excluded.exclusions,
      config = excluded.config,
      composio_account_id = coalesce(excluded.composio_account_id, integrations.composio_account_id),
      last_sync_at = coalesce(excluded.last_sync_at, integrations.last_sync_at),
      updated_at = now()
  `;
}

interface AuditArgs {
  userId: string;
  provider: string;
  action: string;
  itemRef?: string | null;
  caller?: "direct" | "code_execution" | null;
  ok: boolean;
  durationMs?: number | null;
  meta?: Record<string, unknown>;
}

export async function audit(args: AuditArgs): Promise<void> {
  try {
    const sql = getSql();
    await sql`
      insert into integration_audit (
        user_id, provider, action, item_ref, caller, ok, duration_ms, meta
      ) values (
        ${args.userId},
        ${args.provider},
        ${args.action},
        ${args.itemRef ?? null},
        ${args.caller ?? null},
        ${args.ok},
        ${args.durationMs ?? null},
        ${sql.json((args.meta ?? {}) as Parameters<typeof sql.json>[0])}
      )
    `;
  } catch (err) {
    // audit failure must never break the user-facing flow. log + move on.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[integrations] audit write failed (${args.action}): ${msg}`);
  }
}

export interface ExecuteOptions {
  // a stable string describing what we're doing. flows into integration_audit.action.
  action: string;
  // optional reference for the item being acted on (e.g. thread_id). used in audit.
  itemRef?: string | null;
  // optional caller-supplied metadata to land in audit.meta.
  meta?: Record<string, unknown>;
}

// run a composio action for the user identified by the active turn context.
// resolves donna's user → composio entity via integrations.composio_account_id.
// audits every call (success or failure). throws on failure (handlers in
// brain.ts already catch and convert to is_error tool_results).
export async function executeForUser<T = unknown>(
  provider: string,
  composioSlug: string,
  args: Record<string, unknown>,
  opts: ExecuteOptions,
): Promise<T> {
  const ctx = maybeTurnContext();
  if (!ctx) {
    throw new Error(`integration ${provider}: no turn context — call from within a brain turn`);
  }

  const state = await readState(ctx.userId, provider);
  if (!state) {
    throw new Error(
      `integration ${provider} not configured for this user. run the bootstrap script or have donna call integration.connect().`,
    );
  }
  if (state.status !== "connected") {
    throw new Error(`integration ${provider} status=${state.status}, not connected`);
  }
  if (!state.composio_account_id) {
    throw new Error(`integration ${provider}: missing composio_account_id`);
  }

  // mode gate: search_only blocks any call that would index/store. for now
  // every gmail tool is a read, and search_only still allows reads — we just
  // don't write derived state. when write tools land they'll check this.
  // (placeholder; real enforcement lands in phase B with the slabs.)

  const composio = getComposio();
  const startedAt = Date.now();
  let ok = true;
  let result: unknown;
  let error: string | null = null;

  try {
    const resp = (await composio.tools.execute(composioSlug, {
      userId: state.composio_account_id,
      arguments: args,
    })) as ComposioExecuteResponse;
    if (resp.successful === false) {
      ok = false;
      error = resp.error ?? "unknown composio error";
      throw new Error(`composio ${composioSlug} failed: ${error}`);
    }
    result = resp.data;
  } catch (err) {
    ok = false;
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    await audit({
      userId: ctx.userId,
      provider,
      action: opts.action,
      itemRef: opts.itemRef,
      // we don't know the caller here — brain.ts stamps it on its own
      // tool_start/_end events. duplicating that into audit would just be
      // noise. leave caller=null in audit; cross-reference via run_id+action.
      caller: null,
      ok,
      durationMs: Date.now() - startedAt,
      meta: { composio_slug: composioSlug, ...(opts.meta ?? {}), ...(error ? { error } : {}) },
    });
  }

  return result as T;
}
