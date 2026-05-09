import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

export type ProactiveCauseKind =
  | "scheduled"
  | "scan_gmail"
  | "gmail_event"
  | "watch_fired"
  | "world_tick"
  | "subscriptions_onboarding"
  | "subscription_detected";

export interface ProactiveCause {
  kind: ProactiveCauseKind;
  payload: Record<string, unknown>;
  set_at: string;
  schedule_id: string;
  instruction: string;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeXml(s);
}

export function renderCauseXml(cause: ProactiveCause): string {
  const attrs = [
    `kind="${escapeAttr(cause.kind)}"`,
    `set_at="${escapeAttr(cause.set_at)}"`,
    `schedule_id="${escapeAttr(cause.schedule_id)}"`,
  ];
  if (Object.keys(cause.payload).length > 0) {
    attrs.push(`payload="${escapeAttr(JSON.stringify(cause.payload))}"`);
  }
  return `<proactive_cause ${attrs.join(" ")}>${escapeXml(cause.instruction)}</proactive_cause>`;
}

export function synthesizeCauseMessage(cause: ProactiveCause): MessageParam {
  return {
    role: "user",
    content: [{ type: "text", text: renderCauseXml(cause) }],
  };
}
