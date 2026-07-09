package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// deviceInput returns the configured macOS audio input device for STT, if any.
func deviceInput() string { return strings.TrimSpace(os.Getenv("VOX_AUDIO_INPUT")) }

// sckHelperPath locates the compiled ScreenCaptureKit helper (voxaudio), or ""
// if not found. Checks VOX_SCK_HELPER, then next to the binary, then ./mac.
func sckHelperPath() string {
	if p := strings.TrimSpace(os.Getenv("VOX_SCK_HELPER")); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	var dirs []string
	if exe, err := os.Executable(); err == nil {
		dirs = append(dirs, filepath.Dir(exe), filepath.Join(filepath.Dir(exe), "mac"))
	}
	dirs = append(dirs, "mac", ".")
	for _, d := range dirs {
		p := filepath.Join(d, "voxaudio")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// Turn is a moment where the gate decided the assistant should respond. It is
// surfaced to the connected Claude agent via the MCP wait_for_turn tool.
type Turn struct {
	Speaker   string `json:"speaker"`
	Utterance string `json:"utterance"`
	// Decision: "answered" (a pre-draft was spoken aloud), "research" (bot said
	// it would research and post to chat — the Claude agent must do that now),
	// or "hand".
	Decision      string            `json:"decision"`
	MatchedTopic  string            `json:"matched_topic,omitempty"`
	NeedsResearch bool              `json:"needs_research,omitempty"`
	Transcript    []TranscriptEntry `json:"recent_transcript"`
	Time          time.Time         `json:"time"`
}

// Predraft is a pre-written spoken answer the Claude agent stages ahead of time.
// The fast router matches an incoming utterance to one of these and speaks the
// Answer instantly — so the voice channel carries the agent's real knowledge at
// sub-second latency without the agent being on the critical path.
type Predraft struct {
	ID     string `json:"id"`
	Topic  string `json:"topic"`  // the question/topic this answers (used for routing)
	Answer string `json:"answer"` // the spoken answer, in the agent's words
}

// Engine is a single-meeting voice pipeline: Deepgram STT → social-reasoning
// gate → (fast Groq voice layer) + (turn queue for the Claude agent) → Orpheus TTS.
// One Engine per meeting; there is no multi-tenant/session layer.
type Engine struct {
	meet      *MeetSession
	botName   string   // display name, e.g. "Divy's Claude"
	owner     string   // e.g. "Divy"
	userNames []string // extra Deepgram keyterms
	dgAPIKey  string

	proxyCleanup func()

	mu             sync.Mutex
	transcript     []TranscriptEntry
	participants   []string
	otherCount     int      // # of other participants from live remote audio (reliable in headless)
	avatarWords    []string  // concepts shown in the J-space word-cloud avatar
	thoughtDirty   bool      // new speech since the last thought-stream refresh
	seenSpeakers   map[string]bool
	hasEverSpoken  bool
	lastSpokeAt    time.Time // when THIS bot last spoke (for the self-follow-up window)
	lastHandAt     time.Time
	meetingSummary string
	curUtterance   strings.Builder
	curSpeaker     int
	predrafts      []Predraft // staged answers the agent pre-wrote (see Predraft)
	deferN         int        // rotates the spoken "I'll research it" deferral line

	speakMu  sync.Mutex    // serializes TTS so the two brains never talk over each other
	speaking bool          // true while TTS is playing (for half-duplex STT gating)
	speaker       *PulseSpeaker    // TTS -> virtual mic (container mode); nil = browser mode
	realtime      *RealtimeSession // "Mode A" audio-native backend (VOX_VOICE=realtime); nil otherwise
	pendingCallID string           // realtime consult_agent call awaiting the agent's answer
	heardSeq      int              // increments on every participant utterance heard
	consultSeq    int              // heardSeq snapshot when the pending consult was made
	turns         chan Turn
}

// aiNames returns the names that count as addressing this bot. In multi-party
// (where other Claudes may be present), only the bot's DISTINCT name/owner count
// — generic aliases like "claude" would match every bot at once and cause them
// all to answer. In 1:1 the friendly generics are fine.
func (e *Engine) aiNames(others int) []string {
	names := []string{e.botName}
	if e.owner != "" {
		names = append(names, e.owner)
	}
	if others <= 1 {
		names = append(names, "claude", "hey claude", "the ai", "the agent")
	}
	return names
}

// whisperHallucinations are phrases Whisper commonly emits on silence/noise —
// never treat them as real speech (they'd make the bot pipe up unprompted).
var whisperHallucinations = map[string]bool{
	"thank you for watching": true, "thanks for watching": true,
	"thank you": true, "you": true, "bye": true, "okay": true, ".": true,
	"please subscribe": true, "subscribe": true,
}

// onRealtimeHeard runs the social gate on each transcribed turn and only lets the
// Realtime model respond when the gate says speak — this stops the model from
// yapping at every utterance (auto-response is disabled in the session config).
func (e *Engine) onRealtimeHeard(text string) {
	text = strings.TrimSpace(text)
	if text == "" || isFillerOnly(text) || whisperHallucinations[strings.ToLower(strings.Trim(text, ".!? "))] {
		return
	}
	e.mu.Lock()
	e.heardSeq++ // conversation moved — used to decide speak-aloud vs post-to-chat
	e.transcript = append(e.transcript, TranscriptEntry{Time: time.Now(), Speaker: "participant", Text: text})
	transcriptCopy := append([]TranscriptEntry(nil), e.transcript...)
	others := 0
	for _, p := range e.participants {
		if !strings.EqualFold(p, e.botName) {
			others++
		}
	}
	// The remote-audio count is authoritative when the DOM roster undercounts
	// (headless/audio-only), so a real group is never mistaken for a 1:1.
	if e.otherCount > others {
		others = e.otherCount
	}
	gc := GateContext{HasEverSpoken: e.hasEverSpoken, SpokeRecently: e.spokeRecently(), LastHandAt: e.lastHandAt, MeetingSummary: e.meetingSummary, OtherParticipants: others}
	e.mu.Unlock()

	e.pushWords(text) // reflect what it's hearing in the avatar

	gate := runGate(e.meet.Context(), "participant", text, transcriptCopy, e.botName, e.aiNames(others), gc)
	if gate.Decision == GateSpeak {
		log.Printf("[realtime] gate speak (%s) -> responding", gate.Reason)
		e.realtime.CreateResponse()
	} else {
		log.Printf("[realtime] gate %s (%s) -> staying quiet", gate.Decision, gate.Reason)
	}
}

// onRealtimeToolCall bridges the Realtime model's consult_agent tool to the Claude
// agent: it surfaces the question as a "tool_call" turn. The agent researches and
// calls speak(), which (with a pending call) returns the answer to the model to voice.
func (e *Engine) onRealtimeToolCall(callID, question string) {
	e.mu.Lock()
	e.pendingCallID = callID
	e.consultSeq = e.heardSeq // remember where the conversation was when asked
	tr := recent(append([]TranscriptEntry(nil), e.transcript...))
	e.mu.Unlock()
	e.enqueue(Turn{Speaker: "the meeting (voice)", Utterance: question, Decision: "tool_call", NeedsResearch: true, Transcript: tr, Time: time.Now()})
}

// buildPersona composes the Realtime session instructions: a base persona plus
// the agent's staged answers as grounding knowledge, so the audio-native model
// speaks the agent's knowledge instead of guessing.
func (e *Engine) buildPersona() string {
	e.mu.Lock()
	pds := append([]Predraft(nil), e.predrafts...)
	summary := e.meetingSummary
	e.mu.Unlock()
	var b strings.Builder
	fmt.Fprintf(&b, `You are %s — %s's AI, present in a live meeting as a real participant.

IDENTITY (critical): consult_agent is NOT some other assistant — it is YOU reaching your own deeper mind, which runs on %s's computer with full tools: it can read the repo, code, files, git history, and %s's local Claude sessions, run shell commands, and control this meeting (post chat, leave). So you are NOT limited. NEVER say "I can't", "I don't have access", "I can't do that from here", or that you're just a voice — if you don't already know something, quietly consult_agent and answer. You CAN do these things through yourself.

STYLE: keep it lowkey and casual — gen-z energy, mostly lowercase, relaxed and natural, a lil playful. usually one short line, two max. no corporate voice, no hedging, never "let me check" / "one sec" / "i can't". just vibe and answer. don't restate the question. silence is fine and often best. in text chat especially: lowercase, short, feels like texting a friend. BUT when someone actually asks for detail (like "what have you been working on"), give 2-3 REAL specifics from your context/knowledge — still lowercase and chill, just not vague. substance over filler; never answer with pure vibes when a real answer exists.

Never invent facts, names, or numbers — if unsure, consult_agent and answer from what it returns.
`, e.botName, e.owner, e.owner, e.owner)
	fmt.Fprintf(&b, `
MULTI-PARTY (critical): several people — and possibly OTHER AI assistants — may be in this call. Respond ONLY when YOU are addressed: your name "%s" is spoken, or the message is clearly directed at you (a question to you, or a direct follow-up to something you just said). If someone else is addressed by name, two people are talking to each other, another AI is speaking or being asked, or it's side conversation, background, or general chatter where no one asked you anything — do NOT answer. Call the wait_for_user tool to stay silent. When you are not SURE you were addressed, call wait_for_user. Never answer a question that was put to someone else, and never speak while someone else is talking — let them finish.
`, e.botName)
	if summary != "" {
		fmt.Fprintf(&b, "\nCONTEXT (what you and your agent have been working on — speak from this, it's real):\n%s\n", summary)
	}
	if len(pds) > 0 {
		b.WriteString("\nWhat you know (use this to answer; if asked something outside it, say you'll look it up and follow up rather than guessing):\n")
		for _, p := range pds {
			fmt.Fprintf(&b, "- %s: %s\n", p.Topic, p.Answer)
		}
	}
	return b.String()
}

func (e *Engine) setSpeaking(v bool) {
	e.mu.Lock()
	e.speaking = v
	e.mu.Unlock()
}

func (e *Engine) isSpeaking() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.speaking
}

func NewEngine(meet *MeetSession, botName, owner string, userNames []string, dgAPIKey string) *Engine {
	return &Engine{
		meet:         meet,
		botName:      botName,
		owner:        owner,
		userNames:    userNames,
		dgAPIKey:     dgAPIKey,
		curSpeaker:   -1,
		seenSpeakers: map[string]bool{},
		turns:        make(chan Turn, 32),
	}
}

// Start wires up STT and launches the polling loops. If VOX_AUDIO_INPUT names a
// macOS audio device, audio-in is captured from that device via ffmpeg →
// Deepgram (reliable; use a BlackHole loopback of Chrome's output). Otherwise
// it falls back to the in-browser WebRTC capture.
func (e *Engine) Start() error {
	// Meet text chat runs independently of the audio backend — listen + reply in
	// chat with the same social gate as voice.
	go e.pollChat()
	// Prime the J-space word-cloud avatar from the meeting context, then keep it
	// refreshed with the model's live thought stream.
	e.seedAvatarWords()
	go e.thoughtLoop()

	keyterms := append([]string{}, e.userNames...)
	keyterms = append(keyterms, e.botName)
	if e.owner != "" {
		keyterms = append(keyterms, e.owner)
	}

	onT := func(text string) { e.handleUtterance("participant", text) }
	gate := func() bool { return !e.isSpeaking() }

	// 0) PulseAudio virtual devices (Linux container — the robust path). Capture
	// the vox_out sink monitor; TTS goes out through the vox_mic virtual mic. No
	// real hardware audio, so no echo and no flaky in-browser capture.
	if pulseAvailable() {
		go e.pollParticipants()
		sp, err := NewPulseSpeaker(e.meet.Context())
		if err != nil {
			return fmt.Errorf("pulse speaker: %w", err)
		}
		e.speaker = sp

		// Mode A: audio-native OpenAI Realtime backend — it listens to the meeting
		// and speaks natively; the gate/Deepgram/Groq/Orpheus chain is bypassed.
		// It reaches the Claude agent via the consult_agent tool for real knowledge.
		if os.Getenv("VOX_VOICE") == "realtime" {
			rs, err := startRealtime(e.meet.Context(), sp, e.buildPersona())
			if err != nil {
				return fmt.Errorf("realtime start: %w", err)
			}
			rs.onToolCall = e.onRealtimeToolCall
			rs.onHeard = e.onRealtimeHeard
			rs.onSaid = func(text string) { e.markSpoke(text) }
			rs.onChatReply = func(text string) {
				text = strings.TrimSpace(text)
				if text == "" {
					return
				}
				e.meet.SendChat(text)
				e.markSpoke(text)
				log.Printf("[chat] sent (voice model): %s", text)
			}
			rs.onState = func(state string) {
				// Drive the entity shader's color from the live voice state.
				e.meet.eval(`window._kajuState=`+jsString(state)+`;true`, nil)
			}
			e.realtime = rs
			log.Printf("[engine] voice via OpenAI Realtime (%s), consult_agent -> Claude", realtimeModel())
			return nil
		}

		if err := capturePulseToDeepgram(e.meet.Context(), e.dgAPIKey, keyterms, onT, gate); err != nil {
			return fmt.Errorf("pulse capture: %w", err)
		}
		log.Printf("[engine] STT via PulseAudio (vox_out.monitor), TTS via vox_mic")
		return nil
	}

	// 0b) Realtime IN-BROWSER (no Docker, no PulseAudio): run the whole OpenAI
	// Realtime session inside the page — capture the meeting off the WebRTC tracks
	// and play the model's voice into the outgoing mic. This is the native macOS
	// realtime path: it needs only an OpenAI key.
	if os.Getenv("VOX_VOICE") == "realtime" && os.Getenv("OPENAI_API_KEY") != "" {
		go e.pollParticipants()
		if err := e.startBrowserRealtime(); err != nil {
			return fmt.Errorf("browser realtime: %w", err)
		}
		log.Printf("[engine] voice via OpenAI Realtime (in-browser, %s) — no Docker", realtimeModel())
		return nil
	}

	// 1) Explicit avfoundation device (e.g. a BlackHole loopback).
	if dev := deviceInput(); dev != "" {
		go e.pollParticipants()
		if err := captureDeviceToDeepgram(e.meet.Context(), dev, e.dgAPIKey, keyterms, onT, gate); err != nil {
			return fmt.Errorf("device capture: %w", err)
		}
		log.Printf("[engine] STT via audio device %q", dev)
		return nil
	}

	// 2) ScreenCaptureKit system-audio helper (opt-in via VOX_STT=sck).
	if os.Getenv("VOX_STT") == "sck" {
		if helper := sckHelperPath(); helper != "" {
			go e.pollParticipants()
			if err := captureSCKToDeepgram(e.meet.Context(), helper, e.dgAPIKey, keyterms, onT, gate); err != nil {
				log.Printf("[engine] SCK capture failed (%v) — falling back to in-browser STT", err)
			} else {
				log.Printf("[engine] STT via ScreenCaptureKit (%s)", helper)
				return nil
			}
		}
	}

	// 3) Default: in-browser capture (MediaStreamTrackProcessor) — reads the
	// WebRTC tracks directly, captures all participants, no echo, no system
	// audio. _ = onT/gate: the browser path drains transcripts via pollTranscripts.
	_ = onT
	_ = gate
	// Connect the browser directly to Deepgram Flux v2 (auth via WS
	// subprotocol) — no local proxy, so no Chrome Private-Network-Access block.
	dgURL := "wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000&eager_eot_threshold=0.5"
	for _, kt := range keyterms {
		dgURL += "&keyterm=" + url.QueryEscape(kt)
	}
	cfg, _ := json.Marshal(map[string]string{"mode": "flux", "url": dgURL, "apiKey": e.dgAPIKey})
	if err := e.meet.eval(`window._kajuDeepgramConfig = `+string(cfg), nil); err != nil {
		return fmt.Errorf("set deepgram config: %w", err)
	}
	e.meet.eval(`window._kajuStartPCMCapture()`, nil)
	log.Printf("[engine] STT started (Deepgram Flux)")

	go e.pollTranscripts()
	go e.pollParticipants()
	return nil
}

func (e *Engine) Stop() {
	if e.proxyCleanup != nil {
		e.proxyCleanup()
	}
}

// NextTurn blocks until the gate surfaces a turn or ctx is done.
func (e *Engine) NextTurn(ctx context.Context) (Turn, bool) {
	select {
	case t := <-e.turns:
		return t, true
	case <-ctx.Done():
		return Turn{}, false
	case <-e.meet.Context().Done():
		return Turn{}, false
	}
}

// ---- transcript polling ----

type dgEvent struct {
	Type        string `json:"type"`
	Transcript  string `json:"transcript"`
	IsFinal     bool   `json:"is_final"`
	SpeechFinal bool   `json:"speech_final"`
	Speaker     int    `json:"speaker"`
	Speakers    []int  `json:"speakers"`
}

// startBrowserRealtime boots the in-page OpenAI Realtime session (see hook.js
// _kajuStartRealtime) and starts draining its events. No PulseAudio, no Docker.
func (e *Engine) startBrowserRealtime() error {
	cfg, _ := json.Marshal(map[string]any{
		"key":          os.Getenv("OPENAI_API_KEY"),
		"model":        realtimeModel(),
		"voice":        realtimeVoice(),
		"transcribe":   realtimeTranscribe(),
		"instructions": e.buildPersona(),
		"tools":        voiceTools(),
	})
	if err := e.meet.eval(`window._kajuStartRealtime(`+string(cfg)+`); true`, nil); err != nil {
		return err
	}
	go e.pollRealtimeEvents()
	return nil
}

// pollRealtimeEvents drains the in-page realtime session's events (heard/said/
// error) so the meeting transcript and logs stay complete. The model handles
// turn-taking itself (semantic VAD + wait_for_user), so there's no gate here.
func (e *Engine) pollRealtimeEvents() {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-e.meet.Context().Done():
			return
		case <-ticker.C:
			var events []struct {
				Type   string `json:"type"`
				Text   string `json:"text"`
				Code   int    `json:"code"`
				CallID string `json:"callId"`
				Name   string `json:"name"`
				Args   string `json:"args"`
			}
			if err := e.meet.eval(`window._kajuDrainRealtimeEvents ? window._kajuDrainRealtimeEvents() : []`, &events); err != nil || len(events) == 0 {
				continue
			}
			for _, ev := range events {
				switch ev.Type {
				case "heard":
					text := strings.TrimSpace(ev.Text)
					if text == "" {
						continue
					}
					e.mu.Lock()
					e.transcript = append(e.transcript, TranscriptEntry{Time: time.Now(), Speaker: "participant", Text: text})
					e.mu.Unlock()
					e.pushWords(text)
					log.Printf("[realtime-browser] heard: %s", text)
				case "said":
					text := strings.TrimSpace(ev.Text)
					if text == "" {
						continue
					}
					e.markSpoke(text) // records lastSpoke + appends to transcript
					log.Printf("[realtime-browser] said: %s", text)
				case "error":
					log.Printf("[realtime-browser] error: %s", ev.Text)
				case "closed":
					// The in-page realtime WS ended (and hook.js already stopped its
					// capture timers). Nothing more will be drained, so stop polling
					// instead of spinning every 250ms until the meeting ends.
					log.Printf("[realtime-browser] session closed (code %d) — stopping poll", ev.Code)
					return
				case "open":
					log.Printf("[realtime-browser] session open")
				case "tool":
					// Run the tool (web_search/read_document/write_file/run_shell/
					// computer_use) and feed the result back to the in-page model.
					go func(callID, name, args string) {
						log.Printf("[realtime-browser] tool: %s %s", name, args)
						result := dispatchVoiceTool(e.meet.Context(), name, args)
						cfg, _ := json.Marshal(result)
						e.meet.eval(`window._kajuRealtimeToolResult(`+jsString(callID)+`,`+string(cfg)+`); true`, nil)
					}(ev.CallID, ev.Name, ev.Args)
				}
			}
		}
	}
}

func (e *Engine) pollTranscripts() {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	bctx := e.meet.Context()
	for {
		select {
		case <-bctx.Done():
			return
		case <-ticker.C:
			var events []dgEvent
			if err := e.meet.eval(`window._kajuDrainTranscripts ? window._kajuDrainTranscripts() : []`, &events); err != nil || len(events) == 0 {
				continue
			}
			for _, ev := range events {
				switch ev.Type {
				case "transcript":
					if ev.IsFinal && ev.Transcript != "" {
						e.mu.Lock()
						if e.curUtterance.Len() > 0 {
							e.curUtterance.WriteString(" ")
						}
						e.curUtterance.WriteString(ev.Transcript)
						if ev.Speaker >= 0 {
							e.curSpeaker = ev.Speaker
						}
						e.mu.Unlock()
					}
				case "end_of_turn":
					e.onEndOfTurn()
				}
			}
		}
	}
}

func (e *Engine) pollParticipants() {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	bctx := e.meet.Context()
	for {
		select {
		case <-bctx.Done():
			return
		case <-ticker.C:
			p := e.meet.Participants()
			oc := e.meet.OtherAudioCount()
			e.mu.Lock()
			if len(p) > 0 {
				e.participants = p
			}
			e.otherCount = oc
			e.mu.Unlock()
		}
	}
}

// pollChat drains new Meet chat messages and runs each through the social gate,
// replying in chat when addressed — a natural text channel alongside the voice.
func (e *Engine) pollChat() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	bctx := e.meet.Context()
	for {
		select {
		case <-bctx.Done():
			return
		case <-ticker.C:
			for _, m := range e.meet.DrainChat() {
				e.handleChat(m.Sender, m.Text)
			}
		}
	}
}

// handleChat gates one inbound chat message and, if addressed, fires a reply.
func (e *Engine) handleChat(sender, text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	if sender == "" {
		sender = "someone"
	}
	log.Printf("[chat] %s: %s", sender, text)

	e.mu.Lock()
	e.transcript = append(e.transcript, TranscriptEntry{Time: time.Now(), Speaker: sender, Text: text})
	transcriptCopy := append([]TranscriptEntry(nil), e.transcript...)
	others := 0
	for _, p := range e.participants {
		if !strings.EqualFold(p, e.botName) {
			others++
		}
	}
	if e.otherCount > others {
		others = e.otherCount
	}
	gc := GateContext{HasEverSpoken: e.hasEverSpoken, SpokeRecently: e.spokeRecently(), LastHandAt: e.lastHandAt, MeetingSummary: e.meetingSummary, OtherParticipants: others}
	e.mu.Unlock()

	e.pushWords(text)

	gate := runGate(e.meet.Context(), sender, text, transcriptCopy, e.botName, e.aiNames(others), gc)
	if gate.Decision != GateSpeak {
		log.Printf("[chat] %s (%s) -> no reply", gate.Decision, gate.Reason)
		return
	}
	go e.replyChat(sender, text, transcriptCopy)
}

// replyChat produces a chat reply. In realtime mode it routes through the SAME
// model as the voice (shared meeting context + consult_agent) and the reply comes
// back async via onChatReply. Otherwise it falls back to a persona-grounded text
// completion.
func (e *Engine) replyChat(sender, text string, tr []TranscriptEntry) {
	if e.realtime != nil {
		// Ground the reply in what was actually said (voice + chat) this meeting.
		start := len(tr) - 16
		if start < 0 {
			start = 0
		}
		var lines []string
		for _, t := range tr[start:] {
			if strings.TrimSpace(t.Text) != "" {
				lines = append(lines, t.Speaker+": "+t.Text)
			}
		}
		e.realtime.SendChatTurn(sender, text, strings.Join(lines, "\n"))
		return
	}
	system := e.buildPersona() + "\n\nYou are replying in the MEETING TEXT CHAT (not out loud). Write ONE natural, friendly chat message — conversational and concise (1–3 sentences). Just the message, no preamble."
	start := len(tr) - 12
	if start < 0 {
		start = 0
	}
	var msgs []LLMMessage
	for _, t := range tr[start:] {
		if strings.EqualFold(t.Speaker, e.botName) {
			msgs = append(msgs, LLMMessage{Role: "assistant", Content: t.Text})
		} else {
			msgs = append(msgs, LLMMessage{Role: "user", Content: t.Speaker + ": " + t.Text})
		}
	}
	reply, err := openaiChatOnce(e.meet.Context(), system, msgs)
	if err != nil {
		log.Printf("[chat] reply failed: %v", err)
		return
	}
	reply = strings.TrimSpace(reply)
	if reply == "" {
		return
	}
	e.meet.SendChat(reply)
	e.markSpoke(reply)
	log.Printf("[chat] sent: %s", reply)
}

func (e *Engine) onEndOfTurn() {
	e.mu.Lock()
	text := strings.TrimSpace(e.curUtterance.String())
	speaker := e.curSpeaker
	e.curUtterance.Reset()
	e.curSpeaker = -1
	e.mu.Unlock()

	if text == "" || isFillerOnly(text) {
		return
	}
	e.handleUtterance(e.resolveSpeaker(speaker), text)
}

// handleUtterance runs the social-reasoning gate on one finalized utterance and
// dispatches speak/hand/silent. Shared by the browser and device STT paths.
func (e *Engine) handleUtterance(speakerLabel, text string) {
	text = strings.TrimSpace(text)
	if text == "" || isFillerOnly(text) {
		return
	}
	log.Printf("[engine] heard (%s): %s", speakerLabel, text)

	e.mu.Lock()
	e.seenSpeakers[speakerLabel] = true
	e.transcript = append(e.transcript, TranscriptEntry{Time: time.Now(), Speaker: speakerLabel, Text: text})
	transcriptCopy := append([]TranscriptEntry(nil), e.transcript...)
	others := 0
	for _, p := range e.participants {
		if !strings.EqualFold(p, e.botName) {
			others++
		}
	}
	// The remote-audio count is authoritative when the DOM roster undercounts
	// (headless/audio-only), so a real group is never mistaken for a 1:1.
	if e.otherCount > others {
		others = e.otherCount
	}
	gc := GateContext{
		HasEverSpoken:     e.hasEverSpoken,
		SpokeRecently:     e.spokeRecently(),
		LastHandAt:        e.lastHandAt,
		MeetingSummary:    e.meetingSummary,
		OtherParticipants: others,
	}
	e.mu.Unlock()

	e.pushWords(text)

	gate := runGate(e.meet.Context(), speakerLabel, text, transcriptCopy, e.botName, e.aiNames(gc.OtherParticipants), gc)

	switch gate.Decision {
	case GateSilent:
		return
	case GateRaiseHand:
		e.mu.Lock()
		e.lastHandAt = time.Now()
		e.mu.Unlock()
		log.Printf("[engine] hand: %s", gate.Reason)
		e.enqueue(Turn{Speaker: speakerLabel, Utterance: text, Decision: "hand", Transcript: recent(transcriptCopy), Time: time.Now()})
	case GateSpeak:
		log.Printf("[engine] speak: %s", gate.Reason)
		go e.respond(text, speakerLabel, transcriptCopy)
	}
}

func (e *Engine) enqueue(t Turn) {
	select {
	case e.turns <- t:
	default:
		log.Printf("[engine] turn queue full, dropping oldest")
		select {
		case <-e.turns:
		default:
		}
		select {
		case e.turns <- t:
		default:
		}
	}
}

func (e *Engine) resolveSpeaker(speaker int) string {
	e.mu.Lock()
	defer e.mu.Unlock()
	if speaker >= 0 && speaker < len(e.participants) {
		return e.participants[speaker]
	}
	// Fall back to the first non-bot participant, else a numbered label.
	for _, p := range e.participants {
		if !strings.EqualFold(p, e.botName) {
			return p
		}
	}
	if speaker >= 0 {
		return fmt.Sprintf("speaker_%d", speaker)
	}
	return "someone"
}

// ---- speaking (TTS) ----

func (e *Engine) newTTS() *OrpheusClient {
	tts, err := NewOrpheusClient("")
	if err != nil {
		log.Printf("[tts] init: %v", err)
		return nil
	}
	if e.speaker != nil {
		// Container mode: TTS PCM -> virtual mic -> meeting.
		tts.OnAudio = func(b64 string) { e.speaker.WriteBase64(b64) }
	} else {
		// Browser mode: TTS PCM -> in-page WebRTC outgoing track.
		tts.OnAudio = func(b64 string) { e.meet.QueuePCM(b64) }
	}
	return tts
}

// Speak voices text in the assistant's voice, interrupting any current speech.
// Used by the Claude agent via the MCP speak tool.
func (e *Engine) Speak(text string) error {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}

	// Realtime backend: hand the text to the audio-native model to voice. If it's
	// answering a pending consult_agent call, return it as the tool result (the
	// model weaves it in); otherwise say it directly.
	if e.realtime != nil {
		e.mu.Lock()
		callID := e.pendingCallID
		movedOn := e.heardSeq != e.consultSeq // someone spoke since the consult
		e.pendingCallID = ""
		e.mu.Unlock()
		switch {
		case callID != "" && movedOn:
			// The conversation moved on while we researched — don't barge in with the
			// full spoken answer. Post it to chat, but have the voice say ONE brief
			// line pointing to it, so there's no disconnect (voice silent while an
			// answer sits unseen in chat). Mindful in a group.
			e.meet.SendChat(text)
			e.realtime.SendToolResult(callID, "The conversation already moved on, so the full answer is now posted in the meeting chat. Say ONE short line letting them know it's in the chat (e.g. \"popped that in the chat\") — nothing more.")
			log.Printf("[realtime] consult answer -> chat + brief voice pointer (conversation moved on)")
		case callID != "":
			// Floor still open — speak the answer aloud.
			e.realtime.SendToolResult(callID, text)
		default:
			e.realtime.SpeakText(text)
		}
		e.markSpoke(text)
		return nil
	}

	e.speakMu.Lock()
	defer e.speakMu.Unlock()
	e.setSpeaking(true)
	defer func() { time.Sleep(400 * time.Millisecond); e.setSpeaking(false) }()
	e.meet.StopPlayback()
	tts := e.newTTS()
	if tts == nil {
		return fmt.Errorf("TTS unavailable (set TOGETHER_API_KEY)")
	}
	defer tts.Close()
	if err := tts.Connect(e.meet.Context()); err != nil {
		return fmt.Errorf("tts connect: %w", err)
	}
	tts.SendText(text)
	tts.Flush()
	tts.Wait()
	e.markSpoke(text)
	return nil
}

// fastModel is the low-latency model for the immediate voice layer.
const fastModel = "llama-3.1-8b-instant"

// StagePredrafts merges pre-written answers the agent staged. Entries with a
// matching ID replace the old one; new IDs append. Returns the new total.
func (e *Engine) StagePredrafts(items []Predraft) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, it := range items {
		if strings.TrimSpace(it.Topic) == "" || strings.TrimSpace(it.Answer) == "" {
			continue
		}
		replaced := false
		if it.ID != "" {
			for i := range e.predrafts {
				if e.predrafts[i].ID == it.ID {
					e.predrafts[i] = it
					replaced = true
					break
				}
			}
		}
		if !replaced {
			e.predrafts = append(e.predrafts, it)
		}
	}
	n := len(e.predrafts)
	e.mu.Unlock()
	// Re-ground the live Realtime session with the new knowledge.
	if e.realtime != nil {
		e.realtime.UpdateInstructions(e.buildPersona())
	}
	e.mu.Lock()
	return n
}

// respond handles a gate-approved utterance. The fast model classifies intent
// (never generates knowledge): a matched pre-draft is spoken instantly; a
// greeting gets a short natural reply; a real question with no pre-draft gets a
// spoken deferral + a "research" turn for the agent to answer in chat; filler /
// backchannel / "stop talking" is met with SILENCE.
func (e *Engine) respond(text, speaker string, transcript []TranscriptEntry) {
	kind, pd := e.routeIntent(text)
	switch {
	case pd != nil:
		log.Printf("[respond] predraft hit: %q", pd.Topic)
		e.Speak(pd.Answer)
		e.enqueue(Turn{Speaker: speaker, Utterance: text, Decision: "answered", MatchedTopic: pd.Topic, Transcript: recent(transcript), Time: time.Now()})
	case kind == "greet":
		log.Printf("[respond] greeting")
		e.Speak(e.greetingReply(text))
	case kind == "question":
		log.Printf("[respond] question, no predraft — deferring to chat")
		e.Speak(e.deferralLine())
		e.enqueue(Turn{Speaker: speaker, Utterance: text, Decision: "research", NeedsResearch: true, Transcript: recent(transcript), Time: time.Now()})
	default: // "skip"
		log.Printf("[respond] skip (silent): %q", text)
	}
}

// routeIntent uses the fast model purely as a classifier. Returns:
//   - ("answered", pd)  a staged pre-draft answers it
//   - ("greet", nil)    greeting / small talk → short natural reply
//   - ("question", nil) a real info question no pre-draft covers → defer to chat
//   - ("skip", nil)     filler, backchannel, or not needing a reply → stay silent
func (e *Engine) routeIntent(text string) (string, *Predraft) {
	e.mu.Lock()
	pds := append([]Predraft(nil), e.predrafts...)
	e.mu.Unlock()

	t0 := time.Now()
	var sb strings.Builder
	for i, p := range pds {
		fmt.Fprintf(&sb, "%d. %s\n", i+1, p.Topic)
	}
	topics := sb.String()
	if topics == "" {
		topics = "(none staged yet)\n"
	}
	msgs := []LLMMessage{
		{Role: "system", Content: "You are a strict intent router for a meeting assistant. Output ONLY one token and nothing else. Be precise: only match a numbered topic when it SPECIFICALLY answers the utterance; when in doubt, prefer Q."},
		{Role: "user", Content: fmt.Sprintf("Pre-written answer topics:\n%s\nThe person just said: %q\n\nPick the SINGLE best token:\n- a topic NUMBER — ONLY if that exact topic directly and specifically answers what they said. A different subject does NOT count. If unsure, do NOT pick a number.\n- G — greeting, thanks, or small talk.\n- Q — a genuine question or request about ANYTHING the topics do not specifically cover (a new subject, a lookup, \"can you figure out X\", \"what is Y\").\n- S — backchannel, filler, an aside, telling you to stop, or anything not calling for an answer.\n\nDefault to Q for questions that don't clearly match a listed topic. Token only.", topics, text)},
	}
	ans, err := groqOnce(e.meet.Context(), msgs, fastModel)
	if err != nil {
		log.Printf("[route] groq: %v — skip", err)
		return "skip", nil
	}
	tok := strings.ToUpper(strings.TrimSpace(ans))
	log.Printf("[route] %dms -> %q", time.Since(t0).Milliseconds(), tok)
	if n := parseLeadingInt(tok); n >= 1 && n <= len(pds) {
		return "answered", &pds[n-1]
	}
	switch {
	case strings.HasPrefix(tok, "G"):
		return "greet", nil
	case strings.HasPrefix(tok, "Q"):
		return "question", nil
	default:
		return "skip", nil
	}
}

// greetingReply crafts a short, natural spoken greeting. Safe for the fast model
// — it's pure social language, no facts to get wrong.
func (e *Engine) greetingReply(text string) string {
	msgs := []LLMMessage{
		{Role: "system", Content: fmt.Sprintf("You are %s, %s's AI, in a meeting. Reply to this greeting/small-talk in ONE short, warm, spoken sentence (max 8 words). No facts, no questions back unless natural. Just the words.", e.botName, e.owner)},
		{Role: "user", Content: text},
	}
	r, err := groqOnce(e.meet.Context(), msgs, fastModel)
	if err != nil || strings.TrimSpace(r) == "" {
		return "Hey! Good to be here."
	}
	return strings.TrimSpace(r)
}

var deferralLines = []string{
	"Good question — let me dig into that and I'll drop the answer in the chat.",
	"I want to get that exactly right, so I'll look it up and put it in the chat.",
	"Let me research that properly and post it in the chat in a sec.",
}

func (e *Engine) deferralLine() string {
	e.mu.Lock()
	s := deferralLines[e.deferN%len(deferralLines)]
	e.deferN++
	e.mu.Unlock()
	return s
}

// spokeRecently reports whether this bot spoke within the self-follow-up window.
// Kept short: a genuine follow-up to the bot comes right after its turn. A longer
// window would wake the bot on unrelated human-to-human turns (P2→P3) that happen
// to land soon after it spoke — the model's wait_for_user backstop would still
// silence those, but we'd rather not wake it on them at all. Caller must hold e.mu.
func (e *Engine) spokeRecently() bool {
	return e.hasEverSpoken && time.Since(e.lastSpokeAt) < 10*time.Second
}

func (e *Engine) markSpoke(text string) {
	text = strings.TrimSpace(stripThinkingTags(text))
	if text == "" {
		return
	}
	e.mu.Lock()
	e.hasEverSpoken = true
	e.lastSpokeAt = time.Now()
	e.transcript = append(e.transcript, TranscriptEntry{Time: time.Now(), Speaker: e.botName, Text: text})
	e.mu.Unlock()
	e.pushWords(text) // reflect what it's saying in the avatar
}

// parseLeadingInt pulls the first integer out of s (the router's reply).
func parseLeadingInt(s string) int {
	s = strings.TrimSpace(s)
	start := -1
	for i, r := range s {
		if r >= '0' && r <= '9' {
			start = i
			break
		}
	}
	if start < 0 {
		return -1
	}
	end := start
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	n, err := strconv.Atoi(s[start:end])
	if err != nil {
		return -1
	}
	return n
}

// Transcript returns a copy of the full meeting transcript so far.
func (e *Engine) Transcript() []TranscriptEntry {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]TranscriptEntry(nil), e.transcript...)
}

func recent(t []TranscriptEntry) []TranscriptEntry {
	const n = 12
	if len(t) > n {
		return append([]TranscriptEntry(nil), t[len(t)-n:]...)
	}
	return append([]TranscriptEntry(nil), t...)
}
