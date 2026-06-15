package main

import (
	"testing"
	"time"
)

func TestFileTreeHubBroadcastDeliversOnlyMatchingSlug(t *testing.T) {
	hub := newFileTreeHub()
	projEvents, cancelProj := hub.subscribe("proj")
	defer cancelProj()
	otherEvents, cancelOther := hub.subscribe("other")
	defer cancelOther()

	want := fileTreeStreamMessage{
		Type:    "file-delta",
		Added:   []string{"src/new.go"},
		Removed: []string{"old.go"},
		Version: 2,
	}
	hub.broadcast("proj", want)

	select {
	case got := <-projEvents:
		if got.Type != want.Type || got.Version != want.Version || len(got.Added) != 1 || got.Added[0] != "src/new.go" || len(got.Removed) != 1 || got.Removed[0] != "old.go" {
			t.Fatalf("got %#v, want %#v", got, want)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for project event")
	}

	select {
	case got := <-otherEvents:
		t.Fatalf("other slug received event: %#v", got)
	case <-time.After(25 * time.Millisecond):
	}
}

func TestWalkSnapshotMessageReturnsNilWhenNoDelta(t *testing.T) {
	snap := &walkSnapshot{version: 3, deltaAdded: []string{}, deltaRemoved: []string{}}
	if got := fileTreeDeltaMessage(snap); got != nil {
		t.Fatalf("got %#v, want nil", got)
	}
}

func TestWalkSnapshotMessageIncludesDelta(t *testing.T) {
	snap := &walkSnapshot{version: 4, deltaAdded: []string{"a.go"}, deltaRemoved: []string{"b.go"}}
	got := fileTreeDeltaMessage(snap)
	if got == nil {
		t.Fatal("got nil, want message")
	}
	if got.Type != "file-delta" || got.Version != 4 || got.Added[0] != "a.go" || got.Removed[0] != "b.go" {
		t.Fatalf("got %#v", got)
	}
}
