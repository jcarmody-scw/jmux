package adapters

import (
	"os"
	"path/filepath"
	"testing"
)

func writeExecutable(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatalf("write fake %s: %v", name, err)
	}
	return path
}

func TestPiRPCSbxDiscoverRejectsPiWithoutSbxFlag(t *testing.T) {
	dir := t.TempDir()
	writeExecutable(t, dir, "sbx", "#!/bin/sh\nexit 0\n")
	writeExecutable(t, dir, "pi", "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then echo 'Usage: pi --mode rpc'; exit 0; fi\nexit 0\n")
	t.Setenv("PATH", dir)

	if NewPiRPCSbx().Discover() {
		t.Fatal("pi-rpc-sbx should be unavailable when the installed pi binary does not support --sbx")
	}
}

func TestPiRPCSbxDiscoverAllowsPiWithSbxFlag(t *testing.T) {
	dir := t.TempDir()
	writeExecutable(t, dir, "sbx", "#!/bin/sh\nexit 0\n")
	writeExecutable(t, dir, "pi", "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then echo 'Usage: pi --mode rpc --sbx'; exit 0; fi\nexit 0\n")
	t.Setenv("PATH", dir)

	if !NewPiRPCSbx().Discover() {
		t.Fatal("pi-rpc-sbx should be available when sbx exists and pi supports --sbx")
	}
}
