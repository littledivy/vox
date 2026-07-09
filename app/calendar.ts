// Google Calendar integration. Uses an OAuth2 "Desktop app" client (client id +
// secret the user creates in Google Cloud Console) and a loopback redirect to
// obtain a refresh token — no server, no secrets leave this Mac. Once connected,
// we list upcoming events (including their Meet links so Vox can join them).
//
// The credential setup in Cloud Console is fiddly, so `autoSetup()` can drive it
// with computer-use (the vox binary's on-screen control); if that isn't
// available it opens the right console pages and returns step-by-step guidance.

import { readConfig, writeConfig } from "./backend.ts";

const CAL_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const AUTH_EP = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_EP = "https://oauth2.googleapis.com/token";

// Google OAuth "Desktop app" client. Provide your own via ~/.vox/config.json
// (google_client_id / google_client_secret) or the VOX_GOOGLE_CLIENT_ID /
// VOX_GOOGLE_CLIENT_SECRET env vars — none is shipped in source, so calendar is
// opt-in with your own Cloud Console client (Application type: Desktop app).
const DEFAULT_CLIENT_ID = Deno.env.get("VOX_GOOGLE_CLIENT_ID") ?? "";
const DEFAULT_CLIENT_SECRET = Deno.env.get("VOX_GOOGLE_CLIENT_SECRET") ?? "";

function creds(cfg: { google_client_id?: string; google_client_secret?: string }) {
  return {
    id: cfg.google_client_id || DEFAULT_CLIENT_ID,
    secret: cfg.google_client_secret || DEFAULT_CLIENT_SECRET,
  };
}

export interface CalStatus {
  connected: boolean;
}

export async function calendarStatus(): Promise<CalStatus> {
  const cfg = await readConfig();
  return { connected: !!cfg.google_refresh_token };
}

// connectGoogle runs the loopback OAuth flow: spin up a throwaway local server,
// open the consent screen, catch the redirect, exchange the code for a refresh
// token, and persist it. Desktop-app clients allow any localhost port, so no
// redirect URI needs pre-registering.
export async function connectGoogle(): Promise<{ ok: boolean; error?: string }> {
  const cfg = await readConfig();
  const { id: clientId, secret: clientSecret } = creds(cfg);
  if (!clientId || !clientSecret) {
    return { ok: false, error: "No Google client configured. Add google_client_id / google_client_secret to ~/.vox/config.json (create a Desktop-app OAuth client in Google Cloud Console)." };
  }

  let resolveCode: (c: string) => void = () => {};
  let rejectCode: (e: string) => void = () => {};
  const codeP = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    (req) => {
      const u = new URL(req.url);
      if (u.pathname !== "/oauth2callback") return new Response("ok");
      const code = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      const html = (msg: string) =>
        new Response(
          `<!doctype html><meta charset=utf-8><body style="font:16px -apple-system,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#2b2822"><div style="text-align:center"><h2>${msg}</h2><p style="color:#8a8378">You can close this tab and return to Vox.</p></div>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      if (code) {
        resolveCode(code);
        return html("Vox is connected to Google Calendar");
      }
      rejectCode(err || "no code");
      return html("Authorization failed");
    },
  );

  try {
    const port = (server.addr as Deno.NetAddr).port;
    const redirect = `http://localhost:${port}/oauth2callback`;
    const authUrl = `${AUTH_EP}?` +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope: CAL_SCOPE,
        access_type: "offline",
        prompt: "consent",
      });
    await new Deno.Command("open", { args: [authUrl] }).output();

    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("timed out — try again")), 180_000)
    );
    const code = await Promise.race([codeP, timeout]);

    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirect,
      grant_type: "authorization_code",
    });
    const r = await fetch(TOKEN_EP, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const tok = await r.json();
    if (!r.ok || !tok.refresh_token) {
      return {
        ok: false,
        error: tok.error_description || tok.error || "token exchange failed (no refresh token — remove Vox at myaccount.google.com/permissions and retry)",
      };
    }
    await writeConfig({ google_refresh_token: tok.refresh_token });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  } finally {
    ac.abort();
  }
}

export async function disconnectGoogle(): Promise<{ ok: boolean }> {
  await writeConfig({ google_refresh_token: "" });
  return { ok: true };
}

// accessToken mints a short-lived access token from the stored refresh token.
async function accessToken(): Promise<string | null> {
  const cfg = await readConfig();
  if (!cfg.google_refresh_token) return null;
  const { id: clientId, secret: clientSecret } = creds(cfg);
  const r = await fetch(TOKEN_EP, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: cfg.google_refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const tok = await r.json();
  return r.ok ? (tok.access_token ?? null) : null;
}

export interface CalEvent {
  title: string;
  start: string; // ISO
  startLabel: string;
  meetUrl: string;
}

export async function calendarEvents(): Promise<
  { ok: boolean; events?: CalEvent[]; error?: string }
> {
  const at = await accessToken();
  if (!at) return { ok: false, error: "not connected" };
  const now = new Date().toISOString();
  const url = "https://www.googleapis.com/calendar/v3/calendars/primary/events?" +
    new URLSearchParams({
      timeMin: now,
      maxResults: "10",
      singleEvents: "true",
      orderBy: "startTime",
    });
  const r = await fetch(url, { headers: { authorization: `Bearer ${at}` } });
  if (!r.ok) return { ok: false, error: `calendar API ${r.status}` };
  const data = await r.json();
  const events: CalEvent[] = (data.items ?? []).map((it: Record<string, any>) => {
    const startRaw = it.start?.dateTime ?? it.start?.date ?? "";
    const meet = it.hangoutLink ??
      (it.conferenceData?.entryPoints ?? []).find((e: Record<string, string>) =>
        e.entryPointType === "video"
      )?.uri ?? "";
    return {
      title: it.summary ?? "(no title)",
      start: startRaw,
      startLabel: fmtWhen(startRaw),
      meetUrl: typeof meet === "string" ? meet : "",
    };
  });
  return { ok: true, events };
}

function fmtWhen(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

