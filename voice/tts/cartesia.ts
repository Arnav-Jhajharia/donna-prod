// cartesia sonic-3 TTS via websocket. ~100ms TTFB. used until we ship
// true streaming for CSM-1B (see voice/csm/modal_server.py — current state
// is chunk-after-generate which has ~5-15s TTFB, unusable for live calls).
//
// shape deliberately mirrors voice/tts/sesame.ts so the swap is one line
// in voice/agent.ts when CSM streaming lands.
//
// protocol (https://docs.cartesia.ai/api-reference/tts/websocket):
//   - wss connect with `cartesia_version` query param + X-API-Key header
//   - send generate request as one json frame
//   - receive json frames: {type:"chunk", data:base64}, {type:"done"}, {type:"error"}
//   - audio inside the chunk frames is base64-encoded raw pcm_s16le

import { randomUUID } from 'node:crypto';
import { AudioFrame } from '@livekit/rtc-node';
import {
  APIError,
  DEFAULT_API_CONNECT_OPTIONS,
  tts,
  type APIConnectOptions,
} from '@livekit/agents';
import WebSocket from 'ws';

const CARTESIA_WS_URL = 'wss://api.cartesia.ai/tts/websocket';
const CARTESIA_VERSION = '2026-03-01';
const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;
// 20ms @ 24khz mono = 480 samples = 960 bytes pcm_s16le. matches livekit frame size.
const CHUNK_BYTES = 960;

export interface CartesiaTTSOptions {
  /** cartesia api key. falls back to CARTESIA_API_KEY env var. */
  apiKey?: string;
  /** voice uuid from https://play.cartesia.ai/voices.
   *  falls back to CARTESIA_VOICE_ID env var. */
  voiceId?: string;
  /** model id, default "sonic-3". */
  model?: string;
  /** ISO language code, default "en". */
  language?: string;
}

interface InternalOpts {
  apiKey: string;
  voiceId: string;
  model: string;
  language: string;
}

export class CartesiaTTS extends tts.TTS {
  label = 'cartesia.CartesiaTTS';
  readonly #opts: InternalOpts;

  constructor(opts: CartesiaTTSOptions = {}) {
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: true });
    const apiKey = opts.apiKey ?? process.env.CARTESIA_API_KEY;
    const voiceId = opts.voiceId ?? process.env.CARTESIA_VOICE_ID;
    if (!apiKey) {
      throw new Error(
        'CartesiaTTS: CARTESIA_API_KEY must be set in env or passed via opts',
      );
    }
    if (!voiceId) {
      throw new Error(
        'CartesiaTTS: CARTESIA_VOICE_ID must be set in env or passed via opts ' +
          '(browse voices at https://play.cartesia.ai/voices)',
      );
    }
    this.#opts = {
      apiKey,
      voiceId,
      model: opts.model ?? 'sonic-3',
      language: opts.language ?? 'en',
    };
  }

  override get model(): string {
    return this.#opts.model;
  }

  override get provider(): string {
    return 'cartesia';
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new CartesiaChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new CartesiaSynthesizeStream(this, this.#opts, options?.connOptions);
  }
}

class CartesiaChunkedStream extends tts.ChunkedStream {
  label = 'cartesia.CartesiaChunkedStream';
  readonly #opts: InternalOpts;

  constructor(
    parent: CartesiaTTS,
    text: string,
    opts: InternalOpts,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, parent, connOptions ?? DEFAULT_API_CONNECT_OPTIONS, abortSignal);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const requestId = randomUUID();
    const segmentId = randomUUID();
    let pushed = 0;
    try {
      for await (const frame of generateOverWebSocket(
        this.inputText,
        this.#opts,
        this.abortSignal,
      )) {
        this.queue.put({ requestId, segmentId, frame, final: false });
        pushed++;
      }
    } catch (err) {
      throw mapError(err);
    }
    if (pushed > 0) {
      this.queue.put({
        requestId,
        segmentId,
        frame: new AudioFrame(new Int16Array(0), SAMPLE_RATE, NUM_CHANNELS, 0),
        final: true,
      });
    }
  }
}

class CartesiaSynthesizeStream extends tts.SynthesizeStream {
  label = 'cartesia.CartesiaSynthesizeStream';
  readonly #opts: InternalOpts;

  constructor(
    parent: CartesiaTTS,
    opts: InternalOpts,
    connOptions?: APIConnectOptions,
  ) {
    super(parent, connOptions ?? DEFAULT_API_CONNECT_OPTIONS);
    this.#opts = opts;
  }

  protected async run(): Promise<void> {
    const requestId = randomUUID();
    let buffer = '';

    const flush = async () => {
      const text = buffer.trim();
      buffer = '';
      if (!text) return;

      const segmentId = randomUUID();
      let pushed = 0;
      for await (const frame of generateOverWebSocket(
        text,
        this.#opts,
        this.abortSignal,
      )) {
        this.queue.put({ requestId, segmentId, frame, final: false });
        pushed++;
      }
      if (pushed > 0) {
        this.queue.put({
          requestId,
          segmentId,
          frame: new AudioFrame(new Int16Array(0), SAMPLE_RATE, NUM_CHANNELS, 0),
          final: true,
        });
      }
    };

    try {
      for await (const item of this.input) {
        if (this.abortSignal.aborted) break;
        if (item === CartesiaSynthesizeStream.FLUSH_SENTINEL) {
          await flush();
        } else if (typeof item === 'string') {
          buffer += item;
        }
      }
      await flush();
    } catch (err) {
      throw mapError(err);
    } finally {
      this.queue.put(CartesiaSynthesizeStream.END_OF_STREAM);
    }
  }
}

/**
 * open a websocket, send a generate request, yield AudioFrames as base64
 * audio chunks decode, return when {type:"done"} arrives.
 *
 * v0 opens a fresh ws per turn (simpler). cartesia supports multiplexing
 * many turns over one socket — that's a v1 optimization for shaving the
 * connection handshake (~30-50ms).
 */
async function* generateOverWebSocket(
  text: string,
  opts: InternalOpts,
  abortSignal: AbortSignal,
): AsyncGenerator<AudioFrame, void, void> {
  const url = `${CARTESIA_WS_URL}?cartesia_version=${CARTESIA_VERSION}`;
  const ws = new WebSocket(url, {
    headers: { 'X-API-Key': opts.apiKey },
  });

  type Pending = { kind: 'audio'; samples: Int16Array } | { kind: 'done'; error?: string };
  const pending: Pending[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let closeError: Error | undefined;

  const wake = () => {
    while (waiters.length > 0) waiters.shift()!();
  };

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'chunk' && typeof msg.data === 'string') {
        // base64 -> Buffer -> Int16Array view. each chunk is ~10-50ms of pcm.
        const buf = Buffer.from(msg.data, 'base64');
        // copy out so we don't share the Buffer pool memory with ws lib.
        const copy = new Int16Array(buf.byteLength / 2);
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        for (let i = 0; i < copy.length; i++) copy[i] = dv.getInt16(i * 2, true);
        pending.push({ kind: 'audio', samples: copy });
      } else if (msg.type === 'done') {
        pending.push({ kind: 'done' });
      } else if (msg.type === 'error') {
        pending.push({ kind: 'done', error: msg.message ?? 'cartesia error' });
      }
    } catch {
      // ignore malformed messages
    }
    wake();
  });
  ws.on('error', (err) => {
    closeError = err instanceof Error ? err : new Error(String(err));
    closed = true;
    wake();
  });
  ws.on('close', () => {
    closed = true;
    wake();
  });

  const onAbort = () => {
    try {
      ws.close();
    } catch {
      // already closed
    }
  };
  abortSignal.addEventListener('abort', onAbort);

  try {
    await waitForOpen(ws);
    ws.send(
      JSON.stringify({
        model_id: opts.model,
        transcript: text,
        voice: { mode: 'id', id: opts.voiceId },
        language: opts.language,
        context_id: randomUUID(),
        output_format: {
          container: 'raw',
          encoding: 'pcm_s16le',
          sample_rate: SAMPLE_RATE,
        },
        add_timestamps: false,
        continue: false,
      }),
    );

    while (true) {
      if (abortSignal.aborted) return;
      if (pending.length === 0) {
        if (closed) {
          if (closeError) throw closeError;
          return;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
        continue;
      }
      const item = pending.shift()!;
      if (item.kind === 'audio') {
        // re-chunk to 20ms livekit frames. cartesia ships variable chunk sizes;
        // livekit's audio forwarder is happiest with fixed 20ms frames.
        const samples = item.samples;
        let offset = 0;
        const samplesPerFrame = CHUNK_BYTES / 2;
        while (offset < samples.length) {
          const len = Math.min(samplesPerFrame, samples.length - offset);
          const slice = samples.slice(offset, offset + len);
          yield new AudioFrame(slice, SAMPLE_RATE, NUM_CHANNELS, slice.length);
          offset += len;
        }
      } else {
        if (item.error) throw new Error(item.error);
        return;
      }
    }
  } finally {
    abortSignal.removeEventListener('abort', onAbort);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      ws.off('open', onOpen);
      ws.off('error', onError);
    };
    ws.on('open', onOpen);
    ws.on('error', onError);
  });
}

function mapError(err: unknown): Error {
  if (err instanceof Error) {
    return new APIError(err.message, { retryable: true });
  }
  return new APIError(String(err), { retryable: true });
}
