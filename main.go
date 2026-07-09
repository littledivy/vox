package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/joho/godotenv"
)

// setupFileLogging tees log output to a per-session file on disk (in addition to
// stderr) so meetings can be analyzed later. Returns the file path. The dir is
// $VOX_LOG_DIR, else ~/.vox/logs. One file per process launch (each bot is its
// own process, so bots get separate files).
func setupFileLogging() (string, error) {
	dir := os.Getenv("VOX_LOG_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(home, ".vox", "logs")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	name := fmt.Sprintf("vox-%s-%d.log", time.Now().Format("20060102-150405"), os.Getpid())
	path := filepath.Join(dir, name)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return "", err
	}
	log.SetOutput(io.MultiWriter(os.Stderr, f))
	return path, nil
}

func main() {
	// Load .env from the working dir / binary dir if present.
	godotenv.Load()

	// Protocol travels on stdout; all logs must go to stderr.
	log.SetOutput(os.Stderr)
	log.SetPrefix("")
	// Microsecond timestamps so overlapping-turn / gate-timing analysis is possible
	// from the logs after the fact.
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)

	// Tee every log line to a per-session file on disk so any meeting can be
	// post-mortem'd later (gate decisions, who-spoke-when, barge-ins). Live stderr
	// is preserved for the MCP host. Override the dir with VOX_LOG_DIR.
	if logPath, err := setupFileLogging(); err != nil {
		log.Printf("[vox] file logging disabled: %v", err)
	} else {
		log.Printf("[vox] logging to %s", logPath)
	}

	if os.Getenv("DEEPGRAM_API_KEY") == "" {
		log.Println("[vox] warning: DEEPGRAM_API_KEY not set — speech recognition will fail")
	}
	if os.Getenv("TOGETHER_API_KEY") == "" {
		log.Println("[vox] warning: TOGETHER_API_KEY not set — Orpheus TTS will fail")
	}
	if os.Getenv("GROQ_API_KEY") == "" {
		log.Println("[vox] warning: GROQ_API_KEY not set — gate + fast voice layer will fail")
	}

	// Tool smoke test (hidden): VOX_MODE=tooltest VOX_TOOL_QUERY=... VOX_TOOL_DOC=...
	if os.Getenv("VOX_MODE") == "tooltest" {
		ctx := context.Background()
		if p := os.Getenv("VOX_TOOL_DOC"); p != "" {
			r, e := readDocument(ctx, p)
			fmt.Printf("DOC(%d chars, err=%v): %.200s\n", len(r), e, r)
		}
		if q := os.Getenv("VOX_TOOL_QUERY"); q != "" {
			r, e := webSearch(ctx, q)
			fmt.Printf("SEARCH(err=%v): %s\n", e, r)
		}
		if n := os.Getenv("VOX_TOOL_NAME"); n != "" {
			fmt.Printf("TOOL[%s]: %s\n", n, dispatchVoiceTool(ctx, n, os.Getenv("VOX_TOOL_ARGS")))
		}
		return
	}

	// Test mode: capture VOX_AUDIO_INPUT → Deepgram and print transcripts.
	// e.g. VOX_TEST_CAPTURE=1 VOX_AUDIO_INPUT="BlackHole 2ch" ./vox
	if os.Getenv("VOX_TEST_CAPTURE") != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		onT := func(text string) { log.Printf("[test] TRANSCRIPT: %q", text) }
		key := os.Getenv("DEEPGRAM_API_KEY")
		kt := []string{"Claude", "Divy"}
		var err error
		if dev := deviceInput(); dev != "" {
			log.Printf("[test] device %q → Deepgram (30s)", dev)
			err = captureDeviceToDeepgram(ctx, dev, key, kt, onT, nil)
		} else if h := sckHelperPath(); h != "" {
			log.Printf("[test] ScreenCaptureKit %s → Deepgram (30s); play/speak audio now", h)
			err = captureSCKToDeepgram(ctx, h, key, kt, onT, nil)
		} else {
			log.Fatalf("[test] no capture source (set VOX_AUDIO_INPUT to an ffmpeg device)")
		}
		if err != nil {
			log.Fatalf("[test] capture failed: %v", err)
		}
		<-ctx.Done()
		return
	}

	// Pre-warm an Orpheus TTS connection for lower first-audio latency.
	initOrpheusPool()

	log.Printf("[vox] MCP server ready (stdio) — %s v%s", serverName, serverVersion)
	if err := NewMCPServer().Serve(); err != nil {
		fmt.Fprintf(os.Stderr, "vox: %v\n", err)
		os.Exit(1)
	}
}
