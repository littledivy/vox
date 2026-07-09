# Orpheus TTS — Self-hosted

Scripts and patches for running Orpheus TTS (3B, Tara voice) on your own hardware.

## Files

- `orpheus-local-server.py` — MLX server for Mac (Apple Silicon). Uses `mlx-audio` + monkey-patched SNAC streaming. Streaming is broken due to SNAC not being prefix-stable on MLX — falls back to collect-then-yield.
- `orpheus-server.sh` — Start script for local server
- `fix-snac-streaming.diff` — Patch for `mlx-audio` SNAC `decode_stream`: fixes axis (`shape[-1]` -> `shape[1]`), adds `int()` cast on context_samples. Apply with `cd $(pip show mlx-audio | grep Location | cut -d' ' -f2) && patch -p1 < fix-snac-streaming.diff`
## K8s deployment

See `~/gh/k8s/apps/orpheus.yaml` for the CUDA deployment on k8s. Uses vLLM 0.7.3 + orpheus-speech on NVIDIA GPU. Key settings: `gpu_memory_utilization=0.6`, `max_model_len=2048`. Model: `canopylabs/orpheus-tts-0.1-finetune-prod`.

## Status

Self-hosted Orpheus is **slower than realtime** on our RTX A6000 vGPU (0.6x realtime) due to 5.2GB vGPU overhead leaving insufficient memory for quantization. The recommended path is Together AI's hosted Orpheus API which runs on H100s with FP8 — see `orpheus.go` in the parent directory.

## MLX limitations

Orpheus MLX streaming is fundamentally broken: SNAC codec is not prefix-stable (re-decoding same codes with more appended changes ALL positions). Delta-based streaming can't work. The server collects all chunks then yields them as SSE.
