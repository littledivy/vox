// Vox desktop backend — settings persistence, environment/status detection, and
// native (no-Docker) MCP installation into Claude Desktop + Claude Code.
//
// Everything the UI needs is exposed as small JSON handlers consumed by main.ts.

export const HOME = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
export const VOX_DIR = `${HOME}/.vox`;
export const CONFIG_PATH = `${VOX_DIR}/config.json`;

// The vox Go binary. Resolution order: $VOX_BIN, a built binary at the repo
// root (dev), then $PATH. Released builds bundle it next to the app.
export const REPO_ROOT = new URL("../", import.meta.url).pathname;

export interface Config {
  owner?: string;
  voice?: string; // "realtime" | "classic"
  rt_voice?: string;
  rt_model?: string;
  openai?: string;
  deepgram?: string;
  groq?: string;
  together?: string;
  google_client_id?: string;
  google_client_secret?: string;
  google_refresh_token?: string;
}

export async function deleteNote(name: string): Promise<{ ok: boolean }> {
  const safe = name.replace(/[/\\]/g, "");
  if (!safe.endsWith(".md")) return { ok: false };
  try {
    await Deno.remove(`${VOX_DIR}/notes/${safe}`);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function openExternal(url: string): Promise<{ ok: boolean }> {
  // Only http(s) links, opened in the system browser.
  if (!/^https?:\/\//i.test(url)) return { ok: false };
  try {
    await new Deno.Command("open", { args: [url] }).output();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function revealNotes(): Promise<{ ok: boolean }> {
  const dir = `${VOX_DIR}/notes`;
  try {
    await Deno.mkdir(dir, { recursive: true });
    await new Deno.Command("open", { args: [dir] }).output();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ---- Settings ------------------------------------------------------------

export async function readConfig(): Promise<Config> {
  try {
    return JSON.parse(await Deno.readTextFile(CONFIG_PATH));
  } catch {
    return {};
  }
}

// Serialize writes so concurrent POST /api/settings can't interleave their
// read-modify-write and drop each other's fields.
let writeChain: Promise<unknown> = Promise.resolve();

export function writeConfig(patch: Config): Promise<Config> {
  const run = writeChain.then(() => doWriteConfig(patch));
  writeChain = run.catch(() => {}); // keep the chain alive past a failed write
  return run;
}

async function doWriteConfig(patch: Config): Promise<Config> {
  const cur = await readConfig();
  const next = { ...cur, ...patch };
  // Drop empty strings so we never persist blanks over real values elsewhere.
  for (const k of Object.keys(next) as (keyof Config)[]) {
    if (next[k] === "" || next[k] == null) delete next[k];
  }
  await Deno.mkdir(VOX_DIR, { recursive: true });
  await Deno.writeTextFile(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

// ---- Meeting notes -------------------------------------------------------

export async function saveNotes(
  title: string,
  body: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const text = (body ?? "").trim();
  if (!text) return { ok: false, error: "nothing to save yet" };
  const dir = `${VOX_DIR}/notes`;
  await Deno.mkdir(dir, { recursive: true });
  // Stable, sortable filename. (No Date.now dependence beyond the wall clock.)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug = (title || "meeting").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const path = `${dir}/${stamp}-${slug}.md`;
  const md = `# ${title || "Meeting"}\n\n_${new Date().toLocaleString()}_\n\n${text}\n`;
  await Deno.writeTextFile(path, md);
  return { ok: true, path };
}

export async function listNotes(): Promise<{ name: string; path: string }[]> {
  const dir = `${VOX_DIR}/notes`;
  const out: { name: string; path: string }[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.endsWith(".md")) out.push({ name: e.name, path: `${dir}/${e.name}` });
    }
  } catch { /* no notes yet */ }
  out.sort((a, b) => b.name.localeCompare(a.name));
  return out;
}

// summarizeNote reads a saved note, asks OpenAI for a concise summary + action
// items, prepends them to the note, and saves. Returns the updated body.
export async function summarizeNote(name: string): Promise<{ ok: boolean; body?: string; error?: string }> {
  const cfg = await readConfig();
  if (!cfg.openai) return { ok: false, error: "add your OpenAI key in Settings first" };
  const safe = name.replace(/[/\\]/g, "");
  let body: string;
  try {
    body = await Deno.readTextFile(`${VOX_DIR}/notes/${safe}`);
  } catch {
    return { ok: false, error: "note not found" };
  }
  if (/^## Summary/m.test(body)) return { ok: true, body }; // already summarized
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.openai}` },
      body: JSON.stringify({
        model: cfg.rt_model?.includes("mini") ? "gpt-4o-mini" : "gpt-4o-mini",
        messages: [
          { role: "system", content: "You summarize meeting transcripts. Reply in Markdown with exactly two sections: '## Summary' (3-5 tight bullet points) and '## Action items' (a checklist with '- [ ] ' items and the owner if named; write 'None' if there are none). Be concise and specific." },
          { role: "user", content: body.slice(0, 12000) },
        ],
        temperature: 0.3,
      }),
    });
    if (!res.ok) return { ok: false, error: `OpenAI ${res.status}` };
    const data = await res.json();
    const md = data.choices?.[0]?.message?.content?.trim();
    if (!md) return { ok: false, error: "no summary returned" };
    // Insert the summary right after the title/date header.
    const lines = body.split("\n");
    let insertAt = lines.findIndex((l, i) => i > 0 && l.trim() === "") + 1;
    if (insertAt <= 0) insertAt = 1;
    const next = [...lines.slice(0, insertAt), md, "", ...lines.slice(insertAt)].join("\n");
    await Deno.writeTextFile(`${VOX_DIR}/notes/${safe}`, next);
    return { ok: true, body: next };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function readNote(name: string): Promise<{ ok: boolean; body?: string }> {
  // Only allow reading files inside the notes dir (no path traversal).
  const safe = name.replace(/[/\\]/g, "");
  try {
    const body = await Deno.readTextFile(`${VOX_DIR}/notes/${safe}`);
    return { ok: true, body };
  } catch {
    return { ok: false };
  }
}

// ---- Binary / environment resolution ------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

const USER_BIN = `${HOME}/.vox/bin/vox`;
let binMaterialized = false; // re-copy the bundled binary once per app launch

export async function voxBinary(): Promise<string | null> {
  const env = Deno.env.get("VOX_BIN");
  if (env && await exists(env)) return env;

  // The `vox` binary is bundled with the app (--include ../vox) and, in a
  // packaged build, deno extracts it to an ephemeral temp dir with unreliable
  // permissions. So materialize a STABLE, executable copy at USER_BIN once per
  // launch (size comparison is unreliable — different builds can share a size),
  // guaranteeing the freshly-bundled binary is what runs. `../vox` resolves to
  // the repo binary in dev and the extracted copy when packaged.
  try {
    if (!binMaterialized) {
      const data = await Deno.readFile(new URL("../vox", import.meta.url));
      await Deno.mkdir(`${HOME}/.vox/bin`, { recursive: true });
      await Deno.writeFile(USER_BIN, data, { mode: 0o755 });
      await Deno.chmod(USER_BIN, 0o755).catch(() => {});
      binMaterialized = true;
    }
    if (await exists(USER_BIN)) return USER_BIN;
  } catch { /* not bundled / unreadable — fall through */ }

  for (const c of [USER_BIN, `${REPO_ROOT}vox`, `${REPO_ROOT}vox-bin`]) {
    if (await exists(c)) return c;
  }
  try {
    const out = await new Deno.Command("bash", { args: ["-lc", "command -v vox"] }).output();
    const p = new TextDecoder().decode(out.stdout).trim();
    if (p && await exists(p)) return p;
  } catch { /* ignore */ }
  return null;
}

// loginPath returns the user's real PATH (from a login shell), so spawned
// helpers resolve ffmpeg/ffplay/chrome even when the app was launched from
// Finder (GUI apps get a bare PATH that omits Homebrew/Nix bin dirs). Cached.
let _loginPath: string | null = null;
export async function loginPath(): Promise<string> {
  if (_loginPath) return _loginPath;
  const fallback = "/opt/homebrew/bin:/usr/local/bin:" +
    `${HOME}/.nix-profile/bin:/run/current-system/sw/bin:` +
    (Deno.env.get("PATH") ?? "/usr/bin:/bin:/usr/sbin:/sbin");
  try {
    const out = await new Deno.Command("bash", { args: ["-lc", "echo -n $PATH"] }).output();
    const p = new TextDecoder().decode(out.stdout).trim();
    _loginPath = p ? p + ":" + fallback : fallback;
  } catch {
    _loginPath = fallback;
  }
  return _loginPath;
}

async function onPath(cmd: string): Promise<boolean> {
  try {
    const out = await new Deno.Command("bash", { args: ["-lc", `command -v ${cmd}`] }).output();
    return out.success && new TextDecoder().decode(out.stdout).trim().length > 0;
  } catch {
    return false;
  }
}

async function chromePath(): Promise<string | null> {
  const cands = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    Deno.env.get("CHROME_PATH") ?? "",
  ];
  for (const c of cands) if (c && await exists(c)) return c;
  return null;
}

// mcpInstalled reports whether the vox MCP server is registered in each host.
async function mcpInstalled(): Promise<{ claude: boolean; codex: boolean }> {
  let claude = false, codex = false;
  try {
    const c = JSON.parse(await Deno.readTextFile(CLAUDE_DESKTOP_CFG));
    claude = !!(c.mcpServers && c.mcpServers.vox);
  } catch { /* not installed */ }
  try {
    const t = await Deno.readTextFile(`${HOME}/.codex/config.toml`);
    codex = /\[mcp_servers\.vox\]/.test(t);
  } catch { /* not installed */ }
  return { claude, codex };
}

export async function status() {
  const cfg = await readConfig();
  const bin = await voxBinary();
  const chrome = await chromePath();
  const mcp = await mcpInstalled();
  return {
    ok: true,
    binary: bin,
    hasBinary: !!bin,
    chrome,
    hasChrome: !!chrome,
    hasOpenAI: !!cfg.openai,
    hasDeepgram: !!cfg.deepgram,
    owner: cfg.owner ?? "",
    voice: cfg.voice ?? "realtime",
    // Meet needs the vox binary + Chrome + an OpenAI key.
    readyMeet: !!bin && !!chrome && !!cfg.openai,
    ready: !!cfg.openai,
    claudeInstalled: mcp.claude,
    codexInstalled: mcp.codex,
    calendarConnected: !!cfg.google_refresh_token,
  };
}

// ---- Build the vox binary natively (go build) ---------------------------

export async function buildVox(): Promise<{ ok: boolean; output: string; binary?: string }> {
  try {
    const out = await new Deno.Command("go", {
      args: ["build", "-o", "vox", "."],
      cwd: REPO_ROOT,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const log = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    const bin = await voxBinary();
    return { ok: out.success && !!bin, output: log.trim(), binary: bin ?? undefined };
  } catch (e) {
    return { ok: false, output: String(e) };
  }
}

// ---- MCP installation (no Docker) ---------------------------------------

// Env passed to the vox MCP server, derived from saved settings.
function voxEnv(cfg: Config): Record<string, string> {
  const env: Record<string, string> = {};
  if (cfg.owner) env.VOX_OWNER = cfg.owner;
  if (cfg.voice !== "classic") env.VOX_VOICE = "realtime";
  if (cfg.rt_voice) env.VOX_REALTIME_VOICE = cfg.rt_voice;
  if (cfg.rt_model) env.VOX_REALTIME_MODEL = cfg.rt_model;
  if (cfg.openai) env.OPENAI_API_KEY = cfg.openai;
  if (cfg.deepgram) env.DEEPGRAM_API_KEY = cfg.deepgram;
  if (cfg.groq) env.GROQ_API_KEY = cfg.groq;
  if (cfg.together) env.TOGETHER_API_KEY = cfg.together;
  // Native run: persist Chrome profile + logs under ~/.vox.
  env.VOX_CHROME_PROFILE = `${VOX_DIR}/chrome`;
  env.VOX_LOG_DIR = `${VOX_DIR}/logs`;
  if (_loginPath) env.PATH = _loginPath; // so ffmpeg/chrome resolve under GUI hosts
  return env;
}

const CLAUDE_DESKTOP_CFG =
  `${HOME}/Library/Application Support/Claude/claude_desktop_config.json`;

async function installClaudeDesktop(bin: string, env: Record<string, string>) {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await Deno.readTextFile(CLAUDE_DESKTOP_CFG));
  } catch { /* new file */ }
  const servers = (cfg.mcpServers as Record<string, unknown>) ?? {};
  servers.vox = { command: bin, args: [], env };
  cfg.mcpServers = servers;
  await Deno.mkdir(`${HOME}/Library/Application Support/Claude`, { recursive: true });
  await Deno.writeTextFile(CLAUDE_DESKTOP_CFG, JSON.stringify(cfg, null, 2));
  return CLAUDE_DESKTOP_CFG;
}

async function installClaudeCode(bin: string, env: Record<string, string>) {
  // Best-effort: use the claude CLI if present. Non-fatal if missing.
  try {
    const args = ["mcp", "add", "vox", "--scope", "user"];
    for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
    args.push("--", bin);
    const out = await new Deno.Command("bash", {
      args: ["-lc", `claude ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return out.success;
  } catch {
    return false;
  }
}

// installCodex registers the vox MCP server in Codex's config (~/.codex/
// config.toml under [mcp_servers.vox]). Replaces any existing vox block.
async function installCodex(bin: string, env: Record<string, string>): Promise<boolean> {
  const path = `${HOME}/.codex/config.toml`;
  let toml = "";
  try { toml = await Deno.readTextFile(path); } catch { /* new file */ }
  // Drop a previous [mcp_servers.vox] table (until the next top-level table).
  toml = toml.replace(/\n?\[mcp_servers\.vox\][\s\S]*?(?=\n\[|$)/g, "").trimEnd();
  const envInline = Object.entries(env)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ");
  const block = `\n\n[mcp_servers.vox]\ncommand = ${JSON.stringify(bin)}\nargs = []\n` +
    (envInline ? `env = { ${envInline} }\n` : "");
  try {
    await Deno.mkdir(`${HOME}/.codex`, { recursive: true });
    await Deno.writeTextFile(path, (toml + block).trimStart() + "\n");
    return true;
  } catch {
    return false;
  }
}

// mcpConfigSnippet returns the JSON the user could paste into a Claude config
// manually (the same entry installMCP writes).
export async function mcpConfigSnippet(): Promise<{ snippet: string }> {
  const bin = await voxBinary();
  const cfg = await readConfig();
  await loginPath();
  const entry = { mcpServers: { vox: { command: bin ?? "/path/to/vox", args: [], env: voxEnv(cfg) } } };
  return { snippet: JSON.stringify(entry, null, 2) };
}

// installMCP registers the vox MCP server. `which` selects the host: "claude"
// (Desktop + Code), "codex", or undefined for both.
export async function installMCP(
  which?: "claude" | "codex",
): Promise<{ ok: boolean; targets: string[]; error?: string }> {
  let bin = await voxBinary();
  if (!bin) {
    // Auto-build so install "just works" on first run.
    const b = await buildVox();
    if (!b.ok) return { ok: false, targets: [], error: "couldn't build vox: " + b.output.slice(0, 120) };
    bin = b.binary ?? await voxBinary();
  }
  if (!bin) return { ok: false, targets: [], error: "vox binary unavailable" };
  const cfg = await readConfig();
  await loginPath();
  const env = voxEnv(cfg);
  const targets: string[] = [];
  if (which !== "codex") {
    try {
      await installClaudeDesktop(bin, env);
      targets.push("Claude Desktop");
    } catch (e) {
      return { ok: false, targets, error: `Claude Desktop: ${e}` };
    }
    if (await installClaudeCode(bin, env)) targets.push("Claude Code");
  }
  if (which !== "claude") {
    if (await installCodex(bin, env)) targets.push("Codex");
  }
  return { ok: true, targets };
}

// uninstallMCP removes the vox server entry from a host's config.
export async function uninstallMCP(
  which: "claude" | "codex",
): Promise<{ ok: boolean }> {
  if (which === "claude") {
    try {
      const c = JSON.parse(await Deno.readTextFile(CLAUDE_DESKTOP_CFG));
      if (c.mcpServers) delete c.mcpServers.vox;
      await Deno.writeTextFile(CLAUDE_DESKTOP_CFG, JSON.stringify(c, null, 2));
    } catch { /* nothing to remove */ }
    // Best-effort remove from Claude Code too.
    await new Deno.Command("bash", {
      args: ["-lc", "claude mcp remove vox --scope user"],
    }).output().catch(() => {});
  } else {
    const path = `${HOME}/.codex/config.toml`;
    try {
      let toml = await Deno.readTextFile(path);
      toml = toml.replace(/\n?\[mcp_servers\.vox\][\s\S]*?(?=\n\[|$)/g, "").trimEnd() + "\n";
      await Deno.writeTextFile(path, toml);
    } catch { /* nothing to remove */ }
  }
  return { ok: true };
}
