package main

import "time"

// TranscriptEntry is a single line in a meeting transcript.
type TranscriptEntry struct {
	Time    time.Time `json:"time"`
	Speaker string    `json:"speaker"`
	Text    string    `json:"text"`
}

// LLMMessage is the common message format for the fast voice LLM (Groq).
type LLMMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
