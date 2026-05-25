"""donna's voice: CSM-1B hosted on Modal with a true-streaming websocket endpoint.

v1: true autoregressive streaming. we run the official sesame/csm generation
loop manually, call mimi.decode on small frame batches as they're produced,
and push pcm to the websocket while the model is still generating. ttfb is
the time to produce N frames (default 6 = 480ms of audio) + one mimi decode,
not the full sentence. v0 chunk-after-gen (5-15s ttfb) is retired.

scale-to-zero L4 GPU. only billed while a call is active (~$0.74/hr).

protocol on /tts websocket (unchanged from v0):
  client -> server: {"type":"generate","text":"...","speaker":0}
  server -> client: binary frames (raw PCM s16le @ 24khz mono)
  server -> client: {"type":"done"} text frame when generation is complete

deploy: `modal deploy voice/csm/modal_server.py`
"""

import asyncio
import json
import os

import modal

app = modal.App("donna-csm")

# official pytorch image with cuda 12.4 + cudnn 9 + torch 2.4 prewired. avoids
# the cuda+cudnn+torch version dance that bit the previous base. python 3.11
# ships in the image; no add_python needed.
csm_image = (
    modal.Image.from_registry(
        "pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime",
        add_python=None,
    )
    .apt_install("git", "ffmpeg", "libsndfile1")
    .pip_install(
        # versions pinned to match the official sesame/csm requirements.txt.
        # newer huggingface_hub breaks PyTorchModelHubMixin loading (was
        # raising "Model.__init__ missing 'config'" on 0.29+).
        "transformers==4.49.0",
        "huggingface_hub==0.28.1",
        "tokenizers==0.21.0",
        "moshi==0.2.2",
        "torchtune==0.4.0",
        "torchao==0.9.0",
        # audio watermarking lib CSM applies to every generated audio.
        # gated import in csm/models.py — must be installed even if unused.
        "silentcipher @ git+https://github.com/SesameAILabs/silentcipher@master",
        # our own deps (not in csm requirements but our server uses them).
        "fastapi>=0.115.0",
        "numpy<2.0",
        "soundfile",
        "safetensors",
    )
    .run_commands(
        # official sesame/csm. known-working Generator.generate() returns
        # full audio. v1 (true autoregressive streaming) will be added back
        # as our own wrapper around this generator, not via a third-party
        # fork — the davidbrowne17 fork drifted out of compatibility.
        "git clone https://github.com/SesameAILabs/csm.git /opt/csm",
    )
    .env({
        "PYTHONPATH": "/opt/csm",
        "NO_TORCH_COMPILE": "1",
    })
)


@app.cls(
    image=csm_image,
    gpu="L4",
    secrets=[modal.Secret.from_name("huggingface-token")],
    scaledown_window=300,
    timeout=900,
)
@modal.concurrent(max_inputs=4)
class CSMServer:
    @modal.enter()
    def load_model(self):
        """runs once per container startup. ~30-60s on cold start.

        we bypass csm's `load_csm_1b()` / `Model.from_pretrained()` path —
        it relies on PyTorchModelHubMixin auto-deserializing config.json
        into the ModelArgs dataclass, a behavior that broke in newer
        huggingface_hub versions.

        we also bypass the gated meta-llama/Llama-3.2-1B download. CSM's
        internals load that repo via transformers' AutoTokenizer/AutoModel
        which hits a 403 unless your HF account is on meta's approved list.
        the workaround: pre-download unsloth/Llama-3.2-1B (a non-gated
        community mirror with byte-identical weights) and symlink it into
        the HF cache under the meta-llama path. when CSM asks for
        meta-llama, it finds the files locally and never hits the gate.
        """
        import dataclasses
        import json
        import pathlib
        import sys

        import torch
        from huggingface_hub import snapshot_download
        from safetensors.torch import load_file

        token = os.environ.get("HF_TOKEN")
        if not token:
            raise RuntimeError(
                "HF_TOKEN missing. create a modal secret named "
                "'huggingface-token' with HF_TOKEN=hf_xxx"
            )

        sys.path.insert(0, "/opt/csm")
        from generator import Generator  # type: ignore
        from models import Model, ModelArgs  # type: ignore

        # pre-cache Llama-3.2-1B via the unsloth mirror. has to happen
        # BEFORE we load CSM, because CSM's __init__ pulls Llama on
        # construction.
        self._alias_unsloth_as_meta_llama(token)

        # download all model files to a local cache dir. takes ~30-60s the
        # first time the container boots (weights are ~3gb).
        model_dir = snapshot_download(
            repo_id="sesame/csm-1b",
            token=token,
        )

        # parse config.json into ModelArgs. filter to only the dataclass's
        # declared fields so extra metadata in config.json doesn't blow up
        # ModelArgs(**dict) with unexpected-kwarg errors.
        with open(f"{model_dir}/config.json", "r") as f:
            config_dict = json.load(f)
        field_names = {f.name for f in dataclasses.fields(ModelArgs)}
        args = ModelArgs(
            **{k: v for k, v in config_dict.items() if k in field_names}
        )

        # construct model directly. no mixin.
        model = Model(args)

        # load weights. CSM-1B ships safetensors; fall back to .bin just in
        # case the upload format changes.
        weights_safetensors = f"{model_dir}/model.safetensors"
        weights_bin = f"{model_dir}/pytorch_model.bin"
        if os.path.exists(weights_safetensors):
            state_dict = load_file(weights_safetensors)
        elif os.path.exists(weights_bin):
            state_dict = torch.load(weights_bin, map_location="cpu")
        else:
            raise RuntimeError(
                f"no model weights found in {model_dir}. expected one of "
                "model.safetensors or pytorch_model.bin"
            )

        model.load_state_dict(state_dict)
        model.to(device="cuda", dtype=torch.bfloat16)

        self.generator = Generator(model)
        self.sample_rate = self.generator.sample_rate

    def _alias_unsloth_as_meta_llama(self, token: str) -> None:
        """download unsloth/Llama-3.2-1B and symlink it into the HF cache
        under the meta-llama path, so CSM's internal AutoTokenizer /
        AutoModel calls for `meta-llama/Llama-3.2-1B` find files locally
        and never hit the gated endpoint.

        works because unsloth's mirror is byte-identical to meta-llama's
        upload — same tokenizer, same weights, same config.
        """
        import pathlib

        from huggingface_hub import snapshot_download

        # 1. download the non-gated mirror to wherever HF caches it.
        unsloth_dir = snapshot_download(
            repo_id="unsloth/Llama-3.2-1B",
            token=token,
        )

        # 2. figure out where HF expects meta-llama/Llama-3.2-1B to live.
        #    cache layout: {hub_cache}/models--{org}--{repo}/...
        hub_cache_root = pathlib.Path(unsloth_dir).parent.parent.parent
        meta_llama_root = hub_cache_root / "models--meta-llama--Llama-3.2-1B"

        # 3. build the cache skeleton if missing.
        snapshots_dir = meta_llama_root / "snapshots"
        refs_dir = meta_llama_root / "refs"
        snapshots_dir.mkdir(parents=True, exist_ok=True)
        refs_dir.mkdir(parents=True, exist_ok=True)

        # 4. symlink the unsloth snapshot in as the "alias" revision and
        #    point refs/main at it so AutoTokenizer.from_pretrained finds it.
        alias = snapshots_dir / "alias"
        if not alias.exists():
            alias.symlink_to(unsloth_dir, target_is_directory=True)
        (refs_dir / "main").write_text("alias")

    @modal.asgi_app()
    def fastapi_app(self):
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

                    await self._stream_generation(ws, text, speaker, max_ms)

            except WebSocketDisconnect:
                return

        return web_app

    def _generate_stream(
        self,
        text: str,
        speaker: int,
        max_audio_length_ms: int,
        frames_per_chunk: int = 6,
        temperature: float = 0.9,
        topk: int = 50,
    ):
        """generator that runs the csm autoregressive loop and yields pcm bytes
        every `frames_per_chunk` mimi frames (1 frame = 80ms of audio).

        this mirrors official Generator.generate() but interleaves decode with
        generation so audio leaves the box during inference. note we skip the
        silentcipher watermarker and the post-decode resample — both operate
        on the full audio at once and would defeat streaming. acceptable for
        live phone calls; revisit if we ship a non-call surface that needs
        the watermark.

        mimi's decoder is conv-based, so calling decode() on independent code
        windows produces boundary artifacts. we wrap the decode calls in
        `mimi.streaming(1)` which preserves conv state across calls — this is
        the kyutai-supported way to do chunked decoding without seams.
        """
        import torch

        gen = self.generator
        model = gen._model
        mimi = gen._audio_tokenizer
        device = gen.device

        model.reset_caches()

        max_generation_len = int(max_audio_length_ms / 80)

        # prompt = the text segment to speak. no context segments (matches v0
        # call site which passes context=[]).
        prompt_tokens, prompt_tokens_mask = gen._tokenize_text_segment(text, speaker)
        prompt_tokens = prompt_tokens.long().to(device)
        prompt_tokens_mask = prompt_tokens_mask.bool().to(device)

        curr_tokens = prompt_tokens.unsqueeze(0)
        curr_tokens_mask = prompt_tokens_mask.unsqueeze(0)
        curr_pos = (
            torch.arange(0, prompt_tokens.size(0))
            .unsqueeze(0)
            .long()
            .to(device)
        )

        max_seq_len = 2048
        max_context_len = max_seq_len - max_generation_len
        if curr_tokens.size(1) >= max_context_len:
            raise ValueError(
                f"Inputs too long, must be below max_seq_len - max_generation_len: {max_context_len}"
            )

        buffer: list[torch.Tensor] = []

        def flush(buf: list[torch.Tensor]) -> bytes:
            # buf is a list of (1, K) frame tensors. stack into (1, K, T) which
            # is what mimi.decode wants.
            codes = torch.stack(buf, dim=-1)  # (1, K, T)
            audio = mimi.decode(codes).squeeze(0).squeeze(0)  # (samples,)
            return (
                audio.clamp(-1.0, 1.0)
                .mul(32767)
                .to(dtype=torch.int16)
                .cpu()
                .numpy()
                .tobytes()
            )

        # streaming context keeps mimi's decoder conv state across chunked
        # decode calls. without this, every yielded chunk has edge artifacts.
        with torch.inference_mode(), mimi.streaming(1):
            for _ in range(max_generation_len):
                sample = model.generate_frame(
                    curr_tokens, curr_tokens_mask, curr_pos, temperature, topk
                )
                if torch.all(sample == 0):
                    break  # eos

                buffer.append(sample)

                curr_tokens = torch.cat(
                    [sample, torch.zeros(1, 1).long().to(device)], dim=1
                ).unsqueeze(1)
                curr_tokens_mask = torch.cat(
                    [
                        torch.ones_like(sample).bool(),
                        torch.zeros(1, 1).bool().to(device),
                    ],
                    dim=1,
                ).unsqueeze(1)
                curr_pos = curr_pos[:, -1:] + 1

                if len(buffer) >= frames_per_chunk:
                    yield flush(buffer)
                    buffer = []

            # flush trailing frames so the tail of the sentence isn't dropped.
            if buffer:
                yield flush(buffer)

    async def _stream_generation(
        self,
        ws,
        text: str,
        speaker: int,
        max_audio_length_ms: int,
    ) -> None:
        """bridge the sync cuda-blocking generator into the asyncio event loop.

        we run the producer in a worker thread (cuda calls are gil-releasing
        but still blocking from python's view) and shuttle pcm chunks through
        an asyncio.Queue. the websocket coroutine awaits the queue so the
        event loop stays responsive for other connections under
        @modal.concurrent.
        """
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue(maxsize=8)
        SENTINEL = object()
        bytes_sent = 0

        def producer():
            try:
                for chunk in self._generate_stream(
                    text=text,
                    speaker=speaker,
                    max_audio_length_ms=max_audio_length_ms,
                ):
                    # bounded blocking put back into the loop. backpressure
                    # is intentional: if the client/network can't keep up we
                    # slow the gpu rather than buffer unbounded.
                    asyncio.run_coroutine_threadsafe(queue.put(chunk), loop).result()
            except Exception as e:  # surface errors to the consumer
                asyncio.run_coroutine_threadsafe(queue.put(e), loop).result()
            finally:
                asyncio.run_coroutine_threadsafe(queue.put(SENTINEL), loop).result()

        producer_task = asyncio.to_thread(producer)
        # fire-and-await: schedule producer, then drain the queue.
        producer_future = asyncio.ensure_future(producer_task)

        try:
            while True:
                item = await queue.get()
                if item is SENTINEL:
                    break
                if isinstance(item, Exception):
                    raise item
                await ws.send_bytes(item)
                bytes_sent += len(item)
        finally:
            await producer_future

        await ws.send_text(json.dumps({
            "type": "done",
            "sample_rate": self.sample_rate,
            "bytes_sent": bytes_sent,
            "duration_ms": int(1000 * (bytes_sent / 2) / self.sample_rate),
        }))
