#!/bin/bash
# Build the vox Docker image. The Dockerfile is multi-stage, so the Go binary is
# compiled inside the image — no host Go toolchain needed, just Docker.
#
#   ./build.sh              build the image locally (host arch)  -> tag "vox"
#   ./build.sh push         build+push multi-arch to the registry (needs login)
set -e
cd "$(dirname "$0")"

IMAGE="${VOX_IMAGE:-ghcr.io/denoland/vox}"

if [ "$1" = "push" ]; then
  echo "building + pushing multi-arch $IMAGE:latest …"
  docker buildx build \
    --platform linux/amd64,linux/arm64 \
    -t "$IMAGE:latest" \
    --push .
  echo "pushed $IMAGE:latest"
else
  echo "docker build (host arch) -> vox …"
  docker build -t vox .
  echo
  echo "done. Add to Claude:"
  echo "  claude mcp add vox -- docker run --rm -i -e VOX_VOICE=realtime -e OPENAI_API_KEY=sk-... vox"
fi
