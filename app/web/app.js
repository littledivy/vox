// Vox desktop UI — vanilla, no build step. Talks to the Deno backend over the
// JSON API (fetch) so the same page works in a browser and in the webview.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---- Router -------------------------------------------------------------
function setWinTitle(suffix) { document.title = suffix ? "Vox · " + suffix : "Vox"; }

function show(view) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === view));
  $$("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  location.hash = view;
  if (["home", "integrations", "notes", "settings"].includes(view)) localStorage.setItem("vox_view", view);
  if (view === "notes") loadNotes();
}
$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) show(b.dataset.view);
});
addEventListener("hashchange", () => { const v = location.hash.slice(1) || "home"; show(v); if (v === "notes") loadNotes(); });

let STATUS_SESSION_ACTIVE = false;

// ---- Notes --------------------------------------------------------------
let NOTES = [];
function noteLabel(name) { return name.replace(/\.md$/, "").replace(/^(\d{4}-\d\d-\d\d)T([\d-]+)-/, "$1 · "); }

async function loadNotes() {
  try {
    NOTES = await (await fetch("/api/notes/list")).json();
    renderNotesList();
  } catch { /* ignore */ }
}

function renderNotesList() {
  const list = $("#notesList");
  const q = ($("#notesSearch")?.value || "").toLowerCase();
  const filtered = NOTES.filter((n) => noteLabel(n.name).toLowerCase().includes(q));
  document.querySelector(".notes-layout")?.classList.toggle("empty", !NOTES.length);
  if (!NOTES.length) {
    list.innerHTML = "";
    $("#notesBody").innerHTML = '<div class="notes-empty"><p>No notes yet.</p><p class="muted">Hit <b>Save notes</b> during a meeting or voice session and it lands here.</p></div>';
    return;
  }
  if (!filtered.length) { list.innerHTML = '<span class="muted">No matches.</span>'; return; }
  list.innerHTML = filtered.map((n) =>
    `<div class="note-row"><button class="note-item" data-name="${n.name}">${esc(noteLabel(n.name))}</button><button class="note-del" data-del="${n.name}" title="Delete" aria-label="Delete note ${esc(noteLabel(n.name))}">✕</button></div>`
  ).join("");
  $$("#notesList .note-item").forEach((b) => b.addEventListener("click", () => openNote(b, b.dataset.name)));
  $$("#notesList .note-del").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    await fetch("/api/notes/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: b.dataset.del }) }).catch(() => {});
    toast("Note deleted");
    NOTES = NOTES.filter((n) => n.name !== b.dataset.del);
    $("#notesBody").innerHTML = '<span class="muted">Select a note.</span>';
    renderNotesList();
  }));
  $("#notesList .note-item")?.click();
}

function renderNote(name, body) {
  const has = /^## Summary/m.test(body);
  $("#notesBody").innerHTML =
    `<div class="note-tools"><button class="btn tiny" id="btnSummarize" ${has ? "disabled" : ""}>${has ? "Summarized" : "Summarize with AI"}</button></div><pre>${esc(body)}</pre>`;
  $("#btnSummarize")?.addEventListener("click", async () => {
    const btn = $("#btnSummarize");
    btn.disabled = true; btn.textContent = "Summarizing…";
    try {
      const d = await (await fetch("/api/notes/summarize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) })).json();
      if (d.ok) { renderNote(name, d.body); toast("Summary added"); }
      else { toast(d.error || "Couldn't summarize"); btn.disabled = false; btn.textContent = "Summarize with AI"; }
    } catch { toast("Couldn't summarize"); btn.disabled = false; btn.textContent = "Summarize with AI"; }
  });
}
async function openNote(b, name) {
  $$("#notesList .note-item").forEach((x) => x.classList.remove("active"));
  b?.classList.add("active");
  const d = await (await fetch("/api/notes/read?name=" + encodeURIComponent(name))).json();
  if (d.ok) renderNote(name, d.body);
  else $("#notesBody").innerHTML = '<span class="muted">Could not read note.</span>';
}

// ---- Toast --------------------------------------------------------------
let toastT;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("show"), 2200);
}

// ---- Greeting -----------------------------------------------------------
function greet() {
  const h = new Date().getHours();
  const g = h < 5 ? "Still up?" : h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
  $("#greetTitle").textContent = g;
}

// ---- Integration data ---------------------------------------------------
// Brand/logo marks (real logos where available; clean glyphs otherwise).
const LOGOS = {
  meet: { bg: "#00832D", fill: `<svg viewBox="0 0 24 24" fill="#fff"><path d="M5.53 2.13 0 7.75h5.53zm.398 0v5.62h7.608v3.65l5.47-4.45c-.014-1.22.031-2.25-.025-3.46-.148-1.09-1.287-1.47-2.236-1.36zM23.1 4.32c-.802.295-1.358.995-2.047 1.49-2.506 2.05-4.982 4.12-7.468 6.19 3.025 2.59 6.04 5.18 9.065 7.76 1.218.671 1.428-.814 1.328-1.64v-13a.828.828 0 0 0-.877-.825zM.038 8.15v7.7h5.53v-7.7zm13.577 8.1H6.008v5.62c3.864-.006 7.737.011 11.58-.009 1.02-.07 1.618-1.12 1.468-2.07v-2.51l-5.47-4.68v3.65zm-13.577 0c.02 1.44-.041 2.88.033 4.31.162.948 1.158 1.43 2.047 1.31h3.464v-5.62z"/></svg>` },
  zoom: { bg: "#0B5CFF", fill: `<svg viewBox="0 0 24 24" fill="#fff"><path d="M5.033 14.649H.743a.74.74 0 0 1-.686-.458.74.74 0 0 1 .16-.808L3.19 10.41H1.06A1.06 1.06 0 0 1 0 9.35h3.957c.301 0 .57.18.686.458a.74.74 0 0 1-.161.808L1.51 13.59h2.464c.585 0 1.06.475 1.06 1.06zM24 11.338c0-1.14-.927-2.066-2.066-2.066-.61 0-1.158.265-1.537.686a2.061 2.061 0 0 0-1.536-.686c-1.14 0-2.066.926-2.066 2.066v3.311a1.06 1.06 0 0 0 1.06-1.06v-2.251a1.004 1.004 0 0 1 2.013 0v2.251c0 .586.474 1.06 1.06 1.06v-3.311a1.004 1.004 0 0 1 2.012 0v2.251c0 .586.475 1.06 1.06 1.06zM16.265 12a2.728 2.728 0 1 1-5.457 0 2.728 2.728 0 0 1 5.457 0zm-1.06 0a1.669 1.669 0 1 0-3.338 0 1.669 1.669 0 0 0 3.338 0zm-4.82 0a2.728 2.728 0 1 1-5.458 0 2.728 2.728 0 0 1 5.457 0zm-1.06 0a1.669 1.669 0 1 0-3.338 0 1.669 1.669 0 0 0 3.338 0z"/></svg>` },
  calendar: { bg: "#1A73E8", fill: `<svg viewBox="0 0 24 24" fill="#fff"><path d="M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z"/></svg>` },
  teams: { bg: "#6264A7", fill: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7"><circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><circle cx="17.5" cy="9" r="2.1"/><path d="M16 20a5 5 0 0 1 5.5-4.7"/></svg>` },
  direct: { bg: "#cc7a52", fill: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>` },
  claude: { bg: "#D97757", fill: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"><path d="M12 2.5v19M2.5 12h19M5.2 5.2l13.6 13.6M18.8 5.2 5.2 18.8M8.1 3.1l7.8 17.8M15.9 3.1 8.1 20.9M3.1 8.1l17.8 7.8M3.1 15.9 20.9 8.1"/></svg>` },
  codex: { bg: "#0B0B0B", fill: `<svg viewBox="0 0 24 24" fill="#fff"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.998-2.9 6.056 6.056 0 0 0-.748-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.142-.08 4.778-2.758a.795.795 0 0 0 .393-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.495 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.647zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.677l5.815 3.354-2.02 1.169a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.856-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.666zm2.01-3.023-.142-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.057V6.074a4.5 4.5 0 0 1 7.376-3.454l-.142.08L8.704 5.46a.795.795 0 0 0-.393.68zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>` },
  notes: { bg: "#8a8378", fill: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>` },
  keys: { bg: "#cc7a52", fill: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7"><circle cx="7.5" cy="15.5" r="4"/><path d="M10.3 12.7 20 3M17 6l2.5 2.5M14 9l2 2"/></svg>` },
};

const MEETINGS = [
  { id: "meet", name: "Google Meet", desc: "Joins your Meet calls.", status: "on" },
  { id: "zoom", name: "Zoom", desc: "Zoom calls.", status: "soon" },
  { id: "teams", name: "Microsoft Teams", desc: "Teams calls.", status: "soon" },
];
const TOOLS = [
  { id: "calendar", name: "Google Calendar", desc: "Your upcoming events, one tap to join.", status: "on" },
  { id: "claude", name: "Claude", desc: "Let Claude send Vox into a call.", status: "on" },
  { id: "codex", name: "Codex", desc: "Let Codex send Vox into a call.", status: "on" },
  { id: "notes", name: "Meeting notes", desc: "Transcripts you saved.", status: "on" },
];

function logoHtml(id) {
  const lg = LOGOS[id];
  return lg ? `<div class="logo brand" style="background:${lg.bg}">${lg.fill}</div>` : `<div class="logo"></div>`;
}

// Badge reflects real state (installed / connected / ready), not a static flag.
function badgeFor(x) {
  if (x.status === "soon") return '<span class="badge soon">Soon</span>';
  const S = STATUS || {};
  switch (x.id) {
    case "calendar": return S.calendarConnected ? '<span class="badge on">Connected</span>' : '<span class="badge">Connect</span>';
    case "claude": return S.claudeInstalled ? '<span class="badge on">Installed</span>' : '<span class="badge">Install</span>';
    case "codex": return S.codexInstalled ? '<span class="badge on">Installed</span>' : '<span class="badge">Install</span>';
    case "meet": return S.readyMeet ? '<span class="badge on">Ready</span>' : '<span class="badge warn">Setup</span>';
    default: return '<span class="badge on">On</span>';
  }
}

function card(x) {
  return `<div class="card link" data-id="${x.id}" data-status="${x.status}">
    ${badgeFor(x)}
    ${logoHtml(x.id)}
    <h3>${x.name}</h3>
    <p>${x.desc}</p>
  </div>`;
}

function renderCards() {
  if ($("#meetGrid")) $("#meetGrid").innerHTML = MEETINGS.map(card).join("");
  if ($("#toolGrid")) $("#toolGrid").innerHTML = TOOLS.map(card).join("");
}

const SOON_MSG = {
  zoom: "Zoom is on the roadmap — Google Meet works today.",
  teams: "Teams is on the roadmap — Google Meet works today.",
};
document.addEventListener("click", (e) => {
  const c = e.target.closest(".card.link");
  if (!c) return;
  const id = c.dataset.id;
  if (c.dataset.status === "soon") { toast(SOON_MSG[id] || "Coming soon."); return; }
  openIntegration(id);
});

// ---- Integration config modal -------------------------------------------
const INT_META = {
  meet: { title: "Google Meet", desc: "Vox joins a Meet call and talks for you." },
  calendar: { title: "Google Calendar", desc: "Your upcoming events, with one-tap join." },
  claude: { title: "Claude", desc: "Register Vox as an MCP server for Claude." },
  codex: { title: "Codex", desc: "Register Vox as an MCP server for Codex." },
  notes: { title: "Meeting notes", desc: "Saved transcripts, kept on this Mac." },
};
const dot = (ok, text) => `<span class="int-dot ${ok ? "ok" : "no"}"></span>${text}`;
function closeInt() { $("#intModal").classList.remove("show"); }

function openIntegration(id) {
  const meta = INT_META[id];
  if (!meta) return;
  const S = STATUS || {};
  $("#intLogo").innerHTML = logoHtml(id);
  $("#intTitle").textContent = meta.title;
  $("#intDesc").textContent = meta.desc;
  let statusHtml = "", body = "", actions = [];

  if (id === "meet") {
    statusHtml = dot(S.readyMeet, S.readyMeet ? "Ready" : "Setup needed");
    body = intRows([
      ["OpenAI key", S.hasOpenAI],
      ["vox engine", S.hasBinary],
      ["Google Chrome", S.hasChrome],
    ]);
    actions = [{ label: "Join a meeting", primary: true, fn: () => { closeInt(); $("#btnJoin").click(); } }];
    if (!S.hasOpenAI) actions.unshift({ label: "Add key", fn: () => { closeInt(); show("settings"); } });
  } else if (id === "calendar") {
    const c = S.calendarConnected;
    statusHtml = dot(c, c ? "Connected" : "Not connected");
    body = `<p class="int-note">${c ? "Vox is reading your Google Calendar. Upcoming events appear on Home." : "Sign in with Google for read-only calendar access. Vox is an unverified test app, so choose <b>Advanced → Continue</b>, then Allow."}</p>`;
    actions = c
      ? [{ label: "Open calendar", primary: true, fn: () => { closeInt(); openCalendar(); } },
         { label: "Disconnect", danger: true, fn: async () => { await fetch("/api/calendar/disconnect", { method: "POST" }).catch(() => {}); toast("Disconnected"); await refreshStatus(); openIntegration("calendar"); } }]
      : [{ label: "Connect Google", primary: true, fn: connectGoogleFlow }];
  } else if (id === "claude" || id === "codex") {
    const inst = id === "claude" ? S.claudeInstalled : S.codexInstalled;
    const nm = id === "claude" ? "Claude" : "Codex";
    statusHtml = dot(inst, inst ? "Installed" : "Not installed");
    body = `<p class="int-note">${id === "claude"
      ? 'Adds a <span class="kbd">vox</span> entry to Claude Desktop and runs <span class="kbd">claude mcp add</span>.'
      : 'Writes <span class="kbd">[mcp_servers.vox]</span> to <span class="kbd">~/.codex/config.toml</span>.'}</p>`;
    actions = inst
      ? [{ label: "Reinstall", fn: () => installInto(id) },
         { label: "Remove", danger: true, fn: async () => { await fetch("/api/mcp/uninstall?target=" + id, { method: "POST" }).catch(() => {}); toast(nm + " removed"); await refreshStatus(); openIntegration(id); } }]
      : [{ label: "Install", primary: true, fn: () => installInto(id) }];
  } else if (id === "notes") {
    statusHtml = dot(true, "On");
    body = `<p class="int-note">Saved transcripts live in <span class="kbd">~/.vox/notes</span>.</p>`;
    actions = [{ label: "Open notes", primary: true, fn: () => { closeInt(); show("notes"); } }];
  }

  $("#intStatus").innerHTML = statusHtml;
  $("#intBody").innerHTML = body;
  const ab = $("#intActions");
  ab.innerHTML = "";
  actions.forEach((a) => {
    const b = document.createElement("button");
    b.className = "btn" + (a.primary ? " primary" : "") + (a.danger ? " danger" : "");
    b.textContent = a.label;
    b.addEventListener("click", a.fn);
    ab.appendChild(b);
  });
  $("#intModal").classList.add("show");
}

function intRows(rows) {
  return '<div class="int-rows">' + rows.map(([name, ok]) =>
    `<div class="int-row"><span class="int-dot ${ok ? "ok" : "no"}"></span><span>${name}</span><span class="int-row-v">${ok ? "ready" : "missing"}</span></div>`
  ).join("") + "</div>";
}

// Shared connect flow (used by the modal and the calendar view).
async function connectGoogleFlow(ev) {
  const b = ev?.target;
  if (b) { b.disabled = true; b.textContent = "Waiting for Google…"; }
  try {
    const d = await (await fetch("/api/calendar/connect", { method: "POST" })).json();
    if (d.ok) { toast("Connected to Google Calendar"); await refreshStatus(); if ($("#intModal").classList.contains("show")) openIntegration("calendar"); refreshCalendar?.(); }
    else { toast(d.error || "Couldn't connect"); if (b) { b.disabled = false; b.textContent = "Connect Google"; } }
  } catch { toast("Connect failed — is the backend running?"); if (b) { b.disabled = false; b.textContent = "Connect Google"; } }
}

// Install the vox MCP server into a specific host (Claude or Codex).
async function installInto(target) {
  const name = target === "codex" ? "Codex" : "Claude";
  toast("Installing into " + name + "…");
  try {
    const d = await (await fetch("/api/mcp/install?target=" + target, { method: "POST" })).json();
    if (d.ok) toast("Installed into " + (d.targets?.join(" + ") || name));
    else toast(d.error || "Install failed");
  } catch { toast("Install failed"); }
  await refreshStatus();
  if ($("#intModal").classList.contains("show")) openIntegration(target);
}

$("#intClose")?.addEventListener("click", closeInt);
$("#intModal")?.addEventListener("click", (e) => { if (e.target.id === "intModal") closeInt(); });

// ---- Settings (persisted via backend) -----------------------------------
const FIELDS = {
  owner: "s_owner", voice: "s_voice", rt_voice: "s_rt_voice", rt_model: "s_rt_model",
  openai: "s_openai", deepgram: "s_deepgram", groq: "s_groq", together: "s_together",
};

async function loadSettings() {
  try {
    const r = await fetch("/api/settings");
    if (!r.ok) return;
    const s = await r.json();
    for (const [k, id] of Object.entries(FIELDS)) {
      if (s[k] != null && $("#" + id)) $("#" + id).value = s[k];
    }
  } catch { /* backend not ready */ }
}

async function saveSettings() {
  const body = {};
  for (const [k, id] of Object.entries(FIELDS)) body[k] = $("#" + id)?.value ?? "";
  try {
    const r = await fetch("/api/settings", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error();
    toast("Settings saved");
    refreshStatus();
  } catch {
    toast("Couldn't save (backend offline)");
  }
}

// ---- Actions ------------------------------------------------------------
$("#btnSave").addEventListener("click", saveSettings);
let clearArmed = false, clearTimer;
$("#btnClearKeys").addEventListener("click", async () => {
  if (!clearArmed) {
    clearArmed = true; $("#btnClearKeys").textContent = "Confirm forget";
    clearTimer = setTimeout(() => { clearArmed = false; $("#btnClearKeys").textContent = "Forget keys"; }, 3000);
    return;
  }
  clearTimeout(clearTimer); clearArmed = false; $("#btnClearKeys").textContent = "Forget keys";
  for (const id of ["s_openai", "s_deepgram", "s_groq", "s_together"]) if ($("#" + id)) $("#" + id).value = "";
  await saveSettings();
  toast("API keys cleared");
});
let mcpSnippet = "";
$("#mcpManual")?.addEventListener("toggle", async (e) => {
  if (!e.target.open) return;
  try { const d = await (await fetch("/api/mcp/config")).json(); mcpSnippet = d.snippet; $("#mcpSnippet").textContent = d.snippet; } catch { /* */ }
});
$("#btnCopyMcp")?.addEventListener("click", () => copyText(mcpSnippet || $("#mcpSnippet").textContent));
$("#btnRevealNotes")?.addEventListener("click", () => fetch("/api/notes/reveal", { method: "POST" }).catch(() => {}));
$("#notesSearch")?.addEventListener("input", renderNotesList);

// External links open in the system browser (not the webview).
function openExternal(url) { fetch("/api/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) }).catch(() => {}); }
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-ext]");
  if (a) { e.preventDefault(); openExternal(a.getAttribute("href")); }
});

// ---- Join modal + live session ------------------------------------------
function openJoin() { $("#joinModal").classList.add("show"); $("#joinUrl").focus(); }
function closeJoin() { $("#joinModal").classList.remove("show"); }
$("#btnJoin").addEventListener("click", openJoin);
globalThis.voxOpenJoin = openJoin; // native menu → Join
$("#joinCancel").addEventListener("click", closeJoin);
$("#joinModal").addEventListener("click", (e) => { if (e.target.id === "joinModal") closeJoin(); });
$("#joinUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#joinGo").click(); });

$("#joinGo").addEventListener("click", async () => {
  const url = $("#joinUrl").value.trim();
  if (!url) return toast("Paste a meeting link");
  $("#joinGo").disabled = true;
  toast("Sending Vox in…");
  try {
    const r = await fetch("/api/session/join", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, context: $("#joinContext").value.trim() }),
    });
    const d = await r.json();
    if (d.ok) {
      closeJoin();
      show("session");
      startSessionPolling();
      toast("Vox is joining");
    } else {
      toast(d.error || "Couldn't join");
    }
  } catch { toast("Couldn't join (backend offline)"); }
  finally { $("#joinGo").disabled = false; }
});

let sessPoll, sessStart, sessLastLen = -1, sessOrbTimer, sessLastUrl = "";
function fmtTimer(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}
// Normalize a raw speaker label: "test's Claude" / "participant" -> Vox / You.
function speakerLabel(spk) {
  if (/vox|claude/i.test(spk)) return { name: "Vox", vox: true };
  if (/participant|the meeting/i.test(spk)) return { name: "Them", vox: false };
  return { name: spk || "Them", vox: false };
}
function renderTranscript(raw) {
  const box = $("#sessTranscript");
  if (!raw || !String(raw).trim() || /not in a meeting/.test(raw)) {
    box.innerHTML = '<span class="muted">Listening…</span>';
    return;
  }
  // get_transcript returns a JSON array of {time, speaker, text}; older builds
  // returned "speaker: text" lines. Handle both.
  let entries = [];
  const s = String(raw).trim();
  if (s[0] === "[") {
    try {
      entries = JSON.parse(s).map((e) => ({ spk: e.speaker || "", text: (e.text || "").trim() }));
    } catch { /* fall through to line parse */ }
  }
  if (!entries.length) {
    entries = s.split("\n").filter((l) => l.trim()).map((l) => {
      const m = l.match(/^([^:]{1,40}):\s*(.*)$/);
      return m ? { spk: m[1], text: m[2].trim() } : { spk: "", text: l.trim() };
    });
  }
  // Drop consecutive duplicates (same speaker + text).
  const out = [];
  for (const e of entries) {
    if (!e.text) continue;
    const prev = out[out.length - 1];
    if (prev && prev.spk === e.spk && prev.text === e.text) continue;
    out.push(e);
  }
  if (!out.length) { box.innerHTML = '<span class="muted">Listening…</span>'; return; }
  box.innerHTML = out.map((e) => {
    const l = speakerLabel(e.spk);
    return `<div class="line"><span class="spk ${l.vox ? "vox" : ""}">${esc(l.name)}</span>${esc(e.text)}</div>`;
  }).join("");
  box.scrollTop = box.scrollHeight;
}
function esc(s) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

// Copy text with a webview-safe fallback (clipboard API may be gated).
async function copyText(text) {
  if (!text.trim()) return toast("Nothing to copy");
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("Copied"); } catch { toast("Couldn't copy"); }
    ta.remove();
  }
}
function transcriptText(sel) {
  return $$(sel + " .line").map((l) => l.textContent).join("\n");
}
$("#btnCopySess")?.addEventListener("click", () => copyText(transcriptText("#sessTranscript")));

async function pollSession() {
  try {
    const r = await fetch("/api/session/state");
    const s = await r.json();
    if (!s.active) {
      stopSessionPolling();
      // Session ended unexpectedly (vox exited): surface it with a rejoin path.
      const err = $("#sessError");
      const tail = (s.logs || []).slice(-3).join(" · ") || "the session ended";
      err.innerHTML = `Vox left the meeting. <span class="muted">${esc(tail)}</span> <button class="btn tiny" id="btnRejoin">Rejoin</button>`;
      err.classList.add("show");
      $("#btnRejoin")?.addEventListener("click", () => { show("home"); $("#joinUrl").value = sessLastUrl || ""; openJoin(); });
      return;
    }
    $("#sessError").classList.remove("show");
    STATUS_SESSION_ACTIVE = true;
    setWinTitle("In a meeting");
    sessLastUrl = s.url || sessLastUrl;
    sessStart = sessStart || s.startedAt || Date.now();
    $("#sessUrl").textContent = s.url || "—";
    $("#sessTimer").textContent = fmtTimer(Date.now() - sessStart);
    const ps = (s.participants || []).filter((p) => !/not in a meeting/.test(p));
    $("#sessParticipants").innerHTML = ps.length
      ? ps.map((p) => `<span class="chip"><span class="av">${esc((p[0] || "?").toUpperCase())}</span><span class="chip-name">${esc(p)}</span></span>`).join("")
      : '<span class="muted">Waiting…</span>';
    renderTranscript(s.transcript);
    // Infer orb state from transcript growth: bot's line = speaking, else listening.
    const tlen = (s.transcript || "").length;
    const orb = $("#sessOrb");
    if (tlen !== sessLastLen) {
      sessLastLen = tlen;
      let lastSpk = "";
      const t = (s.transcript || "").trim();
      if (t[0] === "[") { try { const a = JSON.parse(t); lastSpk = a[a.length - 1]?.speaker || ""; } catch { /* */ } }
      else lastSpk = (t.split("\n").pop() || "").split(":")[0] || "";
      const botSpeaking = /vox|claude/i.test(lastSpk);
      orb.classList.toggle("st-speaking", botSpeaking);
      orb.classList.toggle("st-listening", !botSpeaking);
      clearTimeout(sessOrbTimer);
      sessOrbTimer = setTimeout(() => { orb.classList.remove("st-speaking"); orb.classList.add("st-listening"); }, 2500);
    }
    $("#sessLog").textContent = (s.logs || []).join("\n");
  } catch { /* transient */ }
}
function startSessionPolling() { sessStart = null; pollSession(); clearInterval(sessPoll); sessPoll = setInterval(pollSession, 1500); }
function stopSessionPolling() { clearInterval(sessPoll); sessPoll = null; STATUS_SESSION_ACTIVE = false; setWinTitle(""); }

$("#btnLeave").addEventListener("click", async () => {
  $("#btnLeave").disabled = true;
  stopSessionPolling();
  await fetch("/api/session/leave", { method: "POST" }).catch(() => {});
  $("#btnLeave").disabled = false;
  show("home");
  toast("Left the meeting");
});
$("#btnSaveNotes").addEventListener("click", async () => {
  const lines = $$("#sessTranscript .line").map((l) => l.textContent).join("\n");
  const d = await (await fetch("/api/notes/save", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Meeting " + ($("#sessUrl").textContent || ""), body: lines }),
  }).catch(() => ({ json: () => ({}) }))).json();
  toast(d.ok ? "Saved to ~/.vox/notes" : (d.error || "Couldn't save"));
});
let muted = false;
$("#btnMute").addEventListener("click", async () => {
  muted = !muted;
  $("#btnMute").classList.toggle("active", muted);
  $("#btnMute").querySelector(".ctl-label").textContent = muted ? "Unmute" : "Mute";
  const d = await (await fetch("/api/session/mute", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ mute: muted }),
  }).catch(() => ({ json: () => ({}) }))).json();
  toast(muted ? "Muted" : "Unmuted");
});

// ---- Status -------------------------------------------------------------
function setStatus(kind, text) {
  const c = $("#statusChip");
  c.className = "status-chip" + (kind ? " " + kind : "");
  $("#statusText").textContent = text;
}

let STATUS = {};
async function refreshStatus() {
  try {
    const r = await fetch("/api/status");
    if (!r.ok) throw new Error();
    STATUS = await r.json();
    $("#offlineBanner").classList.remove("show");
    if (STATUS.readyMeet) setStatus("on", "Ready");
    else if (!STATUS.hasOpenAI) setStatus("", "Add OpenAI key");
    else if (!STATUS.hasChrome) setStatus("", "Install Chrome");
    else if (!STATUS.hasBinary) setStatus("", "Build needed");
    else setStatus("", "Setup needed");
    reflectReadiness();
    renderReadiness();
    reflectHome();
    renderCards();       // badges reflect live install/connect state
    loadHomeUpcoming();  // upcoming events on Home when connected
  } catch {
    setStatus("", "Not connected");
    $("#offlineBanner").classList.add("show");
  }
}

// System readiness list in Settings.
function renderReadiness() {
  const el = $("#readiness");
  if (!el) return;
  const rows = [
    ["OpenAI key", STATUS.hasOpenAI, STATUS.hasOpenAI ? "Set" : "Add it under API keys"],
    ["vox engine", STATUS.hasBinary, STATUS.hasBinary ? "Built" : '<button class="btn tiny" id="btnBuild">Build now</button>'],
    ["Google Chrome", STATUS.hasChrome, STATUS.hasChrome ? "Found" : "Not installed"],
  ];
  el.innerHTML = rows.map(([name, ok, note]) =>
    `<div class="ready-row ${ok ? "ok" : "no"}"><span class="ready-dot"></span><span class="ready-name">${name}</span><span class="ready-note">${note}</span></div>`
  ).join("");
  const bb = $("#btnBuild");
  if (bb) bb.addEventListener("click", async (e) => {
    e.stopPropagation();
    bb.disabled = true; bb.textContent = "Building…";
    try {
      const d = await (await fetch("/api/vox/build", { method: "POST" })).json();
      toast(d.ok ? "Engine built ✓" : "Build failed: " + (d.output || "").slice(0, 80));
      refreshStatus();
    } catch { toast("Build failed"); bb.disabled = false; bb.textContent = "Build now"; }
  });
}

// Home hint based on readiness.
function reflectHome() {
  const hint = $("#homeHint");
  if (!hint) return;
  hint.innerHTML = STATUS.hasOpenAI ? "" : '<a href="#settings">Add your OpenAI key in Settings →</a>';
  $("#btnJoin")?.classList.toggle("needs", !STATUS.hasOpenAI);
}
function reflectReadiness() {}

// ---- Google Calendar ----------------------------------------------------
// Vox ships a built-in Google OAuth client, so the only step is Connect Google.
function calError(msg) {
  const el = $("#calError");
  if (msg) { el.textContent = msg; el.classList.add("show"); }
  else el.classList.remove("show");
}

async function openCalendar() {
  show("calendar");
  await refreshCalendar();
}

async function refreshCalendar() {
  calError("");
  let st = { connected: false };
  try { st = await (await fetch("/api/calendar/status")).json(); } catch { /* offline */ }
  $("#calConnect").hidden = st.connected;
  $("#calEvents").hidden = !st.connected;
  if (st.connected) loadCalEvents();
}

function calEvRow(e) {
  return `<div class="cal-ev">
    <div class="cal-ev-main">
      <div class="cal-ev-title">${esc(e.title)}</div>
      <div class="cal-ev-when">${esc(e.startLabel)}</div>
    </div>
    ${e.meetUrl ? `<button class="btn tiny" data-meet="${esc(e.meetUrl)}">Join</button>` : ""}
  </div>`;
}
function wireMeetJoins(container) {
  container.querySelectorAll("[data-meet]").forEach((b) =>
    b.addEventListener("click", () => joinFromCalendar(b.dataset.meet)));
}

async function loadCalEvents() {
  const list = $("#calList");
  list.innerHTML = '<span class="muted">Loading…</span>';
  try {
    const d = await (await fetch("/api/calendar/events")).json();
    if (!d.ok) { list.innerHTML = `<span class="muted">${esc(d.error || "couldn't load events")}</span>`; return; }
    if (!d.events.length) { list.innerHTML = '<span class="muted">No upcoming events.</span>'; return; }
    list.innerHTML = d.events.map(calEvRow).join("");
    wireMeetJoins(list);
  } catch { list.innerHTML = '<span class="muted">Backend offline.</span>'; }
}

// Home shows a compact upcoming list once the calendar is connected.
async function loadHomeUpcoming() {
  const wrap = $("#homeUpcoming");
  if (!wrap) return;
  if (!STATUS.calendarConnected) { wrap.hidden = true; return; }
  try {
    const d = await (await fetch("/api/calendar/events")).json();
    if (!d.ok || !d.events.length) { wrap.hidden = true; return; }
    const list = $("#homeUpList");
    list.innerHTML = d.events.slice(0, 4).map(calEvRow).join("");
    wireMeetJoins(list);
    wrap.hidden = false;
  } catch { wrap.hidden = true; }
}

function joinFromCalendar(url) {
  show("home");
  $("#joinUrl") && ($("#joinUrl").value = url);
  $("#btnJoin").click();
  setTimeout(() => { if ($("#joinUrl")) { $("#joinUrl").value = url; $("#joinGo")?.click(); } }, 60);
}

$("#btnConnectCal")?.addEventListener("click", openCalendar);
$("#btnHomeCal")?.addEventListener("click", openCalendar);
$("#btnConnectGoogle")?.addEventListener("click", connectGoogleFlow);
$("#btnCalRefresh")?.addEventListener("click", loadCalEvents);
$("#btnCalDisconnect")?.addEventListener("click", async () => {
  await fetch("/api/calendar/disconnect", { method: "POST" }).catch(() => {});
  toast("Disconnected");
  refreshCalendar();
});
globalThis.voxOpenCalendar = openCalendar;

// ---- Onboarding ---------------------------------------------------------
const OB_STEPS = 4;
let obStep = 0;
function obRender() {
  $$("#onboard .ob-step").forEach((s) => s.classList.toggle("active", +s.dataset.step === obStep));
  $("#obDots").innerHTML = Array.from({ length: OB_STEPS }, (_, i) => `<i class="${i === obStep ? "on" : ""}"></i>`).join("");
}
function obGo(n) { obStep = Math.max(0, Math.min(OB_STEPS - 1, n)); obRender(); }
function openOnboard() { $("#onboard").classList.add("show"); obGo(0); }
function closeOnboard() { $("#onboard").classList.remove("show"); localStorage.setItem("vox_onboarded", "1"); }

$("#onboard").addEventListener("click", async (e) => {
  if (e.target.matches("[data-next]")) {
    // Persist step 1 inputs before advancing.
    if (obStep === 1) {
      await fetch("/api/settings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: $("#ob_owner").value.trim(), openai: $("#ob_openai").value.trim() }),
      }).catch(() => {});
      refreshStatus();
    }
    obGo(obStep + 1);
  } else if (e.target.matches("[data-back]")) obGo(obStep - 1);
});
$("#obInstall").addEventListener("click", async () => {
  $("#obInstall").disabled = true;
  $("#obInstall").textContent = "Installing…";
  try {
    const d = await (await fetch("/api/mcp/install", { method: "POST" })).json();
    $("#obInstallState").innerHTML = d.ok
      ? `<div class="ob-check" style="width:56px;height:56px;font-size:24px;margin:0 auto 8px">✓</div><p style="margin:0">Installed into ${(d.targets || []).join(" + ") || "Claude"}</p>`
      : `<p class="muted">${d.error || "Install failed"}</p>`;
    if (d.ok) setTimeout(() => obGo(3), 900);
  } catch { $("#obInstall").textContent = "Install into Claude"; $("#obInstall").disabled = false; }
});
$("#obDone").addEventListener("click", () => { closeOnboard(); loadSettings(); show("home"); });

$("#offlineRetry")?.addEventListener("click", refreshStatus);

// ---- Boot ---------------------------------------------------------------
async function resumeSession() {
  try {
    const s = await (await fetch("/api/session/state")).json();
    if (s.active) { show("session"); startSessionPolling(); return true; }
  } catch { /* ignore */ }
  return false;
}

// Help overlay.
function openHelp() { $("#helpModal").classList.add("show"); setTimeout(() => $("#helpClose")?.focus(), 30); }
function closeHelp() { $("#helpModal").classList.remove("show"); }
globalThis.voxOpenHelp = openHelp; // native menu → Help
$("#helpClose").addEventListener("click", closeHelp);
$("#helpModal").addEventListener("click", (e) => { if (e.target.id === "helpModal") closeHelp(); });

// Keyboard: Esc closes dialogs; Cmd/Ctrl+, → Settings; ? → help.
addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (e.key === "Escape") { closeJoin(); closeHelp(); closeInt(); }
  if ((e.metaKey || e.ctrlKey) && e.key === ",") { e.preventDefault(); show("settings"); }
  if (e.key === "?" && !typing) { e.preventDefault(); openHelp(); }
});

if (location.search.includes("noob")) localStorage.setItem("vox_onboarded", "1");

renderCards();
loadSettings();
refreshStatus();
setInterval(refreshStatus, 4000);

(async () => {
  if (await resumeSession()) return;
  const h = location.hash.slice(1);
  if (h === "join") { show("home"); openJoin(); }
  else if (h === "help") { show("home"); openHelp(); }
  else show(h || localStorage.getItem("vox_view") || "home");
  // First run: no key saved and never onboarded → guided setup.
  if (h !== "onboard" && !localStorage.getItem("vox_onboarded") && !STATUS.hasOpenAI) {
    // give status a beat to load, then decide
    setTimeout(() => { if (!STATUS.hasOpenAI && !localStorage.getItem("vox_onboarded")) openOnboard(); }, 400);
  }
  if (h === "onboard") openOnboard(); // deep-link for testing
  const obStepParam = new URLSearchParams(location.search).get("obstep");
  if (obStepParam != null) { openOnboard(); obGo(+obStepParam); } // QA: jump to a step
})();
