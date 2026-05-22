// the outbound vocabulary — every type of bubble donna can emit.
//
// a burst is `OutboundMessage[]`. heterogeneous, any order, any count.
// three texts + a button is fine. image + caption + delay + list is fine.
// the brain just passes the array through; rendering is the channel's job
// (cli, whatsapp, mobile app — each renders these the same types differently).
//
// every type carries hard limits matching the strictest downstream channel
// we expect to render to (whatsapp interactive messages). enforcing them at
// the schema means claude gets a 400-style tool_result when she violates,
// and self-corrects, rather than us silently truncating at render time.

export interface TextMessage {
  type: "text";
  text: string;
}

export interface QuickReplyButton {
  id: string;
  label: string;
}

export interface ButtonMessage {
  type: "buttons";
  text: string;
  buttons: QuickReplyButton[];
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export interface ListSection {
  title?: string;
  rows: ListRow[];
}

export interface ListMessage {
  type: "list";
  text: string;
  button_label: string;
  sections: ListSection[];
  header?: string;
  footer?: string;
}

export interface CtaUrlMessage {
  type: "cta_url";
  text: string;
  label: string;
  url: string;
}

export interface ImageMessage {
  type: "image";
  url: string;
  caption?: string;
}

export interface DocumentMessage {
  type: "document";
  url: string;
  filename: string;
  caption?: string;
}

export interface VideoMessage {
  type: "video";
  url: string;
  caption?: string;
}

export interface AudioMessage {
  type: "audio";
  url: string;
}

export interface DelayMessage {
  type: "delay";
  seconds: number;
}

export type OutboundMessage =
  | TextMessage
  | ButtonMessage
  | ListMessage
  | CtaUrlMessage
  | ImageMessage
  | DocumentMessage
  | VideoMessage
  | AudioMessage
  | DelayMessage;

// ---------- runtime validation ----------
// the json schema on the tool catches most violations before claude's call
// even lands. but the model can still produce shapes the schema permits but
// the runtime can't render. these validators are the second line: malformed
// items get dropped, the rest of the burst still ships.

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strLen(v: unknown, min: number, max: number): string | null {
  if (typeof v !== "string") return null;
  if (v.length < min || v.length > max) return null;
  return v;
}

function optStrLen(v: unknown, min: number, max: number): string | undefined {
  if (v == null) return undefined;
  return strLen(v, min, max) ?? undefined;
}

function parseQuickReplyButton(v: unknown): QuickReplyButton | null {
  if (!isObject(v)) return null;
  const id = strLen(v.id, 1, 256);
  const label = strLen(v.label, 1, 20);
  if (!id || !label) return null;
  return { id, label };
}

function parseListRow(v: unknown): ListRow | null {
  if (!isObject(v)) return null;
  const id = strLen(v.id, 1, 200);
  const title = strLen(v.title, 1, 24);
  if (!id || !title) return null;
  return { id, title, description: optStrLen(v.description, 1, 72) };
}

function parseListSection(v: unknown): ListSection | null {
  if (!isObject(v) || !Array.isArray(v.rows)) return null;
  const rows: ListRow[] = [];
  for (const r of v.rows) {
    const row = parseListRow(r);
    if (row) rows.push(row);
  }
  if (rows.length === 0) return null;
  return { rows, title: optStrLen(v.title, 1, 24) };
}

export function parseOutboundMessage(v: unknown): OutboundMessage | null {
  if (!isObject(v)) return null;
  switch (v.type) {
    case "text": {
      const text = strLen(v.text, 1, 4096);
      return text ? { type: "text", text } : null;
    }
    case "buttons": {
      const text = strLen(v.text, 1, 1024);
      if (!text || !Array.isArray(v.buttons)) return null;
      const buttons: QuickReplyButton[] = [];
      for (const b of v.buttons) {
        const btn = parseQuickReplyButton(b);
        if (btn) buttons.push(btn);
      }
      if (buttons.length < 1 || buttons.length > 3) return null;
      return { type: "buttons", text, buttons };
    }
    case "list": {
      const text = strLen(v.text, 1, 1024);
      const button_label = strLen(v.button_label, 1, 20);
      if (!text || !button_label || !Array.isArray(v.sections)) return null;
      const sections: ListSection[] = [];
      let totalRows = 0;
      for (const s of v.sections) {
        const section = parseListSection(s);
        if (section) {
          sections.push(section);
          totalRows += section.rows.length;
        }
      }
      if (sections.length === 0 || totalRows > 10) return null;
      return {
        type: "list",
        text,
        button_label,
        sections,
        header: optStrLen(v.header, 1, 60),
        footer: optStrLen(v.footer, 1, 60),
      };
    }
    case "cta_url": {
      const text = strLen(v.text, 1, 1024);
      const label = strLen(v.label, 1, 20);
      const url = strLen(v.url, 1, 2000);
      if (!text || !label || !url) return null;
      return { type: "cta_url", text, label, url };
    }
    case "image": {
      const url = strLen(v.url, 1, 2000);
      if (!url) return null;
      return { type: "image", url, caption: optStrLen(v.caption, 1, 1024) };
    }
    case "document": {
      const url = strLen(v.url, 1, 2000);
      const filename = strLen(v.filename, 1, 240);
      if (!url || !filename) return null;
      return {
        type: "document",
        url,
        filename,
        caption: optStrLen(v.caption, 1, 1024),
      };
    }
    case "video": {
      const url = strLen(v.url, 1, 2000);
      if (!url) return null;
      return { type: "video", url, caption: optStrLen(v.caption, 1, 1024) };
    }
    case "audio": {
      const url = strLen(v.url, 1, 2000);
      if (!url) return null;
      return { type: "audio", url };
    }
    case "delay": {
      const s = v.seconds;
      if (typeof s !== "number" || s < 0.1 || s > 30) return null;
      return { type: "delay", seconds: s };
    }
    default:
      return null;
  }
}

// pull `{ messages: [...] }` out of a tool input and validate each item.
// malformed items are dropped; well-formed items pass through in order.
export function parseOutboundMessages(input: unknown): OutboundMessage[] {
  const obj = (input ?? {}) as { messages?: unknown };
  if (!Array.isArray(obj.messages)) return [];
  const out: OutboundMessage[] = [];
  for (const m of obj.messages) {
    const parsed = parseOutboundMessage(m);
    if (parsed) out.push(parsed);
  }
  return out;
}
