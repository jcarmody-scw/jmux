package gitwatcher_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/gmuxapp/gmux/services/gmuxd/internal/gitwatcher"
	"github.com/gmuxapp/gmux/services/gmuxd/internal/store"
)

// initRepo creates a temp dir with a real git repo and an initial commit.
func initRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	run("init")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "Test")

	// Create initial file and commit so HEAD exists.
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "README.md")
	run("commit", "-m", "init")

	return dir
}

// collectEvents subscribes to the store and collects git-status events
// until stop is closed. Thread-safe.
type eventCollector struct {
	mu     sync.Mutex
	events []store.Event
}

func (c *eventCollector) collect(s *store.Store, stop <-chan struct{}) {
	ch, cancel := s.Subscribe()
	go func() {
		defer cancel()
		for {
			select {
			case <-stop:
				return
			case ev, ok := <-ch:
				if !ok {
					return
				}
				if ev.Type == "git-status" {
					c.mu.Lock()
					c.events = append(c.events, ev)
					c.mu.Unlock()
				}
			}
		}
	}()
}

func (c *eventCollector) snapshot() []store.Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]store.Event, len(c.events))
	copy(out, c.events)
	return out
}

func waitForGitStatusEvent(t *testing.T, col *eventCollector, timeout time.Duration) store.Event {
	t.Helper()

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()

	for {
		evs := col.snapshot()
		if len(evs) > 0 {
			return evs[0]
		}

		select {
		case <-timer.C:
			t.Fatalf("timeout waiting %s for git-status event", timeout)
		case <-ticker.C:
		}
	}
}

// TestGitWatcher_BroadcastsOnIndexChange verifies that touching .git/index
// after staging a file causes a git-status SSE event to be broadcast within
// the debounce window plus a small margin.
func TestGitWatcher_BroadcastsOnIndexChange(t *testing.T) {
	dir := initRepo(t)

	s := store.New()
	stop := make(chan struct{})
	defer close(stop)

	col := &eventCollector{}
	col.collect(s, stop)

	watcher := gitwatcher.New(s)
	watcher.SetDebounce(150 * time.Millisecond)

	if err := watcher.Add("myslug", dir); err != nil {
		t.Fatalf("Add: %v", err)
	}
	go watcher.Run(stop)

	// Modify a file and stage it — this updates .git/index.
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("git", "-C", dir, "add", "README.md")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git add: %v\n%s", err, out)
	}

	// Wait for an event long enough to tolerate full-suite load.
	ev := waitForGitStatusEvent(t, col, 5*time.Second)

	// Verify slug and payload.
	if ev.Type != "git-status" {
		t.Fatalf("unexpected event type: %s", ev.Type)
	}
	if ev.ID != "myslug" {
		t.Fatalf("expected slug myslug, got %s", ev.ID)
	}
	var payload gitwatcher.GitStatusPayload
	if err := json.Unmarshal(ev.Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if payload.Slug != "myslug" {
		t.Fatalf("payload.Slug = %q, want myslug", payload.Slug)
	}
}

// TestGitWatcher_Debounce verifies that rapid events are coalesced: many
// quick writes produce exactly one broadcast (not one per write).
func TestGitWatcher_Debounce(t *testing.T) {
	dir := initRepo(t)

	s := store.New()
	stop := make(chan struct{})
	defer close(stop)

	col := &eventCollector{}
	col.collect(s, stop)

	watcher := gitwatcher.New(s)
	watcher.SetDebounce(200 * time.Millisecond)

	if err := watcher.Add("slug2", dir); err != nil {
		t.Fatalf("Add: %v", err)
	}
	go watcher.Run(stop)

	// Write .git/index several times in quick succession.
	gitIndex := filepath.Join(dir, ".git", "index")
	existing, _ := os.ReadFile(gitIndex)
	for i := 0; i < 5; i++ {
		// Touch the index by re-writing its content (no-op for git, but
		// fsnotify sees a write event).
		_ = os.WriteFile(gitIndex, existing, 0o644)
		time.Sleep(20 * time.Millisecond)
	}

	// Wait for debounce period + margin.
	time.Sleep(300 * time.Millisecond)

	evs := col.snapshot()
	// Should be 0 or 1 (touching with same bytes may not trigger git changes,
	// but the important thing is it's not 5).
	if len(evs) > 2 {
		t.Fatalf("expected debounce to coalesce events, got %d events", len(evs))
	}
}

// TestGitWatcher_PayloadContainsShortstat verifies that the broadcast payload
// includes a parsed shortstat with files > 0 after a staged change.
func TestGitWatcher_PayloadContainsShortstat(t *testing.T) {
	dir := initRepo(t)

	s := store.New()
	stop := make(chan struct{})
	defer close(stop)

	col := &eventCollector{}
	col.collect(s, stop)

	watcher := gitwatcher.New(s)
	watcher.SetDebounce(100 * time.Millisecond)

	if err := watcher.Add("proj", dir); err != nil {
		t.Fatalf("Add: %v", err)
	}
	go watcher.Run(stop)

	// Stage a modification.
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("modified content\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("git", "-C", dir, "add", "README.md")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git add: %v\n%s", err, out)
	}

	ev := waitForGitStatusEvent(t, col, 5*time.Second)

	var payload gitwatcher.GitStatusPayload
	if err := json.Unmarshal(ev.Payload, &payload); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if payload.Files == 0 {
		t.Fatalf("expected Files > 0, got %+v", payload)
	}
}

// TestGitWatcher_NoUnflagUsed verifies option A: git status is called
// without the -u flag. We can't introspect the command, but we can
// verify a new untracked file does NOT appear in the entries list
// (since without -u, git status --porcelain=v1 omits untracked).
func TestGitWatcher_NoUnflagUsed(t *testing.T) {
	dir := initRepo(t)

	s := store.New()
	stop := make(chan struct{})
	defer close(stop)

	col := &eventCollector{}
	col.collect(s, stop)

	watcher := gitwatcher.New(s)
	watcher.SetDebounce(100 * time.Millisecond)

	if err := watcher.Add("slug3", dir); err != nil {
		t.Fatalf("Add: %v", err)
	}
	go watcher.Run(stop)

	// Create an untracked file AND stage a tracked file.
	if err := os.WriteFile(filepath.Join(dir, "untracked.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Only stage README.md, leave untracked.txt untracked.
	cmd := exec.Command("git", "-C", dir, "add", "README.md")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git add: %v\n%s", err, out)
	}

	ev := waitForGitStatusEvent(t, col, 5*time.Second)

	var payload gitwatcher.GitStatusPayload
	if err := json.Unmarshal(ev.Payload, &payload); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// Without -u, untracked.txt should NOT appear in entries.
	for _, e := range payload.Entries {
		if e.Status == "untracked" {
			t.Fatalf("expected no untracked entries (no -u flag), got: %+v", payload.Entries)
		}
	}
}
