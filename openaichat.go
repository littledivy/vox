package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// chatModel is the text model used for Meet text-chat replies. OpenAI is used
// (its key is guaranteed in realtime mode); override with VOX_CHAT_MODEL.
func chatModel() string {
	if m := os.Getenv("VOX_CHAT_MODEL"); m != "" {
		return m
	}
	return "gpt-4o-mini"
}

// openaiChatOnce runs a simple non-streaming chat completion for Meet text-chat
// replies. system grounds the persona; msgs is the recent conversation. Returns
// the assistant's text.
func openaiChatOnce(ctx context.Context, system string, msgs []LLMMessage) (string, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return "", fmt.Errorf("OPENAI_API_KEY not set")
	}
	all := append([]LLMMessage{{Role: "system", Content: system}}, msgs...)
	reqBody, _ := json.Marshal(map[string]any{
		"model":       chatModel(),
		"messages":    all,
		"temperature": 0.6,
		"max_tokens":  220,
	})

	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(ctx, "POST", "https://api.openai.com/v1/chat/completions", bytes.NewReader(reqBody))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := llmHTTPClient.Do(httpReq)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("chat LLM %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	if len(result.Choices) == 0 {
		return "", fmt.Errorf("chat LLM: no choices")
	}
	return result.Choices[0].Message.Content, nil
}
