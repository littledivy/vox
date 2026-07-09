package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"time"
)

// mcp.go implements a minimal Model Context Protocol server over stdio
// (newline-delimited JSON-RPC 2.0). The connected Claude agent adds vox as an
// MCP server and drives a meeting with these tools:
//
//	join_meeting → wait_for_turn → speak → wait_for_turn → … → leave_meeting
//
// The fast Groq layer keeps the conversation flowing at low latency; the agent
// contributes deeper, session-aware replies via speak() whenever it has value.

const (
	mcpProtocolVersion = "2025-06-18"
	serverName         = "vox"
	serverVersion      = "0.2.0"
)

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  interface{}     `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type MCPServer struct {
	mu     sync.Mutex
	meet   *MeetSession
	engine *Engine

	outMu sync.Mutex
	out   *bufio.Writer
}

func NewMCPServer() *MCPServer {
	return &MCPServer{out: bufio.NewWriter(os.Stdout)}
}

// Serve reads JSON-RPC messages from stdin until EOF.
func (s *MCPServer) Serve() error {
	dec := json.NewDecoder(bufio.NewReader(os.Stdin))
	for {
		var req rpcRequest
		if err := dec.Decode(&req); err != nil {
			if err == io.EOF {
				return nil
			}
			log.Printf("[mcp] decode error: %v", err)
			return err
		}
		s.handle(req)
	}
}

func (s *MCPServer) handle(req rpcRequest) {
	// Notifications (no id) get no response.
	notification := len(req.ID) == 0

	switch req.Method {
	case "initialize":
		s.reply(req.ID, map[string]interface{}{
			"protocolVersion": mcpProtocolVersion,
			"capabilities":    map[string]interface{}{"tools": map[string]interface{}{}},
			"serverInfo":      map[string]string{"name": serverName, "version": serverVersion},
		})
	case "notifications/initialized", "notifications/cancelled":
		// no-op
	case "ping":
		s.reply(req.ID, map[string]interface{}{})
	case "tools/list":
		s.reply(req.ID, map[string]interface{}{"tools": toolDefs})
	case "tools/call":
		s.handleToolCall(req)
	default:
		if !notification {
			s.replyErr(req.ID, -32601, "method not found: "+req.Method)
		}
	}
}

func (s *MCPServer) handleToolCall(req rpcRequest) {
	var p struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &p); err != nil {
		s.replyErr(req.ID, -32602, "invalid params")
		return
	}
	text, isErr := s.dispatch(p.Name, p.Arguments)
	s.reply(req.ID, map[string]interface{}{
		"content": []map[string]string{{"type": "text", "text": text}},
		"isError": isErr,
	})
}

func (s *MCPServer) dispatch(name string, rawArgs json.RawMessage) (string, bool) {
	switch name {
	case "join_meeting":
		return s.toolJoin(rawArgs)
	case "wait_for_turn":
		return s.toolWaitForTurn(rawArgs)
	case "stage_answers":
		return s.toolStageAnswers(rawArgs)
	case "speak":
		return s.toolSpeak(rawArgs)
	case "send_chat":
		return s.toolSendChat(rawArgs)
	case "get_transcript":
		return s.toolGetTranscript()
	case "get_participants":
		return s.toolParticipants()
	case "mute_yourself":
		return s.toolSetMic(false)
	case "unmute_yourself":
		return s.toolSetMic(true)
	case "leave_meeting":
		return s.toolLeave()
	default:
		return "unknown tool: " + name, true
	}
}

func (s *MCPServer) toolJoin(raw json.RawMessage) (string, bool) {
	var a struct {
		URL       string   `json:"url"`
		Name      string   `json:"name"`
		Owner     string   `json:"owner"`
		UserNames []string `json:"user_names"`
		Context   string   `json:"context"`
	}
	json.Unmarshal(raw, &a)
	if a.URL == "" || !IsMeetURL(a.URL) {
		return "provide a valid Google Meet url (https://meet.google.com/...)", true
	}
	s.mu.Lock()
	if s.engine != nil {
		s.mu.Unlock()
		return "already in a meeting — leave_meeting first", true
	}
	s.mu.Unlock()

	// Realtime mode (VOX_VOICE=realtime) uses OpenAI for STT+brain+TTS, so it needs
	// only OPENAI_API_KEY — the one-key install path. The classic pipeline instead
	// needs Deepgram (STT). Require whichever the active backend actually uses.
	realtime := os.Getenv("VOX_VOICE") == "realtime"
	dgKey := os.Getenv("DEEPGRAM_API_KEY")
	if realtime {
		if os.Getenv("OPENAI_API_KEY") == "" {
			return "OPENAI_API_KEY not set (required for VOX_VOICE=realtime)", true
		}
	} else if dgKey == "" {
		return "DEEPGRAM_API_KEY not set (or set VOX_VOICE=realtime to use only OPENAI_API_KEY)", true
	}
	owner := a.Owner
	if owner == "" {
		owner = os.Getenv("VOX_OWNER")
	}
	if owner == "" {
		owner = "Someone"
	}
	name := a.Name
	if name == "" {
		name = owner + "'s Claude"
	}

	meet := &MeetSession{MeetURL: a.URL}
	if err := meet.Join(name); err != nil {
		return "join failed: " + err.Error(), true
	}
	eng := NewEngine(meet, name, owner, a.UserNames, dgKey)
	// Seed the voice with what the agent has been working on, so it can speak from
	// real context at first turn instead of consulting for everything. Set before
	// Start() — the realtime persona is built there.
	eng.meetingSummary = strings.TrimSpace(a.Context)
	meet.onEnd = func() { eng.Stop() }
	if err := eng.Start(); err != nil {
		meet.Leave()
		return "engine start failed: " + err.Error(), true
	}

	s.mu.Lock()
	s.meet = meet
	s.engine = eng
	s.mu.Unlock()

	return fmt.Sprintf("Joined %s as %q.\n\nHOW YOU WORK (predictive pre-draft):\n1. RIGHT NOW, before listening, call stage_answers with pre-written spoken answers to the questions people are LIKELY to ask you here — from your session knowledge (who you are, what you/%s are working on, project status, key facts). Each has a `topic` (for routing) and a spoken `answer` (your words, conversational). These get spoken INSTANTLY when matched — this is how the voice stays fast AND smart.\n2. Then call wait_for_turn. When a question matches a staged answer, it's already spoken (decision \"answered\") — you can stay silent or stage follow-ups.\n3. When nothing matches (decision \"research\"), the bot told them out loud you'd look it up and post it in chat. So: research it, call send_chat with the answer, and call stage_answers so it's instant next time.\nKeep staging answers as the meeting evolves — always stay one step ahead.", a.URL, name, owner), false
}

func (s *MCPServer) toolStageAnswers(raw json.RawMessage) (string, bool) {
	s.mu.Lock()
	eng := s.engine
	s.mu.Unlock()
	if eng == nil {
		return "not in a meeting — call join_meeting first", true
	}
	var a struct {
		Answers []Predraft `json:"answers"`
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		return "bad arguments: " + err.Error(), true
	}
	if len(a.Answers) == 0 {
		return "provide answers: [{id, topic, answer}, ...]", true
	}
	total := eng.StagePredrafts(a.Answers)
	return fmt.Sprintf("staged %d answer(s); %d total ready to speak instantly.", len(a.Answers), total), false
}

func (s *MCPServer) toolWaitForTurn(raw json.RawMessage) (string, bool) {
	eng := s.currentEngine()
	if eng == nil {
		return "not in a meeting — call join_meeting first", true
	}
	var a struct {
		TimeoutSeconds int `json:"timeout_seconds"`
	}
	json.Unmarshal(raw, &a)
	timeout := 300 * time.Second
	if a.TimeoutSeconds > 0 {
		timeout = time.Duration(a.TimeoutSeconds) * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	turn, ok := eng.NextTurn(ctx)
	if !ok {
		if !s.meetJoined() {
			return "meeting ended.", false
		}
		return "no one has addressed you yet (timeout). Call wait_for_turn again to keep listening.", false
	}
	body, _ := json.MarshalIndent(turn, "", "  ")
	hint := "\n\nYou are the BRAIN. Act on `decision`:\n" +
		"• \"tool_call\": the live voice (Realtime model) hit something it doesn't know and called consult_agent — the `utterance` is its question. Research it with your tools/session knowledge and call speak() with the answer; it is returned to the voice, which speaks it in-meeting. Be concise and spoken. Then wait_for_turn again.\n" +
		"• \"answered\": one of your staged pre-drafts (see matched_topic) was ALREADY spoken aloud — the person heard your real answer instantly. Usually just stage_answers for likely FOLLOW-UPS and call wait_for_turn again. Only speak() if you must correct or meaningfully extend it.\n" +
		"• \"research\": nothing matched, so the bot said OUT LOUD that you'd look it up and post it in the chat. Now honor that: research using your tools/knowledge, call send_chat with a clear answer, AND call stage_answers with this Q&A so it's spoken instantly if asked again. Do NOT speak() a full answer — the promise was chat.\n" +
		"• \"hand\": you could add value by looking something up — do it and send_chat or speak briefly.\n" +
		"After acting, always call wait_for_turn again. Keep staging pre-drafts proactively so more turns resolve as instant \"answered\"."
	return string(body) + hint, false
}

func (s *MCPServer) toolSpeak(raw json.RawMessage) (string, bool) {
	eng := s.currentEngine()
	if eng == nil {
		return "not in a meeting — call join_meeting first", true
	}
	var a struct {
		Text string `json:"text"`
	}
	json.Unmarshal(raw, &a)
	if a.Text == "" {
		return "text is required", true
	}
	if err := eng.Speak(a.Text); err != nil {
		return "speak failed: " + err.Error(), true
	}
	return "spoke: " + a.Text, false
}

func (s *MCPServer) toolSendChat(raw json.RawMessage) (string, bool) {
	s.mu.Lock()
	meet := s.meet
	s.mu.Unlock()
	if meet == nil {
		return "not in a meeting — call join_meeting first", true
	}
	var a struct {
		Text string `json:"text"`
	}
	json.Unmarshal(raw, &a)
	if a.Text == "" {
		return "text is required", true
	}
	meet.SendChat(a.Text)
	return "posted to meeting chat: " + a.Text, false
}

func (s *MCPServer) toolParticipants() (string, bool) {
	s.mu.Lock()
	meet := s.meet
	s.mu.Unlock()
	if meet == nil {
		return "not in a meeting — call join_meeting first", true
	}
	body, _ := json.MarshalIndent(meet.Participants(), "", "  ")
	return string(body), false
}

func (s *MCPServer) toolSetMic(on bool) (string, bool) {
	s.mu.Lock()
	meet := s.meet
	s.mu.Unlock()
	if meet == nil {
		return "not in a meeting — call join_meeting first", true
	}
	meet.SetMic(on)
	if on {
		return "unmuted", false
	}
	return "muted", false
}

func (s *MCPServer) toolGetTranscript() (string, bool) {
	eng := s.currentEngine()
	if eng == nil {
		return "not in a meeting — call join_meeting first", true
	}
	body, _ := json.MarshalIndent(eng.Transcript(), "", "  ")
	return string(body), false
}

func (s *MCPServer) toolLeave() (string, bool) {
	s.mu.Lock()
	meet, eng := s.meet, s.engine
	s.meet, s.engine = nil, nil
	s.mu.Unlock()
	if meet == nil {
		return "not in a meeting", false
	}
	if eng != nil {
		eng.Stop()
	}
	meet.Leave()
	return "left the meeting", false
}

func (s *MCPServer) currentEngine() *Engine {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.engine
}

func (s *MCPServer) meetJoined() bool {
	s.mu.Lock()
	meet := s.meet
	s.mu.Unlock()
	return meet != nil && meet.Joined()
}

func (s *MCPServer) reply(id json.RawMessage, result interface{}) {
	s.write(rpcResponse{JSONRPC: "2.0", ID: id, Result: result})
}

func (s *MCPServer) replyErr(id json.RawMessage, code int, msg string) {
	s.write(rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: msg}})
}

func (s *MCPServer) write(resp rpcResponse) {
	data, err := json.Marshal(resp)
	if err != nil {
		log.Printf("[mcp] marshal: %v", err)
		return
	}
	s.outMu.Lock()
	defer s.outMu.Unlock()
	s.out.Write(data)
	s.out.WriteByte('\n')
	s.out.Flush()
}

// toolDefs is the static tools/list payload.
var toolDefs = []map[string]interface{}{
	{
		"name":        "join_meeting",
		"description": "Join a Google Meet call as the user's AI presence (e.g. \"Divy's Claude\"). Launches a headless Chrome that joins audio-only. After joining, call wait_for_turn to listen.",
		"inputSchema": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"url":        map[string]interface{}{"type": "string", "description": "Google Meet URL, e.g. https://meet.google.com/abc-defg-hij"},
				"name":       map[string]interface{}{"type": "string", "description": "Display name in the meeting. Defaults to \"<owner>'s Claude\"."},
				"owner":      map[string]interface{}{"type": "string", "description": "The person you represent, e.g. \"Divy\". Defaults to VOX_OWNER env."},
				"user_names": map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Extra names to feed the speech recognizer as keyterms."},
				"context":    map[string]interface{}{"type": "string", "description": "A briefing of what YOU (the agent driving this session) have been working on — current project, task, recent progress, key facts. The voice uses this to speak from real context at its first turn instead of consulting for everything. A few sentences to a paragraph."},
			},
			"required": []string{"url"},
		},
	},
	{
		"name":        "wait_for_turn",
		"description": "Block until the gate decides you should respond. Returns the utterance, speaker, recent transcript, and a `decision`: \"answered\" (a staged pre-draft was already spoken), \"research\" (the bot said aloud it would look it up and post in chat — you must send_chat the answer), or \"hand\". Loop: wait_for_turn → act on decision → wait_for_turn.",
		"inputSchema": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"timeout_seconds": map[string]interface{}{"type": "integer", "description": "Max seconds to block before returning a timeout notice (default 300). On timeout, just call again."},
			},
		},
	},
	{
		"name":        "stage_answers",
		"description": "Pre-write spoken answers to questions people are LIKELY to ask, so they're spoken INSTANTLY (sub-second) when matched — this is how the voice stays both fast and smart. Call it right after joining with your session knowledge, and keep calling it as the meeting evolves (and after every \"research\" turn). Answers should be in your voice: conversational, spoken, concise.",
		"inputSchema": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"answers": map[string]interface{}{
					"type":        "array",
					"description": "Pre-drafted Q&A to stage.",
					"items": map[string]interface{}{
						"type": "object",
						"properties": map[string]interface{}{
							"id":     map[string]interface{}{"type": "string", "description": "Stable id; re-staging the same id updates that answer."},
							"topic":  map[string]interface{}{"type": "string", "description": "The question or topic this answers, used for routing (e.g. \"what is vox / what are you building\")."},
							"answer": map[string]interface{}{"type": "string", "description": "The spoken answer in your voice — conversational, 1-3 sentences."},
						},
						"required": []string{"topic", "answer"},
					},
				},
			},
			"required": []string{"answers"},
		},
	},
	{
		"name":        "speak",
		"description": "Say something aloud in the meeting in your voice, interrupting any current speech. Use for concise, session-aware answers — keep it conversational and spoken, not written prose.",
		"inputSchema": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"text": map[string]interface{}{"type": "string", "description": "What to say aloud."},
			},
			"required": []string{"text"},
		},
	},
	{
		"name":        "send_chat",
		"description": "Post a text message to the meeting chat panel (good for links, code, or details that are awkward to say aloud).",
		"inputSchema": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"text": map[string]interface{}{"type": "string", "description": "Message to post in chat."},
			},
			"required": []string{"text"},
		},
	},
	{
		"name":        "get_transcript",
		"description": "Return the full meeting transcript so far as JSON.",
		"inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
	},
	{
		"name":        "get_participants",
		"description": "Return the current meeting participants (display names) as JSON.",
		"inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
	},
	{
		"name":        "mute_yourself",
		"description": "Mute the bot's microphone so your spoken audio stops reaching the meeting.",
		"inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
	},
	{
		"name":        "unmute_yourself",
		"description": "Unmute the bot's microphone so speak() audio reaches the meeting again.",
		"inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
	},
	{
		"name":        "leave_meeting",
		"description": "Leave the meeting and shut down the browser.",
		"inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
	},
}
