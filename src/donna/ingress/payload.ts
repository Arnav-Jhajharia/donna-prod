// transport-agnostic inbound payload. every platform adapter normalizes its
// raw webhook data into IngressPayload before handing it to the brain. the
// brain never imports platform-specific code.

export interface DocumentPayload {
  fileBytes: Uint8Array;
  filename: string;
  mimeType: string;
}

export interface ImagePayload {
  fileBytes: Uint8Array;
  mimeType: string;
}

export interface VoicePayload {
  fileBytes: Uint8Array;
  mimeType: string;
}

export type MessageType = "text" | "voice" | "image" | "document";
export type Source = "whatsapp" | "web" | "api" | "imessage";

export interface IngressPayload {
  userId: string; // resolved before payload is built
  phone: string;
  message: string | null; // text body or caption
  messageType: MessageType;
  document?: DocumentPayload;
  image?: ImagePayload;
  voice?: VoicePayload;
  source: Source;
  // platform metadata (opaque to brain, passed through for delivery)
  platformMessageId: string | null; // wa_message_id, linq message id, etc.
  platformProfileName: string | null;
  replyToId: string | null; // swipe-reply context
  chatId?: string | null; // linq chat id when source = "imessage"
}
