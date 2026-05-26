// donna's voice surface. one livekit agent worker process.
//
// architecture: GPT-realtime as the "voice fabric" + Claude brain as a function.
//
//   user audio  -> livekit room -> openai realtime (handles VAD, STT, LLM, TTS
//                                  natively, sub-500ms TTFB, real conversational
//                                  prosody)
//   ask_donna_brain function -> our src/donna/brain.ts runTurn() (claude tool
//                               loop, memory, integrations — the same brain that
//                               powers whatsapp and mobile chat)
//
// the voice persona prompt teaches gpt-realtime: handle small talk yourself,
// but call ask_donna_brain for anything substantive (memory, facts, actions).
// shared memory across surfaces lives in the chatMessages table.

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import {
  cli,
  defineAgent,
  llm,
  voice,
  WorkerOptions,
  type JobContext,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { runTurn } from '../src/donna/brain.js';
import { loadRecentMessages, saveMessages } from '../src/donna/chat.js';
import { VOICE_PERSONA_PROMPT } from './prompt.js';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    // identity flows in via the LiveKit participant. mintCallToken (in
    // src/donna/voice/livekit-token.ts) sets identity to the donna user UUID,
    // so we can use it directly here — no clerk roundtrip needed.
    const participant = await ctx.waitForParticipant();
    const userId = participant.identity;

    const model = new openai.realtime.RealtimeModel({
      // gpt-realtime is the latest s2s model. voice "marin" is one of the
      // warmer options — feels conversational, less broadcaster. swap if a
      // different voice character lands better.
      model: 'gpt-realtime',
      voice: 'marin',
    });

    const session = new voice.AgentSession({ llm: model });

    await session.start({
      agent: new voice.Agent({
        instructions: VOICE_PERSONA_PROMPT,
        tools: {
          ask_donna_brain: llm.tool({
            description:
              "Defer to donna's slow brain for any user request that needs memory, integrations, multi-step thinking, or commitment to a fact. " +
              "ALWAYS call this for: dates/times of events, contents of emails or messages, decisions involving people, actions on integrations (send, draft, schedule), anything the user might verify later. " +
              "While this is running, fill conversational space naturally (\"hmm hold on\", \"let me check\") — that's expected behavior.",
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description:
                    "The user's request, verbatim or lightly paraphrased. Pass enough context that the brain can act without the audio history.",
                },
              },
              required: ['query'],
            } as const,
            execute: async ({ query }) => {
              const history = await loadRecentMessages(userId);
              const userMsg: MessageParam = { role: 'user', content: query };
              const result = await runTurn([...history, userMsg], { userId: userId });

              // persist the voice turn so text donna (whatsapp, mobile chat)
              // sees what was said and replied on the call.
              await saveMessages(userId, [userMsg, ...result.newMessages]);

              // realtime model can only speak text — flatten the burst.
              // non-text bubble types (buttons, lists, cta_url) get dropped
              // here because they don't make sense on a voice call.
              const text = result.sends
                .filter((s) => s.type === 'text')
                .map((s) => s.text)
                .join(' ');

              return text || "i couldn't find an answer for that.";
            },
          }),
        },
      }),
      room: ctx.room,
    });

    // donna talks first. realtime model doesn't have a separate TTS to call
    // session.say() against — instead we ask it to generate a greeting via
    // its native s2s loop. instruction is concrete so the model emits exactly
    // this line rather than something longer.
    session.generateReply({
      instructions: "Greet the user with exactly: hey, what's up. Nothing else.",
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
