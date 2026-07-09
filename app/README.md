# Vox — desktop app

A native **macOS** app that gives your Claude a voice in live conversations —
Google Meet or a direct microphone. Minimal, Claude-app-style. **No Docker.**

Built with [`deno desktop`](https://docs.deno.com/runtime/desktop/): a Deno HTTP
server rendered in a native webview. The same code runs in a browser for dev.

## What it does

- **Direct mic** — a hands-free voice chat (like the ChatGPT app). Your mic
  streams to OpenAI's Realtime API and the reply plays on your speakers. Needs
  only an OpenAI key. ✅ *no Docker.*
- **Google Meet** — sends your Claude into a meeting as a participant that
  listens, knows when to speak, and talks. Realtime runs **inside the meeting
  page** (OpenAI Realtime over a WebSocket), so it also needs **only an OpenAI
  key — no Docker**. The app spawns the native `vox` binary and drives it over MCP.
- **Notes** — save a meeting/voice transcript to `~/.vox/notes/*.md`; search,
  read, delete, and reveal in Finder from the app.
- **Integrations** — cards for Meet, Zoom, Teams, direct mic, notes, and Claude (MCP).
- **Settings** — your name, voice engine + realtime voice/model, API keys, and a
  System readiness panel (binary, Chrome, ffmpeg, keys). Keys live on this Mac in
  `~/.vox/config.json`; nothing leaves the machine except to the provider you pick.
- **Install into Claude** — registers the *native* `vox` binary as an MCP server
  in Claude Desktop + Claude Code (no Docker) so Claude can send itself in. Builds
  the binary automatically if needed; a copyable manual config is also provided.
- Time-aware home, first-run onboarding, in-app help (`?`), keyboard shortcuts,
  offline/error surfacing, and accessibility.

## Requirements

- **Deno** 2.9+ (canary): `deno upgrade canary`
- **Google Chrome** (for the Meet path)
- **ffmpeg / ffplay** on `PATH` (for direct-mic capture + playback)
- The `vox` Go binary — built automatically by the app, or `go build -o ../vox .`
  from the repo root.

## Run

```bash
cd app
deno task serve   # browser dev at the printed URL (fast UI iteration)
deno task start   # native desktop window
deno task build   # -> dist/Vox.app
./package.sh      # -> dist/Vox.dmg (drag-to-Applications)
```

First launch shows a short setup: your name, OpenAI key, and one-click install
into Claude. Then hit **Start talking**, or **Join a meeting** (full link or a
bare `abc-defg-hij` code).

Verify the no-Docker Meet realtime path end-to-end without a live call:
`./test-realtime.sh` (needs `OPENAI_API_KEY` in `../.env`).

## Architecture

```
web/            Claude-style UI (vanilla HTML/CSS/JS, no build step)
main.ts         Deno.serve HTTP + JSON API + native window/menu
backend.ts      settings, status/deps detection, MCP install, notes, go build
mcp.ts          MCP stdio client — app drives the native vox binary
talk.ts         direct-mic duplex session (spawns VOX_MODE=talk)
package.sh      build Vox.app + wrap in Vox.dmg
test-realtime.sh verify the in-browser Meet realtime path (no live call)
```

The voice engine is the `vox` Go binary in the repo root:
- Direct-mic uses `VOX_MODE=talk` (`localvoice.go`): OpenAI Realtime over local
  audio (ffmpeg/ffplay), no PulseAudio/Docker.
- Meet realtime runs the OpenAI Realtime session **in the meeting page**
  (`hook.js` `_kajuStartRealtime` + `engine.go`), capturing off the WebRTC tracks
  and playing the reply into the injected mic — only an OpenAI key, no Docker.
