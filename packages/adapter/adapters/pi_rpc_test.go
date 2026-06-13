package adapters

import (
	"os/exec"
	"testing"

	"github.com/gmuxapp/gmux/packages/adapter"
)

// Compile-time interface checks.
var (
	_ adapter.Launchable        = (*PiRPC)(nil)
	_ adapter.SessionFiler      = (*PiRPC)(nil)
	_ adapter.FileMonitor       = (*PiRPC)(nil)
	_ adapter.FileAttributor    = (*PiRPC)(nil)
	_ adapter.Resumer           = (*PiRPC)(nil)
	_ adapter.CommandTitler     = (*PiRPC)(nil)
	_ adapter.SubprocessAdapter = (*PiRPC)(nil)
)

// ── Name ────────────────────────────────────────────────────────────────────

func TestPiRPCName(t *testing.T) {
	if NewPiRPC().Name() != "pi-rpc" {
		t.Fatal("expected 'pi-rpc'")
	}
}

// ── Match ────────────────────────────────────────────────────────────────────

func TestPiRPCMatchAlwaysFalse(t *testing.T) {
	p := NewPiRPC()
	// pi-rpc sessions are not PTY sessions; no gmux-run process ever matches them.
	for _, cmd := range [][]string{
		{"pi"},
		{"node", "pi-rpc-lib.js"},
		{"pi-rpc"},
		{},
		nil,
	} {
		if p.Match(cmd) {
			t.Errorf("Match(%v) = true, want false", cmd)
		}
	}
}

// ── Env / Monitor ────────────────────────────────────────────────────────────

func TestPiRPCEnvNil(t *testing.T) {
	if env := NewPiRPC().Env(adapter.EnvContext{}); env != nil {
		t.Fatalf("expected nil env, got %v", env)
	}
}

func TestPiRPCMonitorNil(t *testing.T) {
	if NewPiRPC().Monitor([]byte("some output")) != nil {
		t.Fatal("Monitor should return nil")
	}
}

// ── CommandTitle ─────────────────────────────────────────────────────────────

func TestPiRPCCommandTitle(t *testing.T) {
	p := NewPiRPC()
	cases := []struct {
		cmd  []string
		want string
	}{
		{nil, "pi"},
		{[]string{}, "pi"},
		{[]string{"node", "/path/to/index.js", "--cwd", "/some/dir"}, "pi"},
	}
	for _, tc := range cases {
		got := p.CommandTitle(tc.cmd)
		if got != tc.want {
			t.Errorf("CommandTitle(%v) = %q, want %q", tc.cmd, got, tc.want)
		}
	}
}

// ── Launchers ────────────────────────────────────────────────────────────────

func TestPiRPCLaunchersCount(t *testing.T) {
	p := NewPiRPC()
	if n := len(p.Launchers()); n != 1 {
		t.Fatalf("expected 1 launcher, got %d", n)
	}
}

func TestPiRPCLauncherID(t *testing.T) {
	l := NewPiRPC().Launchers()[0]
	if l.ID != "pi-rpc" {
		t.Errorf("launcher ID: got %q, want %q", l.ID, "pi-rpc")
	}
}

func TestPiRPCLauncherAvailableWhenBinSet(t *testing.T) {
	p := &PiRPC{pi: NewPi(), piBin: "/usr/bin/env"} // any existing binary
	l := p.Launchers()[0]
	if !l.Available {
		t.Error("launcher should be available when piBin is set")
	}
}

func TestPiRPCLauncherUnavailableWhenNoBin(t *testing.T) {
	p := &PiRPC{pi: NewPi(), piBin: ""}
	l := p.Launchers()[0]
	if l.Available {
		t.Error("launcher should not be available when piBin is empty")
	}
}

// ── SubprocessCommand ────────────────────────────────────────────────────────

func TestPiRPCSubprocessCommandStructure(t *testing.T) {
	const bin = "/usr/local/bin/pi"
	p := &PiRPC{pi: NewPi(), piBin: bin}
	cmd := p.SubprocessCommand("/my/project")

	if len(cmd) != 3 {
		t.Fatalf("expected 3 args, got %d: %v", len(cmd), cmd)
	}
	if cmd[0] != bin {
		t.Errorf("cmd[0]: got %q, want %q", cmd[0], bin)
	}
	if cmd[1] != "--mode" {
		t.Errorf("cmd[1]: got %q, want \"--mode\"", cmd[1])
	}
	if cmd[2] != "rpc" {
		t.Errorf("cmd[2]: got %q, want \"rpc\"", cmd[2])
	}
}

func TestPiRPCSubprocessCommandIgnoresCwd(t *testing.T) {
	// cwd is managed by pirpc.Manager (sets cmd.Dir), not baked into argv.
	p := &PiRPC{pi: NewPi(), piBin: "/usr/local/bin/pi"}
	cmd1 := p.SubprocessCommand("/project/a")
	cmd2 := p.SubprocessCommand("/project/b")
	if len(cmd1) != len(cmd2) {
		t.Error("SubprocessCommand should return same structure regardless of cwd")
	}
	for i := range cmd1 {
		if cmd1[i] != cmd2[i] {
			t.Errorf("arg[%d] differs: %q vs %q", i, cmd1[i], cmd2[i])
		}
	}
}

// ── piBin resolution ─────────────────────────────────────────────────────────

func TestNewPiRPCResolvesBin(t *testing.T) {
	p := NewPiRPC()
	// If pi is on PATH, piBin should be set and Discover should return true.
	// If pi is not on PATH, piBin should be empty and Discover false.
	_, err := exec.LookPath("pi")
	if err == nil {
		if p.piBin == "" {
			t.Error("pi is on PATH but piBin is empty")
		}
		if !p.Discover() {
			t.Error("pi is on PATH but Discover() returned false")
		}
	} else {
		if p.piBin != "" {
			t.Errorf("pi is not on PATH but piBin=%q", p.piBin)
		}
		if p.Discover() {
			t.Error("pi is not on PATH but Discover() returned true")
		}
	}
}

// ── Delegation to Pi ─────────────────────────────────────────────────────────

func TestPiRPCDelegatesSessionRootDir(t *testing.T) {
	p := NewPiRPC()
	pi := NewPi()
	if p.SessionRootDir() != pi.SessionRootDir() {
		t.Errorf("SessionRootDir mismatch: %q vs %q", p.SessionRootDir(), pi.SessionRootDir())
	}
}

func TestPiRPCDelegatesSessionDir(t *testing.T) {
	p := NewPiRPC()
	pi := NewPi()
	cwd := t.TempDir()
	if p.SessionDir(cwd) != pi.SessionDir(cwd) {
		t.Errorf("SessionDir mismatch for %q", cwd)
	}
}

func TestPiRPCDelegatesCanResume(t *testing.T) {
	p := NewPiRPC()
	// Non-existent path: both should return false
	if p.CanResume("/nonexistent/path.jsonl") {
		t.Error("CanResume should return false for nonexistent path")
	}
}
