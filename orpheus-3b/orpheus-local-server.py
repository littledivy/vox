"""Orpheus TTS (Tara) streaming server — native streaming with patched SNAC.

Supports: <laugh>, <sigh>, <gasp>, <chuckle>, <cough>, <yawn>
Voices: tara, leah, jess, leo, dan, mia, zac, zoe
"""
import base64
import json
import os
import struct
import threading
import time

os.environ.setdefault("NO_TORCH_COMPILE", "1")

import numpy as np
import mlx.core as mx
from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origin_regex=".*", allow_methods=["*"], allow_headers=["*"])

model_lock = threading.Lock()
orpheus_model = None
SAMPLE_RATE = 24000


class TTSRequest(BaseModel):
    text: str
    speaker: int = 0
    max_audio_length_ms: int = 10_000
    temperature: float = 0.6
    topk: int = 50
    chunk_frames: int = 1
    use_context: bool = False
    voice: str = "tara"


@app.on_event("startup")
def load():
    global orpheus_model
    from mlx_audio.tts.generate import load_model

    # Patch SNAC streaming: fix axis + increase context to 16 frames
    from mlx_audio.codec.models.snac import snac as snac_mod
    import mlx_audio.tts.models.llama.llama as llama_mod

    orig_decode_stream = snac_mod.SNAC.decode_stream
    def fixed_decode_stream(self, codes, prev_codes=None, context_frames=16):
        if prev_codes is None:
            audio = self.decode(codes)
            new_context = [
                c[:, -context_frames:] if c.shape[1] > context_frames else c
                for c in codes
            ]
            return audio, new_context

        combined_codes = []
        for i, (prev, new) in enumerate(zip(prev_codes, codes)):
            stride = self.vq_strides[i]
            layer_context = max(1, context_frames // stride)
            if prev.shape[1] > layer_context:
                prev = prev[:, -layer_context:]
            combined = mx.concatenate([prev, new], axis=1)
            combined_codes.append(combined)

        full_audio = self.decode(combined_codes)
        context_samples = int(context_frames * self.hop_length)

        # Fix: samples are in dim 1, not dim -1
        if full_audio.shape[1] > context_samples:
            new_audio = full_audio[:, context_samples:, :]
        else:
            new_audio = full_audio

        new_context = [
            c[:, -context_frames:] if c.shape[1] > context_frames else c for c in codes
        ]
        return new_audio, new_context

    snac_mod.SNAC.decode_stream = fixed_decode_stream

    # Also patch the already-instantiated snac_model in llama module
    llama_mod.snac_model.decode_stream = lambda *args, **kwargs: fixed_decode_stream(llama_mod.snac_model, *args, **kwargs)

    # Patch context_frames=16 in the caller
    orig_decode_audio_stream = llama_mod.decode_audio_stream
    def fixed_decode_audio_stream(code_list, prev_codes=None, context_frames=16):
        from mlx_audio.tts.models.llama.llama import codes_to_layers
        codes = codes_to_layers(code_list)
        audio, new_context = llama_mod.snac_model.decode_stream(codes, prev_codes, context_frames)
        return audio.squeeze(-1), new_context
    llama_mod.decode_audio_stream = fixed_decode_audio_stream

    print("[orpheus] patched SNAC streaming (axis fix + 16 context frames + instance patch)")

    print("[orpheus] loading model...")
    t0 = time.time()
    orpheus_model = load_model("mlx-community/orpheus-3b-0.1-ft-4bit")
    print(f"[orpheus] ready in {time.time()-t0:.1f}s")


@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": orpheus_model is not None, "backend": "orpheus-mlx"}


@app.post("/v1/tts/stream")
def tts_stream(req: TTSRequest):
    def gen():
        with model_lock:
            yield from _stream(req)
    return StreamingResponse(gen(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _stream(req: TTSRequest):
    t0 = time.time()

    mx.clear_cache()

    # Collect all chunks first — the generator must complete inside the lock
    # to avoid interleaved model access
    chunks = []
    for result in orpheus_model.generate(
        text=req.text, voice=req.voice,
        temperature=req.temperature,
        stream=True, streaming_interval=0.5,
        verbose=False,
    ):
        audio_np = np.array(result.audio).flatten().astype(np.float32)
        if len(audio_np) > 0:
            chunks.append(audio_np)

    mx.clear_cache()

    gen_ms = int((time.time() - t0) * 1000)

    # Now yield the collected chunks as SSE
    for i, audio_np in enumerate(chunks):
        pcm_16 = (np.clip(audio_np, -1, 1) * 32767).astype(np.int16).tobytes()
        b64 = base64.b64encode(pcm_16).decode()

        if i == 0:
            print(f"[orpheus] first audio: {gen_ms}ms ({len(audio_np)/SAMPLE_RATE:.2f}s)")

        yield f"data: {json.dumps({'type': 'audio', 'pcm': b64, 'frame': i+1})}\n\n"

    elapsed = int((time.time() - t0) * 1000)
    print(f"[orpheus] done: {len(chunks)} chunks, {elapsed}ms")
    yield f"data: {json.dumps({'type': 'done', 'total_frames': len(chunks), 'elapsed_ms': elapsed})}\n\n"


@app.post("/v1/tts")
def tts(req: TTSRequest):
    t0 = time.time()

    mx.clear_cache()

    with model_lock:
        results = list(orpheus_model.generate(
            text=req.text, voice=req.voice,
            temperature=req.temperature, verbose=False,
        ))

    mx.clear_cache()

    if not results:
        return Response(content="no audio", status_code=500)

    audio_np = np.array(results[0].audio).flatten()
    pcm_16 = (np.clip(audio_np, -1, 1) * 32767).astype(np.int16)
    data = pcm_16.tobytes()
    header = struct.pack('<4sI4s4sIHHIIHH4sI',
        b'RIFF', 36 + len(data), b'WAVE',
        b'fmt ', 16, 1, 1, SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16,
        b'data', len(data))

    print(f"[orpheus] tts: {time.time()-t0:.2f}s")
    return Response(content=header + data, media_type="audio/wav",
        headers={"X-Generation-Time-Ms": str(int((time.time()-t0)*1000))})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8090)
