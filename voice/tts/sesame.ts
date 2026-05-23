// custom TTS adapter that pulls audio from our CSM-1B server on modal.
// the server lives at voice/csm/modal_server.py and exposes /tts as a
// websocket. protocol:
//   client -> server: {"type":"generate","text":"...","speaker":0}
//   server -> client: binary frames of raw PCM s16le @ 24khz mono
//   server -> client: {"type":"done"} text frame when generation completes
//
// v0 caveat: this is "chunk transmission of fully-generated audio." the
// server still runs generation to completion before sending the first byte,
// so TTFB is ~2-5s per turn. v1 will swap in autoregressive streaming
// (server-side change) and this adapter will work unchanged because the
// protocol shape stays identical.

import { randomUUID } from 'node:crypto';
import { AudioFrame } from '@livekit/rtc-node';
import {
  APIError,
  DEFAULT_API_CONNECT_OPTIONS,
  tts,
  type APIConnectOptions,
} from '@livekit/agents';
import WebSocket from 'ws';

const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;
// 20ms @ 24khz = 480 samples per channel. matches the modal server's chunk size.
const SAMPLES_PER_CHUNK = 480;

export interface SesameTTSOptions {
  /** wss:// url to the modal /tts endpoint. */
  wsUrl?: string;
  /** CSM speaker id (0 is the default voice). */
  speaker?: number;
  /** max generation length in ms. */
  maxAudioLengthMs?: number;
}

interface InternalOpts {
  wsUrl: string;
  speaker: number;
  maxAudioLengthMs: number;
}

export class SesameTTS extends tts.TTS {
  label = 'sesame.SesameTTS';
  readonly #opts: InternalOpts;

  constructor(opts: SesameTTSOptions = {}) {
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: true });
    const wsUrl = opts.wsUrl ?? process.env.SESAME_WS_URL;
    if (!wsUrl) {
      throw new Error(
        'SesameTTS: SESAME_WS_URL must be set in env or passed via opts',
      );
    }
    this.#opts = {
      wsUrl,
      speaker: opts.speaker ?? 0,
      maxAudioLengthMs: opts.maxAudioLengthMs ?? 15000,
    };
  }

  override get model(): string {
    return 'sesame/csm-1b';
  }

  override get provider(): string {
    return 'sesame';
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new SesameChunkedStream(this, text, this.#opts, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new SesameSynthesizeStream(this, this.#opts, options?.connOptions);
  }
}

class SesameChunkedStream extends tts.ChunkedStream {
  label = 'sesame.SesameChunkedStream';
  readonly #opts: InternalOpts;

  constructor(
    parent: SesameTTS,
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
        this.queue.put({
          requestId,
          segmentId,
          frame,
          final: false,
        });
        pushed++;
      }
    } catch (err) {
      throw mapError(err);
    }

    // emit one final empty-marker frame so the consumer knows the segment ended.
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

class SesameSynthesizeStream extends tts.SynthesizeStream {
  label = 'sesame.SesameSynthesizeStream';
  readonly #opts: InternalOpts;

  constructor(
    parent: SesameTTS,
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
        this.queue.put({
          requestId,
          segmentId,
          frame,
          final: false,
        });
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
        if (item === SesameSynthesizeStream.FLUSH_SENTINEL) {
          await flush();
        } else if (typeof item === 'string') {
          buffer += item;
        }
      }
      // input ended — flush whatever is left.
      await flush();
    } catch (err) {
      throw mapError(err);
    } finally {
      this.queue.put(SesameSynthesizeStream.END_OF_STREAM);
    }
  }
}

/**
 * open a websocket to the modal server, send a generate request, yield
 * AudioFrames as binary chunks arrive, return when `{type:"done"}` lands.
 */
async function* generateOverWebSocket(
  text: string,
  opts: InternalOpts,
  abortSignal: AbortSignal,
): AsyncGenerator<AudioFrame, void, void> {
  const ws = new WebSocket(opts.wsUrl);

  // queue inbound messages so the consumer (this generator) can pull them
  // sequentially without missing events that arrive between iterations.
  const pending: Array<Buffer | { done: boolean; error?: string }> = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let closeError: Error | undefined;

  const wake = () => {
    while (waiters.length > 0) waiters.shift()!();
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      pending.push(data as Buffer);
    } else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.type === 'done') {
          pending.push({ done: true });
        } else if (msg?.type === 'error') {
          pending.push({ done: true, error: msg.message ?? 'sesame error' });
        }
      } catch {
        // ignore malformed text frames
      }
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
        type: 'generate',
        text,
        speaker: opts.speaker,
        max_audio_length_ms: opts.maxAudioLengthMs,
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
      if (Buffer.isBuffer(item)) {
        // each chunk is exactly 20ms of s16le mono pcm at 24khz.
        const samples = new Int16Array(
          item.buffer,
          item.byteOffset,
          item.byteLength / 2,
        );
        yield new AudioFrame(samples, SAMPLE_RATE, NUM_CHANNELS, samples.length);
      } else if (item.done) {
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
