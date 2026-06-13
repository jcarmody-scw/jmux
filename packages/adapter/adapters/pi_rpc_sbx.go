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

// PiRPCSbx is the adapter for pi sessions driven by the pi-rpc Node subprocess
// running inside a Docker AI Sandbox (sbx). The Node process runs on the host
// but launches pi inside the sandbox via the --sbx flag.
// All file capabilities delegate to PiRPC (and transitively to Pi).
type PiRPCSbx struct {
	sdk *PiRPC
}

func NewPiRPCSbx() *PiRPCSbx {
	return &PiRPCSbx{sdk: NewPiRPC()}
}

// ── Adapter base ────────────────────────────────────────────────────────────

func (a *PiRPCSbx) Name() string { return "pi-rpc-sbx" }

// Discover returns true if both sbx and the pi-rpc-lib prerequisites are present.
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
			Label:       "pi (sdk, sandbox)",
			Command:     []string{"pi-rpc-sbx"}, // sentinel; not executed directly
			Description: "New pi session via SDK subprocess bridge (sandbox)",
			Available:   false, // pending t-1142: sbx integration with pi --mode rpc
		},
	}
}

// ── SubprocessAdapter ───────────────────────────────────────────────────────

// SubprocessCommand returns the same Node command as PiRPC but with --sbx,
// which tells pi-rpc-lib to create the pi session via sbx exec.
func (a *PiRPCSbx) SubprocessCommand(cwd string) []string {
	base := a.sdk.SubprocessCommand(cwd)
	return append(base, "--sbx")
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
