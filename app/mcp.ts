// Minimal MCP stdio client + single-session manager. Lets the app itself spawn
// the native vox binary (no Docker) and drive it — join a meeting, poll the
// transcript/participants, mute, leave — by speaking newline-delimited JSON-RPC
// over the child's stdin/stdout. The vox stderr stream is captured as live logs.

import { loginPath, readConfig, voxBinary, VOX_DIR } from "./backend.ts";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

class MCPClient {
  #proc: Deno.ChildProcess;
  #stdin: WritableStreamDefaultWriter<Uint8Array>;
  #enc = new TextEncoder();
  #dec = new TextDecoder();
  #id = 0;
  #pending = new Map<number, Pending>();
  #buf = "";
  logs: string[] = [];
  closed = false;

  constructor(bin: string, env: Record<string, string>) {
    this.#proc = new Deno.Command(bin, {
      env: { ...Deno.env.toObject(), ...env },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.#stdin = this.#proc.stdin.getWriter();
    // Fire-and-forget readers: a killed/exited child makes the stream reads
    // reject — catch here so it never becomes an app-killing unhandled rejection.
    this.#readStdout().catch(() => { this.closed = true; });
    this.#readStderr().catch(() => {});
    this.#proc.status.then(() => { this.closed = true; }).catch(() => { this.closed = true; });
  }

  async #readStdout() {
    for await (const chunk of this.#proc.stdout) {
      this.#buf += this.#dec.decode(chunk);
      let nl: number;
      while ((nl = this.#buf.indexOf("\n")) >= 0) {
        const line = this.#buf.slice(0, nl).trim();
        this.#buf = this.#buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.#pending.has(msg.id)) {
            const p = this.#pending.get(msg.id)!;
            this.#pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message ?? "rpc error"));
            else p.resolve(msg.result);
          }
        } catch { /* non-JSON line, ignore */ }
      }
    }
  }

  async #readStderr() {
    for await (const chunk of this.#proc.stderr) {
      const text = this.#dec.decode(chunk);
      for (const line of text.split("\n")) {
        if (line.trim()) {
          this.logs.push(line);
          if (this.logs.length > 500) this.logs.shift();
        }
      }
    }
  }

  #send(method: string, params?: unknown, notify = false): Promise<unknown> {
    const id = notify ? undefined : ++this.#id;
    const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    if (id !== undefined) msg.id = id;
    const line = JSON.stringify(msg) + "\n";
    const p = notify || id === undefined ? Promise.resolve(undefined) : new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error("timeout"));
        }
      }, 120_000);
    });
    // The write returns a promise; if the vox child has exited its stdin pipe is
    // broken. Catch it so it never becomes an unhandled rejection (which crashes
    // the whole app under `deno desktop`) — reject the pending RPC instead.
    this.#stdin.write(this.#enc.encode(line)).catch((e) => {
      this.closed = true;
      if (id !== undefined) {
        const pend = this.#pending.get(id);
        if (pend) { this.#pending.delete(id); pend.reject(new Error("vox engine exited: " + (e?.message ?? e))); }
      }
    });
    return p;
  }

  async initialize() {
    await this.#send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vox-desktop", version: "0.1.0" },
    });
    await this.#send("notifications/initialized", {}, true);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const res = await this.#send("tools/call", { name, arguments: args }) as
      { content?: { type: string; text?: string }[] };
    return (res?.content ?? []).map((c) => c.text ?? "").join("\n");
  }

  async kill() {
    // Try a graceful leave, but never let an unresponsive child block the kill
    // (call() otherwise waits up to its 120s RPC timeout).
    try {
      await Promise.race([
        this.call("leave_meeting").catch(() => {}),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
    } catch { /* ignore */ }
    try { this.#proc.kill(); } catch { /* ignore */ }
    this.closed = true;
  }
}

// ---- Single-session manager ---------------------------------------------

export interface Session {
  id: string;
  url: string;
  startedAt: number;
  joinResult: string;
}

let client: MCPClient | null = null;
let session: Session | null = null;

function sessionEnv(): Record<string, string> {
  // Force the native, no-Docker run: real Chrome (non-headless so the user can
  // complete any Google sign-in), persistent profile + logs under ~/.vox.
  return {
    VOX_CHROME_PROFILE: `${VOX_DIR}/chrome`,
    VOX_LOG_DIR: `${VOX_DIR}/logs`,
  };
}

// Accept a bare Meet code (abc-defg-hij) or a full URL.
function normalizeMeetUrl(input: string): string {
  const s = input.trim();
  if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(s)) return "https://meet.google.com/" + s.toLowerCase();
  if (/^meet\.google\.com\//i.test(s)) return "https://" + s;
  return s;
}

export async function joinMeeting(rawUrl: string, context = ""): Promise<{ ok: boolean; error?: string; result?: string }> {
  const url = normalizeMeetUrl(rawUrl);
  if (session) return { ok: false, error: "a session is already active" };
  const bin = await voxBinary();
  if (!bin) return { ok: false, error: "Vox engine not built — open Settings and click Build now" };
  const cfg = await readConfig();
  const env: Record<string, string> = { ...sessionEnv(), PATH: await loginPath() };
  if (cfg.owner) env.VOX_OWNER = cfg.owner;
  if (cfg.voice !== "classic") env.VOX_VOICE = "realtime";
  if (cfg.rt_voice) env.VOX_REALTIME_VOICE = cfg.rt_voice;
  if (cfg.rt_model) env.VOX_REALTIME_MODEL = cfg.rt_model;
  if (cfg.openai) env.OPENAI_API_KEY = cfg.openai;
  if (cfg.deepgram) env.DEEPGRAM_API_KEY = cfg.deepgram;
  if (cfg.groq) env.GROQ_API_KEY = cfg.groq;
  if (cfg.together) env.TOGETHER_API_KEY = cfg.together;

  try {
    client = new MCPClient(bin, env);
    await client.initialize();
    const args: Record<string, unknown> = { url };
    if (cfg.owner) args.owner = cfg.owner;
    if (context) args.context = context;
    const result = await client.call("join_meeting", args);
    // vox returns a plain-text result; a validation/refusal means we did NOT join,
    // so don't retain a session or leave a stray process behind.
    if (/valid Google Meet url|not a meet|join failed|error/i.test(result)) {
      await client.kill().catch(() => {});
      client = null;
      return { ok: false, error: result };
    }
    session = { id: crypto.randomUUID(), url, startedAt: Date.now(), joinResult: result };
    return { ok: true, result };
  } catch (e) {
    if (client) { await client.kill().catch(() => {}); client = null; }
    return { ok: false, error: String(e) };
  }
}

export async function sessionState() {
  if (!session || !client) return { active: false, logs: client?.logs.slice(-40) ?? [] };
  let transcript = "";
  let participants: string[] = [];
  try { transcript = await client.call("get_transcript"); } catch { /* ignore */ }
  try {
    const p = await client.call("get_participants");
    participants = p.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { /* ignore */ }
  return {
    active: !client.closed,
    ...session,
    transcript,
    participants,
    logs: client.logs.slice(-40),
  };
}

export async function muteToggle(mute: boolean): Promise<string> {
  if (!client) return "no session";
  return await client.call(mute ? "mute_yourself" : "unmute_yourself");
}

export async function leaveMeeting(): Promise<{ ok: boolean }> {
  if (client) { await client.kill().catch(() => {}); client = null; }
  session = null;
  return { ok: true };
}
