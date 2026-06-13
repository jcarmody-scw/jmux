package adapters

import (
	"os/exec"

	"github.com/gmuxapp/gmux/packages/adapter"
)

func init() {
	All = append(All, NewPiRPC())
}

// PiRPC is an adapter for pi sessions driven by pi --mode rpc.
// Session files are identical to regular pi JSONL sessions; all file-related
// capabilities delegate to Pi.
type PiRPC struct {
	pi     *Pi
	piBin  string // absolute path resolved at startup; avoids launchd PATH issues
}

func NewPiRPC() *PiRPC {
	a := &PiRPC{pi: NewPi()}
	if p, err := exec.LookPath("pi"); err == nil {
		a.piBin = p
	}
	return a
}

// ── Adapter base ────────────────────────────────────────────────────────────

func (a *PiRPC) Name() string { return "pi-rpc" }

// Discover returns true if the pi binary was found at startup.
func (a *PiRPC) Discover() bool { return a.piBin != "" }

// Match always returns false: pi-rpc sessions are not PTY sessions, so no
// gmux-run process will ever report this adapter kind.
func (a *PiRPC) Match(_ []string) bool { return false }

func (a *PiRPC) Env(_ adapter.EnvContext) []string { return nil }

func (a *PiRPC) Monitor(_ []byte) *adapter.Event { return nil }

// ── Launchable ──────────────────────────────────────────────────────────────

func (a *PiRPC) Launchers() []adapter.Launcher {
	return []adapter.Launcher{
		{
			ID:          "pi-rpc",
			Label:       "pi (rpc)",
			Command:     []string{"pi-rpc"}, // sentinel; gmuxd detects SubprocessAdapter before exec
			Description: "New pi session via RPC subprocess",
			Available:   a.Discover(),
		},
	}
}

// ── SubprocessAdapter ───────────────────────────────────────────────────────

// SubprocessCommand returns the argv to run pi in RPC mode.
// Uses the absolute path resolved at startup so the subprocess spawns correctly
// regardless of the runtime PATH (e.g. when gmuxd runs under launchd on macOS).
func (a *PiRPC) SubprocessCommand(_ string) []string {
	return []string{a.piBin, "--mode", "rpc"}
}

// ── File capabilities (delegate to Pi) ─────────────────────────────────────

func (a *PiRPC) SessionRootDir() string { return a.pi.SessionRootDir() }

func (a *PiRPC) SessionDir(cwd string) string { return a.pi.SessionDir(cwd) }

func (a *PiRPC) ParseSessionFile(path string) (*adapter.SessionFileInfo, error) {
	return a.pi.ParseSessionFile(path)
}

func (a *PiRPC) ParseNewLines(lines []string, filePath string) []adapter.Event {
	return a.pi.ParseNewLines(lines, filePath)
}

func (a *PiRPC) AttributeFile(filePath string, candidates []adapter.FileCandidate) string {
	return a.pi.AttributeFile(filePath, candidates)
}

func (a *PiRPC) ResumeCommand(info *adapter.SessionFileInfo) []string {
	return a.pi.ResumeCommand(info)
}

func (a *PiRPC) CanResume(path string) bool { return a.pi.CanResume(path) }

func (a *PiRPC) CommandTitle(_ []string) string { return "pi" }
