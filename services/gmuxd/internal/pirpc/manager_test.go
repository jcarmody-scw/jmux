package pirpc

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gmuxapp/gmux/services/gmuxd/internal/store"
	"nhooyr.io/websocket"
)

// ─── subprocess test harness ─────────────────────────────────────────────────
//
// Tests spawn the test binary itself as a subprocess (standard Go pattern).
// The subprocess detects GO_WANT_HELPER_PROCESS=1 and the mode after "--".

// TestHelperProcess is invoked only by the test subprocess, not by the runner.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") != "1" {
		return
	}
	mode := helperMode()
	switch mode {
	case "emit-session-ready":
		// Emit session_ready, then wait for stdin to close (graceful shutdown).
		fmt.Println(`{"type":"session_ready","model":"test-model"}`)
		io.Copy(io.Discard, os.Stdin) //nolint:errcheck
	case "emit-and-exit":
		// Emit session_ready then exit immediately (tests exit lifecycle).
		fmt.Println(`{"type":"session_ready","model":"m1"}`)
	case "echo-stdin":
		// Echo every byte received on stdin back to stdout (used for broadcast tests).
		io.Copy(os.Stdout, os.Stdin) //nolint:errcheck
	case "rpc-sim":
		// Simulates pi --mode rpc: responds to get_state with a response line,
		// echoes all other stdin lines back as events, exits on stdin close.
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			line := scanner.Text()
			var cmd map[string]interface{}
			if err := json.Unmarshal([]byte(line), &cmd); err != nil {
				continue
			}
			if cmd["type"] == "get_state" {
				fmt.Println(`{"type":"response","command":"get_state","success":true,"data":{"model":{"id":"test-model"},"sessionFile":"/tmp/test.jsonl","sessionId":"abc"}}`)
			} else {
				// Echo back as an event so broadcast tests can verify receipt.
				fmt.Println(line)
			}
		}
	case "require-pi-env":
		missing := []string{}
		for _, key := range []string{"PI_CODING_AGENT_DIR", "AWS_PROFILE", "AWS_REGION"} {
			if os.Getenv(key) == "" {
				missing = append(missing, key)
			}
		}
		if len(missing) > 0 {
			fmt.Fprintf(os.Stderr, "missing required env: %s\n", strings.Join(missing, ","))
			os.Exit(42)
		}
	default:
		fmt.Fprintf(os.Stderr, "pirpc test helper: unknown mode %q\n", mode)
		os.Exit(1)
	}
	os.Exit(0)
}

func helperMode() string {
	for i, a := range os.Args {
		if a == "--" && i+1 < len(os.Args) {
			return os.Args[i+1]
		}
	}
	return ""
}

// helperCmd returns the argv to run the test binary as a subprocess in mode.
func helperCmd(mode string) []string {
	return []string{os.Args[0], "-test.run=TestHelperProcess", "--", mode}
}

// ─── helpers ─────────────────────────────────────────────────────────────────

func newTestStore(id string) *store.Store {
	s := store.New()
	s.Upsert(store.Session{ID: id, Kind: "pi-rpc", Alive: true})
	return s
}

// waitFor polls cond every 10 ms until it returns true or the timeout elapses.
// Reports a fatal error if the timeout fires.
func waitFor(t *testing.T, timeout time.Duration, desc string, cond func() bool) {
	t.Helper()
	deadline := time.After(timeout)
	for {
		if cond() {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("timed out waiting for: %s", desc)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// launchHelper starts a helper subprocess via m.Launch, setting the env var
// that activates the helper mode in the subprocess.
func launchHelper(t *testing.T, m *Manager, sessID, mode string) {
	t.Helper()
	t.Setenv("GO_WANT_HELPER_PROCESS", "1")
	if err := m.Launch(sessID, helperCmd(mode), ""); err != nil {
		t.Fatalf("Launch(%s): %v", mode, err)
	}
}

// ─── tests ───────────────────────────────────────────────────────────────────

// TestSessionReadyUpdatesSubtitle verifies that a session_ready JSON line
// emitted by the subprocess causes the store to reflect the model as Subtitle.
func TestSessionReadyUpdatesSubtitle(t *testing.T) {
	s := newTestStore("sess-1")
	m := New(s)

	launchHelper(t, m, "sess-1", "emit-session-ready")

	waitFor(t, 5*time.Second, "subtitle == test-model", func() bool {
		sess, _ := s.Get("sess-1")
		return sess.Subtitle == "test-model"
	})

	// Cleanup: close stdin so the helper exits cleanly.
	m.mu.Lock()
	proc := m.sessions["sess-1"]
	m.mu.Unlock()
	if proc != nil {
		proc.stdin.Close()
	}
}

// TestBroadcastToConnectedClients verifies that JSON lines from the subprocess
// stdout are fanned out to all connected WebSocket clients.
func TestBroadcastToConnectedClients(t *testing.T) {
	s := newTestStore("sess-2")
	m := New(s)

	launchHelper(t, m, "sess-2", "echo-stdin")

	// Serve HandleWebSocket via httptest.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.HandleWebSocket(w, r, "sess-2")
	}))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/"

	// Connect two clients.
	ctx := context.Background()
	c1, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("client 1 dial: %v", err)
	}
	defer c1.Close(websocket.StatusNormalClosure, "")

	c2, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("client 2 dial: %v", err)
	}
	defer c2.Close(websocket.StatusNormalClosure, "")

	// Wait until both conns are registered in proc.conns.
	waitFor(t, 3*time.Second, "2 WS clients registered", func() bool {
		m.mu.Lock()
		proc := m.sessions["sess-2"]
		m.mu.Unlock()
		if proc == nil {
			return false
		}
		proc.mu.Lock()
		defer proc.mu.Unlock()
		return len(proc.conns) == 2
	})

	// Write a JSON line directly to subprocess stdin; it echoes to stdout,
	// which readLoop picks up and broadcasts.
	want := `{"type":"test","payload":"hello"}`
	m.mu.Lock()
	proc := m.sessions["sess-2"]
	m.mu.Unlock()
	if proc == nil {
		t.Fatal("subprocess not found")
	}
	if _, err := proc.stdin.Write([]byte(want + "\n")); err != nil {
		t.Fatalf("stdin write: %v", err)
	}

	// readUntil reads WS messages until it finds the expected one, discarding
	// any startup echoes that arrive first (e.g. the get_state echo).
	readUntil := func(conn *websocket.Conn, label, want string) string {
		for {
			rctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_, data, err := conn.Read(rctx)
			cancel()
			if err != nil {
				t.Errorf("%s read: %v", label, err)
				return ""
			}
			if string(data) == want {
				return string(data)
			}
		}
	}

	got1 := readUntil(c1, "client 1", want)
	got2 := readUntil(c2, "client 2", want)

	if got1 != want {
		t.Errorf("client 1: got %q, want %q", got1, want)
	}
	if got2 != want {
		t.Errorf("client 2: got %q, want %q", got2, want)
	}

	// Close stdin to stop the echo subprocess.
	proc.stdin.Close()
}

// TestWaitLoopMarksSessionDead verifies that when the subprocess exits,
// the store session is marked Alive=false with an ExitCode.
func TestWaitLoopMarksSessionDead(t *testing.T) {
	s := newTestStore("sess-3")
	m := New(s)

	launchHelper(t, m, "sess-3", "emit-and-exit")

	waitFor(t, 5*time.Second, "session alive=false", func() bool {
		sess, _ := s.Get("sess-3")
		return !sess.Alive
	})

	sess, _ := s.Get("sess-3")
	if sess.ExitCode == nil {
		t.Error("ExitCode should be set after exit")
	} else if *sess.ExitCode != 0 {
		t.Errorf("ExitCode: got %d, want 0", *sess.ExitCode)
	}
	if sess.ExitedAt == "" {
		t.Error("ExitedAt should be set after exit")
	}
}

// TestHandleWebSocketUnknownSession verifies a 404 for sessions not in the manager.
func TestHandleWebSocketUnknownSession(t *testing.T) {
	m := New(store.New())

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.HandleWebSocket(w, r, "no-such-session")
	}))
	defer srv.Close()

	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status: got %d, want %d", resp.StatusCode, http.StatusNotFound)
	}
}

// TestShutdown verifies that Shutdown closes all running subprocesses and
// the store transitions the sessions to dead.
func TestShutdown(t *testing.T) {
	s := newTestStore("sess-4")
	m := New(s)

	launchHelper(t, m, "sess-4", "rpc-sim")

	// Wait for the subprocess to be fully running (subtitle updated).
	waitFor(t, 5*time.Second, "subtitle set", func() bool {
		sess, _ := s.Get("sess-4")
		return sess.Subtitle == "test-model"
	})

	m.Shutdown(5 * time.Second)

	// After Shutdown, the session should be dead.
	waitFor(t, 5*time.Second, "session dead after Shutdown", func() bool {
		sess, _ := s.Get("sess-4")
		return !sess.Alive
	})
}

// TestRpcSessionReadyUpdatesSubtitle verifies that the manager synthesises a
// session_ready event (and updates the store subtitle) from the get_state RPC
// response emitted by rpc-sim on startup.
func TestRpcSessionReadyUpdatesSubtitle(t *testing.T) {
	s := newTestStore("sess-5")
	m := New(s)

	launchHelper(t, m, "sess-5", "rpc-sim")

	waitFor(t, 5*time.Second, "subtitle == test-model", func() bool {
		sess, _ := s.Get("sess-5")
		return sess.Subtitle == "test-model"
	})

	// Cleanup.
	m.mu.Lock()
	proc := m.sessions["sess-5"]
	m.mu.Unlock()
	if proc != nil {
		proc.stdin.Close()
	}
}

// TestResponseLinesNotBroadcast verifies that RPC response lines are filtered
// out and never forwarded to WebSocket clients.
func TestResponseLinesNotBroadcast(t *testing.T) {
	s := newTestStore("sess-6")
	m := New(s)

	launchHelper(t, m, "sess-6", "rpc-sim")

	// Wait for startup get_state to be consumed.
	waitFor(t, 5*time.Second, "subtitle set", func() bool {
		sess, _ := s.Get("sess-6")
		return sess.Subtitle != ""
	})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.HandleWebSocket(w, r, "sess-6")
	}))
	defer srv.Close()

	ctx := context.Background()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	waitFor(t, 3*time.Second, "conn registered", func() bool {
		m.mu.Lock()
		proc := m.sessions["sess-6"]
		m.mu.Unlock()
		if proc == nil {
			return false
		}
		proc.mu.Lock()
		defer proc.mu.Unlock()
		return len(proc.conns) == 1
	})

	// Send an event line directly to the subprocess — it echoes back as an event.
	// The echo should arrive at the client.
	want := `{"type":"agent_start"}`
	m.mu.Lock()
	proc := m.sessions["sess-6"]
	m.mu.Unlock()
	if _, err := proc.stdin.Write([]byte(want + "\n")); err != nil {
		t.Fatalf("stdin write: %v", err)
	}

	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, data, err := conn.Read(rctx)
	if err != nil {
		t.Fatalf("ws read: %v", err)
	}
	got := string(data)

	// The response line for get_state must NOT have been forwarded.
	// The agent_start event SHOULD have arrived.
	if strings.Contains(got, "\"command\":") {
		t.Errorf("response line leaked to client: %s", got)
	}
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}

	proc.stdin.Close()
}

// TestPromptTextTranslation verifies that WebSocket input with field 'text' is
// translated to the RPC field 'message' before reaching the subprocess stdin.
func TestPromptTextTranslation(t *testing.T) {
	s := newTestStore("sess-7")
	m := New(s)

	// Use echo-stdin so we can observe exactly what reaches the subprocess stdin.
	// We intercept at the subprocess stdout (echo) level.
	launchHelper(t, m, "sess-7", "echo-stdin")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.HandleWebSocket(w, r, "sess-7")
	}))
	defer srv.Close()

	ctx := context.Background()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	waitFor(t, 3*time.Second, "conn registered", func() bool {
		m.mu.Lock()
		proc := m.sessions["sess-7"]
		m.mu.Unlock()
		if proc == nil {
			return false
		}
		proc.mu.Lock()
		defer proc.mu.Unlock()
		return len(proc.conns) == 1
	})

	// Send a prompt with 'text' field (WebSocket protocol).
	wsMsg := `{"type":"prompt","text":"hello world"}`
	if err := conn.Write(ctx, websocket.MessageText, []byte(wsMsg)); err != nil {
		t.Fatalf("ws write: %v", err)
	}

	// Read messages until we find one with type=="prompt" (skipping any
	// startup get_state echo that may arrive first).
	var got map[string]interface{}
	for {
		rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		_, data, err := conn.Read(rctx)
		cancel()
		if err != nil {
			t.Fatalf("ws read: %v", err)
		}
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatalf("parse echoed line: %v", err)
		}
		if got["type"] == "prompt" {
			break
		}
	}
	if _, hasText := got["text"]; hasText {
		t.Error("translated prompt still has 'text' field")
	}
	if msg, ok := got["message"]; !ok || msg != "hello world" {
		t.Errorf("expected message='hello world', got: %v", got)
	}

	m.mu.Lock()
	proc := m.sessions["sess-7"]
	m.mu.Unlock()
	proc.stdin.Close()
}

func TestLaunchProvidesPiRPCEnvironmentFallbacks(t *testing.T) {
	t.Setenv("PI_CODING_AGENT_DIR", "")
	t.Setenv("AWS_PROFILE", "")
	t.Setenv("AWS_REGION", "")
	t.Setenv("GO_WANT_HELPER_PROCESS", "1")

	s := newTestStore("sess-env")
	m := New(s)

	if err := m.Launch("sess-env", helperCmd("require-pi-env"), ""); err != nil {
		t.Fatalf("Launch(require-pi-env): %v", err)
	}

	var proc *subprocess
	waitFor(t, 3*time.Second, "env helper started", func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		proc = m.sessions["sess-env"]
		return proc != nil
	})

	proc.stdin.Close()

	waitFor(t, 3*time.Second, "env helper exited", func() bool {
		sess, _ := s.Get("sess-env")
		return !sess.Alive
	})

	if proc.cmd.ProcessState == nil || proc.cmd.ProcessState.ExitCode() != 0 {
		t.Fatalf("env helper exited with state %v", proc.cmd.ProcessState)
	}
}
