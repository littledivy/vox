package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// captureDeviceToDeepgram captures audio from a macOS input device (via ffmpeg
// avfoundation), streams it to Deepgram Flux v2, and calls onTranscript for each
// completed turn. This is the reliable audio-in path: it reads the OS audio
// device directly (e.g. a BlackHole loopback of Chrome's output), bypassing the
// browser's flaky WebRTC→WebAudio capture entirely.
//
// deviceName is the avfoundation audio device name (e.g. "BlackHole 2ch" or
// "MacBook Pro Microphone"). Deepgram auth uses the Authorization header, which
// Go can send directly — no local proxy needed.
// sendGate, if non-nil, gates audio frames: while it returns false (e.g. the
// bot is speaking) frames are dropped so the bot never transcribes its own TTS
// looping back through the captured device (half-duplex).
// captureDeviceToDeepgram captures a named avfoundation device via ffmpeg.
func captureDeviceToDeepgram(ctx context.Context, deviceName, apiKey string, keyterms []string, onTranscript func(string), sendGate func() bool) error {
	ff := exec.CommandContext(ctx, "ffmpeg",
		"-f", "avfoundation",
		"-i", ":"+deviceName,
		"-ac", "1",
		"-ar", "16000",
		"-f", "s16le",
		"-loglevel", "error",
		"-",
	)
	stdout, err := ff.StdoutPipe()
	if err != nil {
		return fmt.Errorf("ffmpeg stdout: %w", err)
	}
	ff.Stderr = &prefixWriter{prefix: "[ffmpeg] "}
	if err := ff.Start(); err != nil {
		return fmt.Errorf("ffmpeg start: %w", err)
	}
	log.Printf("[capture] ffmpeg capturing %q -> 16kHz mono", deviceName)
	return pcmToDeepgram(ctx, stdout, func() { ff.Process.Kill() }, apiKey, keyterms, onTranscript, sendGate)
}

// captureSCKToDeepgram captures system audio via the ScreenCaptureKit helper
// (voxaudio) — non-invasive, no audio-device changes. helperPath is the compiled
// Swift binary that writes 16kHz mono s16le to stdout.
func captureSCKToDeepgram(ctx context.Context, helperPath, apiKey string, keyterms []string, onTranscript func(string), sendGate func() bool) error {
	h := exec.CommandContext(ctx, helperPath)
	stdout, err := h.StdoutPipe()
	if err != nil {
		return fmt.Errorf("sck stdout: %w", err)
	}
	h.Stderr = &prefixWriter{prefix: "[voxaudio] "}
	if err := h.Start(); err != nil {
		return fmt.Errorf("sck start: %w", err)
	}
	log.Printf("[capture] ScreenCaptureKit system audio via %s", helperPath)
	return pcmToDeepgram(ctx, stdout, func() { h.Process.Kill() }, apiKey, keyterms, onTranscript, sendGate)
}

// pcmToDeepgram reads 16kHz mono s16le PCM from r and streams it to Deepgram
// Flux v2, delivering completed turns via onTranscript. It reconnects on socket
// drops and drops frames while sendGate() is false (half-duplex). onStop is
// called when the reader ends (to kill the producer process).
func pcmToDeepgram(ctx context.Context, r io.Reader, onStop func(), apiKey string, keyterms []string, onTranscript func(string), sendGate func() bool) error {
	// Continuously read PCM into a channel so a Deepgram reconnect never blocks
	// the capture. Frames are ~50ms (1600 bytes @ 16kHz mono s16le).
	pcmCh := make(chan []byte, 64)
	go func() {
		defer onStop()
		defer close(pcmCh)
		br := bufio.NewReader(r)
		for {
			buf := make([]byte, 1600)
			n, err := io.ReadFull(br, buf)
			if n > 0 {
				select {
				case pcmCh <- buf[:n]:
				case <-ctx.Done():
					return
				default: // drop if consumer is mid-reconnect
				}
			}
			if err != nil {
				if err != io.EOF && err != io.ErrUnexpectedEOF && ctx.Err() == nil {
					log.Printf("[capture] ffmpeg read: %v", err)
				}
				return
			}
		}
	}()

	// Maintain the Deepgram connection, reconnecting on close (Flux v2 drops the
	// socket after a turn / on silence), until ctx is cancelled.
	go func() {
		first := true
		for ctx.Err() == nil {
			if err := runDeepgramSession(ctx, apiKey, keyterms, pcmCh, onTranscript, first, sendGate); err != nil {
				if first {
					log.Printf("[capture] deepgram: %v", err)
				}
			}
			first = false
			if ctx.Err() != nil {
				return
			}
			time.Sleep(300 * time.Millisecond)
		}
	}()

	return nil
}

// runDeepgramSession dials Deepgram, streams pcmCh to it, and delivers turns via
// onTranscript until the socket closes or ctx is cancelled.
func runDeepgramSession(ctx context.Context, apiKey string, keyterms []string, pcmCh <-chan []byte, onTranscript func(string), logConnect bool, sendGate func() bool) error {
	dgURL := "wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000&eager_eot_threshold=0.5"
	for _, kt := range keyterms {
		dgURL += "&keyterm=" + url.QueryEscape(kt)
	}
	header := http.Header{}
	header.Set("Authorization", "Token "+strings.TrimSpace(apiKey))

	conn, resp, err := ipv4WSDialer.Dial(dgURL, header)
	if err != nil {
		if resp != nil {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			return fmt.Errorf("dial %s: dg-error=%q body=%q", resp.Status, resp.Header.Get("dg-error"), strings.TrimSpace(string(body)))
		}
		return fmt.Errorf("dial: %w", err)
	}
	if logConnect {
		log.Printf("[capture] connected to Deepgram Flux v2")
	}
	defer conn.Close()

	sctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Reader: Deepgram → onTranscript.
	go func() {
		defer cancel()
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var m struct {
				Type       string `json:"type"`
				Event      string `json:"event"`
				Transcript string `json:"transcript"`
			}
			if json.Unmarshal(msg, &m) != nil {
				continue
			}
			if m.Type == "TurnInfo" && m.Event == "EndOfTurn" {
				if text := strings.TrimSpace(m.Transcript); text != "" {
					onTranscript(text)
				}
			}
		}
	}()

	// Writer: pcmCh → Deepgram.
	for {
		select {
		case <-sctx.Done():
			return nil
		case frame, ok := <-pcmCh:
			if !ok {
				return nil
			}
			if sendGate != nil && !sendGate() {
				continue // half-duplex: bot is speaking, drop the frame
			}
			if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
				return nil
			}
		}
	}
}

// prefixWriter tags ffmpeg stderr lines so they're identifiable in logs.
type prefixWriter struct{ prefix string }

func (w *prefixWriter) Write(p []byte) (int, error) {
	for _, line := range strings.Split(strings.TrimRight(string(p), "\n"), "\n") {
		if strings.TrimSpace(line) != "" {
			log.Printf("%s%s", w.prefix, line)
		}
	}
	return len(p), nil
}
