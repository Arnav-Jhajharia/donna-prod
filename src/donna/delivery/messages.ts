// abstract outbound message types — what the brain produces. these are
// channel-agnostic. each channel implementation translates them into
// platform-specific payloads.
//
// each channel also exports a CAPABILITIES_PROMPT describing what it
// supports, which the system prompt consumes so the model knows what
// it can emit.

export interface TextMessage {
  kind: "text";
  body: string;
  replyToMessageId?: string | null;
}

export interface Button {
  id: string; // payload echoed back when tapped
  title: string; // display label — WA limits 20 chars, channel layer truncates
}

export interface CTAMessage {
  kind: "cta";
  body: string;
  buttons: Button[];
  replyToMessageId?: string | null;
}

export interface CTAUrlMessage {
  kind: "cta_url";
  body: string;
  displayText: string;
  url: string;
  replyToMessageId?: string | null;
}

export interface Section {
  title: string;
  rows: Button[];
}

export interface ListMessage {
  kind: "list";
  body: string;
  buttonLabel: string;
  sections: Section[];
  replyToMessageId?: string | null;
}

export interface ImageMessage {
  kind: "image";
  url?: string;
  mediaId?: string; // takes precedence over url
  caption?: string;
  replyToMessageId?: string | null;
}

export interface AudioMessage {
  kind: "audio";
  url?: string;
  mediaId?: string;
  voice?: boolean; // WA native voice-note flag (requires ogg/opus)
  replyToMessageId?: string | null;
}

export interface DocumentMessage {
  kind: "document";
  filename: string;
  url?: string;
  mediaId?: string;
  caption?: string;
  replyToMessageId?: string | null;
}

export interface Delay {
  kind: "delay";
  seconds: number;
}

export type OutboundMessage =
  | TextMessage
  | CTAMessage
  | CTAUrlMessage
  | ListMessage
  | ImageMessage
  | AudioMessage
  | DocumentMessage;

export type OutboundOrDelay = OutboundMessage | Delay;

export function assertImageMessage(m: ImageMessage): void {
  const hasUrl = !!m.url;
  const hasMedia = !!m.mediaId;
  if (hasUrl === hasMedia) {
    throw new Error("ImageMessage requires exactly one of url or mediaId");
  }
}

export function assertAudioMessage(m: AudioMessage): void {
  const hasUrl = !!m.url;
  const hasMedia = !!m.mediaId;
  if (hasUrl === hasMedia) {
    throw new Error("AudioMessage requires exactly one of url or mediaId");
  }
}

export function assertDocumentMessage(m: DocumentMessage): void {
  const hasUrl = !!m.url;
  const hasMedia = !!m.mediaId;
  if (hasUrl === hasMedia) {
    throw new Error("DocumentMessage requires exactly one of url or mediaId");
  }
  if (!m.filename) throw new Error("DocumentMessage requires filename");
}
