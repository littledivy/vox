# vox — Claude in your Google Meet. Self-contained image: Chromium + Xvfb +
# PulseAudio + the Go MCP server. Builds the binary in-image (no host Go needed),
# so `docker build` alone produces a runnable image, and `docker buildx` can
# cross-build linux/amd64 + linux/arm64.
#
# Build:  docker build -t vox .
# Use:    claude mcp add vox -- docker run --rm -i \
#           -e VOX_VOICE=realtime -e OPENAI_API_KEY=sk-... vox

# ---- build stage -----------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /vox .

# ---- runtime stage ---------------------------------------------------------
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    pulseaudio \
    pulseaudio-utils \
    dbus-x11 \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /vox /usr/local/bin/vox
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV CHROME_PATH=/usr/bin/chromium \
    HOME=/tmp/fakehome \
    XDG_RUNTIME_DIR=/tmp/pulse-runtime

RUN mkdir -p /tmp/fakehome /tmp/pulse-runtime

# Entrypoint provisions Xvfb + PulseAudio, then execs vox (MCP server on stdio).
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
