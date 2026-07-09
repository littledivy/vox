package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// RealtimeSession is the "Mode A" voice backend: OpenAI's Realtime API listens to
// the whole meeting (audio in) and speaks (audio out) natively — one audio-native
// reasoning model replacing the Deepgram STT + Groq + Orpheus chain. It's grounded
// by an `instructions` briefing (built from the agent's staged answers) so it
// speaks the agent's knowledge, not hallucinations. Server VAD handles turn-taking.
type RealtimeSession struct {
	conn    wsConn
	speaker *PulseSpeaker
	parec   *exec.Cmd
	ctx     context.Context
	cancel  context.CancelFunc

	mu        sync.Mutex
	persona   string
	seenCalls map[string]bool
	dropAudio  bool   // true after barge-in until the next response starts
	responding bool   // true while a model response is in progress (created→done)
	curItemID  string // id of the assistant item currently being spoken (for truncate)
	playedMs   int    // ms of audio written for the current item (barge-in truncate point)
	writeMu   sync.Mutex

	// onToolCall fires when the model invokes the consult_agent tool — the engine
	// routes the question to the Claude agent, which answers via SendToolResult.
	onToolCall func(callID, question string)
	// onHeard fires on each completed input transcription — the engine runs the
	// social gate and calls CreateResponse only when the model should reply.
	onHeard func(text string)
	// onSaid fires when the model finishes speaking a response (its completed
	// output transcript) so the engine can record what the bot actually said into
	// the shared transcript — keeps the log and gate state complete.
	onSaid func(text string)
	// onChatReply fires with the model's TEXT-modality output — a Meet chat reply.
	// Chat is handled by the SAME model as the voice, so it shares full meeting
	// context and the consult_agent tool. The engine posts this to Meet chat.
	onChatReply func(text string)
	chatBuf     strings.Builder
	// onState fires on visual-state changes (idle/listening/thinking/speaking) so
	// the entity shader can recolor. Deduped via lastState.
	onState   func(state string)
	lastState string
}

// setState emits a visual state change (deduped) for the entity shader.
func (rs *RealtimeSession) setState(s string) {
	rs.mu.Lock()
	if rs.lastState == s {
		rs.mu.Unlock()
		return
	}
	rs.lastState = s
	cb := rs.onState
	rs.mu.Unlock()
	if cb != nil {
		cb(s)
	}
}

// CreateResponse asks the model to produce one response now (used by the gate,
// since auto-response is disabled).
func (rs *RealtimeSession) CreateResponse() {
	rs.writeMu.Lock()
	defer rs.writeMu.Unlock()
	rs.conn.WriteJSON(map[string]any{"type": "response.create"})
}

// wsConn is the subset of *websocket.Conn we use (keeps the file testable).
type wsConn interface {
	WriteJSON(v interface{}) error
	ReadMessage() (int, []byte, error)
	Close() error
}

func realtimeModel() string {
	if m := os.Getenv("VOX_REALTIME_MODEL"); m != "" {
		return m
	}
	// Proven-working default. Set VOX_REALTIME_MODEL=gpt-realtime-2.1 for the
	// larger (better-reasoning, higher-latency) model once verified in your account.
	return "gpt-realtime-2.1-mini"
}

// realtimeTranscribe is the model used for the side-channel input transcription
// that feeds the social gate (the wake-word name match runs on this text). Default
// whisper-1 (known-good); set VOX_REALTIME_TRANSCRIBE=gpt-realtime-whisper to try
// the newer, better entity-capture transcriber once verified in your account.
func realtimeTranscribe() string {
	if m := os.Getenv("VOX_REALTIME_TRANSCRIBE"); m != "" {
		return m
	}
	return "whisper-1"
}

func realtimeVoice() string {
	if v := os.Getenv("VOX_REALTIME_VOICE"); v != "" {
		return v
	}
	return "marin"
}

func realtimeEffort() string {
	if e := os.Getenv("VOX_REALTIME_EFFORT"); e != "" {
		return e
	}
	return "low"
}

// startRealtime connects to the Realtime API, configures the session with the
// given persona/briefing, and starts pumping meeting audio in and model audio out.
func startRealtime(ctx context.Context, speaker *PulseSpeaker, persona string) (*RealtimeSession, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("OPENAI_API_KEY not set (required for VOX_VOICE=realtime)")
	}
	model := realtimeModel()
	url := "wss://api.openai.com/v1/realtime?model=" + model
	header := http.Header{}
	header.Set("Authorization", "Bearer "+apiKey)

	conn, resp, err := ipv4WSDialer.Dial(url, header)
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("realtime dial: %w (status %s, %s)", err, resp.Status, resp.Header.Get("x-request-id"))
		}
		return nil, fmt.Errorf("realtime dial: %w", err)
	}
	log.Printf("[realtime] connected: %s", model)

	rctx, cancel := context.WithCancel(ctx)
	rs := &RealtimeSession{conn: conn, speaker: speaker, ctx: rctx, cancel: cancel, persona: persona}

	if err := rs.configure(persona); err != nil {
		conn.Close()
		cancel()
		return nil, err
	}
	go rs.readLoop()
	if err := rs.startCapture(); err != nil {
		conn.Close()
		cancel()
		return nil, err
	}
	return rs, nil
}

// configure sends session.update with the persona/briefing + audio formats + VAD.
func (rs *RealtimeSession) configure(instructions string) error {
	rs.writeMu.Lock()
	defer rs.writeMu.Unlock()
	return rs.conn.WriteJSON(map[string]any{
		"type": "session.update",
		"session": map[string]any{
			"type":              "realtime",
			"instructions":      instructions,
			"output_modalities": []string{"audio"},
			"audio": map[string]any{
				"input": map[string]any{
					"format": map[string]any{"type": "audio/pcm", "rate": 24000},
					// Semantic VAD: a classifier decides turn-end from the CONTENT of
					// speech, not a fixed silence timer — so it waits for a real
					// end-of-utterance and won't chop in on a mid-thought pause. That's
					// what keeps the bot from talking over people in a live room.
					// eagerness "low" = give speakers time to finish. It still doesn't
					// auto-respond (create_response:false) — our social gate + the
					// model's own wait_for_user tool decide when to actually reply.
					"turn_detection": map[string]any{
						"type":               "semantic_vad",
						"eagerness":          "low",
						"create_response":    false,
						"interrupt_response": true,
					},
					"transcription": map[string]any{"model": realtimeTranscribe()},
				},
				"output": map[string]any{
					"format": map[string]any{"type": "audio/pcm", "rate": 24000},
					"voice":  realtimeVoice(),
				},
			},
			"reasoning": map[string]any{"effort": realtimeEffort()},
			"tools": []map[string]any{
				{
					"type":        "function",
					"name":        "consult_agent",
					"description": "Ask your own deeper mind (the Claude agent driving this session) for anything you don't already know: session knowledge, project or code details, meeting history, or research. Use this instead of guessing whenever a real, specific answer is needed. It may take a few seconds — you can say you're checking, then speak the answer it returns.",
					"parameters": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"question": map[string]any{"type": "string", "description": "The exact question to ask the agent, in full."},
						},
						"required": []string{"question"},
					},
				},
				{
					"type":        "function",
					"name":        "wait_for_user",
					"description": "Call this to STAY SILENT and keep listening (it produces no speech) whenever the latest audio was NOT addressed to you: another person or AI is being spoken to, two others are talking to each other, a question was put to someone else, or it's side conversation, background, or general chatter where you weren't asked anything. Strongly prefer this whenever you are not sure you were directly addressed. Answering un-addressed audio in a group is the main failure mode — when in doubt, wait_for_user.",
					"parameters": map[string]any{
						"type":       "object",
						"properties": map[string]any{},
					},
				},
			},
			"tool_choice": "auto",
		},
	})
}

// SendToolResult returns the agent's answer to a consult_agent call and asks the
// model to speak it. The model voices it in its own natural voice.
func (rs *RealtimeSession) SendToolResult(callID, output string) {
	rs.writeMu.Lock()
	defer rs.writeMu.Unlock()
	if err := rs.conn.WriteJSON(map[string]any{
		"type": "conversation.item.create",
		"item": map[string]any{"type": "function_call_output", "call_id": callID, "output": output},
	}); err != nil {
		log.Printf("[realtime] tool result: %v", err)
		return
	}
	rs.conn.WriteJSON(map[string]any{"type": "response.create"})
}

// SendToolResultSilent returns a consult_agent result WITHOUT asking the model to
// respond — used when the agent posted the answer to chat because the
// conversation moved on, so the voice should stay quiet.
func (rs *RealtimeSession) SendToolResultSilent(callID, output string) {
	rs.writeMu.Lock()
	defer rs.writeMu.Unlock()
	rs.conn.WriteJSON(map[string]any{
		"type": "conversation.item.create",
		"item": map[string]any{"type": "function_call_output", "call_id": callID, "output": output},
	})
}

// CancelResponse interrupts the model's in-progress spoken response (barge-in).
func (rs *RealtimeSession) CancelResponse() {
	rs.writeMu.Lock()
	defer rs.writeMu.Unlock()
	rs.conn.WriteJSON(map[string]any{"type": "response.cancel"})
}

// truncateItem tells the server to drop everything after audioEndMs from the given
// assistant item, so the model's memory of what it said matches what was actually
// heard before a barge-in cut it off.
func (rs *RealtimeSession) truncateItem(itemID string, audioEndMs int) {
	if audioEndMs < 0 {
		audioEndMs = 0
	}
	rs.writeMu.Lock()
	defer rs.writeMu.Unlock()
	rs.conn.WriteJSON(map[string]any{
		"type":          "conversation.item.truncate",
		"item_id":       itemID,
		"content_index": 0,
		"audio_end_ms":  audioEndMs,
	})
}

// SpeakText makes the model say something unprompted (e.g. the agent used the
// speak tool directly): inject an assistant message and trigger a response.
func (rs *RealtimeSession) SpeakText(text string) {
	rs.writeMu.Lock()
	defer rs.writeMu.Unlock()
	rs.conn.WriteJSON(map[string]any{
		"type": "conversation.item.create",
		"item": map[string]any{
			"type":    "message",
			"role":    "system",
			"content": []map[string]any{{"type": "input_text", "text": "Say the following out loud verbatim, naturally: " + text}},
		},
	})
	rs.conn.WriteJSON(map[string]any{"type": "response.create"})
}

// SendChatTurn injects an inbound Meet chat message into the shared conversation
// and asks the model for a TEXT reply (routed to Meet chat, not spoken). Because
// it's the same session, the reply has full meeting context and can use the
// consult_agent tool — chat is a natural text extension of the voice. The recent
// transcript is included so the reply is explicitly grounded in what was said
// aloud (e.g. "verify my claim" resolves to the actual spoken claim).
func (rs *RealtimeSession) SendChatTurn(sender, text, recent string) {
	body := ""
	if recent != "" {
		body = "What's been said in the meeting so far (voice + chat):\n" + recent + "\n\n"
	}
	body += "[Meeting chat] " + sender + ": " + text +
		"\n(You've been listening the whole meeting — use that full context. Reply in the meeting chat: text only, natural and concise.)"
	rs.writeMu.Lock()
	defer rs.writeMu.Unlock()
	rs.conn.WriteJSON(map[string]any{
		"type": "conversation.item.create",
		"item": map[string]any{
			"type":    "message",
			"role":    "user",
			"content": []map[string]any{{"type": "input_text", "text": body}},
		},
	})
	rs.conn.WriteJSON(map[string]any{
		"type":     "response.create",
		"response": map[string]any{"output_modalities": []string{"text"}},
	})
}

// UpdateInstructions re-grounds the live session (called when the agent stages
// more answers). Best-effort.
func (rs *RealtimeSession) UpdateInstructions(instructions string) {
	rs.mu.Lock()
	rs.persona = instructions
	rs.mu.Unlock()
	if err := rs.configure(instructions); err != nil {
		log.Printf("[realtime] update instructions: %v", err)
	}
}

// startCapture streams vox_out.monitor (the meeting audio) as 24kHz PCM into the
// input audio buffer. Server VAD segments turns and auto-responds.
func (rs *RealtimeSession) startCapture() error {
	cmd := exec.CommandContext(rs.ctx, "parec",
		"-d", "vox_out.monitor",
		"--format=s16le", "--rate=24000", "--channels=1", "--raw",
		"--latency-msec=20",
	)
	cmd.Env = pulseEnv()
	cmd.Stderr = &prefixWriter{prefix: "[parec] "}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("parec stdout: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("parec start: %w", err)
	}
	rs.parec = cmd
	log.Printf("[realtime] capturing vox_out.monitor -> realtime")

	go func() {
		buf := make([]byte, 4800) // 100ms of 24kHz mono s16le
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				b64 := base64.StdEncoding.EncodeToString(buf[:n])
				rs.writeMu.Lock()
				werr := rs.conn.WriteJSON(map[string]any{"type": "input_audio_buffer.append", "audio": b64})
				rs.writeMu.Unlock()
				if werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
			if rs.ctx.Err() != nil {
				return
			}
		}
	}()
	return nil
}

// readLoop consumes server events: output audio -> mic, transcripts + errors logged.
func (rs *RealtimeSession) readLoop() {
	for {
		if rs.ctx.Err() != nil {
			return
		}
		_, data, err := rs.conn.ReadMessage()
		if err != nil {
			log.Printf("[realtime] read: %v", err)
			rs.cancel()
			return
		}
		var ev struct {
			Type       string `json:"type"`
			Delta      string `json:"delta"`
			Transcript string `json:"transcript"`
			Text       string `json:"text"`
			CallID     string `json:"call_id"`
			Name       string `json:"name"`
			Arguments  string `json:"arguments"`
			ItemID     string `json:"item_id"`
			Item       struct {
				Type      string `json:"type"`
				Name      string `json:"name"`
				CallID    string `json:"call_id"`
				Arguments string `json:"arguments"`
			} `json:"item"`
			Error struct {
				Message string `json:"message"`
				Code    string `json:"code"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &ev) != nil {
			continue
		}
		switch {
		case strings.HasSuffix(ev.Type, "function_call_arguments.done"):
			rs.dispatchToolCall(ev.CallID, ev.Name, ev.Arguments)
		case ev.Type == "response.output_item.done" && ev.Item.Type == "function_call":
			rs.dispatchToolCall(ev.Item.CallID, ev.Item.Name, ev.Item.Arguments)
		case ev.Type == "response.created":
			rs.mu.Lock()
			rs.dropAudio = false
			rs.responding = true
			rs.curItemID = ""
			rs.playedMs = 0
			rs.mu.Unlock()
		case strings.HasSuffix(ev.Type, "output_audio.delta"):
			rs.mu.Lock()
			drop := rs.dropAudio
			if !drop {
				if ev.ItemID != "" {
					rs.curItemID = ev.ItemID
				}
				// 24kHz mono s16le → 48000 bytes/sec → ms = bytes/48. Track how much
				// we've actually played so a barge-in can truncate the item there.
				rs.playedMs += base64.StdEncoding.DecodedLen(len(ev.Delta)) / 48
			}
			rs.mu.Unlock()
			if !drop {
				rs.setState("speaking")
				rs.speaker.WriteBase64(ev.Delta)
			}
		case strings.HasSuffix(ev.Type, "text.delta"):
			// TEXT-modality output = a Meet chat reply (voice uses audio). Accumulate.
			rs.mu.Lock()
			rs.chatBuf.WriteString(ev.Delta)
			rs.mu.Unlock()
		case strings.HasSuffix(ev.Type, "text.done"):
			rs.mu.Lock()
			reply := ev.Text
			if reply == "" {
				reply = rs.chatBuf.String()
			}
			rs.chatBuf.Reset()
			cb := rs.onChatReply
			rs.mu.Unlock()
			if cb != nil && strings.TrimSpace(reply) != "" {
				cb(reply)
			}
		case ev.Type == "response.output_audio_transcript.done":
			if ev.Transcript != "" {
				log.Printf("[realtime] said: %s", ev.Transcript)
				rs.mu.Lock()
				cb := rs.onSaid
				rs.mu.Unlock()
				if cb != nil {
					cb(ev.Transcript)
				}
			}
		case ev.Type == "response.done":
			rs.mu.Lock()
			rs.responding = false
			rs.mu.Unlock()
			rs.setState("idle")
		case strings.HasSuffix(ev.Type, "input_audio_transcription.completed"):
			if ev.Transcript != "" {
				log.Printf("[realtime] heard: %s", ev.Transcript)
				rs.mu.Lock()
				cb := rs.onHeard
				rs.mu.Unlock()
				if cb != nil {
					cb(ev.Transcript)
				}
			}
		case ev.Type == "input_audio_buffer.speech_started":
			// Barge-in: someone started talking — stop our own audio immediately
			// (drop queued deltas) and cancel the in-progress response so we don't
			// talk over them.
			rs.mu.Lock()
			wasResponding := rs.responding
			rs.dropAudio = true
			itemID := rs.curItemID
			playedMs := rs.playedMs
			rs.curItemID = ""
			rs.mu.Unlock()
			rs.speaker.Flush()
			rs.setState("listening")
			// Only interrupt if we were actually talking — otherwise response.cancel
			// errors with "no active response" and it's just noise.
			if !wasResponding {
				break
			}
			// Trim the unheard tail from the model's conversation memory so it
			// doesn't believe it said words the humans never heard. Without this,
			// context drifts after every interruption — and a real multi-party call
			// interrupts constantly.
			if itemID != "" {
				rs.truncateItem(itemID, playedMs)
			}
			rs.CancelResponse()
			log.Printf("[realtime] barge-in: speech started, truncating at %dms", playedMs)
		case ev.Type == "error":
			log.Printf("[realtime] ERROR: %s (%s)", ev.Error.Message, ev.Error.Code)
		case ev.Type == "session.updated", ev.Type == "session.created":
			log.Printf("[realtime] %s", ev.Type)
		}
	}
}

var errNoQuestion = fmt.Errorf("no question")

// dispatchToolCall parses a consult_agent invocation and routes it to the agent.
// Deduped because the arguments arrive via both function_call_arguments.done and
// output_item.done.
func (rs *RealtimeSession) dispatchToolCall(callID, name, arguments string) {
	// wait_for_user is a no-op the model invokes to stay silent on un-addressed
	// audio (the native "wake word" gate). No output — the response just ends.
	if name == "wait_for_user" {
		rs.setState("listening")
		log.Printf("[realtime] wait_for_user — not addressed, staying silent")
		return
	}
	if name != "consult_agent" || callID == "" {
		return
	}
	rs.mu.Lock()
	if rs.seenCalls == nil {
		rs.seenCalls = map[string]bool{}
	}
	if rs.seenCalls[callID] {
		rs.mu.Unlock()
		return
	}
	rs.seenCalls[callID] = true
	cb := rs.onToolCall
	rs.mu.Unlock()

	var a struct {
		Question string `json:"question"`
	}
	json.Unmarshal([]byte(arguments), &a)
	q := strings.TrimSpace(a.Question)
	if q == "" {
		q = "(the meeting participants want an answer — see recent transcript)"
	}
	log.Printf("[realtime] consult_agent: %s", q)
	rs.setState("thinking")
	if cb != nil {
		cb(callID, q)
	}
}

func (rs *RealtimeSession) Close() {
	if rs == nil {
		return
	}
	rs.cancel()
	if rs.parec != nil && rs.parec.Process != nil {
		rs.parec.Process.Kill()
	}
	if rs.conn != nil {
		rs.conn.Close()
	}
	time.Sleep(50 * time.Millisecond)
}
