package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// OrpheusClient streams TTS via Together AI's Orpheus WebSocket API.
type OrpheusClient struct {
	apiKey string
	model  string
	voice  string

	conn    *websocket.Conn
	mu      sync.Mutex
	textBuf strings.Builder
	closed  bool
	done    chan struct{}

	OnAudio func(audioBase64 string)
}

func newOrpheusConn(apiKey, model, voice string) (*websocket.Conn, error) {
	url := "wss://api.together.ai/v1/audio/speech/websocket" +
		"?model=" + model +
		"&voice=" + voice +
		"&response_format=pcm" +
		"&sample_rate=24000" +
		"&segment=immediate"

	header := http.Header{}
	header.Set("Authorization", "Bearer "+apiKey)

	conn, _, err := ipv4WSDialer.Dial(url, header)
	if err != nil {
		return nil, fmt.Errorf("[orpheus] ws connect: %w", err)
	}

	// Wait for session.created
	_, msg, err := conn.ReadMessage()
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("[orpheus] session.created: %w", err)
	}
	var m struct{ Type string `json:"type"` }
	json.Unmarshal(msg, &m)
	if m.Type != "session.created" {
		log.Printf("[orpheus] unexpected first message: %s", string(msg))
	}
	return conn, nil
}

// OrpheusPool keeps a pre-warmed WebSocket connection ready.
type OrpheusPool struct {
	apiKey string
	model  string
	voice  string

	mu   sync.Mutex
	warm *websocket.Conn
	at   time.Time
}

var orpheusPool *OrpheusPool

func initOrpheusPool() {
	apiKey := os.Getenv("TOGETHER_API_KEY")
	if apiKey == "" {
		return
	}
	voice := "tara" // default
	orpheusPool = &OrpheusPool{
		apiKey: apiKey,
		model:  "canopylabs/orpheus-3b-0.1-ft",
		voice:  voice,
	}
	go orpheusPool.warmUp()
}

func (p *OrpheusPool) warmUp() {
	conn, err := newOrpheusConn(p.apiKey, p.model, p.voice)
	if err != nil {
		log.Printf("[orpheus-pool] warm-up failed: %v", err)
		return
	}
	p.mu.Lock()
	p.warm = conn
	p.at = time.Now()
	p.mu.Unlock()
	log.Printf("[orpheus-pool] warm connection ready")
}

// Take returns a pre-warmed connection or creates a fresh one.
// Stale connections (>30s) are discarded.
func (p *OrpheusPool) Take() (*websocket.Conn, error) {
	p.mu.Lock()
	conn := p.warm
	age := time.Since(p.at)
	p.warm = nil
	p.mu.Unlock()

	// Start warming the next connection in background
	go p.warmUp()

	if conn != nil && age < 30*time.Second {
		log.Printf("[orpheus-pool] using warm connection (%dms old)", age.Milliseconds())
		return conn, nil
	}
	if conn != nil {
		conn.Close() // stale
	}
	log.Printf("[orpheus-pool] creating fresh connection")
	return newOrpheusConn(p.apiKey, p.model, p.voice)
}

func NewOrpheusClient(voice string) (*OrpheusClient, error) {
	apiKey := os.Getenv("TOGETHER_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("TOGETHER_API_KEY not set")
	}
	if voice == "" {
		voice = "tara"
	}
	return &OrpheusClient{
		apiKey: apiKey,
		model:  "canopylabs/orpheus-3b-0.1-ft",
		voice:  voice,
		done:   make(chan struct{}),
	}, nil
}

func (o *OrpheusClient) Connect(ctx context.Context) error {
	var conn *websocket.Conn
	var err error

	// Try pool first
	if orpheusPool != nil {
		conn, err = orpheusPool.Take()
	} else {
		conn, err = newOrpheusConn(o.apiKey, o.model, o.voice)
	}
	if err != nil {
		return err
	}
	o.conn = conn

	go o.readLoop()
	log.Printf("[orpheus] connected (voice: %s)", o.voice)
	return nil
}

func (o *OrpheusClient) readLoop() {
	defer func() {
		select {
		case <-o.done:
		default:
			close(o.done)
		}
	}()

	for {
		_, msg, err := o.conn.ReadMessage()
		if err != nil {
			if !o.closed {
				log.Printf("[orpheus] read error: %v", err)
			}
			return
		}

		var m struct {
			Type  string `json:"type"`
			Delta string `json:"delta"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error,omitempty"`
		}
		if json.Unmarshal(msg, &m) != nil {
			continue
		}

		switch m.Type {
		case "conversation.item.audio_output.delta":
			if m.Delta != "" && o.OnAudio != nil {
				o.OnAudio(m.Delta)
			}
		case "conversation.item.audio_output.done":
			return
		case "conversation.item.tts.failed":
			errMsg := "unknown"
			if m.Error != nil {
				errMsg = m.Error.Message
			}
			log.Printf("[orpheus] tts failed: %s", errMsg)
			return
		}
	}
}

// SendText streams text to Together AI immediately — TTS starts generating
// as sentences complete, so audio arrives before the LLM finishes.
func (o *OrpheusClient) SendText(text string) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.conn == nil || o.closed {
		return nil
	}
	o.textBuf.WriteString(text)

	// Send complete sentences immediately for lowest TTFA
	buf := o.textBuf.String()
	for {
		idx := strings.IndexAny(buf, ".!?,;:")
		if idx == -1 || idx+1 >= len(buf) {
			break
		}
		end := idx + 1
		if end < len(buf) && buf[end] == ' ' {
			end++
		}
		sentence := buf[:end]
		buf = buf[end:]

		o.conn.WriteJSON(map[string]string{
			"type": "input_text_buffer.append",
			"text": sentence,
		})
	}
	o.textBuf.Reset()
	o.textBuf.WriteString(buf)
	return nil
}

// Flush sends any remaining buffered text and commits.
func (o *OrpheusClient) Flush() error {
	o.mu.Lock()
	remaining := strings.TrimSpace(o.textBuf.String())
	o.textBuf.Reset()
	o.mu.Unlock()

	if o.conn == nil {
		select {
		case <-o.done:
		default:
			close(o.done)
		}
		return nil
	}

	if remaining != "" {
		o.conn.WriteJSON(map[string]string{
			"type": "input_text_buffer.append",
			"text": remaining,
		})
	}

	o.conn.WriteJSON(map[string]string{
		"type": "input_text_buffer.commit",
	})

	return nil
}

func (o *OrpheusClient) Wait() {
	<-o.done
}

func (o *OrpheusClient) Close() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.closed = true
	if o.conn != nil {
		o.conn.Close()
	}
}

// Wrap OrpheusClient to implement TTSProvider.
type orpheusProvider struct{ *OrpheusClient }

func (p *orpheusProvider) SetOnAudio(fn func(string)) { p.OnAudio = fn }
