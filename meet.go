package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
)

//go:embed hook.js
var meetHookJS string

// MeetSession drives a Chromium that joins a single Google Meet call. In the
// Linux container (the supported path) it runs on Xvfb with audio wired to
// PulseAudio virtual devices — Chrome plays the meeting into a null sink we
// capture, and its mic is a virtual source fed by TTS. On macOS it falls back
// to headed Chrome with in-browser audio (flaky; for local dev only).
type MeetSession struct {
	MeetURL string

	ctx         context.Context
	cancel      context.CancelFunc
	allocCancel context.CancelFunc
	userDataDir string

	persistentProfile bool

	// Container (Linux) audio/display stack.
	container bool
	display   string
	xvfbCmd   *exec.Cmd
	chromeCmd *exec.Cmd
	pulse     *PulseCleanup

	mu     sync.Mutex
	joined bool

	// onEnd fires once when the meeting ends on its own (everyone else left
	// or Meet showed an end screen).
	onEnd func()
}

// launchChromium starts Chromium as a subprocess (headed, on Xvfb, wired to the
// PulseAudio virtual devices) and returns the CDP browser WebSocket URL scraped
// from its stderr. chromedp then connects via RemoteAllocator.
func launchChromium(chrome, userDataDir, display string) (string, *exec.Cmd, error) {
	args := []string{
		"--no-sandbox",
		"--disable-dev-shm-usage",
		"--ozone-platform=x11",
		// Software WebGL (no GPU in the container) so the dithering shader renders.
		"--enable-unsafe-swiftshader",
		"--use-gl=angle",
		"--use-angle=swiftshader",
		// Audio routes to vox_out/vox_mic via PULSE_SINK/PULSE_SOURCE env below.
		// (NOT --alsa-*-device: those crash Chrome when given a Pulse source name.)
		"--use-fake-ui-for-media-stream",
		"--autoplay-policy=no-user-gesture-required",
		"--disable-blink-features=AutomationControlled",
		"--window-size=1280,720",
		"--user-data-dir=" + userDataDir,
		"--remote-debugging-port=0",
		"about:blank",
	}
	// Send Chromium's output to a file (NOT a pipe/os.Stdout) and poll it for the
	// DevTools URL — exactly like `setsid chromium ... >file 2>&1 </dev/null &`,
	// which is the only invocation that keeps Chromium alive under vox (PID 1).
	logf, err := os.CreateTemp("", "vox-chrome-*.log")
	if err != nil {
		return "", nil, err
	}
	logPath := logf.Name()

	cmd := exec.Command(chrome, args...)
	cmd.Env = append(os.Environ(),
		"DISPLAY="+display,
		"HOME=/tmp/fakehome",
		"XDG_RUNTIME_DIR=/tmp/pulse-runtime",
		"PULSE_SINK=vox_out",
		"PULSE_SOURCE=vox_mic",
	)
	cmd.Stdin = nil // /dev/null
	cmd.Stdout = logf
	cmd.Stderr = logf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} // detached session
	if err := cmd.Start(); err != nil {
		logf.Close()
		return "", nil, err
	}
	logf.Close() // Chromium keeps its own dup'd fd

	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		data, _ := os.ReadFile(logPath)
		if i := strings.Index(string(data), "DevTools listening on "); i >= 0 {
			rest := string(data)[i+len("DevTools listening on "):]
			ws := strings.TrimSpace(strings.SplitN(rest, "\n", 2)[0])
			log.Printf("[meet] chromium up: %s", ws)
			os.Remove(logPath)
			return ws, cmd, nil
		}
		if cmd.ProcessState != nil { // exited
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	cmd.Process.Kill()
	tail, _ := os.ReadFile(logPath)
	os.Remove(logPath)
	for _, ln := range strings.Split(string(tail), "\n") {
		if ln != "" && !strings.Contains(ln, "dbus/bus.cc") && !strings.Contains(ln, "cpufreq") {
			log.Printf("[chromium] %s", ln)
		}
	}
	return "", nil, fmt.Errorf("chromium never reported a DevTools URL")
}

func chromePath() string {
	if p := os.Getenv("CHROME_PATH"); p != "" {
		return p
	}
	candidates := []string{
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/opt/homebrew/bin/chromium",
		"/opt/google/chrome/chrome",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return "chromium"
}

// silenceWAV writes a 1-second silent WAV that backs the fake mic device.
// Chrome replaces this track in-page with the TTS audio once we speak.
func silenceWAV() (string, error) {
	path := filepath.Join(os.TempDir(), "vox-silence.wav")
	if _, err := os.Stat(path); err == nil {
		return path, nil
	}
	pcm := make([]byte, 16000*2) // 1s @ 16kHz mono s16le, all zeros
	if err := os.WriteFile(path, encodeWAV(pcm, 16000, 1, 16), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// Join launches Chrome, injects the hook, navigates to the Meet URL and joins
// the call as displayName. It returns once the "Leave call" control is visible.
func (ms *MeetSession) Join(displayName string) error {
	userDataDir := os.Getenv("VOX_CHROME_PROFILE")
	ms.persistentProfile = userDataDir != ""
	if !ms.persistentProfile {
		userDataDir, _ = os.MkdirTemp("", "vox-chrome-*")
	} else {
		os.MkdirAll(userDataDir, 0o755)
	}
	ms.userDataDir = userDataDir
	chrome := chromePath()

	// Container mode (Linux + PulseAudio available): run Chromium on Xvfb with
	// its audio wired to the virtual PulseAudio devices — reliable, echo-free.
	ms.container = goruntime.GOOS == "linux"

	var opts []chromedp.ExecAllocatorOption
	if ms.container {
		display := os.Getenv("DISPLAY")
		if display != "" {
			// docker-entrypoint.sh already provisioned Xvfb + PulseAudio.
			ms.display = display
		} else {
			// Self-managed fallback (e.g. running the binary directly on Linux).
			display = FindFreeDisplay()
			xvfb, err := StartXvfb(display)
			if err != nil {
				return fmt.Errorf("xvfb: %w", err)
			}
			ms.xvfbCmd = xvfb
			if err := waitForX(display, 10*time.Second); err != nil {
				StopXvfb(xvfb)
				return fmt.Errorf("xvfb ready: %w", err)
			}
			ms.display = display
			startDBus()
			pulse, err := SetupPulse()
			if err != nil {
				StopXvfb(ms.xvfbCmd)
				return fmt.Errorf("pulse: %w", err)
			}
			ms.pulse = pulse
		}

		log.Printf("[meet] chromium container: display=%s chrome=%s", ms.display, chrome)
		// Container mode launches Chromium manually (below) and connects chromedp
		// over CDP — chromedp's own launcher is unreliable in this environment.
		_ = display
	} else {
		// macOS fallback: headed Chrome, in-browser audio (flaky — container is
		// the supported path).
		silence, _ := silenceWAV()
		headless := os.Getenv("VOX_HEADLESS") == "1"
		log.Printf("[meet] chrome=%s headless=%v (macOS fallback)", chrome, headless)
		opts = []chromedp.ExecAllocatorOption{
			chromedp.ExecPath(chrome),
			chromedp.NoFirstRun,
			chromedp.NoDefaultBrowserCheck,
			chromedp.UserDataDir(userDataDir),
			chromedp.Flag("headless", headless),
			chromedp.Flag("app", ms.MeetURL),
			chromedp.Flag("disable-blink-features", "AutomationControlled"),
			chromedp.Flag("disable-dev-shm-usage", true),
			chromedp.Flag("disable-features", "TranslateUI,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights"),
			chromedp.Flag("allow-running-insecure-content", true),
			chromedp.Flag("use-fake-ui-for-media-stream", true),
			chromedp.Flag("use-fake-device-for-media-stream", true),
			chromedp.Flag("use-file-for-fake-audio-capture", silence),
			chromedp.Flag("autoplay-policy", "no-user-gesture-required"),
			// Mute the bot's own speakers so it never plays remote participants
			// back out (the "I can hear myself" echo). Capture reads raw track
			// frames via MediaStreamTrackProcessor, so muted output is fine.
			chromedp.Flag("mute-audio", true),
			chromedp.Flag("enable-features", "AutoGrantCameraMicAccess"),
			chromedp.WindowSize(1280, 900),
		}
	}
	var allocCtx context.Context
	var allocCancel context.CancelFunc
	if ms.container {
		wsURL, cmd, err := launchChromium(chrome, userDataDir, ms.display)
		if err != nil {
			ms.cleanup()
			return fmt.Errorf("launch chromium: %w", err)
		}
		ms.chromeCmd = cmd
		allocCtx, allocCancel = chromedp.NewRemoteAllocator(context.Background(), wsURL)
	} else {
		opts = append(opts, chromedp.WSURLReadTimeout(60*time.Second))
		allocCtx, allocCancel = chromedp.NewExecAllocator(context.Background(), opts...)
	}
	ms.allocCancel = allocCancel

	ctx, cancel := chromedp.NewContext(allocCtx, chromedp.WithLogf(log.Printf))

	maxDur := 4 * time.Hour
	if v := os.Getenv("MEET_MAX_DURATION"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			maxDur = d
		}
	}
	ms.ctx, ms.cancel = context.WithTimeout(ctx, maxDur)
	_ = cancel // superseded by the timeout context's cancel

	// Surface browser-side [kaju] logs to stderr for debugging.
	chromedp.ListenTarget(ms.ctx, func(ev interface{}) {
		if e, ok := ev.(*runtime.EventConsoleAPICalled); ok {
			var parts []string
			for _, arg := range e.Args {
				parts = append(parts, string(arg.Value))
			}
			msg := strings.Join(parts, " ")
			if strings.Contains(msg, "[kaju]") {
				log.Printf("[browser] %s", msg)
			}
		}
	})

	if err := chromedp.Run(ms.ctx, chromedp.ActionFunc(func(ctx context.Context) error {
		if err := runtime.Enable().Do(ctx); err != nil {
			return err
		}
		_, err := page.AddScriptToEvaluateOnNewDocument(meetHookJS).Do(ctx)
		return err
	})); err != nil {
		ms.cleanup()
		return fmt.Errorf("add hook script: %w", err)
	}

	if err := chromedp.Run(ms.ctx,
		chromedp.Navigate(ms.MeetURL),
		chromedp.Sleep(5*time.Second),
	); err != nil {
		ms.cleanup()
		return fmt.Errorf("navigate: %w", err)
	}

	if err := ms.joinMeeting(displayName); err != nil {
		ms.cleanup()
		return fmt.Errorf("join meeting: %w", err)
	}
	if err := ms.waitUntilJoined(2 * time.Minute); err != nil {
		ms.cleanup()
		return fmt.Errorf("wait joined: %w", err)
	}

	ms.mu.Lock()
	ms.joined = true
	ms.mu.Unlock()

	// Dismiss any leftover permission dialogs.
	chromedp.Run(ms.ctx, chromedp.Evaluate(`
		document.querySelectorAll('[aria-label="Dismiss"]').forEach(b => b.click());
		document.querySelectorAll('button').forEach(b => { if(b.textContent.includes('Got it')) b.click(); });
		true
	`, nil))

	// Container mode: the bot's mic is the vox_mic virtual device (TTS). Keep it
	// ON so spoken audio reaches the meeting — retry for a while since Meet may
	// join muted, or the mic control isn't rendered until admitted from a lobby.
	if ms.container {
		go func() {
			for i := 0; i < 20; i++ {
				var muted bool
				ms.eval(`!!document.querySelector('[aria-label^="Turn on microphone" i]')`, &muted)
				if muted {
					ms.SetMic(true)
				}
				time.Sleep(2 * time.Second)
			}
		}()
	}

	// Inject the dithering shader as the bot's video track.
	chromedp.Run(ms.ctx, chromedp.Evaluate(`window._kajuStartBlobVideo && window._kajuStartBlobVideo(); true`, nil))

	// Turn the camera ON so Meet publishes a video track — the hook swaps in the
	// shader canvas, so participants see the dithering avatar instead of a blank
	// tile. Retry: the control isn't rendered until admitted, and Meet may join
	// with video off. Re-assert _kajuStartBlobVideo each time in case Meet
	// (re)negotiated the sender when the camera came on.
	if ms.container {
		go func() {
			for i := 0; i < 20; i++ {
				var off bool
				ms.eval(`!!document.querySelector('[aria-label^="Turn on camera" i]')`, &off)
				if off {
					ms.SetCam(true)
					time.Sleep(500 * time.Millisecond)
					ms.eval(`window._kajuStartBlobVideo && window._kajuStartBlobVideo(); true`, nil)
				}
				time.Sleep(2 * time.Second)
			}
		}()
	}

	go func() {
		ms.waitForMeetingEnd()
		log.Println("[meet] meeting ended")
		if ms.onEnd != nil {
			ms.onEnd()
		}
		ms.Leave()
	}()

	log.Printf("[meet] joined %s as %q", ms.MeetURL, displayName)
	return nil
}

// eval runs a JS expression in the page, optionally unmarshaling the result.
func (ms *MeetSession) eval(js string, out interface{}) error {
	return chromedp.Run(ms.ctx, chromedp.Evaluate(js, out))
}

// Context returns the browser context (cancelled when the meeting ends).
func (ms *MeetSession) Context() context.Context { return ms.ctx }

// QueuePCM hands a base64 PCM chunk (24kHz s16le) to the in-page playback queue,
// which injects it into the outgoing WebRTC audio track.
func (ms *MeetSession) QueuePCM(b64 string) {
	ms.eval(`window._kajuQueuePCM(`+jsString(b64)+`); true`, nil)
}

// StopPlayback cuts any in-flight TTS audio (barge-in).
func (ms *MeetSession) StopPlayback() {
	ms.eval(`window._kajuStopPlayback && window._kajuStopPlayback(); true`, nil)
}

// ChatMsg is one inbound Meet chat message.
type ChatMsg struct {
	Sender string `json:"sender"`
	Text   string `json:"text"`
}

// DrainChat returns Meet chat messages posted since the last call (the bot's own
// posts are filtered out in JS).
func (ms *MeetSession) DrainChat() []ChatMsg {
	var msgs []ChatMsg
	// Keep the chat panel open (Meet only renders messages in the DOM while open),
	// then drain new messages.
	ms.eval(`(window._kajuEnsureChatOpen&&window._kajuEnsureChatOpen(),window._kajuDrainChatMessages?window._kajuDrainChatMessages():[])`, &msgs)
	return msgs
}

// SendChat posts a message to the Meet chat panel.
func (ms *MeetSession) SendChat(text string) {
	ms.eval(`window._kajuSendChat && window._kajuSendChat(`+jsString(text)+`); true`, nil)
}

// Participants returns the current participant display names.
func (ms *MeetSession) Participants() []string {
	var names []string
	ms.eval(`window._kajuGetParticipants ? window._kajuGetParticipants() : []`, &names)
	return names
}

// OtherAudioCount returns how many OTHER participants are in the call, counted
// from live remote audio streams (WebRTC). This is the reliable multi-party
// signal in a headless/audio-only join, where the DOM participant tiles that
// Participants() scrapes don't render — so the name roster alone undercounts and
// the gate would wrongly fall into proactive 1:1 mode.
func (ms *MeetSession) OtherAudioCount() int {
	var n int
	ms.eval(`window._kajuGetOtherCount ? window._kajuGetOtherCount() : 0`, &n)
	return n
}

// SetMic turns the bot's microphone on or off by clicking Meet's mic control.
func (ms *MeetSession) SetMic(on bool) {
	want := "Turn on microphone"
	if !on {
		want = "Turn off microphone"
	}
	ms.eval(`(function(){
		var b = document.querySelector('[aria-label^=`+jsString(want)+` i]') ||
		        [...document.querySelectorAll('button')].find(function(x){
		          var l=(x.getAttribute('aria-label')||'').toLowerCase();
		          return l.indexOf(`+jsString(strings.ToLower(want))+`)===0;
		        });
		if (b) b.click();
		return !!b;
	})()`, nil)
}

// SetCam turns the bot's camera on or off by clicking Meet's camera control.
// With the camera on, Meet publishes a video track that hook.js has swapped for
// the shader canvas.
func (ms *MeetSession) SetCam(on bool) {
	want := "Turn on camera"
	if !on {
		want = "Turn off camera"
	}
	ms.eval(`(function(){
		var b = document.querySelector('[aria-label^=`+jsString(want)+` i]') ||
		        [...document.querySelectorAll('button')].find(function(x){
		          var l=(x.getAttribute('aria-label')||'').toLowerCase();
		          return l.indexOf(`+jsString(strings.ToLower(want))+`)===0;
		        });
		if (b) b.click();
		return !!b;
	})()`, nil)
}

func (ms *MeetSession) Leave() {
	ms.mu.Lock()
	if !ms.joined {
		ms.mu.Unlock()
		return
	}
	ms.joined = false
	ms.mu.Unlock()

	log.Println("[meet] leaving")
	chromedp.Run(ms.ctx, chromedp.Evaluate(`window._kajuStopPCMCapture && window._kajuStopPCMCapture(); true`, nil))
	if ms.cancel != nil {
		ms.cancel()
	}
	ms.cleanup()
}

func (ms *MeetSession) Joined() bool {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	return ms.joined
}

func (ms *MeetSession) cleanup() {
	if ms.allocCancel != nil {
		ms.allocCancel()
	}
	if ms.chromeCmd != nil && ms.chromeCmd.Process != nil {
		ms.chromeCmd.Process.Kill()
		ms.chromeCmd = nil
	}
	if ms.pulse != nil {
		ms.pulse.Teardown()
		ms.pulse = nil
	}
	if ms.xvfbCmd != nil {
		StopXvfb(ms.xvfbCmd)
		ms.xvfbCmd = nil
	}
	if ms.userDataDir != "" && !ms.persistentProfile {
		os.RemoveAll(ms.userDataDir)
		ms.userDataDir = ""
	}
}

func (ms *MeetSession) joinMeeting(displayName string) error {
	log.Printf("[meet] joining as %s", displayName)

	var nameVisible bool
	chromedp.Run(ms.ctx, chromedp.Evaluate(
		`!!document.querySelector('input[aria-label="Your name"]')`, &nameVisible,
	))
	if nameVisible && displayName != "" {
		chromedp.Run(ms.ctx,
			chromedp.Clear(`input[aria-label="Your name"]`, chromedp.ByQuery),
			chromedp.SendKeys(`input[aria-label="Your name"]`, displayName, chromedp.ByQuery),
			chromedp.Sleep(1*time.Second),
		)
	}
	// Camera stays as-is — the fake device backs it and hook.js injects the
	// entity canvas as the video track. Toggling it can trip Meet's detection.

	// Best-effort: open meetings can auto-join with no button, so a missing
	// button is not fatal — waitUntilJoined ("Leave call" present) is the
	// source of truth.
	if err := ms.clickJoinButton(); err != nil {
		log.Printf("[meet] no join button clicked (%v) — may be auto-joining", err)
	}
	return nil
}

// clickJoinButton waits for the join control to be genuinely ready, lets media
// negotiation settle (a too-early programmatic click makes Meet reject the
// request with "You can't join this video call"), then issues one trusted CDP
// click on the precise button.
func (ms *MeetSession) clickJoinButton() error {
	selectors := []string{
		`button[jsname="Qx7uuf"]`,
		`button[aria-label="Ask to join"]`,
		`button[aria-label="Join now"]`,
		`[data-mdc-dialog-action="join"]`,
	}

	// Poll up to 40s for a join button to appear and stay present.
	deadline := time.Now().Add(40 * time.Second)
	var found string
	for time.Now().Before(deadline) {
		for _, sel := range selectors {
			var present bool
			chromedp.Run(ms.ctx, chromedp.Evaluate(
				`!!document.querySelector(`+jsString(sel)+`)`, &present))
			if present {
				found = sel
				break
			}
		}
		// Text-based fallback probe.
		if found == "" {
			var hasText bool
			chromedp.Run(ms.ctx, chromedp.Evaluate(`
				Array.from(document.querySelectorAll('button')).some(b => {
					var t = (b.innerText||'').toLowerCase().trim();
					return t.includes('ask to join') || t.includes('join now');
				})
			`, &hasText))
			if hasText {
				found = "__text__"
				break
			}
		}
		if found != "" {
			break
		}
		time.Sleep(1 * time.Second)
	}
	if found == "" {
		return fmt.Errorf("join button never appeared")
	}

	// Let the local media/preview finish negotiating before requesting to join,
	// mimicking a human who doesn't click the instant the button renders.
	log.Printf("[meet] join button ready (%s); settling before click", found)
	time.Sleep(4 * time.Second)

	if found != "__text__" {
		ctx, cancel := context.WithTimeout(ms.ctx, 5*time.Second)
		err := chromedp.Run(ctx, chromedp.Click(found, chromedp.ByQuery, chromedp.NodeVisible))
		cancel()
		if err == nil {
			log.Printf("[meet] clicked join: %s", found)
			return nil
		}
		log.Printf("[meet] CDP click failed (%v), trying text match", err)
	}

	var clicked bool
	chromedp.Run(ms.ctx, chromedp.Evaluate(`
		(function() {
			for (const btn of document.querySelectorAll('button')) {
				const t = btn.innerText.toLowerCase().trim();
				if (t.includes('join now') || t.includes('ask to join') || t === 'join') { btn.click(); return true; }
			}
			return false;
		})()
	`, &clicked))
	if clicked {
		log.Println("[meet] clicked join via JS fallback")
		return nil
	}
	// Debug: list what buttons/page actually show so we can fix selectors.
	var btns string
	chromedp.Run(ms.ctx, chromedp.Evaluate(`
		Array.from(document.querySelectorAll('button')).map(b => (b.getAttribute('aria-label')||b.innerText||'').trim()).filter(Boolean).slice(0,25).join(' | ')
	`, &btns))
	log.Printf("[meet:debug] buttons: %s", btns)
	return fmt.Errorf("could not find join button")
}

func (ms *MeetSession) waitUntilJoined(timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ms.ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("timeout waiting to join meeting")
		case <-ticker.C:
			var inMeeting bool
			if err := chromedp.Run(ms.ctx, chromedp.Evaluate(`
				!!document.querySelector('[aria-label="Leave call"]') ||
				!!document.querySelector('[data-tooltip="Leave call"]')
			`, &inMeeting)); err != nil {
				continue
			}
			if inMeeting {
				log.Println("[meet] joined")
				return nil
			}
			// Debug: surface what Meet is actually showing.
			var snap string
			chromedp.Run(ms.ctx, chromedp.Evaluate(`(function(){
				var t = (document.body ? document.body.innerText : '').replace(/\s+/g,' ').slice(0,240);
				return t;
			})()`, &snap))
			log.Printf("[meet:debug] page: %s", snap)
			var rejected bool
			chromedp.Run(ms.ctx, chromedp.Evaluate(`(function(){
				var b = (document.body ? document.body.innerText : '');
				return b.includes("can't join this video call") || b.includes('Return to home screen') || b.includes('No one responded');
			})()`, &rejected))
			if rejected {
				return fmt.Errorf("meet rejected join (see page text above — likely anonymous not allowed / not admitted)")
			}
		}
	}
}

func (ms *MeetSession) waitForMeetingEnd() {
	select {
	case <-ms.ctx.Done():
		return
	case <-time.After(60 * time.Second):
	}
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ms.ctx.Done():
			return
		case <-ticker.C:
			// Only leave when the meeting actually ends / we're kicked. We do NOT
			// auto-leave on being "alone" — the bot stays until leave_meeting.
			var ended bool
			chromedp.Run(ms.ctx, chromedp.Evaluate(`
				(function() {
					var body = document.body ? document.body.innerText : '';
					return body.includes('You left the meeting') ||
						body.includes('Meeting ended') ||
						body.includes('Return to home screen') ||
						body.includes('removed from the meeting');
				})()
			`, &ended))
			if ended {
				return
			}
		}
	}
}

// IsMeetURL reports whether s looks like a Google Meet link.
func IsMeetURL(s string) bool { return strings.Contains(s, "meet.google.com/") }

// jsString safely encodes s as a JS string literal for chromedp.Evaluate.
func jsString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
