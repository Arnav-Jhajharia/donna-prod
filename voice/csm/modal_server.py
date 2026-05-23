"""donna's voice: CSM-1B hosted on Modal with a websocket endpoint.

scale-to-zero L4 GPU. only billed while a call is active (~$0.74/hr).
the python here is the inference server; the livekit-side client lives in
voice/tts/sesame.ts.

v0 scope: chunked transmission of fully-generated audio. TTFB is the full
generation time (~2-5s on L4 for a sentence). v1 swaps in true autoregressive
streaming so TTFB drops below 500ms.

protocol on /tts websocket:
  client -> server: {"type":"generate","text":"...","speaker":0}
  server -> client: binary frames (raw PCM s16le @ 24khz mono)
  server -> client: {"type":"done"} text frame when generation is complete

deploy: `modal deploy voice/csm/modal_server.py`
the deploy prints a URL; copy it into .env as SESAME_WS_URL (use the
wss:// form, replacing the leading https://).
"""

import json
import os

import modal

app = modal.App("donna-csm")

# image: cuda 12.4, python 3.10, torch + the official sesame/csm code.
# torch wheels match cuda 12.4 — keep these aligned if you bump the base.
csm_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.0-cudnn-runtime-ubuntu22.04",
        add_python="3.10",
    )
    .apt_install("git", "ffmpeg", "libsndfile1")
    .pip_install(
        "torch==2.4.0",
        "torchaudio==2.4.0",
        "transformers>=4.49.0",
        "huggingface_hub>=0.24.0",
        "moshi==0.2.2",  # provides the mimi audio decoder CSM uses
        "fastapi>=0.115.0",
        "numpy<2.0",
        "soundfile",
        "tokenizers",
        extra_index_url="https://download.pytorch.org/whl/cu124",
    )
    .run_commands(
        "git clone https://github.com/SesameAILabs/csm.git /opt/csm",
    )
    .env({
        "PYTHONPATH": "/opt/csm",
        # disable lazy torch.compile in mimi — speeds up first inference.
        "NO_TORCH_COMPILE": "1",
    })
)


@app.cls(
    image=csm_image,
    gpu="L4",
    secrets=[modal.Secret.from_name("huggingface-token")],
    # idle for 5 min -> tear down container -> $0 until next call.
    # bump this up if you see cold starts mid-conversation.
    scaledown_window=300,
    # generation occasionally runs long on first warm call; keep a margin.
    timeout=900,
)
@modal.concurrent(max_inputs=4)
class CSMServer:
    @modal.enter()
    def load_model(self):
        """runs once per container startup. ~30-60s on cold start."""
        import sys

        sys.path.insert(0, "/opt/csm")
        from generator import load_csm_1b  # type: ignore

        # HF_TOKEN comes from the modal secret. needs license accepted at
        # huggingface.co/sesame/csm-1b and huggingface.co/meta-llama/Llama-3.2-1B.
        token = os.environ.get("HF_TOKEN")
        if not token:
            raise RuntimeError(
                "HF_TOKEN missing. create a modal secret named "
                "'huggingface-token' with HF_TOKEN=hf_xxx"
            )

        self.generator = load_csm_1b(device="cuda")
        # mimi (the audio codec) produces 24khz mono pcm.
        self.sample_rate = self.generator.sample_rate

    @modal.asgi_app()
    def fastapi_app(self):
        """exposes /tts as a websocket endpoint.

        livekit's SesameTTS adapter opens one connection per turn, sends a
        generate message, reads pcm frames until it receives {"type":"done"}.
        """
        from fastapi import FastAPI, WebSocket, WebSocketDisconnect

        web_app = FastAPI()

        @web_app.get("/health")
        def health():
            return {"ok": True, "sample_rate": self.sample_rate}

        @web_app.websocket("/tts")
        async def tts_endpoint(ws: WebSocket):
            await ws.accept()
            try:
                while True:
                    payload = await ws.receive_text()
                    msg = json.loads(payload)
                    if msg.get("type") != "generate":
                        await ws.send_text(json.dumps({
                            "type": "error",
                            "message": f"unknown message type: {msg.get('type')}",
                        }))
                        continue

                    text = msg.get("text", "").strip()
                    if not text:
                        await ws.send_text(json.dumps({"type": "done"}))
                        continue

                    speaker = int(msg.get("speaker", 0))
                    max_ms = int(msg.get("max_audio_length_ms", 15000))

                    audio = self.generator.generate(
                        text=text,
                        speaker=speaker,
                        context=[],
                        max_audio_length_ms=max_ms,
                    )

                    # audio is a float32 torch tensor in [-1, 1] @ self.sample_rate.
                    # livekit consumes s16le PCM, so convert + clip.
                    pcm = (
                        audio.clamp(-1.0, 1.0)
                        .mul(32767)
                        .to(dtype=__import__("torch").int16)
                        .cpu()
                        .numpy()
                        .tobytes()
                    )

                    # chunk transmission. 20ms frames @ 24khz = 480 samples
                    # = 960 bytes (s16). matches livekit's audio frame size.
                    chunk_bytes = 960
                    for i in range(0, len(pcm), chunk_bytes):
                        await ws.send_bytes(pcm[i : i + chunk_bytes])

                    await ws.send_text(json.dumps({
                        "type": "done",
                        "sample_rate": self.sample_rate,
                        "duration_ms": int(1000 * len(audio) / self.sample_rate),
                    }))

            except WebSocketDisconnect:
                return
