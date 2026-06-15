package main

import (
	"os"
	"strings"
	"testing"
)

func TestDevTaskBootstrapsFullPiConfig(t *testing.T) {
	data, err := os.ReadFile("../../moon.yml")
	if err != nil {
		t.Fatalf("read moon.yml: %v", err)
	}
	script := string(data)

	if strings.Contains(script, "for _f in settings.json models.json") {
		t.Fatal("dev task must not copy only settings.json and models.json")
	}
	if !strings.Contains(script, `cp -a "$_PARENT_PI_DIR/." "$DEV_PI_DIR/"`) {
		t.Fatal("dev task must copy the full parent PI_CODING_AGENT_DIR into the dev pi-agent dir")
	}
	if !strings.Contains(script, `_NORMAL_WORKSPACE_DIR="$(dirname "$_PARENT_PI_DIR")"`) {
		t.Fatal("dev task must derive the normal workspace .pi directory from PI_CODING_AGENT_DIR when WORKSPACE_DIR is unset")
	}
	if !strings.Contains(script, `cp -a "$_WORKSPACE_PI_DIR/extensions/." "$DEV_PI_DIR/extensions/"`) {
		t.Fatal("dev task must copy workspace .pi/extensions into the dev pi-agent extensions dir")
	}
}

func TestDevTaskBuildsWithWorktreeGitStamping(t *testing.T) {
	data, err := os.ReadFile("../../moon.yml")
	if err != nil {
		t.Fatalf("read moon.yml: %v", err)
	}
	script := string(data)

	if !strings.Contains(script, `GMUX_GIT_DIR="$(git -C "$ROOT" rev-parse --git-dir)"`) {
		t.Fatal("dev task must resolve the gmux worktree git dir before building")
	}
	if !strings.Contains(script, `GMUX_GIT_WORK_TREE="$(git -C "$ROOT" rev-parse --show-toplevel)"`) {
		t.Fatal("dev task must resolve the gmux worktree root before building")
	}

	if strings.Count(script, `GIT_DIR="$GMUX_GIT_DIR"`) < 2 {
		t.Fatal("dev task must pass GIT_DIR to both initial Go builds")
	}
	if strings.Count(script, `GIT_WORK_TREE="$GMUX_GIT_WORK_TREE"`) < 2 {
		t.Fatal("dev task must pass GIT_WORK_TREE to both initial Go builds")
	}
	if strings.Count(script, `GIT_DIR=\"$GMUX_GIT_DIR\"`) < 2 {
		t.Fatal("dev task must pass GIT_DIR to both watcher Go builds")
	}
	if strings.Count(script, `GIT_WORK_TREE=\"$GMUX_GIT_WORK_TREE\"`) < 2 {
		t.Fatal("dev task must pass GIT_WORK_TREE to both watcher Go builds")
	}
}
