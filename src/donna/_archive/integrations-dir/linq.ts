// linq partner api v3 client. https://docs.linqapp.com
//
// thin fetch wrapper. composio.ts uses an SDK; we keep linq SDK-free to avoid
// a new dependency for what is fundamentally a few REST calls. throws with the
// linq error code embedded so callers can branch on it.

const DEFAULT_BASE = "https://api.linqapp.com/api/partner/v3";

export interface LinqConfig {
  apiKey: string;
  fromNumber: string; // e.164, e.g. +12025551234
  webhookSecret: string | null; // signing secret returned by POST /webhook-subscriptions
  baseUrl: string;
}

let _config: LinqConfig | null = null;

export function getLinqConfig(): LinqConfig {
  if (_config) return _config;
  const apiKey = process.env.LINQ_API_KEY;
  const fromNumber = process.env.LINQ_FROM_NUMBER;
  if (!apiKey) throw new Error("LINQ_API_KEY not set");
  if (!fromNumber) throw new Error("LINQ_FROM_NUMBER not set (e.g. +12025551234)");
  _config = {
    apiKey,
    fromNumber,
    webhookSecret: process.env.LINQ_WEBHOOK_SECRET || null,
    baseUrl: process.env.LINQ_BASE_URL || DEFAULT_BASE,
  };
  return _config;
}

interface LinqErrorBody {
  error?: { code?: number | string; message?: string } | string;
  message?: string;
}

export class LinqError extends Error {
  readonly status: number;
  readonly code: string | number | null;
  constructor(status: number, code: string | number | null, message: string) {
    super(`linq ${status}${code ? ` [${code}]` : ""}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

export async function linqRequest<T = unknown>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const cfg = getLinqConfig();
  const url = path.startsWith("http") ? path : `${cfg.baseUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    Accept: "application/json",
  };
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const resp = await fetch(url, { method, headers, body: payload });

  if (resp.status === 204) return undefined as T;

  const text = await resp.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!resp.ok) {
    const errBody = (parsed ?? {}) as LinqErrorBody;
    const errObj = typeof errBody.error === "object" ? errBody.error : null;
    const code = errObj?.code ?? null;
    const msg =
      errObj?.message ??
      (typeof errBody.error === "string" ? errBody.error : null) ??
      errBody.message ??
      text.slice(0, 200) ??
      resp.statusText;
    throw new LinqError(resp.status, code, msg);
  }

  return (parsed ?? {}) as T;
}

// ── thin endpoint helpers used by delivery + tools ──────────────────────────

export interface LinqMessagePart {
  type: "text" | "media" | "link";
  value?: string;
  url?: string;
  attachment_id?: string;
}

export interface LinqMessageContent {
  parts: LinqMessagePart[];
  reply_to?: { message_id: string; part_index?: number };
  idempotency_key?: string;
  effect?: { type: "screen" | "bubble"; name: string };
  preferred_service?: "iMessage" | "RCS" | "SMS";
}

export interface LinqHandle {
  handle?: string;
  id?: string;
  is_me?: boolean;
  service?: "iMessage" | "RCS" | "SMS";
  status?: string;
}

export interface LinqMessage {
  id: string;
  parts?: LinqMessagePart[];
  sent_at?: string;
  delivered_at?: string | null;
  read_at?: string | null;
  service?: string;
  direction?: "inbound" | "outbound";
  sender_handle?: LinqHandle;
}

export interface LinqChat {
  id: string;
  is_group?: boolean;
  participants?: LinqHandle[];
  owner_handle?: LinqHandle;
  last_message?: LinqMessage;
  health_status?: { status: string; updated_at?: string };
}

export interface CreateChatBody {
  from: string;
  to: string[];
  message: LinqMessageContent;
}

export async function createChat(body: CreateChatBody): Promise<LinqChat> {
  return linqRequest<LinqChat>("POST", "/chats", body);
}

export async function sendMessageToChat(
  chatId: string,
  message: LinqMessageContent,
): Promise<LinqMessage> {
  const resp = await linqRequest<{ message?: LinqMessage } & LinqMessage>(
    "POST",
    `/chats/${encodeURIComponent(chatId)}/messages`,
    { message },
  );
  return resp.message ?? (resp as LinqMessage);
}

export async function listChats(params?: {
  limit?: number;
  cursor?: string;
}): Promise<{ data: LinqChat[]; next_cursor?: string | null }> {
  const search = new URLSearchParams();
  if (params?.limit) search.set("limit", String(params.limit));
  if (params?.cursor) search.set("cursor", params.cursor);
  const qs = search.toString();
  return linqRequest("GET", `/chats${qs ? `?${qs}` : ""}`);
}

export async function listChatMessages(
  chatId: string,
  params?: { limit?: number; cursor?: string },
): Promise<{ data: LinqMessage[]; next_cursor?: string | null }> {
  const search = new URLSearchParams();
  if (params?.limit) search.set("limit", String(params.limit));
  if (params?.cursor) search.set("cursor", params.cursor);
  const qs = search.toString();
  return linqRequest(
    "GET",
    `/chats/${encodeURIComponent(chatId)}/messages${qs ? `?${qs}` : ""}`,
  );
}

export async function startTyping(chatId: string): Promise<void> {
  await linqRequest("POST", `/chats/${encodeURIComponent(chatId)}/typing/start`);
}

export async function stopTyping(chatId: string): Promise<void> {
  await linqRequest("POST", `/chats/${encodeURIComponent(chatId)}/typing/stop`);
}

export async function addReaction(
  messageId: string,
  reaction: string,
): Promise<void> {
  await linqRequest("POST", `/messages/${encodeURIComponent(messageId)}/reactions`, {
    reaction,
  });
}

export async function checkImessageCapability(
  handle: string,
): Promise<{ supported: boolean }> {
  return linqRequest("POST", "/capability/check-imessage", { handle });
}

export interface WebhookSubscription {
  id: string;
  target_url: string;
  subscribed_events: string[];
  signing_secret?: string;
  active?: boolean;
  created_at?: string;
}

export async function createWebhookSubscription(body: {
  target_url: string;
  subscribed_events: string[];
}): Promise<WebhookSubscription> {
  return linqRequest("POST", "/webhook-subscriptions", body);
}

export async function listWebhookSubscriptions(): Promise<{
  data: WebhookSubscription[];
}> {
  return linqRequest("GET", "/webhook-subscriptions");
}
