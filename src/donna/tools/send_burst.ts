import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import {
  type OutboundMessage,
  parseOutboundMessages,
} from "../messages.js";

// send_burst is the terminator: every turn ends with one of these.
// the items in `messages` are EXACTLY what the user sees. mix freely —
// three texts + a button is fine, image + caption + delay + list is fine.
// nothing else the model emits (raw text blocks, reasoning) is ever shown.
export const sendBurstTool: Tool = {
  name: "send_burst",
  description: `the only way to talk to the user. pass an array of one or more messages; each becomes a separate bubble in order.

each item has a "type" discriminator. mix freely in any order, any count:
- text:     {type:"text", text}
- buttons:  {type:"buttons", text, buttons:[{id,label}]}        — 1-3 quick replies, label ≤20 chars
- list:     {type:"list", text, button_label, sections:[{rows:[{id,title,description?}]}]}  — for 4+ choices
- cta_url:  {type:"cta_url", text, label, url}                  — text + link button (use for mobile-app deep links)
- image:    {type:"image", url, caption?}
- document: {type:"document", url, filename, caption?}
- video:    {type:"video", url, caption?}
- audio:    {type:"audio", url}
- delay:    {type:"delay", seconds}                             — pace between bubbles, 0.1-30s

never put reasoning into any text or caption — these are user-visible.`,
  input_schema: {
    type: "object",
    properties: {
      messages: {
        type: "array",
        minItems: 1,
        description: "one or more outbound items, in order.",
        items: {
          oneOf: [
            {
              type: "object",
              properties: {
                type: { const: "text" },
                text: { type: "string", minLength: 1, maxLength: 4096 },
              },
              required: ["type", "text"],
            },
            {
              type: "object",
              properties: {
                type: { const: "buttons" },
                text: { type: "string", minLength: 1, maxLength: 1024 },
                buttons: {
                  type: "array",
                  minItems: 1,
                  maxItems: 3,
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string", minLength: 1, maxLength: 256 },
                      label: { type: "string", minLength: 1, maxLength: 20 },
                    },
                    required: ["id", "label"],
                  },
                },
              },
              required: ["type", "text", "buttons"],
            },
            {
              type: "object",
              properties: {
                type: { const: "list" },
                text: { type: "string", minLength: 1, maxLength: 1024 },
                button_label: { type: "string", minLength: 1, maxLength: 20 },
                header: { type: "string", minLength: 1, maxLength: 60 },
                footer: { type: "string", minLength: 1, maxLength: 60 },
                sections: {
                  type: "array",
                  minItems: 1,
                  maxItems: 10,
                  items: {
                    type: "object",
                    properties: {
                      title: { type: "string", minLength: 1, maxLength: 24 },
                      rows: {
                        type: "array",
                        minItems: 1,
                        maxItems: 10,
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string", minLength: 1, maxLength: 200 },
                            title: { type: "string", minLength: 1, maxLength: 24 },
                            description: { type: "string", minLength: 1, maxLength: 72 },
                          },
                          required: ["id", "title"],
                        },
                      },
                    },
                    required: ["rows"],
                  },
                },
              },
              required: ["type", "text", "button_label", "sections"],
            },
            {
              type: "object",
              properties: {
                type: { const: "cta_url" },
                text: { type: "string", minLength: 1, maxLength: 1024 },
                label: { type: "string", minLength: 1, maxLength: 20 },
                url: { type: "string", minLength: 1, maxLength: 2000 },
              },
              required: ["type", "text", "label", "url"],
            },
            {
              type: "object",
              properties: {
                type: { const: "image" },
                url: { type: "string", minLength: 1, maxLength: 2000 },
                caption: { type: "string", minLength: 1, maxLength: 1024 },
              },
              required: ["type", "url"],
            },
            {
              type: "object",
              properties: {
                type: { const: "document" },
                url: { type: "string", minLength: 1, maxLength: 2000 },
                filename: { type: "string", minLength: 1, maxLength: 240 },
                caption: { type: "string", minLength: 1, maxLength: 1024 },
              },
              required: ["type", "url", "filename"],
            },
            {
              type: "object",
              properties: {
                type: { const: "video" },
                url: { type: "string", minLength: 1, maxLength: 2000 },
                caption: { type: "string", minLength: 1, maxLength: 1024 },
              },
              required: ["type", "url"],
            },
            {
              type: "object",
              properties: {
                type: { const: "audio" },
                url: { type: "string", minLength: 1, maxLength: 2000 },
              },
              required: ["type", "url"],
            },
            {
              type: "object",
              properties: {
                type: { const: "delay" },
                seconds: { type: "number", minimum: 0.1, maximum: 30 },
              },
              required: ["type", "seconds"],
            },
          ],
        },
      },
    },
    required: ["messages"],
  },
};

export interface SendBurstInput {
  messages: OutboundMessage[];
}

// the handler acknowledges. actual delivery is the caller's job — they read
// the parsed messages from `extractMessages(tu.input)` and ship them.
export async function sendBurstHandler(input: unknown): Promise<string> {
  const messages = parseOutboundMessages(input);
  return `sent ${messages.length} message(s).`;
}

export function extractMessages(input: unknown): OutboundMessage[] {
  return parseOutboundMessages(input);
}
