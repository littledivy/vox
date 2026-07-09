# vox — put your Claude in the meeting

<img width="1192" height="872" alt="image" src="https://github.com/user-attachments/assets/3102e649-cd9c-4084-ae96-b3bc0f9bc568" />
<img width="364" height="495" alt="image" src="https://github.com/user-attachments/assets/57ca6e99-79c3-4a2c-bda3-a0baeb31a4cd" />

<img width="1209" height="926" alt="image" src="https://github.com/user-attachments/assets/56d00eac-5981-4386-87e8-72c190d7340f" />

vox is a local **MCP server** that lets your Claude agent join a Google Meet as a
real participant — it listens, talks back in a natural low-latency voice, knows
when to speak (and when to stay quiet), and answers with your Claude session's
full knowledge.

It runs entirely on your machine in a Docker container (Chromium + virtual audio),
so there's no echo, nothing to install on your Mac's audio, and it works while you
sit in the same call.

> **Prefer an app? No Docker?** [`app/`](app/) is a native macOS app (Deno Desktop)
> that sets up and drives vox from a UI — direct-mic voice, Google Meet, notes, and
> one-click MCP install. Meet and direct-mic both run natively on just an OpenAI key,
> no container. See [app/README.md](app/README.md).

## Quick start (one key, one command)

You need three things: **Docker Desktop**, **Claude Code**, and an **OpenAI API
key** ([platform.openai.com](https://platform.openai.com/api-keys), with billing
enabled — the Realtime API is pay-as-you-go).

```bash
claude mcp add vox -- docker run --rm -i \
  -e VOX_VOICE=realtime \
  -e VOX_OWNER="Your Name" \
  -e OPENAI_API_KEY=sk-proj-... \
  ghcr.io/denoland/vox:latest
```

Then **restart Claude Code** and just say:

> join my meeting https://meet.google.com/abc-defg-hij

Claude joins as *"Your Name's Claude"*, and you talk. (Docker pulls the image the
first time automatically — no clone, no build.)

That's it. In realtime mode OpenAI handles speech-in, reasoning, and voice-out, so
`OPENAI_API_KEY` is the only key required.

### How it behaves

- **1:1** (just you + the bot): it's conversational — answers your questions and
  greetings directly.
- **Group calls**: it stays out of the way — it speaks only when you address it by
  name ("*Your Name's Claude*, …") or when you're following up on what it just
  said. No talking over people.
- When it needs real detail it doesn't have, it consults your Claude agent
  (`consult_agent`) — which can read your repo, files, git history, and sessions,
  and run commands — then speaks the answer. If the conversation has moved on by
  then, it drops the answer in the meeting chat instead of interrupting.
- It shows a small dithering-shader avatar whose color tracks its state — idle,
  listening, thinking, speaking.

## Cost

Realtime mode is billed by OpenAI per audio token (roughly $1–4/hr of active
meeting on `gpt-realtime-2.1-mini`, depending on how much is said). See
[OpenAI pricing](https://platform.openai.com/docs/pricing).

## MCP tools

`join_meeting`, `wait_for_turn`, `speak`, `send_chat`, `stage_answers`,
`get_transcript`, `get_participants`, `mute_yourself`, `unmute_yourself`,
`leave_meeting`.

## Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `OPENAI_API_KEY` | — | **Required** for realtime mode. |
| `VOX_VOICE` | (classic) | Set to `realtime` for the one-key OpenAI voice. |
| `VOX_OWNER` | `Someone` | Who the bot represents; sets the display name. |
| `VOX_REALTIME_MODEL` | `gpt-realtime-2.1-mini` | Realtime model. |
| `VOX_REALTIME_VOICE` | `marin` | Voice (marin, cedar, alloy, coral, …). |
| `VOX_REALTIME_EFFORT` | `low` | Reasoning effort (minimal→xhigh). |

<details>
<summary>Classic pipeline (no OpenAI)</summary>

Without `VOX_VOICE=realtime`, vox uses Deepgram (STT) + Groq (fast layer) +
Orpheus/Together (TTS). That needs `DEEPGRAM_API_KEY`, `GROQ_API_KEY`, and
`TOGETHER_API_KEY`. The realtime path is simpler and recommended.
</details>

## Build from source

```bash
git clone https://github.com/denoland/vox && cd vox
docker build -t vox .        # multi-stage: compiles the Go binary in-image
# then use `vox` instead of ghcr.io/denoland/vox in the mcp add command
```

`./build.sh push` builds and pushes a multi-arch image to the registry.

## How it works

Chromium runs headless on Xvfb inside the container and joins the meeting. Two
PulseAudio virtual devices route audio with no real hardware — one null-sink the
browser plays the meeting into, and one remapped into a virtual mic the bot speaks
through — so it's echo-free and reliable even on the same Mac you're calling from.
A [social-reasoning gate](research/README.md) decides when to talk; the Go MCP
server on stdio is what your Claude agent drives.
