// Vox desktop — a native macOS app that sets up and drives the vox voice agent
// (Google Meet / direct duplex), manages integrations, settings, and the MCP
// installation, with a minimal Claude-style UI.
//
// Architecture (deno desktop model): this is a normal Deno HTTP server. When run
// under `deno desktop`, Deno opens a native webview window pointed at the local
// server. The exact same code runs in a plain browser via `deno task serve` for
// fast UI iteration.
//
//   deno task dev     # desktop window, hot reload
//   deno task start   # desktop window
//   deno task serve   # plain browser dev at the printed URL

import {
  buildVox,
  deleteNote,
  installMCP,
  uninstallMCP,
  listNotes,
  mcpConfigSnippet,
  openExternal,
  readConfig,
  readNote,
  summarizeNote,
  revealNotes,
  saveNotes,
  status,
  writeConfig,
} from "./backend.ts";
import {
  joinMeeting,
  leaveMeeting,
  muteToggle,
  sessionState,
} from "./mcp.ts";
import {
  calendarEvents,
  calendarStatus,
  connectGoogle,
  disconnectGoogle,
} from "./calendar.ts";

// Under `deno desktop` an unhandled promise rejection or uncaught error kills
// the whole app. Backgrounded work around the spawned vox engine (broken pipes,
// killed-stream reads) can reject after we've already moved on, so swallow those
// globally — log them, but never let one take the window down.
globalThis.addEventListener("unhandledrejection", (e) => {
  console.error("[vox] unhandled rejection:", e.reason);
  e.preventDefault();
});
globalThis.addEventListener("error", (e) => {
  console.error("[vox] uncaught error:", (e as ErrorEvent).error ?? e);
  e.preventDefault();
});

const WEB = new URL("./web/", import.meta.url);
const WIN_W = 1080;
const WIN_H = 760;

// ---------------------------------------------------------------------------
// Static file serving (the ./web UI bundle, included in the compiled binary).
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function ext(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(i).toLowerCase();
}

async function serveStatic(pathname: string): Promise<Response> {
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  try {
    const data = await Deno.readFile(new URL(rel, WEB));
    return new Response(data, {
      headers: { "content-type": MIME[ext(rel)] ?? "application/octet-stream" },
    });
  } catch {
    // SPA fallback: unknown non-asset routes render the shell.
    if (!ext(rel)) {
      try {
        const data = await Deno.readFile(new URL("index.html", WEB));
        return new Response(data, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      } catch { /* fall through */ }
    }
    return new Response("Not found", { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// HTTP + JSON API.
// ---------------------------------------------------------------------------

// Under `deno desktop` the runtime injects the serve address; in plain browser
// dev we pick a free ephemeral port (0) so we never collide with another server.
const underDesktop = !!(Deno as Record<string, unknown>).BrowserWindow ||
  !!Deno.env.get("DENO_SERVE_ADDRESS");
const serveOpts: Deno.ServeTcpOptions = underDesktop ? {} : { port: 0 };

async function api(req: Request, pathname: string): Promise<Response | null> {
  switch (pathname) {
    case "/api/health":
      return Response.json({ ok: true, app: "vox", version: "0.1.0" });
    case "/api/status":
      return Response.json(await status());
    case "/api/settings":
      if (req.method === "POST") {
        const patch = await req.json();
        return Response.json(await writeConfig(patch));
      }
      return Response.json(await readConfig());
    case "/api/mcp/install": {
      const t = new URL(req.url).searchParams.get("target");
      const which = t === "claude" || t === "codex" ? t : undefined;
      return Response.json(await installMCP(which));
    }
    case "/api/mcp/uninstall": {
      const t = new URL(req.url).searchParams.get("target");
      if (t !== "claude" && t !== "codex") return Response.json({ ok: false });
      return Response.json(await uninstallMCP(t));
    }
    case "/api/mcp/config":
      return Response.json(await mcpConfigSnippet());
    case "/api/vox/build":
      return Response.json(await buildVox());
    case "/api/session/join": {
      const { url, context } = await req.json();
      return Response.json(await joinMeeting(url, context ?? ""));
    }
    case "/api/session/state":
      return Response.json(await sessionState());
    case "/api/session/mute": {
      const { mute } = await req.json();
      return Response.json({ ok: true, result: await muteToggle(!!mute) });
    }
    case "/api/session/leave":
      return Response.json(await leaveMeeting());
    case "/api/calendar/status":
      return Response.json(await calendarStatus());
    case "/api/calendar/connect":
      return Response.json(await connectGoogle());
    case "/api/calendar/disconnect":
      return Response.json(await disconnectGoogle());
    case "/api/calendar/events":
      return Response.json(await calendarEvents());
    case "/api/notes/save": {
      const { title, body } = await req.json();
      return Response.json(await saveNotes(title ?? "", body ?? ""));
    }
    case "/api/notes/list":
      return Response.json(await listNotes());
    case "/api/notes/read": {
      const name = new URL(req.url).searchParams.get("name") ?? "";
      return Response.json(await readNote(name));
    }
    case "/api/notes/summarize": {
      const { name } = await req.json();
      return Response.json(await summarizeNote(name ?? ""));
    }
    case "/api/notes/reveal":
      return Response.json(await revealNotes());
    case "/api/notes/delete": {
      const { name } = await req.json();
      return Response.json(await deleteNote(name ?? ""));
    }
    case "/api/open": {
      const { url } = await req.json();
      return Response.json(await openExternal(url ?? ""));
    }
    default:
      return null;
  }
}

Deno.serve(serveOpts, async (req) => {
  const { pathname } = new URL(req.url);
  if (pathname.startsWith("/api/")) {
    try {
      const r = await api(req, pathname);
      if (r) return r;
      return Response.json({ ok: false, error: "unknown endpoint" }, { status: 404 });
    } catch (e) {
      return Response.json({ ok: false, error: String(e) }, { status: 500 });
    }
  }
  return serveStatic(pathname);
});

// ---------------------------------------------------------------------------
// Native window (only present under `deno desktop`, absent in browser dev).
// ---------------------------------------------------------------------------

type DesktopWindow = {
  setSize?: (w: number, h: number) => void;
  setTitle?: (t: string) => void;
  setApplicationMenu?: (menu: unknown[]) => void;
  executeJs?: (code: string) => Promise<unknown>;
  addEventListener?: (
    type: string,
    cb: (e: { detail?: { id?: string } }) => void,
  ) => void;
};
const desktop = Deno as unknown as {
  BrowserWindow?: new (opts: Record<string, unknown>) => DesktopWindow;
};

function applicationMenu() {
  const item = (label: string, id: string, accelerator?: string) => ({
    item: { label, id, accelerator, enabled: true },
  });
  const role = (r: string) => ({ role: { role: r } });
  return [
    { submenu: { label: "Vox", items: [role("about"), "separator", role("hide"), role("quit")] } },
    {
      submenu: {
        label: "Go",
        items: [
          item("Home", "nav-home", "CmdOrCtrl+1"),
          item("Integrations", "nav-integrations", "CmdOrCtrl+2"),
          item("Notes", "nav-notes", "CmdOrCtrl+3"),
          item("Settings", "nav-settings", "CmdOrCtrl+4"),
          "separator",
          item("Join a meeting…", "join", "CmdOrCtrl+J"),
        ],
      },
    },
    {
      submenu: {
        label: "Edit",
        items: [role("undo"), role("redo"), "separator", role("cut"), role("copy"), role("paste"), role("selectAll")],
      },
    },
    { submenu: { label: "Window", items: [role("minimize"), role("zoom"), role("front")] } },
    { submenu: { label: "Help", items: [item("Vox Help & Shortcuts", "help", "?")] } },
  ];
}

if (desktop.BrowserWindow) {
  const win = new desktop.BrowserWindow({
    title: "Vox",
    width: WIN_W,
    height: WIN_H,
  });
  const size = () => win.setSize?.(WIN_W, WIN_H);
  size();
  win.setTitle?.("Vox");
  setTimeout(size, 250);

  // Quit when the window is closed. Deno.serve is a live async task, so without
  // this the process (and the close button) would appear to do nothing — the
  // runtime only exits when no windows are open AND no async tasks remain.
  win.addEventListener?.("close", () => Deno.exit(0));

  win.setApplicationMenu?.(applicationMenu());
  win.addEventListener?.("menuclick", (e) => {
    const id = e.detail?.id;
    const nav: Record<string, string> = {
      "nav-home": "home",
      "nav-integrations": "integrations",
      "nav-notes": "notes",
      "nav-settings": "settings",
    };
    if (id && nav[id]) win.executeJs?.(`location.hash='${nav[id]}'`);
    else if (id === "join") win.executeJs?.(`globalThis.voxOpenJoin&&globalThis.voxOpenJoin()`);
    else if (id === "help") win.executeJs?.(`globalThis.voxOpenHelp&&globalThis.voxOpenHelp()`);
  });
}
