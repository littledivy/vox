package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"os/exec"
	"sync"
)

// capturePulseToDeepgram reads the vox_out sink monitor (the meeting audio Chrome
// plays) as 16kHz mono PCM via `parec` and streams it to Deepgram. This is the
// reliable, echo-free STT path: it's a null-sink monitor, so it always has the
// audio and never touches real hardware.
func capturePulseToDeepgram(ctx context.Context, apiKey string, keyterms []string, onTranscript func(string), sendGate func() bool) error {
	cmd := exec.CommandContext(ctx, "parec",
		"-d", "vox_out.monitor",
		"--format=s16le", "--rate=16000", "--channels=1", "--raw",
		"--latency-msec=20",
	)
	cmd.Env = pulseEnv()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("parec stdout: %w", err)
	}
	cmd.Stderr = &prefixWriter{prefix: "[parec] "}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("parec start: %w", err)
	}
	log.Printf("[pulse] capturing vox_out.monitor -> Deepgram")
	return pcmToDeepgram(ctx, stdout, func() { cmd.Process.Kill() }, apiKey, keyterms, onTranscript, sendGate)
}

// PulseSpeaker feeds TTS PCM into the vox_tts sink (which is remapped to the
// bot's microphone), so Orpheus audio goes out as the bot's mic into the
// meeting. Orpheus emits 24kHz mono s16le.
type PulseSpeaker struct {
	mu    sync.Mutex
	ctx   context.Context
	cmd   *exec.Cmd
	stdin io.WriteCloser
}

func spawnPacat(ctx context.Context) (*exec.Cmd, io.WriteCloser, error) {
	cmd := exec.CommandContext(ctx, "pacat",
		"-d", "vox_tts",
		"--format=s16le", "--rate=24000", "--channels=1", "--raw",
		"--latency-msec=40",
	)
	cmd.Env = pulseEnv()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, err
	}
	cmd.Stderr = &prefixWriter{prefix: "[pacat] "}
	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}
	return cmd, stdin, nil
}

func NewPulseSpeaker(ctx context.Context) (*PulseSpeaker, error) {
	cmd, stdin, err := spawnPacat(ctx)
	if err != nil {
		return nil, err
	}
	log.Printf("[pulse] TTS speaker ready (-> vox_tts -> vox_mic)")
	return &PulseSpeaker{ctx: ctx, cmd: cmd, stdin: stdin}, nil
}

// Flush drops any audio still buffered in pacat by restarting it — used for
// barge-in so the bot goes quiet the instant someone starts talking.
func (s *PulseSpeaker) Flush() {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stdin != nil {
		s.stdin.Close()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		s.cmd.Process.Kill()
	}
	cmd, stdin, err := spawnPacat(s.ctx)
	if err != nil {
		log.Printf("[pulse] flush respawn: %v", err)
		return
	}
	s.cmd, s.stdin = cmd, stdin
}

// WriteBase64 decodes a base64 PCM chunk (from Orpheus) and writes it to the mic.
func (s *PulseSpeaker) WriteBase64(b64 string) {
	pcm, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(pcm) == 0 {
		return
	}
	s.mu.Lock()
	s.stdin.Write(pcm)
	s.mu.Unlock()
}

func (s *PulseSpeaker) Close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.stdin != nil {
		s.stdin.Close()
	}
	s.mu.Unlock()
	if s.cmd != nil && s.cmd.Process != nil {
		s.cmd.Process.Kill()
	}
}
