// donna's voice surface. one livekit agent worker process.
//
// pipeline:
//   user mic -> silero VAD -> deepgram STT -> livekit turn detector
//             -> layered claude (haiku filler + opus brain)
//             -> {cartesia | elevenlabs | sesame} TTS -> user speakers
//
// TTS provider is selected at boot via VOICE_TTS_PROVIDER env var. see
// selectTTS() below for the three options.

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
import { tts } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import { turnDetector } from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { LayeredClaudeLLM } from './llm/layered.js';
import { VOICE_SYSTEM_PROMPT } from './prompt.js';
import { CartesiaTTS } from './tts/cartesia.js';
import { SesameTTS } from './tts/sesame.js';

// pick the TTS provider via VOICE_TTS_PROVIDER env var. one runtime, three
// engines, zero code changes to swap:
//   cartesia (default)  — sonic-3 over wss. ~100ms TTFB. natural conversation.
//   elevenlabs          — flash v2.5. ~75ms TTFB. polished broadcaster.
//   sesame              — CSM-1B on modal. closer to maya. requires
//                         voice/csm/modal_server.py deployed and a warm
//                         SESAME_WS_URL.
function selectTTS(): tts.TTS {
  const provider = (process.env.VOICE_TTS_PROVIDER ?? 'cartesia').toLowerCase();
  switch (provider) {
    case 'elevenlabs':
      return new elevenlabs.TTS({
        model: 'eleven_flash_v2_5',
        voiceId: process.env.ELEVENLABS_VOICE_ID,
      });
    case 'sesame':
      return new SesameTTS();
    case 'cartesia':
      return new CartesiaTTS();
    default:
      throw new Error(
        `unknown VOICE_TTS_PROVIDER=${provider}. ` +
          `expected one of: cartesia, elevenlabs, sesame`,
      );
  }
}

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
      // v3: two-tier brain. haiku 4.5 emits a conversational filler within
      // ~500ms while opus 4.7 generates the real answer in parallel. user
      // perceives an "alive" response immediately instead of dead air.
      llm: new LayeredClaudeLLM({ systemPrompt: VOICE_SYSTEM_PROMPT }),
      // see selectTTS() above for which provider is active. swap by setting
      // VOICE_TTS_PROVIDER in .env — no code change needed.
      tts: selectTTS(),
      // semantic endpointing — knows the difference between a mid-sentence
      // pause and an actual end of turn. the qwen2.5-0.5b model, distilled
      // by livekit, runs on cpu.
      turnDetection: new turnDetector.EnglishModel(),
      // v2: predictive prefetch. fire claude on the partial transcript at
      // high-confidence end-of-turn instead of waiting for the turn detector
      // to confirm. if the user keeps talking, the in-flight generation gets
      // discarded and refired. shaves ~500-1500ms off perceived latency.
      preemptiveGeneration: true,
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
