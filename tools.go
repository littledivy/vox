package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// tools.go implements the extra capabilities the voice agent can call: searching
// the web and reading local documents (pdf/docx/xlsx/…). Each returns a compact
// text result suitable for the model to speak from.

// voiceTools is the shared set of function tools exposed to the voice agent
// (web search + document reading). Used by every realtime backend.
func voiceTools() []map[string]any {
	return []map[string]any{
		{
			"type":        "function",
			"name":        "web_search",
			"description": "Search the web for current or factual information and get a concise answer with sources. Use whenever the user asks about recent events, facts you're unsure of, or anything that benefits from up-to-date info.",
			"parameters": map[string]any{
				"type":       "object",
				"properties": map[string]any{"query": map[string]any{"type": "string", "description": "The search query."}},
				"required":   []string{"query"},
			},
		},
		{
			"type":        "function",
			"name":        "read_document",
			"description": "Read a local file and return its text. Supports PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), and plain text/markdown/csv. Use when the user refers to a document by path so you can answer from its contents.",
			"parameters": map[string]any{
				"type":       "object",
				"properties": map[string]any{"path": map[string]any{"type": "string", "description": "Absolute path to the file (may start with ~)."}},
				"required":   []string{"path"},
			},
		},
		{
			"type":        "function",
			"name":        "write_file",
			"description": "Write text to a local file (creates or overwrites, making parent folders). Use to save notes, drafts, code, or results the user asks you to write down.",
			"parameters": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path":    map[string]any{"type": "string", "description": "Absolute path to write (may start with ~)."},
					"content": map[string]any{"type": "string", "description": "The full text to write."},
				},
				"required": []string{"path", "content"},
			},
		},
		{
			"type":        "function",
			"name":        "run_shell",
			"description": "Run a shell command on the user's Mac and return its output. Use for quick tasks: listing files, git status, opening apps, running scripts. Prefer safe, non-destructive commands; avoid anything that deletes data unless the user clearly asked.",
			"parameters": map[string]any{
				"type":       "object",
				"properties": map[string]any{"command": map[string]any{"type": "string", "description": "The shell command to run."}},
				"required":   []string{"command"},
			},
		},
		{
			"type":        "function",
			"name":        "computer_use",
			"description": "Control the computer's screen — take a screenshot, click, type, or press keys — via the open-computer-use tool. Use for on-screen tasks that need seeing and clicking the UI.",
			"parameters": map[string]any{
				"type":       "object",
				"properties": map[string]any{"instruction": map[string]any{"type": "string", "description": "What to do on screen, in plain language."}},
				"required":   []string{"instruction"},
			},
		},
		{
			"type":        "function",
			"name":        "consult_agent",
			"description": "Ask a stronger coding/reasoning agent (Claude Code or Codex, running locally) a hard question and get back its written answer. Use for anything that needs deep analysis, multi-step reasoning, reading a codebase, or writing real code — then speak a concise summary of the reply. The agent runs on the user's machine and can see their files.",
			"parameters": map[string]any{
				"type":       "object",
				"properties": map[string]any{"question": map[string]any{"type": "string", "description": "The full question or task to hand off, with any needed context."}},
				"required":   []string{"question"},
			},
		},
	}
}

// dispatchVoiceTool runs a named voice tool and returns its text result (errors
// are returned as a short message the model can speak).
func dispatchVoiceTool(ctx context.Context, name, argsJSON string) string {
	var a struct {
		Query       string `json:"query"`
		Path        string `json:"path"`
		Content     string `json:"content"`
		Command     string `json:"command"`
		Instruction string `json:"instruction"`
		Question    string `json:"question"`
	}
	json.Unmarshal([]byte(argsJSON), &a)
	switch name {
	case "web_search":
		r, err := webSearch(ctx, a.Query)
		if err != nil {
			return "Web search failed: " + err.Error()
		}
		return r
	case "read_document":
		r, err := readDocument(ctx, a.Path)
		if err != nil {
			return "Couldn't read the document: " + err.Error()
		}
		return r
	case "write_file":
		if err := writeFile(a.Path, a.Content); err != nil {
			return "Couldn't write the file: " + err.Error()
		}
		return "Wrote " + a.Path
	case "run_shell":
		return runShell(ctx, a.Command)
	case "computer_use":
		return computerUse(ctx, a.Instruction)
	case "consult_agent":
		return consultAgent(ctx, a.Question)
	}
	return "Unknown tool: " + name
}

// consultAgent hands a question to a stronger local coding agent (Claude Code
// or Codex) in non-interactive mode and returns its written answer. Prefers
// `claude -p`; falls back to `codex exec`. Runs via the login shell so the
// CLIs resolve even under a GUI-launched parent with a minimal PATH.
func consultAgent(ctx context.Context, question string) string {
	question = strings.TrimSpace(question)
	if question == "" {
		return "no question"
	}
	ctx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()

	var agent, tmpl string
	switch {
	case haveCmd("claude"):
		agent, tmpl = "Claude Code", "claude -p %s"
	case haveCmd("codex"):
		agent, tmpl = "Codex", "codex exec %s"
	default:
		return "No coding agent found. Install Claude Code (`claude`) or Codex (`codex`) to use consult_agent."
	}

	cmdline := fmt.Sprintf(tmpl, shellQuote(question))
	var buf bytes.Buffer
	cmd := exec.CommandContext(ctx, "bash", "-lc", cmdline)
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	out := strings.TrimSpace(buf.String())
	if len(out) > 8000 {
		out = out[:8000] + "\n…(truncated)"
	}
	if err != nil {
		if out == "" {
			return agent + " failed: " + err.Error()
		}
		return out + "\n(" + agent + " exit: " + err.Error() + ")"
	}
	if out == "" {
		return "(" + agent + " returned no output)"
	}
	return out
}

// haveCmd reports whether a command resolves on the login-shell PATH.
func haveCmd(name string) bool {
	if _, err := exec.LookPath(name); err == nil {
		return true
	}
	// GUI-launched parents can have a minimal PATH; check the login shell too.
	err := exec.Command("bash", "-lc", "command -v "+name).Run()
	return err == nil
}

// shellQuote wraps s in single quotes, safe for bash.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func writeFile(path, content string) error {
	path = expandHome(strings.TrimSpace(path))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

// runShell runs a command via the login shell and returns combined output
// (capped). This is a local personal-agent capability on the user's own machine.
func runShell(ctx context.Context, command string) string {
	if strings.TrimSpace(command) == "" {
		return "no command"
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	var buf bytes.Buffer
	cmd := exec.CommandContext(ctx, "bash", "-lc", command)
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	out := strings.TrimSpace(buf.String())
	if len(out) > 6000 {
		out = out[:6000] + "\n…(truncated)"
	}
	if err != nil {
		if out == "" {
			return "command failed: " + err.Error()
		}
		return out + "\n(exit: " + err.Error() + ")"
	}
	if out == "" {
		return "(done, no output)"
	}
	return out
}

// computerUse drives the open-computer-use CLI (github.com/iFurySt/
// open-codex-computer-use) if installed, letting the agent see and control the
// screen. Falls back to a clear setup hint.
func computerUse(ctx context.Context, instruction string) string {
	bin := ""
	for _, c := range []string{"ocu", "open-computer-use"} {
		if p, err := exec.LookPath(c); err == nil {
			bin = p
			break
		}
	}
	if bin == "" {
		return "computer control isn't set up — install open-computer-use (github.com/iFurySt/open-codex-computer-use) and grant Accessibility access"
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	out, err := runCmd(ctx, bin, "do", instruction)
	if err != nil {
		return "computer control failed: " + err.Error()
	}
	return strings.TrimSpace(out)
}

// webSearch answers a query using OpenAI's Responses API with the hosted
// web_search tool — so it needs only the OpenAI key the agent already uses.
func webSearch(ctx context.Context, query string) (string, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return "", fmt.Errorf("OPENAI_API_KEY not set")
	}
	reqBody, _ := json.Marshal(map[string]any{
		"model": "gpt-4o-mini",
		"tools": []map[string]any{{"type": "web_search_preview"}},
		"tool_choice": "auto",
		"input": "Search the web and answer concisely (2-4 sentences), citing sources inline: " + query,
	})
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.openai.com/v1/responses", bytes.NewReader(reqBody))
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := llmHTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("responses api %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	// The Responses API returns an "output" array; pull the assistant text out.
	var out struct {
		OutputText string `json:"output_text"`
		Output     []struct {
			Type    string `json:"type"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
	}
	json.Unmarshal(body, &out)
	if s := strings.TrimSpace(out.OutputText); s != "" {
		return s, nil
	}
	var sb strings.Builder
	for _, o := range out.Output {
		if o.Type != "message" {
			continue
		}
		for _, c := range o.Content {
			if c.Text != "" {
				sb.WriteString(c.Text)
			}
		}
	}
	if s := strings.TrimSpace(sb.String()); s != "" {
		return s, nil
	}
	return "", fmt.Errorf("no answer from web search")
}

var xmlTag = regexp.MustCompile(`<[^>]+>`)

func stripXML(s string) string {
	s = xmlTag.ReplaceAllString(s, " ")
	s = strings.ReplaceAll(s, "&amp;", "&")
	s = strings.ReplaceAll(s, "&lt;", "<")
	s = strings.ReplaceAll(s, "&gt;", ">")
	return strings.Join(strings.Fields(s), " ")
}

// readDocument extracts plain text from a local file. Supports txt/md/csv/json
// directly; docx/doc/rtf/html/odt via `textutil`; pdf via `pdftotext`; xlsx/pptx
// by pulling text out of the office-open-xml zip.
func readDocument(ctx context.Context, path string) (string, error) {
	path = expandHome(strings.TrimSpace(path))
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("no such file: %s", path)
	}
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()

	ext := strings.ToLower(filepath.Ext(path))
	var text string
	var err error
	switch ext {
	case ".txt", ".md", ".markdown", ".csv", ".json", ".log", ".rtf":
		var b []byte
		b, err = os.ReadFile(path)
		text = string(b)
		if ext == ".rtf" {
			text, err = runCmd(ctx, "textutil", "-convert", "txt", "-stdout", path)
		}
	case ".docx", ".doc", ".odt", ".html", ".htm", ".webarchive", ".wordml":
		text, err = runCmd(ctx, "textutil", "-convert", "txt", "-stdout", path)
	case ".pdf":
		text, err = runCmd(ctx, "pdftotext", "-q", path, "-")
		if err != nil {
			return "", fmt.Errorf("reading PDFs needs poppler (brew install poppler)")
		}
	case ".xlsx", ".pptx":
		text, err = readOfficeZip(ctx, path)
	default:
		// Best effort: treat as text.
		var b []byte
		b, err = os.ReadFile(path)
		text = string(b)
	}
	if err != nil {
		return "", err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", fmt.Errorf("no readable text in %s", filepath.Base(path))
	}
	const max = 8000
	if len(text) > max {
		text = text[:max] + "\n…(truncated)"
	}
	return text, nil
}

// readOfficeZip pulls text out of an xlsx/pptx (a zip of XML parts).
func readOfficeZip(ctx context.Context, path string) (string, error) {
	// List the parts, then dump the text-bearing ones and strip tags.
	parts := []string{"xl/sharedStrings.xml"}
	list, _ := runCmd(ctx, "unzip", "-Z1", path)
	for _, p := range strings.Split(list, "\n") {
		if strings.HasPrefix(p, "ppt/slides/slide") && strings.HasSuffix(p, ".xml") {
			parts = append(parts, p)
		}
	}
	var sb strings.Builder
	for _, part := range parts {
		out, err := runCmd(ctx, "unzip", "-p", path, part)
		if err == nil && out != "" {
			sb.WriteString(stripXML(out))
			sb.WriteString(" ")
		}
	}
	return sb.String(), nil
}

func runCmd(ctx context.Context, name string, args ...string) (string, error) {
	var out, errb bytes.Buffer
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%s: %v %s", name, err, strings.TrimSpace(errb.String()))
	}
	return out.String(), nil
}

func expandHome(p string) string {
	if strings.HasPrefix(p, "~/") {
		if h, err := os.UserHomeDir(); err == nil {
			return filepath.Join(h, p[2:])
		}
	}
	return p
}
