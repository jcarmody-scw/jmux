package adapters

import (
	"os/exec"

	"github.com/gmuxapp/gmux/packages/adapter"
)

// Compile-time interface checks.
var (
	_ adapter.Launchable        = (*PiRPCSbx)(nil)
	_ adapter.SubprocessAdapter = (*PiRPCSbx)(nil)
	_ adapter.SessionFiler      = (*PiRPCSbx)(nil)
	_ adapter.FileMonitor       = (*PiRPCSbx)(nil)
	_ adapter.FileAttributor    = (*PiRPCSbx)(nil)
	_ adapter.Resumer           = (*PiRPCSbx)(nil)
)

func init() {
	All = append(All, NewPiRPCSbx())
}

// PiRPCSbx is the adapter for pi sessions driven by pi --mode rpc inside a
// Docker AI Sandbox (sbx). The host launches sbx exec and pi runs inside the
// sandbox without a --sbx flag.
// All file capabilities delegate to PiRPC (and transitively to Pi).
type PiRPCSbx struct {
	sdk *PiRPC
}

func NewPiRPCSbx() *PiRPCSbx {
	return &PiRPCSbx{sdk: NewPiRPC()}
}

// ── Adapter base ────────────────────────────────────────────────────────────

func (a *PiRPCSbx) Name() string { return "pi-rpc-sbx" }

// Discover returns true if both sbx and the pi-rpc prerequisites are present.
func (a *PiRPCSbx) Discover() bool {
	if _, err := exec.LookPath("sbx"); err != nil {
		return false
	}
	return a.sdk.Discover()
}

// Match always returns false: pi-rpc-sbx sessions are not PTY sessions.
func (a *PiRPCSbx) Match(_ []string) bool { return false }

func (a *PiRPCSbx) Env(_ adapter.EnvContext) []string { return nil }

func (a *PiRPCSbx) Monitor(_ []byte) *adapter.Event { return nil }

// ── Launchable ──────────────────────────────────────────────────────────────

func (a *PiRPCSbx) Launchers() []adapter.Launcher {
	return []adapter.Launcher{
		{
			ID:          "pi-rpc-sbx",
			Label:       "pi-rpc-sbx",
			Command:     []string{"pi-rpc-sbx"}, // sentinel; gmuxd detects SubprocessAdapter before exec
			Description: "New pi-rpc session in the workspace sandbox",
			Available:   a.Discover(),
		},
	}
}

// ── SubprocessAdapter ───────────────────────────────────────────────────────

// SubprocessCommand runs pi RPC mode inside the workspace sandbox.
// RPC sessions use JSON over stdin/stdout, so this uses -i rather than -it.
func (a *PiRPCSbx) SubprocessCommand(_ string) []string {
	return []string{"sbx", "exec", "-i", "sbx-pi-james-agent-workspace", "--", "pi", "--mode", "rpc"}
}

// ── File capabilities (delegate to PiRPC) ───────────────────────────────────

func (a *PiRPCSbx) SessionRootDir() string { return a.sdk.SessionRootDir() }

func (a *PiRPCSbx) SessionDir(cwd string) string { return a.sdk.SessionDir(cwd) }

func (a *PiRPCSbx) ParseSessionFile(path string) (*adapter.SessionFileInfo, error) {
	return a.sdk.ParseSessionFile(path)
}

func (a *PiRPCSbx) ParseNewLines(lines []string, filePath string) []adapter.Event {
	return a.sdk.ParseNewLines(lines, filePath)
}

func (a *PiRPCSbx) AttributeFile(filePath string, candidates []adapter.FileCandidate) string {
	return a.sdk.AttributeFile(filePath, candidates)
}

func (a *PiRPCSbx) ResumeCommand(info *adapter.SessionFileInfo) []string {
	return a.sdk.ResumeCommand(info)
}

func (a *PiRPCSbx) CanResume(path string) bool { return a.sdk.CanResume(path) }
