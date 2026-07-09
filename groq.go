package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

// ipv4Dialer forces tcp4 — inside Docker Desktop IPv6 has no route, so Go's
// happy-eyeballs would dial the AAAA record first and stall ~6s before falling
// back to IPv4. Pinning to tcp4 kills that latency for every LLM call.
var ipv4Dialer = &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}

// llmHTTPClient is a shared persistent client for low-latency LLM calls.
var llmHTTPClient = &http.Client{
	Timeout: 60 * time.Second,
	Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return ipv4Dialer.DialContext(ctx, "tcp4", addr)
		},
		ForceAttemptHTTP2:   true,
		MaxIdleConns:        20,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
	},
}

func groqModel() string {
	if m := os.Getenv("GROQ_MODEL"); m != "" {
		return m
	}
	return "llama-3.3-70b-versatile"
}

// groqStream calls the Groq API with streaming (OpenAI-compatible).
func groqStream(ctx context.Context, messages []LLMMessage) (<-chan string, error) {
	return groqStreamModel(ctx, messages, groqModel())
}

// groqOnce runs a non-streaming completion by draining the stream — used for
// short, fast calls like the intent router where we just need the whole reply.
func groqOnce(ctx context.Context, messages []LLMMessage, model string) (string, error) {
	ch, err := groqStreamModel(ctx, messages, model)
	if err != nil {
		return "", err
	}
	var sb strings.Builder
	for d := range ch {
		sb.WriteString(d)
	}
	return strings.TrimSpace(sb.String()), nil
}

// groqStreamModel is groqStream with an explicit model (e.g. a fast small model
// for the low-latency voice layer).
func groqStreamModel(ctx context.Context, messages []LLMMessage, model string) (<-chan string, error) {
	apiKey := os.Getenv("GROQ_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("GROQ_API_KEY not set")
	}

	reqBody, _ := json.Marshal(map[string]any{
		"model":       model,
		"messages":    messages,
		"stream":      true,
		"temperature": 0,
	})

	httpReq, err := http.NewRequestWithContext(ctx, "POST", "https://api.groq.com/openai/v1/chat/completions", bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := llmHTTPClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("groq stream: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("groq %d: %s", resp.StatusCode, string(body))
	}

	ch := make(chan string, 64)
	go func() {
		defer close(ch)
		defer resp.Body.Close()
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			if ctx.Err() != nil {
				return
			}
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			data := strings.TrimPrefix(line, "data: ")
			if data == "[DONE]" {
				return
			}
			var event struct {
				Choices []struct {
					Delta struct {
						Content string `json:"content"`
					} `json:"delta"`
				} `json:"choices"`
			}
			if err := json.Unmarshal([]byte(data), &event); err != nil {
				continue
			}
			if len(event.Choices) > 0 && event.Choices[0].Delta.Content != "" {
				select {
				case ch <- event.Choices[0].Delta.Content:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return ch, nil
}
