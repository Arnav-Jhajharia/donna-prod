// donna's voice surface. one livekit agent worker process.
//
// on each incoming room dispatch this entry runs once. the pipeline:
//   user mic -> silero VAD -> deepgram STT -> livekit turn detector
//             -> claude (our adapter) -> elevenlabs TTS -> user speakers
//
// v0 scope: no tool calls, no preemptive generation, no fast frontline.
// donna only speaks. those are layered in once the loop is proven.

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import {
  cli,
  defineAgent,
  voice,
  WorkerOptions,
  type JobContext,
  type JobProcess,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import { turnDetector } from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { ClaudeLLM } from './llm/anthropic.js';
import { VOICE_SYSTEM_PROMPT } from './prompt.js';
import { SesameTTS } from './tts/sesame.js';

export default defineAgent({
  // load silero VAD once per worker process. the model lives in proc.userData
  // so each room dispatch reuses it instead of paying the load cost on connect.
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    const vad = ctx.proc.userData.vad as silero.VAD;

    const session = new voice.AgentSession({
      vad,
      stt: new deepgram.STT({
        model: 'nova-3',
        interimResults: true,
        language: 'en',
      }),
      llm: new ClaudeLLM({ systemPrompt: VOICE_SYSTEM_PROMPT }),
      // sesame CSM-1B on a modal L4 GPU. set SESAME_WS_URL in .env to the
      // wss:// url of your deployed modal app (see voice/csm/modal_server.py).
      tts: new SesameTTS(),
      // semantic endpointing — knows the difference between a mid-sentence
      // pause and an actual end of turn. the qwen2.5-0.5b model, distilled
      // by livekit, runs on cpu.
      turnDetection: new turnDetector.EnglishModel(),
    });

    await session.start({
      agent: new voice.Agent({ instructions: VOICE_SYSTEM_PROMPT }),
      room: ctx.room,
    });

    // donna talks first. no "hi this is donna" — pick up like a friend would.
    // this is what kills the dead 2 seconds at call connect.
    session.say('hey, what\'s up');
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
