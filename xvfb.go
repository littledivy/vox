package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// waitForX blocks until the X server's unix socket for display exists.
func waitForX(display string, timeout time.Duration) error {
	n, err := strconv.Atoi(strings.TrimPrefix(display, ":"))
	if err != nil {
		return fmt.Errorf("bad display %q", display)
	}
	sock := filepath.Join("/tmp", ".X11-unix", fmt.Sprintf("X%d", n))
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(sock); err == nil {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("X socket %s never appeared", sock)
}

// startDBus starts a system D-Bus daemon (best-effort) so Chrome doesn't spam
// connection errors. Safe to call repeatedly.
func startDBus() {
	if _, err := os.Stat("/run/dbus/system_bus_socket"); err == nil {
		return
	}
	os.MkdirAll("/run/dbus", 0o755)
	if err := exec.Command("dbus-daemon", "--system", "--fork").Run(); err != nil {
		log.Printf("[dbus] start (non-fatal): %v", err)
	}
}

// isDisplayActive checks if an X display is already running.
// Checks both the lock file and the unix socket.
func isDisplayActive(display string) bool {
	if len(display) < 2 || display[0] != ':' {
		return false
	}
	n, err := strconv.Atoi(display[1:])
	if err != nil {
		return false
	}
	// Check lock file.
	lock := filepath.Join("/tmp", fmt.Sprintf(".X%d-lock", n))
	if _, err := os.Stat(lock); err == nil {
		return true
	}
	// Check unix socket.
	sock := filepath.Join("/tmp", ".X11-unix", fmt.Sprintf("X%d", n))
	if _, err := os.Stat(sock); err == nil {
		return true
	}
	return false
}

// FindFreeDisplay checks :99, :100, … for an unused X11 display number.
func FindFreeDisplay() string {
	for n := 99; n < 120; n++ {
		lock := filepath.Join("/tmp", fmt.Sprintf(".X%d-lock", n))
		if _, err := os.Stat(lock); os.IsNotExist(err) {
			return fmt.Sprintf(":%d", n)
		}
	}
	return ":99"
}

// StartXvfb launches Xvfb on the given display (e.g. ":99").
func StartXvfb(display string) (*exec.Cmd, error) {
	cmd := exec.Command("Xvfb", display, "-screen", "0", "1280x720x24", "-nolisten", "tcp")
	// NEVER inherit os.Stdout — that's the MCP JSON-RPC channel; Xvfb writing to
	// it corrupts the protocol and gets SIGPIPE (killing Xvfb). Logs -> stderr.
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start Xvfb: %w", err)
	}
	return cmd, nil
}

// StopXvfb kills the Xvfb process.
func StopXvfb(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	cmd.Process.Kill()
	cmd.Wait()
	if len(cmd.Args) >= 2 {
		display := cmd.Args[1]
		if len(display) > 1 && display[0] == ':' {
			if n, err := strconv.Atoi(display[1:]); err == nil {
				os.Remove(filepath.Join("/tmp", fmt.Sprintf(".X%d-lock", n)))
			}
		}
	}
}
