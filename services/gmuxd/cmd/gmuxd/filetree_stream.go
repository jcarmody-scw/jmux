package main

import (
	"context"
	"encoding/json"
	"sync"

	"nhooyr.io/websocket"
)

type walkSnapshot struct {
	paths        map[string]struct{}
	version      int64
	deltaAdded   []string
	deltaRemoved []string
}

type fileTreeStreamMessage struct {
	Type       string          `json:"type"`
	Added      []string        `json:"added,omitempty"`
	Removed    []string        `json:"removed,omitempty"`
	Version    int64           `json:"version,omitempty"`
	Files      int             `json:"files,omitempty"`
	Insertions int             `json:"insertions,omitempty"`
	Deletions  int             `json:"deletions,omitempty"`
	Entries    []gitFileStatus `json:"entries,omitempty"`
	Message    string          `json:"message,omitempty"`
}

type fileTreeHub struct {
	mu   sync.Mutex
	subs map[string]map[chan fileTreeStreamMessage]struct{}
}

func newFileTreeHub() *fileTreeHub {
	return &fileTreeHub{subs: make(map[string]map[chan fileTreeStreamMessage]struct{})}
}

func (h *fileTreeHub) subscribe(slug string) (<-chan fileTreeStreamMessage, func()) {
	ch := make(chan fileTreeStreamMessage, 16)
	h.mu.Lock()
	if h.subs[slug] == nil {
		h.subs[slug] = make(map[chan fileTreeStreamMessage]struct{})
	}
	h.subs[slug][ch] = struct{}{}
	h.mu.Unlock()
	cancel := func() {
		h.mu.Lock()
		if subs := h.subs[slug]; subs != nil {
			delete(subs, ch)
			if len(subs) == 0 {
				delete(h.subs, slug)
			}
		}
		h.mu.Unlock()
		close(ch)
	}
	return ch, cancel
}

func (h *fileTreeHub) broadcast(slug string, msg fileTreeStreamMessage) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs[slug] {
		select {
		case ch <- msg:
		default:
		}
	}
}

func fileTreeDeltaMessage(snap *walkSnapshot) *fileTreeStreamMessage {
	if snap == nil {
		return nil
	}
	if len(snap.deltaAdded) == 0 && len(snap.deltaRemoved) == 0 {
		return nil
	}
	return &fileTreeStreamMessage{
		Type:    "file-delta",
		Added:   snap.deltaAdded,
		Removed: snap.deltaRemoved,
		Version: snap.version,
	}
}

func wsWriteJSON(ctx context.Context, conn *websocket.Conn, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, data)
}
