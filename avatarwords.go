package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode"
)

// avatarStopwords are common words we don't want floating in the J-space cloud —
// they're filler, not concepts. (Words shorter than 4 chars are dropped anyway.)
var avatarStopwords = map[string]bool{
	"that": true, "this": true, "with": true, "have": true, "what": true,
	"your": true, "just": true, "like": true, "about": true, "there": true,
	"they": true, "them": true, "then": true, "than": true, "from": true,
	"here": true, "were": true, "been": true, "being": true, "will": true,
	"would": true, "could": true, "should": true, "into": true, "over": true,
	"some": true, "much": true, "very": true, "yeah": true, "okay": true,
	"gonna": true, "want": true, "know": true, "think": true, "really": true,
	"thing": true, "things": true, "going": true, "doing": true, "make": true,
	"sure": true, "well": true, "good": true, "hello": true, "right": true,
	"still": true, "also": true, "even": true, "back": true, "because": true,
	"which": true, "when": true, "where": true, "does": true, "your's": true,
}

// keywords extracts salient content words from text (length ≥4, not stopwords),
// in order, deduped — a crude proxy for what the agent is attending to.
func keywords(text string) []string {
	fields := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r)
	})
	seen := map[string]bool{}
	var out []string
	for _, w := range fields {
		if len(w) < 4 || avatarStopwords[w] || seen[w] {
			continue
		}
		seen[w] = true
		out = append(out, w)
	}
	return out
}

// pushWords folds the concepts from text into the avatar's word cloud (newest at
// the front = most salient) and pushes the set to the canvas.
func (e *Engine) pushWords(text string) {
	kw := keywords(text)
	if len(kw) == 0 {
		return
	}
	e.mu.Lock()
	merged := append([]string{}, kw...)
	for _, w := range e.avatarWords {
		dup := false
		for _, n := range merged {
			if n == w {
				dup = true
				break
			}
		}
		if !dup {
			merged = append(merged, w)
		}
	}
	if len(merged) > 20 {
		merged = merged[:20]
	}
	e.avatarWords = merged
	e.thoughtDirty = true // ask the thought-stream loop to refine these
	words := append([]string{}, merged...)
	e.mu.Unlock()
	e.setAvatarWords(words)
}

// splitWords loosely tokenizes model output into lowercase concept words.
func splitWords(text string, minLen, cap int) []string {
	fields := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r)
	})
	seen := map[string]bool{}
	var out []string
	for _, w := range fields {
		if len(w) < minLen || seen[w] {
			continue
		}
		seen[w] = true
		out = append(out, w)
		if len(out) >= cap {
			break
		}
	}
	return out
}

// thoughtWords asks the model for the concepts it's internally attending to right
// now — a proxy "J-space" thought stream (we can't read real activations). Returns
// nil on error so the caller keeps the immediate keyword echo.
func (e *Engine) thoughtWords(tr []TranscriptEntry) []string {
	start := len(tr) - 10
	if start < 0 {
		start = 0
	}
	var lines []string
	for _, t := range tr[start:] {
		lines = append(lines, t.Speaker+": "+t.Text)
	}
	sys := fmt.Sprintf("You are %s, silently present in a meeting. Output ONLY 8 to 14 short lowercase words — the concepts you are internally attending to right now (topics, entities, ideas in the air, what you'd look up), like a raw stream of thought. No sentences, no punctuation, just words separated by spaces.", e.botName)
	out, err := openaiChatOnce(e.meet.Context(), sys, []LLMMessage{{Role: "user", Content: strings.Join(lines, "\n")}})
	if err != nil {
		return nil
	}
	return splitWords(out, 3, 16)
}

// thoughtLoop periodically refreshes the word cloud with the model's current
// thought stream (debounced to when new things have been said).
func (e *Engine) thoughtLoop() {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	bctx := e.meet.Context()
	for {
		select {
		case <-bctx.Done():
			return
		case <-ticker.C:
			e.mu.Lock()
			dirty := e.thoughtDirty
			trc := append([]TranscriptEntry(nil), e.transcript...)
			e.mu.Unlock()
			if !dirty || len(trc) == 0 {
				continue
			}
			words := e.thoughtWords(trc)
			e.mu.Lock()
			e.thoughtDirty = false
			if len(words) > 0 {
				e.avatarWords = words
			}
			e.mu.Unlock()
			if len(words) > 0 {
				e.setAvatarWords(words)
			}
		}
	}
}

// seedAvatarWords primes the cloud from the meeting context + staged topics so the
// avatar isn't empty before anyone speaks.
func (e *Engine) seedAvatarWords() {
	var seed []string
	seed = append(seed, keywords(e.meetingSummary)...)
	e.mu.Lock()
	for _, p := range e.predrafts {
		seed = append(seed, keywords(p.Topic)...)
	}
	e.mu.Unlock()
	if len(seed) == 0 {
		seed = []string{"listening"}
	}
	if len(seed) > 20 {
		seed = seed[:20]
	}
	e.mu.Lock()
	e.avatarWords = seed
	e.mu.Unlock()
	e.setAvatarWords(seed)
}

// setAvatarWords pushes the word list to the canvas renderer.
func (e *Engine) setAvatarWords(words []string) {
	b, err := json.Marshal(words)
	if err != nil {
		return
	}
	e.meet.eval(`window._kajuWords=`+string(b)+`;true`, nil)
}
