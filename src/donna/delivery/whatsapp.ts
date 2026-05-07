// whatsapp cloud api channel implementation. ported from old repo's
// delivery/whatsapp.py.
//
// renders OutboundMessage objects into WA API payloads and POSTs them.
//
// WA constraints encoded here (not in message types):
//   - button titles truncated to 20 chars
//   - CTAMessage with >3 buttons auto-degrades to ListMessage (single section)
//   - list rows truncated to 24 chars (WA limit)
//   - typing indicator: mark_as_read with typing_on (WA Cloud API ~2025)

import { getConfig } from "../config.js";
import {
  assertAudioMessage,
  assertDocumentMessage,
  assertImageMessage,
  type AudioMessage,
  type CTAMessage,
  type CTAUrlMessage,
  type DocumentMessage,
  type ImageMessage,
  type ListMessage,
  type OutboundMessage,
  type OutboundOrDelay,
  type Section,
  type TextMessage,
} from "./messages.js";

const _BUTTON_TITLE_MAX = 20;
const _LIST_ROW_TITLE_MAX = 24;

// ── channel capabilities (consumed by the system prompt) ─────────────────────
export const CAPABILITIES_PROMPT = `# HOW YOU USE WHATSAPP

Text is default. Use another widget only when it makes the next action cheaper or the answer clearer. The best turn is usually one item. Max 3 non-delay items per turn.

- text: default. raw urls auto-linkify.

- cta: text plus 1-3 reply buttons. only for closed choices like yes/no/confirm/cancel. never for open questions.

- cta_url: text plus one tap-to-open button. for oauth, external links, forms, dashboards, or anything that navigates away.

- list: scrollable options. only when there are 4+ parallel choices the user will scan. rare.

- image: use when the answer is visual. requires a publicly accessible url from available media. never invent one.

- document: file delivery. requires url and filename. use when the user will save or forward it.

- voice_response: this is the ONLY way to deliver a voice note. include it as an item in the send_burst messages array (place it first), with one or more text items after it. the text bodies are concatenated and synthesized as a single whatsapp voice note. saying "here is a voice message" in text without the voice_response item sends a text bubble, not voice. voice is RARE — text is the default reply mode in every turn, including when the inbound was a voice note (the user dictated for their own convenience, that is not a request for voice back). use voice_response only when (a) the user explicitly asks for it ("send me a voice", "voice me", "say it out loud"), or (b) the reply is personal and emotionally weighted in a way text would flatten — a pep talk, a soft check-in at a hard moment, a longform reflective reply. do not use for factual lists, links, tables, anything the user will scan visually, or short operational replies. cannot combine with cta, cta_url, list, image, or document. on any synthesis failure the burst falls back to text automatically.

- delay: a 0.5-4s beat before the next item. only when pacing helps. never first or last.

- reply-to: use reply_to_message_id when pulling an earlier message back into focus.

widgets are not decoration. pick the one that makes the next user action cheapest. when in doubt, plain text wins.`;

interface ListPayloadInteractive {
  type: "interactive";
  interactive: {
    type: "list";
    body: { text: string };
    action: {
      button: string;
      sections: { title: string; rows: { id: string; title: string }[] }[];
    };
  };
}

export class WhatsAppChannel {
  private get cfg() {
    return getConfig().whatsapp;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.token}`,
      "Content-Type": "application/json",
    };
  }

  private get base(): string {
    return `https://graph.facebook.com/${this.cfg.graphVersion}`;
  }

  private get messagesUrl(): string {
    return `${this.base}/${this.cfg.phoneNumberId}/messages`;
  }

  private get mediaUrl(): string {
    return `${this.base}/${this.cfg.phoneNumberId}/media`;
  }

  // ── public ─────────────────────────────────────────────────────────────────

  async uploadMedia(
    fileBytes: Uint8Array | Buffer,
    mimeType: string = "image/png",
  ): Promise<string> {
    const form = new FormData();
    const blob = new Blob([fileBytes as BlobPart], { type: mimeType });
    form.append("file", blob, "upload.bin");
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    const resp = await fetch(this.mediaUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.token}` },
      body: form,
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error(
        `WhatsApp /media upload error ${resp.status}: ${text.slice(0, 200)}`,
      );
      throw new Error(`whatsapp media upload failed: ${resp.status}`);
    }
    const body = (await resp.json()) as { id?: string };
    if (!body.id) {
      throw new Error(`WhatsApp /media response missing id: ${JSON.stringify(body)}`);
    }
    return body.id;
  }

  async send(phone: string, message: OutboundMessage): Promise<string | null> {
    const payload = this.render(phone, message);
    const data = await this.post(payload);
    const messages = (data.messages ?? []) as { id?: string }[];
    return messages[0]?.id ?? null;
  }

  async sendMany(
    phone: string,
    messages: OutboundOrDelay[],
  ): Promise<string[]> {
    const wamids: string[] = [];
    for (const msg of messages) {
      if (msg.kind === "delay") {
        await new Promise((r) => setTimeout(r, msg.seconds * 1000));
        continue;
      }
      const id = await this.send(phone, msg);
      if (id) wamids.push(id);
    }
    return wamids;
  }

  async sendReaction(
    phone: string,
    messageId: string | null,
    emoji: string,
  ): Promise<void> {
    if (!messageId || !emoji) return;
    const payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "reaction",
      reaction: { message_id: messageId, emoji },
    };
    try {
      await this.post(payload);
    } catch {
      console.warn(`send_reaction failed for ${phone.slice(0, 6)} — non-fatal`);
    }
  }

  async sendTyping(phone: string, messageId: string | null): Promise<void> {
    if (!messageId) {
      console.warn("send_typing: message_id required — skipping");
      return;
    }
    const payload = {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    };
    try {
      await this.post(payload);
    } catch {
      console.warn(`send_typing failed for ${phone} — non-fatal`);
    }
  }

  // ── render ─────────────────────────────────────────────────────────────────

  private render(phone: string, message: OutboundMessage): Record<string, unknown> {
    const base: Record<string, unknown> = { messaging_product: "whatsapp", to: phone };
    if (message.replyToMessageId) {
      base.context = { message_id: message.replyToMessageId };
    }

    switch (message.kind) {
      case "text":
        return this.renderText(base, message);
      case "cta":
        return this.renderCTA(base, message, phone);
      case "cta_url":
        return this.renderCTAUrl(base, message);
      case "list":
        return this.renderList(base, message);
      case "image":
        return this.renderImage(base, message);
      case "audio":
        return this.renderAudio(base, message);
      case "document":
        return this.renderDocument(base, message);
    }
  }

  private renderText(base: Record<string, unknown>, m: TextMessage): Record<string, unknown> {
    return { ...base, type: "text", text: { body: m.body } };
  }

  private renderCTA(
    base: Record<string, unknown>,
    m: CTAMessage,
    phone: string,
  ): Record<string, unknown> {
    if (m.buttons.length > 3) {
      const degraded: ListMessage = {
        kind: "list",
        body: m.body,
        buttonLabel: "Choose one",
        sections: [{ title: "Options", rows: m.buttons }],
        replyToMessageId: m.replyToMessageId,
      };
      return this.render(phone, degraded);
    }
    return {
      ...base,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: m.body },
        action: {
          buttons: m.buttons.map((btn) => ({
            type: "reply",
            reply: { id: btn.id, title: btn.title.slice(0, _BUTTON_TITLE_MAX) },
          })),
        },
      },
    };
  }

  private renderCTAUrl(
    base: Record<string, unknown>,
    m: CTAUrlMessage,
  ): Record<string, unknown> {
    return {
      ...base,
      type: "interactive",
      interactive: {
        type: "cta_url",
        body: { text: m.body },
        action: {
          name: "cta_url",
          parameters: {
            display_text: m.displayText.slice(0, _BUTTON_TITLE_MAX),
            url: m.url,
          },
        },
      },
    };
  }

  private renderList(
    base: Record<string, unknown>,
    m: ListMessage,
  ): Record<string, unknown> {
    const interactive: ListPayloadInteractive["interactive"] = {
      type: "list",
      body: { text: m.body },
      action: {
        button: m.buttonLabel.slice(0, _BUTTON_TITLE_MAX),
        sections: m.sections.map((section: Section) => ({
          title: section.title,
          rows: section.rows.map((row) => ({
            id: row.id,
            title: row.title.slice(0, _LIST_ROW_TITLE_MAX),
          })),
        })),
      },
    };
    return { ...base, type: "interactive", interactive };
  }

  private renderImage(
    base: Record<string, unknown>,
    m: ImageMessage,
  ): Record<string, unknown> {
    assertImageMessage(m);
    const image: Record<string, unknown> = m.mediaId
      ? { id: m.mediaId }
      : { link: m.url };
    if (m.caption) image.caption = m.caption;
    return { ...base, type: "image", image };
  }

  private renderAudio(
    base: Record<string, unknown>,
    m: AudioMessage,
  ): Record<string, unknown> {
    assertAudioMessage(m);
    const audio: Record<string, unknown> = m.mediaId
      ? { id: m.mediaId }
      : { link: m.url };
    if (m.voice) audio.voice = true;
    return { ...base, type: "audio", audio };
  }

  private renderDocument(
    base: Record<string, unknown>,
    m: DocumentMessage,
  ): Record<string, unknown> {
    assertDocumentMessage(m);
    const doc: Record<string, unknown> = m.mediaId
      ? { id: m.mediaId }
      : { link: m.url };
    doc.filename = m.filename;
    if (m.caption) doc.caption = m.caption;
    return { ...base, type: "document", document: doc };
  }

  // ── http ───────────────────────────────────────────────────────────────────

  private async post(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const resp = await fetch(this.messagesUrl, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error(
        `WhatsApp API error ${resp.status}: ${text.slice(0, 200)}`,
      );
      throw new Error(`whatsapp post failed: ${resp.status}`);
    }
    return (await resp.json()) as Record<string, unknown>;
  }
}
