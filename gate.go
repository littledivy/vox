package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// GateDecision represents the three possible gate outcomes.
type GateDecision string

const (
	GateSpeak     GateDecision = "speak"
	GateRaiseHand GateDecision = "hand"
	GateSilent    GateDecision = "silent"
)

// gateResult holds the decision and reasoning.
type gateResult struct {
	Decision GateDecision
	Reason   string
}

// ruleGate applies fast heuristic rules. Returns a definitive decision or "maybe" for LLM fallback.
func ruleGate(speaker, text string, transcript []TranscriptEntry, botName string, aiNames []string) gateResult {
	lower := strings.ToLower(text)

	// Rule 1: Direct addressing → SPEAK
	for _, name := range aiNames {
		nameLower := strings.ToLower(name)
		if strings.Contains(lower, nameLower+",") ||
			strings.Contains(lower, nameLower+" ") ||
			strings.HasSuffix(lower, nameLower) ||
			strings.HasSuffix(lower, nameLower+".") ||
			strings.HasSuffix(lower, nameLower+"?") ||
			strings.HasSuffix(lower, nameLower+"!") ||
			strings.HasPrefix(lower, nameLower) {
			// Filter out passing mentions
			passingPhrases := []string{
				"testing " + nameLower, "tried " + nameLower, "using " + nameLower,
				nameLower + " yesterday", nameLower + " crashed", nameLower + " broke",
				"about " + nameLower,
			}
			isPassing := false
			for _, p := range passingPhrases {
				if strings.Contains(lower, p) {
					isPassing = true
					break
				}
			}
			if !isPassing {
				return gateResult{GateSpeak, "name invoked"}
			}
		}
	}

	// Rule 2: AI just spoke → follow-up might be for us, let LLM decide
	lastAI := -1
	for i := len(transcript) - 1; i >= 0; i-- {
		if strings.EqualFold(transcript[i].Speaker, botName) {
			lastAI = len(transcript) - 1 - i
			break
		}
	}
	if lastAI == 0 {
		return gateResult{"maybe", "follow-up to AI"}
	}

	// Rule 3 removed — let the LLM gate handle human conversation dynamics.

	// Rule 4: Open question → let LLM decide
	if strings.HasSuffix(strings.TrimSpace(text), "?") {
		return gateResult{"maybe", "question asked"}
	}

	// Rule 5: One turn after AI spoke → possible follow-up
	if lastAI == 1 {
		return gateResult{"maybe", "possible follow-up"}
	}

	return gateResult{"maybe", "unclear"}
}

var gatePromptTemplate = `You are the social reasoning gate for "%s", an AI in a multi-person meeting. %s has tools: web search, code search, shell commands, file reading.

Given the recent conversation and %s's current state, answer ONLY one of: "speak", "hand", or "silent".

"speak" — %s's name appears in the utterance, OR someone greets the room and %s hasn't spoken yet.
"hand" — %s could look something up that would add real value. Examples:
  - Someone mentions a specific tool, library, benchmark, or dataset
  - Someone asks about status of an issue, PR, or deployment
  - Someone is unsure about a technical fact
  - Someone asks "has anyone tried X" or "is there a Y for this"
  Do NOT hand for opinions, architecture decisions, planning, or small talk.
"silent" — DEFAULT. Human-to-human discussion, status updates, opinions, agreements, planning.

Answer with ONLY "speak", "hand", or "silent".`

// llmGate calls a fast LLM to decide speak/hand/silent for ambiguous cases.
func llmGate(ctx context.Context, transcript []TranscriptEntry, botName string, hasEverSpoken bool, meetingSummary string) (GateDecision, error) {
	apiKey := os.Getenv("GROQ_API_KEY")
	if apiKey == "" {
		return GateSilent, fmt.Errorf("GROQ_API_KEY not set")
	}

	// Build recent context
	start := len(transcript) - 6
	if start < 0 {
		start = 0
	}
	var recentLines []string
	for _, e := range transcript[start:] {
		recentLines = append(recentLines, fmt.Sprintf("[%s]: %s", e.Speaker, e.Text))
	}
	recent := strings.Join(recentLines, "\n")

	stateStr := fmt.Sprintf("[%s state: has NOT spoken yet — just joined, should greet if greeted]", botName)
	if hasEverSpoken {
		stateStr = fmt.Sprintf("[%s state: has already spoken in this meeting]", botName)
	}

	contextStr := ""
	if meetingSummary != "" {
		contextStr = fmt.Sprintf("[Meeting context: %s]\n\n", meetingSummary)
	}

	sysPrompt := fmt.Sprintf(gatePromptTemplate, botName, botName, botName, botName, botName, botName)
	userPrompt := fmt.Sprintf("%s\n\n%sRecent conversation:\n%s\n\nWhat should %s do?", stateStr, contextStr, recent, botName)

	reqBody, _ := json.Marshal(map[string]any{
		"model": "llama-3.1-8b-instant",
		"messages": []map[string]string{
			{"role": "system", "content": sysPrompt},
			{"role": "user", "content": userPrompt},
		},
		"temperature": 0.1,
		"max_tokens":  5,
	})

	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(ctx, "POST", "https://api.groq.com/openai/v1/chat/completions", bytes.NewReader(reqBody))
	if err != nil {
		return GateSilent, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := llmHTTPClient.Do(httpReq)
	if err != nil {
		return GateSilent, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return GateSilent, fmt.Errorf("gate LLM %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return GateSilent, err
	}

	answer := strings.TrimSpace(strings.ToLower(result.Choices[0].Message.Content))
	// LLM gate can return speak only if vox hasn't spoken yet (first greeting).
	// After vox has spoken, speak is only from rule gate (name invocation).
	if strings.HasPrefix(answer, "speak") {
		if !hasEverSpoken {
			return GateSpeak, nil
		}
		return GateSilent, nil
	}
	if strings.HasPrefix(answer, "hand") {
		return GateRaiseHand, nil
	}
	return GateSilent, nil
}

// GateContext carries session state needed by the gate.
type GateContext struct {
	HasEverSpoken  bool
	// SpokeRecently is true when THIS bot spoke within the follow-up window. In a
	// multi-party call it lets the bot you're already talking to take a direct
	// follow-up without being re-named — while bots that haven't just spoken stay
	// silent, so other AIs don't chime in.
	SpokeRecently  bool
	LastHandAt     time.Time
	MeetingSummary string
	// OtherParticipants is the number of humans in the call besides the bot.
	// When it's ≤1 the meeting is effectively a 1:1 with the bot, so the gate
	// drops its multi-party reticence and answers directed utterances directly.
	OtherParticipants int
}

// runGate runs the two-stage gate: fast rules, then LLM fallback for ambiguous cases.
func runGate(ctx context.Context, speaker, text string, transcript []TranscriptEntry, botName string, aiNames []string, gc ...GateContext) gateResult {
	var gctx GateContext
	if len(gc) > 0 {
		gctx = gc[0]
	}

	rule := ruleGate(speaker, text, transcript, botName, aiNames)

	if rule.Decision != "maybe" {
		log.Printf("[gate] %s (%s) — rule: %s", rule.Decision, rule.Reason, text)
		return rule
	}

	// 1:1 conversation mode: when the bot is alone with one person, there's no
	// one to talk over — treat any non-filler utterance that reached here as
	// directed at the bot and answer it. This is the "talk to your Claude" path,
	// where the bot may be proactive.
	if gctx.OtherParticipants <= 1 {
		log.Printf("[gate] speak (1:1 %s) — %s", rule.Reason, text)
		return gateResult{GateSpeak, rule.Reason + " → 1:1"}
	}

	// Multi-party: default to name-only (the definitive name-match above already
	// returned). We do NOT honor generic follow-up heuristics for every bot — that
	// made every recently-active bot pile onto the same turn.
	//
	// The one exception: a bot that JUST spoke may take a direct follow-up to
	// itself — a question or continuation shortly after its own turn — without
	// being re-named. This is the "you're mid-conversation with David, ask the
	// next thing" case. Only the bot that just spoke reaches this (SpokeRecently),
	// so the OTHER AI never chimes in, and the model's wait_for_user backstop
	// rejects anything not actually aimed at it.
	if gctx.SpokeRecently && (strings.Contains(rule.Reason, "follow-up") || strings.Contains(rule.Reason, "question")) {
		log.Printf("[gate] speak (multi-party self-follow-up: %s) — %s", rule.Reason, text)
		return gateResult{GateSpeak, rule.Reason + " → multi-party self-follow-up"}
	}
	log.Printf("[gate] silent (multi-party, not addressed) — %s", text)
	return gateResult{GateSilent, rule.Reason + " → multi-party not addressed"}
}
