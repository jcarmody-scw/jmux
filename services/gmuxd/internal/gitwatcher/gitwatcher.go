// Package gitwatcher watches .git/index and .git/HEAD for a set of project
// roots using fsnotify. On change (debounced), it runs git commands and
// broadcasts a git-status SSE event on the store.
//
// Design decisions:
//   - Option A: git status --porcelain=v1 WITHOUT -u. Only index/HEAD
//     changes trigger an update, not every file save. Untracked files
//     are intentionally excluded to avoid full untracked-scan overhead.
//   - Debounce: rapid fsnotify events (e.g. git rewriting the index
//     multiple times during `git add`) are coalesced into one broadcast.
//   - One watcher shared across all project roots; each root gets two
//     watches: .git/index and .git/HEAD.
package gitwatcher

import (
	"context"
	"encoding/json"
	"log"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/gmuxapp/gmux/services/gmuxd/internal/store"
)

// defaultDebounce is the default debounce window. Coalesces rapid fsnotify
// events (git rewrites the index several times during `git add`) into one run.
const defaultDebounce = 300 * time.Millisecond

// GitStatusEntry mirrors the porcelain v1 entry used by the HTTP handler.
type GitStatusEntry struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

// GitStatusPayload is the payload embedded in git-status SSE events.
type GitStatusPayload struct {
	Slug       string           `json:"slug"`
	Files      int              `json:"files"`
	Insertions int              `json:"insertions"`
	Deletions  int              `json:"deletions"`
	Entries    []GitStatusEntry `json:"entries"`
}

// GitWatcher watches multiple project roots and broadcasts git-status events.
type GitWatcher struct {
	store    *store.Store
	debounce time.Duration

	mu      sync.Mutex
	roots   map[string]string        // slug -> root path
	timers  map[string]*time.Timer   // slug -> pending debounce timer
	watcher *fsnotify.Watcher
}

// New creates a new GitWatcher backed by the given store.
func New(s *store.Store) *GitWatcher {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		log.Printf("gitwatcher: failed to create fsnotify watcher: %v", err)
	}
	return &GitWatcher{
		store:    s,
		debounce: defaultDebounce,
		roots:    make(map[string]string),
		timers:   make(map[string]*time.Timer),
		watcher:  w,
	}
}

// SetDebounce overrides the debounce duration. Must be called before Add/Run.
func (gw *GitWatcher) SetDebounce(d time.Duration) {
	gw.debounce = d
}

// Add registers a project root for watching. The .git directory is watched
// with fsnotify. Events for index and HEAD trigger debounced git-status
// broadcasts.
//
// We watch the .git directory rather than individual files because git
// updates index via an atomic rename (index.lock → index). Watching the
// file directly misses the rename-in event; watching the directory catches
// both rename-in and write events for any file inside .git.
func (gw *GitWatcher) Add(slug, root string) error {
	if gw.watcher == nil {
		return nil // watcher creation failed at startup; degrade gracefully
	}

	gitDir := filepath.Join(root, ".git")
	if err := gw.watcher.Add(gitDir); err != nil {
		return err
	}

	gw.mu.Lock()
	gw.roots[slug] = root
	gw.mu.Unlock()

	return nil
}

// Remove stops watching a project root.
func (gw *GitWatcher) Remove(slug string) {
	if gw.watcher == nil {
		return
	}

	gw.mu.Lock()
	root, ok := gw.roots[slug]
	if ok {
		delete(gw.roots, slug)
		if t := gw.timers[slug]; t != nil {
			t.Stop()
			delete(gw.timers, slug)
		}
	}
	gw.mu.Unlock()

	if !ok {
		return
	}

	_ = gw.watcher.Remove(filepath.Join(root, ".git"))
}

// Run processes fsnotify events until stop is closed.
func (gw *GitWatcher) Run(stop <-chan struct{}) {
	if gw.watcher == nil {
		<-stop
		return
	}
	defer gw.watcher.Close()

	for {
		select {
		case <-stop:
			return

		case event, ok := <-gw.watcher.Events:
			if !ok {
				return
			}
			gw.handleEvent(event)

		case err, ok := <-gw.watcher.Errors:
			if !ok {
				return
			}
			log.Printf("gitwatcher: watcher error: %v", err)
		}
	}
}

// handleEvent processes a single fsnotify event by finding the owning project
// slug and scheduling a debounced broadcast.
//
// We watch the .git directory and filter to events on index and HEAD.
// git uses atomic rename (index.lock → index) so we accept Rename events too.
func (gw *GitWatcher) handleEvent(event fsnotify.Event) {
	if !event.Has(fsnotify.Write) && !event.Has(fsnotify.Create) && !event.Has(fsnotify.Rename) {
		return
	}

	name := filepath.Clean(event.Name)
	base := filepath.Base(name)
	if base != "index" && base != "HEAD" {
		return
	}

	slug := gw.slugForFile(name)
	if slug == "" {
		return
	}

	gw.schedule(slug)
}

// slugForFile finds which slug owns a file inside a .git directory.
func (gw *GitWatcher) slugForFile(path string) string {
	gw.mu.Lock()
	defer gw.mu.Unlock()
	for slug, root := range gw.roots {
		gitDir := filepath.Join(root, ".git")
		if filepath.Dir(path) == gitDir {
			return slug
		}
	}
	return ""
}

// schedule arms (or rearms) the debounce timer for a slug.
func (gw *GitWatcher) schedule(slug string) {
	gw.mu.Lock()
	defer gw.mu.Unlock()

	if t, ok := gw.timers[slug]; ok && t != nil {
		t.Stop()
	}

	root, ok := gw.roots[slug]
	if !ok {
		return
	}

	d := gw.debounce
	gw.timers[slug] = time.AfterFunc(d, func() {
		gw.mu.Lock()
		delete(gw.timers, slug)
		gw.mu.Unlock()
		gw.broadcast(slug, root)
	})
}

// broadcast runs git commands and sends the git-status event to the store.
func (gw *GitWatcher) broadcast(slug, root string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// shortstat: count files, insertions, deletions from HEAD.
	shortOut, _ := exec.CommandContext(ctx, "git", "-C", root, "diff", "HEAD", "--shortstat").Output()
	files, ins, del := parseGitShortstat(string(shortOut))

	// porcelain v1 with -uno: only tracked changes, explicitly no untracked scan.
	// Option A: git-operations-only. Untracked files are not reported here;
	// the watcher only fires on index/HEAD changes anyway.
	porcelainOut, _ := exec.CommandContext(ctx, "git", "-C", root, "status", "--porcelain=v1", "-uno").Output()
	entries := parseGitPorcelain(string(porcelainOut))

	payload := GitStatusPayload{
		Slug:       slug,
		Files:      files,
		Insertions: ins,
		Deletions:  del,
		Entries:    entries,
	}

	raw, err := json.Marshal(payload)
	if err != nil {
		log.Printf("gitwatcher: marshal payload for %s: %v", slug, err)
		return
	}

	gw.store.Broadcast(store.Event{
		Type:    "git-status",
		ID:      slug,
		Payload: raw,
	})
}

// parseGitShortstat parses `git diff HEAD --shortstat` output into counts.
// Example: " 1 file changed, 2 insertions(+), 1 deletion(-)"
func parseGitShortstat(out string) (files, insertions, deletions int) {
	out = strings.TrimSpace(out)
	if out == "" {
		return 0, 0, 0
	}
	for _, part := range strings.Split(out, ",") {
		part = strings.TrimSpace(part)
		switch {
		case strings.Contains(part, "file"):
			files = leadingInt(part)
		case strings.Contains(part, "insertion"):
			insertions = leadingInt(part)
		case strings.Contains(part, "deletion"):
			deletions = leadingInt(part)
		}
	}
	return
}

// leadingInt extracts the leading integer from a string like "3 files changed".
func leadingInt(s string) int {
	s = strings.TrimSpace(s)
	i := strings.IndexByte(s, ' ')
	if i < 0 {
		return 0
	}
	n, _ := strconv.Atoi(s[:i])
	return n
}

// parseGitPorcelain parses `git status --porcelain=v1` output into entries.
// Each line is "XY path" where X is staged status and Y is unstaged.
// No -u flag means untracked files are not present in the output.
func parseGitPorcelain(out string) []GitStatusEntry {
	var entries []GitStatusEntry
	for _, line := range strings.Split(out, "\n") {
		if len(line) < 4 {
			continue
		}
		xy := line[:2]
		path := line[3:]
		status := porcelainStatus(xy)
		if status == "" {
			continue
		}
		entries = append(entries, GitStatusEntry{Path: path, Status: status})
	}
	return entries
}

// porcelainStatus converts a porcelain XY code to a display status string.
func porcelainStatus(xy string) string {
	if len(xy) < 2 {
		return ""
	}
	x, y := xy[0], xy[1]
	switch {
	case x == '?' && y == '?':
		return "untracked"
	case x == '!':
		return "ignored"
	case x == 'A' || (x == ' ' && y == 'A'):
		return "added"
	case x == 'D' || (x == ' ' && y == 'D'):
		return "deleted"
	case x == 'R' || (x == ' ' && y == 'R'):
		return "renamed"
	case x == 'M' || y == 'M':
		return "modified"
	case x == ' ' && y == ' ':
		return ""
	default:
		return "modified"
	}
}
