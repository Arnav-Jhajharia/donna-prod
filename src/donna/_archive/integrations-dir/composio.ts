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
