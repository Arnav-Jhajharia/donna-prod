// in-conversation lifecycle tools for stateful integrations. direct-only —
// these are user-facing state changes that must NOT be called from inside
// the python sandbox. donna calls them directly when the user asks.

import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../brain.js";
import { getTurnContext } from "../context.js";
import { getComposio } from "../integrations/composio.js";
import {
  listForUser,
  readState,
  setMode,
  upsertState,
  disconnectIntegration,
  type IntegrationMode,
} from "../integrations/service.js";

const VALID_MODES: IntegrationMode[] = ["search_only", "smart_index", "full"];

const CONNECT_TIMEOUT_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// integration_status — list configured integrations for the current user
// ---------------------------------------------------------------------------

export const integrationStatusTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "integration_status",
  description: `list the user's configured integrations: provider, status (connected | expired | revoked | error), mode (search_only | smart_index | full), composio_account_id, when connected, when last synced.

call this when the user asks:
- "what's connected?"
- "is gmail still connected?"
- "what do you have access to?"

returns: { integrations: [{provider, status, mode, exclusions, composio_account_id, last_sync_at, connected_at}, ...], count }.`,
  input_schema: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        description: "optional — filter to a single provider (e.g. 'gmail').",
      },
    },
  },
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

interface IntegrationStatusInput {
  provider?: string;
}

export async function integrationStatusHandler(input: unknown): Promise<unknown> {
  const { provider } = (input ?? {}) as IntegrationStatusInput;
  const ctx = getTurnContext();
  if (provider) {
    const row = await readState(ctx.userId, provider);
    return { integrations: row ? [row] : [], count: row ? 1 : 0 };
  }
  const all = await listForUser(ctx.userId);
  return { integrations: all, count: all.length };
}

// ---------------------------------------------------------------------------
// integration_set_mode — change consent depth for a provider
// ---------------------------------------------------------------------------

export const integrationSetModeTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "integration_set_mode",
  description: `change how deeply donna processes data from an integration.

modes:
- search_only: live search only, store nothing, no derived memory.
- smart_index: indexed minus excluded categories (banking/medical/legal). most copilot features active. DEFAULT.
- full: indexed everything, full memory enrichment.

call this when the user says things like:
- "stop indexing my gmail" → set_mode(provider="gmail", mode="search_only")
- "use everything from my inbox" → mode="full"
- "go back to default" → mode="smart_index"

returns the updated state row. fails if the provider isn't configured.`,
  input_schema: {
    type: "object",
    properties: {
      provider: { type: "string", description: "provider slug, e.g. 'gmail'." },
      mode: {
        type: "string",
        enum: ["search_only", "smart_index", "full"],
        description: "new mode.",
      },
    },
    required: ["provider", "mode"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

interface IntegrationSetModeInput {
  provider?: string;
  mode?: string;
}

export async function integrationSetModeHandler(input: unknown): Promise<unknown> {
  const { provider, mode } = (input ?? {}) as IntegrationSetModeInput;
  if (!provider) throw new Error("integration_set_mode: provider required");
  if (!mode || !VALID_MODES.includes(mode as IntegrationMode)) {
    throw new Error(`integration_set_mode: mode must be one of ${VALID_MODES.join(" | ")}`);
  }
  const ctx = getTurnContext();
  const existing = await readState(ctx.userId, provider);
  if (!existing) {
    throw new Error(
      `integration_set_mode: ${provider} not configured. user must connect it first via the connect cli.`,
    );
  }
  const updated = await setMode(ctx.userId, provider, mode as IntegrationMode);
  return { ok: true, state: updated };
}

// ---------------------------------------------------------------------------
// integration_disconnect — revoke + mark row revoked
// ---------------------------------------------------------------------------

export const integrationDisconnectTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "integration_disconnect",
  description: `disconnect an integration: revoke the oauth grant at composio, mark the integration row revoked. donna will not be able to call provider tools afterward.

call this when the user says:
- "disconnect my gmail"
- "stop using my inbox"
- "log out of [provider]"

side effects: oauth revoke + status='revoked'. does NOT wipe historical audit log or any downstream data (those need a separate forget step).

returns: { ok, composio_account_id, error? }`,
  input_schema: {
    type: "object",
    properties: {
      provider: { type: "string", description: "provider slug, e.g. 'gmail'." },
    },
    required: ["provider"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

interface IntegrationDisconnectInput {
  provider?: string;
}

export async function integrationDisconnectHandler(input: unknown): Promise<unknown> {
  const { provider } = (input ?? {}) as IntegrationDisconnectInput;
  if (!provider) throw new Error("integration_disconnect: provider required");
  const ctx = getTurnContext();
  return disconnectIntegration(ctx.userId, provider);
}

// ---------------------------------------------------------------------------
// integration_connect — kick off oauth, return redirect url, fire-and-forget
// the background completion handler that flips state and acks proactively.
// ---------------------------------------------------------------------------

export const integrationConnectTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "integration_connect",
  description: `kick off oauth for a provider. returns { provider, redirect_url, status, mode }.

response shape:
- redirect_url: send this to the user via send_burst. they open it on their phone, complete oauth.
- status: "pending" — oauth in flight. donna will be told (proactively) when it lands.
- status: "already_connected" — provider was already linked; redirect_url is null. tell the user.

call this when the user says "connect my gmail", "hook up email", "link my inbox", etc.

mode (default smart_index):
- search_only: live search only, store nothing.
- smart_index: indexed minus banking/medical/legal. most copilot features active.
- full: indexed everything, full memory enrichment.

after calling: send a short send_burst with the redirect url and a one-liner that you'll ping them when oauth completes. do NOT block waiting — the background handler delivers a proactive ack on success.`,
  input_schema: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        description: "provider slug, e.g. 'gmail'.",
      },
      mode: {
        type: "string",
        enum: ["search_only", "smart_index", "full"],
        description: "consent depth. defaults to smart_index.",
      },
    },
    required: ["provider"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

interface IntegrationConnectInput {
  provider?: string;
  mode?: string;
}

interface IntegrationConnectResult {
  provider: string;
  status: "pending" | "already_connected";
  redirect_url: string | null;
  mode: IntegrationMode;
  composio_account_id?: string | null;
}

export async function integrationConnectHandler(
  input: unknown,
): Promise<IntegrationConnectResult> {
  const { provider, mode } = (input ?? {}) as IntegrationConnectInput;
  if (!provider) throw new Error("integration_connect: provider required");
  const desiredMode: IntegrationMode = (mode as IntegrationMode | undefined) ?? "smart_index";
  if (!VALID_MODES.includes(desiredMode)) {
    throw new Error(`integration_connect: mode must be one of ${VALID_MODES.join(" | ")}`);
  }

  const ctx = getTurnContext();

  const existing = await readState(ctx.userId, provider);
  if (existing && existing.status === "connected" && existing.composio_account_id) {
    return {
      provider,
      status: "already_connected",
      redirect_url: null,
      mode: existing.mode,
      composio_account_id: existing.composio_account_id,
    };
  }

  const composio = getComposio();
  const cr = await composio.toolkits.authorize(ctx.userId, provider);

  // detached: when oauth lands, flip state and fire a proactive ack to the
  // user's actual channel. dynamic import of brain.ts breaks the cycle
  // (tools/index → tools/integrations → brain → tools/index).
  void completeConnectionInBackground({
    userId: ctx.userId,
    source: ctx.source,
    provider,
    mode: desiredMode,
    cr,
  });

  return {
    provider,
    status: "pending",
    redirect_url: cr.redirectUrl ?? null,
    mode: desiredMode,
  };
}

interface ComposioAuthHandle {
  redirectUrl?: string | null;
  waitForConnection: (timeoutMs: number) => Promise<{ id: string; status?: string }>;
}

async function completeConnectionInBackground(args: {
  userId: string;
  source: "cli" | "whatsapp" | "imessage" | "proactive_worker";
  provider: string;
  mode: IntegrationMode;
  cr: ComposioAuthHandle;
}): Promise<void> {
  const { userId, source, provider, mode, cr } = args;
  try {
    const account = await cr.waitForConnection(CONNECT_TIMEOUT_MS);
    await upsertState({
      userId,
      provider,
      status: "connected",
      mode,
      composio_account_id: account.id,
    });

    if (source === "cli") {
      console.log(`[integrations] ${provider} connected for ${userId.slice(0, 8)} (cli — no proactive ack)`);
      return;
    }

    // proactive ack: brain composes a short burst, we deliver to the user's channel
    const [{ runProactiveTurn }, { deliverBurstToUser }, { randomUUID }] = await Promise.all([
      import("../brain.js"),
      import("../delivery/proactive.js"),
      import("node:crypto"),
    ]);
    const cause = {
      kind: "scheduled" as const,
      payload: { provider, mode } as Record<string, unknown>,
      set_at: new Date().toISOString(),
      schedule_id: randomUUID(),
      instruction: `${provider} just finished oauth and is now connected (mode=${mode}). this is the user's first connection of this provider — or a reconnect.`,
    };
    const result = await runProactiveTurn({
      userId,
      source,
      cause,
    });
    await deliverBurstToUser(userId, result.sends);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[integrations] background connect for ${provider}/${userId.slice(0, 8)} failed: ${msg}`,
    );
  }
}
