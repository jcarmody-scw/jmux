// Package pirpc manages pi-rpc subprocess sessions in gmuxd.
// Each session owns one subprocess (pi --mode rpc) that communicates via JSON
// lines on stdin/stdout. This package handles subprocess lifecycle, WebSocket
// fan-out, and store updates.
package pirpc

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/gmuxapp/gmux/services/gmuxd/internal/store"
	"nhooyr.io/websocket"
)

const maxReplayEvents = 1000

// Manager manages pi-rpc subprocess sessions.
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*subprocess
	store    *store.Store
}

type subprocess struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	done  chan struct{}

	mu     sync.Mutex
	conns  []*websocket.Conn
	replay [][]byte
}

// New creates a Manager backed by the given session store.
func New(s *store.Store) *Manager {
	return &Manager{
		sessions: make(map[string]*subprocess),
		store:    s,
	}
}

var defaultPiRPCEnv = map[string]string{
	"AWS_PROFILE": "scw-agentic-bedrock-sso",
	"AWS_REGION":  "eu-central-1",
}

func piRPCEnv() []string {
	env := os.Environ()
	if os.Getenv("PI_CODING_AGENT_DIR") == "" {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			env = upsertEnv(env, "PI_CODING_AGENT_DIR", filepath.Join(home, ".pi", "agent"))
		}
	}
	for key, val := range defaultPiRPCEnv {
		if os.Getenv(key) == "" {
			env = upsertEnv(env, key, val)
		}
	}
	return env
}

func upsertEnv(env []string, key, val string) []string {
	prefix := key + "="
	for i, entry := range env {
		if len(entry) >= len(prefix) && entry[:len(prefix)] == prefix {
			env[i] = prefix + val
			return env
		}
	}
	return append(env, prefix+val)
}

func envHas(env []string, key string) bool {
	prefix := key + "="
	for _, entry := range env {
		if len(entry) >= len(prefix) && entry[:len(prefix)] == prefix {
			return entry != prefix
		}
	}
	return false
}

// Launch spawns the subprocess for a session that is already registered
// in the store. argv is the full command + args (e.g. ["pi", "--mode", "rpc"]).
// dir is the working directory for the subprocess.
func (m *Manager) Launch(sessionID string, argv []string, dir string) error {
	if len(argv) == 0 {
		return fmt.Errorf("pirpc: empty command")
	}

	c := exec.Command(argv[0], argv[1:]...)
	c.Dir = dir
	c.Stderr = os.Stderr // surface subprocess errors in the gmuxd log
	c.Env = piRPCEnv()
	log.Printf("pirpc: %s: env PI_CODING_AGENT_DIR=%t AWS_PROFILE=%t AWS_REGION=%t", sessionID, envHas(c.Env, "PI_CODING_AGENT_DIR"), envHas(c.Env, "AWS_PROFILE"), envHas(c.Env, "AWS_REGION"))

	stdin, err := c.StdinPipe()
	if err != nil {
		return fmt.Errorf("pirpc: stdin pipe: %w", err)
	}
	stdout, err := c.StdoutPipe()
	if err != nil {
		return fmt.Errorf("pirpc: stdout pipe: %w", err)
	}

	if err := c.Start(); err != nil {
		return fmt.Errorf("pirpc: start: %w", err)
	}

	proc := &subprocess{
		cmd:   c,
		stdin: stdin,
		done:  make(chan struct{}),
	}

	m.mu.Lock()
	m.sessions[sessionID] = proc
	m.mu.Unlock()

	// Update store with PID.
	m.store.Update(sessionID, func(s *store.Session) {
		s.Pid = c.Process.Pid
	})

	// Request state immediately so readLoop can synthesise session_ready.
	if _, err := stdin.Write([]byte(`{"id":"startup","type":"get_state"}` + "\n")); err != nil {
		log.Printf("pirpc: %s: get_state write: %v", sessionID, err)
	}

	go m.readLoop(sessionID, proc, stdout)
	go m.waitLoop(sessionID, proc)

	log.Printf("pirpc: launched session %s pid=%d", sessionID, c.Process.Pid)
	return nil
}

// readLoop reads JSON-line events from stdout and broadcasts them to all
// connected WebSocket clients.
//
// The startup get_state response is handled specially to synthesise a
// session_ready event. Other RPC response lines are forwarded to clients so
// request/response commands such as get_commands can be consumed by the UI.
func (m *Manager) readLoop(sessionID string, proc *subprocess, stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 256*1024), 256*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		log.Printf("pirpc: %s: stdout: %s", sessionID, truncate(line, 200))

		// Peek at type (and optional fields used for special handling).
		var peek struct {
			Type    string `json:"type"`
			Command string `json:"command"`
			Success bool   `json:"success"`
			Data    struct {
				Model struct {
					ID string `json:"id"`
				} `json:"model"`
				SessionFile string `json:"sessionFile"`
				SessionID   string `json:"sessionId"`
			} `json:"data"`
			// Legacy direct fields (session_ready from old pi-rpc-lib).
			Model string `json:"model"`
		}
		if err := json.Unmarshal(line, &peek); err != nil {
			log.Printf("pirpc: %s: bad JSON from subprocess: %v", sessionID, err)
			continue
		}

		// The startup get_state response is used to synthesise session_ready.
		// All other response lines are part of the public RPC protocol and must be
		// forwarded to clients, for example get_commands responses for slash command
		// discovery.
		if peek.Type == "response" && peek.Command == "get_state" && peek.Success && peek.Data.Model.ID != "" {
			modelID := peek.Data.Model.ID
			sessFile := peek.Data.SessionFile
			m.store.Update(sessionID, func(s *store.Session) {
				s.Subtitle = modelID
			})
			// Synthesise session_ready so the frontend shows "connected · <model>".
			synthesised, _ := json.Marshal(map[string]string{
				"type":        "session_ready",
				"model":       modelID,
				"sessionFile": sessFile,
			})
			line = synthesised
			peek.Type = "session_ready"
		}

		// Legacy: direct session_ready (kept for test helpers / future use).
		if peek.Type == "session_ready" && peek.Model != "" {
			m.store.Update(sessionID, func(s *store.Session) {
				s.Subtitle = peek.Model
			})
		}

		// Store the event for reconnect replay and broadcast to all connected clients.
		msg := append([]byte(nil), line...) // copy before retaining/broadcasting
		proc.mu.Lock()
		proc.replay = append(proc.replay, msg)
		if len(proc.replay) > maxReplayEvents {
			proc.replay = append([][]byte(nil), proc.replay[len(proc.replay)-maxReplayEvents:]...)
		}

		log.Printf("pirpc: %s: broadcast to %d client(s): type=%s", sessionID, len(proc.conns), peek.Type)
		for _, conn := range proc.conns {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := conn.Write(ctx, websocket.MessageText, msg); err != nil {
				log.Printf("pirpc: %s: write to client: %v", sessionID, err)
			}
			cancel()
		}
		proc.mu.Unlock()
	}

	if err := scanner.Err(); err != nil {
		log.Printf("pirpc: %s: stdout read error: %v", sessionID, err)
	}
}

// waitLoop waits for the subprocess to exit, then marks the session dead in
// the store and closes all open WebSocket connections.
func (m *Manager) waitLoop(sessionID string, proc *subprocess) {
	_ = proc.cmd.Wait()
	close(proc.done)

	exitCode := 0
	if proc.cmd.ProcessState != nil {
		exitCode = proc.cmd.ProcessState.ExitCode()
	}

	now := time.Now().UTC().Format(time.RFC3339)
	code := exitCode // capture for closure
	m.store.Update(sessionID, func(s *store.Session) {
		s.Alive = false
		s.ExitCode = &code
		s.ExitedAt = now
	})

	// Close all open WebSocket connections.
	proc.mu.Lock()
	conns := proc.conns
	proc.conns = nil
	proc.mu.Unlock()

	for _, conn := range conns {
		conn.Close(websocket.StatusNormalClosure, "process exited")
	}

	m.mu.Lock()
	delete(m.sessions, sessionID)
	m.mu.Unlock()

	log.Printf("pirpc: session %s exited (code %d)", sessionID, exitCode)
}

// HandleWebSocket accepts a WebSocket upgrade for a pi-rpc session, adds the
// connection to the broadcast fan-out, and relays incoming client messages to
// the subprocess stdin as JSON lines.
func (m *Manager) HandleWebSocket(w http.ResponseWriter, r *http.Request, sessionID string) {
	m.mu.Lock()
	proc := m.sessions[sessionID]
	m.mu.Unlock()

	if proc == nil {
		http.Error(w, "session not running", http.StatusNotFound)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// InsecureSkipVerify disables Origin checking. gmuxd is a localhost
		// daemon; cross-origin WebSocket connections are acceptable here.
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Printf("pirpc: ws accept %s: %v", sessionID, err)
		return
	}
	log.Printf("pirpc: ws client connected %s (remote=%s)", sessionID, r.RemoteAddr)

	// Replay retained session events before adding this connection to live
	// broadcast. Holding proc.mu prevents readLoop from writing live events to
	// this connection concurrently or missing events between replay and register.
	proc.mu.Lock()
	select {
	case <-proc.done:
		proc.mu.Unlock()
		conn.Close(websocket.StatusNormalClosure, "process exited")
		return
	default:
	}
	for _, msg := range proc.replay {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := conn.Write(ctx, websocket.MessageText, msg); err != nil {
			cancel()
			proc.mu.Unlock()
			conn.Close(websocket.StatusInternalError, "replay failed")
			log.Printf("pirpc: %s: replay to client: %v", sessionID, err)
			return
		}
		cancel()
	}
	proc.conns = append(proc.conns, conn)
	proc.mu.Unlock()

	defer func() {
		proc.mu.Lock()
		for i, c := range proc.conns {
			if c == conn {
				proc.conns = append(proc.conns[:i], proc.conns[i+1:]...)
				break
			}
		}
		proc.mu.Unlock()
		conn.Close(websocket.StatusNormalClosure, "")
		log.Printf("pirpc: ws client disconnected %s", sessionID)
	}()

	// Relay: client messages → subprocess stdin.
	// Translate WebSocket prompt format → RPC format:
	//   {"type":"prompt","text":"..."} → {"type":"prompt","message":"..."}
	ctx := r.Context()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			log.Printf("pirpc: %s: ws read closed: %v", sessionID, err)
			return
		}
		translated := translateToRPC(data)
		log.Printf("pirpc: %s: ws→stdin: %s", sessionID, truncate(translated, 200))
		line := append(translated, '\n')
		if _, err := proc.stdin.Write(line); err != nil {
			log.Printf("pirpc: %s: stdin write: %v", sessionID, err)
			return
		}
	}
}

// IsRunning reports whether the subprocess for sessionID is still alive.
func (m *Manager) IsRunning(sessionID string) bool {
	m.mu.Lock()
	_, ok := m.sessions[sessionID]
	m.mu.Unlock()
	return ok
}

// Shutdown closes stdin on all running subprocesses, triggering graceful exit,
// then waits up to timeout for them to finish. Any still running after the
// deadline are force-killed.
func (m *Manager) Shutdown(timeout time.Duration) {
	m.mu.Lock()
	procs := make([]*subprocess, 0, len(m.sessions))
	for _, p := range m.sessions {
		procs = append(procs, p)
	}
	m.mu.Unlock()

	// Close stdin on all subprocesses (sends EOF → graceful shutdown).
	for _, p := range procs {
		p.stdin.Close()
	}

	// Wait for all to exit, then force-kill any that exceed the deadline.
	done := make(chan struct{})
	go func() {
		for _, p := range procs {
			<-p.done
		}
		close(done)
	}()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
		// All exited gracefully.
	case <-timer.C:
		// Force-kill anything still running.
		for _, p := range procs {
			select {
			case <-p.done:
				// already exited
			default:
				if p.cmd.Process != nil {
					p.cmd.Process.Kill()
				}
			}
		}
	}
}

// translateToRPC rewrites WebSocket client messages to match the RPC protocol.
// The only difference is the prompt command: WS uses {"text":"..."} but RPC
// expects {"message":"..."}. All other message types pass through unchanged.
func translateToRPC(data []byte) []byte {
	var msg map[string]json.RawMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return data // not valid JSON — pass through as-is
	}
	rawType, ok := msg["type"]
	if !ok {
		return data
	}
	var msgType string
	if err := json.Unmarshal(rawType, &msgType); err != nil || msgType != "prompt" {
		return data // not a prompt — pass through unchanged
	}
	if textRaw, hasText := msg["text"]; hasText {
		msg["message"] = textRaw
		delete(msg, "text")
		out, err := json.Marshal(msg)
		if err != nil {
			return data
		}
		return out
	}
	return data
}

// truncate returns s truncated to maxLen bytes with a suffix if cut.
func truncate(s []byte, maxLen int) string {
	if len(s) <= maxLen {
		return string(s)
	}
	return string(s[:maxLen]) + "…"
}
