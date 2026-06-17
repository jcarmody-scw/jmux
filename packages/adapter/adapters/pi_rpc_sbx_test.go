package adapters

import (
	"reflect"
	"testing"

	"github.com/gmuxapp/gmux/packages/adapter"
)

func TestPiRPCSbxName(t *testing.T) {
	if NewPiRPCSbx().Name() != "pi-rpc-sbx" {
		t.Fatal("expected 'pi-rpc-sbx'")
	}
}

func TestPiRPCSbxLaunchers(t *testing.T) {
	launchers := NewPiRPCSbx().Launchers()
	if len(launchers) != 1 {
		t.Fatalf("expected 1 launcher, got %d", len(launchers))
	}
	l := launchers[0]
	if l.ID != "pi-rpc-sbx" {
		t.Errorf("expected ID 'pi-rpc-sbx', got %q", l.ID)
	}
	if l.Label != "pi-rpc-sbx" {
		t.Errorf("expected label 'pi-rpc-sbx', got %q", l.Label)
	}
}

func TestPiRPCSbxSubprocessCommandWrapsRPCInSandbox(t *testing.T) {
	a := &PiRPCSbx{sdk: &PiRPC{pi: NewPi(), piBin: "/host/bin/pi"}}
	cmd := a.SubprocessCommand("/workspace")
	want := []string{"sbx", "exec", "-i", "sbx-pi-james-agent-workspace", "--", "pi", "--mode", "rpc"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("SubprocessCommand = %#v, want %#v", cmd, want)
	}
}

func TestPiRPCSbxSubprocessCommandDoesNotPassSbxFlagToPi(t *testing.T) {
	a := &PiRPCSbx{sdk: &PiRPC{pi: NewPi(), piBin: "/host/bin/pi"}}
	for _, arg := range a.SubprocessCommand("/workspace") {
		if arg == "--sbx" {
			t.Fatal("SubprocessCommand must wrap sbx around pi --mode rpc, not pass --sbx to pi")
		}
	}
}

func TestPiRPCSbxImplementsCapabilities(t *testing.T) {
	var a adapter.Adapter = NewPiRPCSbx()
	if _, ok := a.(adapter.Launchable); !ok {
		t.Fatal("should implement Launchable")
	}
	if _, ok := a.(adapter.SubprocessAdapter); !ok {
		t.Fatal("should implement SubprocessAdapter")
	}
}
