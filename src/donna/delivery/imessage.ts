// linq imessage delivery channel — parallel to delivery/whatsapp.ts.
//
// the brain emits visible sends via send_burst (just strings); server.ts
// dispatches them through this channel. for inbound replies we already have
// a chat_id from the webhook envelope, so prefer POST /chats/{id}/messages
// (cheap, no recipient resolution). fallback to POST /chats which creates a
// new chat from from+to.

import {
  createChat,
  sendMessageToChat,
  startTyping as linqStartTyping,
  stopTyping as linqStopTyping,
  addReaction,
  getLinqConfig,
  type LinqMessageContent,
  type LinqMessagePart,
} from "../integrations/linq.js";

export interface IMessageSendArgs {
  toPhone: string; // e.164
  body: string;
  chatId?: string | null; // when replying to an inbound; preferred path
  replyToMessageId?: string | null;
  idempotencyKey?: string;
}

export interface IMessageSendResult {
  chatId: string;
  messageId: string | null;
}

export class IMessageChannel {
  private get fromNumber(): string {
    return getLinqConfig().fromNumber;
  }

  async send(args: IMessageSendArgs): Promise<IMessageSendResult> {
    const parts: LinqMessagePart[] = [{ type: "text", value: args.body }];
    const message: LinqMessageContent = { parts };
    if (args.replyToMessageId) {
      message.reply_to = { message_id: args.replyToMessageId };
    }
    if (args.idempotencyKey) message.idempotency_key = args.idempotencyKey;

    if (args.chatId) {
      const sent = await sendMessageToChat(args.chatId, message);
      return { chatId: args.chatId, messageId: sent.id ?? null };
    }

    // first contact — POST /chats. linq disallows links in the first message;
    // brain output already avoids links by default, but if a link slips in
    // here the api will 4xx and the dispatcher will surface it.
    const chat = await createChat({
      from: this.fromNumber,
      to: [args.toPhone],
      message,
    });
    return { chatId: chat.id, messageId: chat.last_message?.id ?? null };
  }

  async sendTyping(chatId: string | null): Promise<void> {
    if (!chatId) return;
    try {
      await linqStartTyping(chatId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[imessage] start_typing failed (${msg}) — non-fatal`);
    }
  }

  async stopTyping(chatId: string | null): Promise<void> {
    if (!chatId) return;
    try {
      await linqStopTyping(chatId);
    } catch {
      // best-effort
    }
  }

  async sendReaction(
    messageId: string | null,
    reaction: string,
  ): Promise<void> {
    if (!messageId || !reaction) return;
    try {
      await addReaction(messageId, reaction);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[imessage] add_reaction failed (${msg}) — non-fatal`);
    }
  }
}
