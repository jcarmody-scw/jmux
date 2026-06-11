// PiSessionView — terminal-style chat UI for pi-sdk and pi-sdk-sbx sessions.
// Connects to /ws/{session.id}, renders streaming events as a message list.
import { type Session } from './types'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import type { RefObject } from 'preact'

// ---------------------------------------------------------------------------
// Content block types (mirroring SDK AgentMessage content)
// ---------------------------------------------------------------------------

export interface TextContent {
  type: 'text'
  text: string
}

export interface ThinkingContent {
  type: 'thinking'
  thinking: string
  redacted?: boolean
}

export interface ToolCallContent {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type ContentBlock = TextContent | ThinkingContent | ToolCallContent

// ---------------------------------------------------------------------------
// Tool execution state
// ---------------------------------------------------------------------------

export interface ToolExec {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  output: string
  done: boolean
  isError: boolean
}

export type ToolExecMap = Record<string, ToolExec>

// ---------------------------------------------------------------------------
// Render items
// ---------------------------------------------------------------------------

interface UserItem {
  kind: 'user'
  text: string
}

export interface AssistantItem {
  kind: 'assistant'
  blocks: ContentBlock[]
  toolExecMap: ToolExecMap
  complete: boolean
}

type SystemSubtype = 'ready' | 'error' | 'warning' | 'info'

interface SystemItem {
  kind: 'system'
  subtype: SystemSubtype
  text: string
}

export type RenderItem = UserItem | AssistantItem | SystemItem

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Extract typed ContentBlock[] from a raw message object (message_update payload). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractBlocks(message: any): ContentBlock[] {
  const content = message?.content
  if (!Array.isArray(content)) return []
  return content as ContentBlock[]
}

/** Return a human-readable string for a system-level AgentSessionEvent. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSystemText(event: any): string {
  switch (event.type) {
    case 'session_ready':
      return `connected · ${event.model}`
    case 'error':
      return String(event.message ?? 'unknown error')
    case 'warning':
      return String(event.message ?? 'warning')
    case 'compaction_start':
      return `compacting context (${event.reason ?? ''})…`
    case 'compaction_end':
      if (event.aborted) return `compaction aborted`
      return `compaction done`
    case 'auto_retry_start':
      return `retrying (attempt ${event.attempt}/${event.maxAttempts})… ${event.errorMessage ?? ''}`
    case 'auto_retry_end':
      if (event.success) return `retry success`
      return `retry failed: ${event.finalError ?? 'unknown'}`
    default:
      return String(event.type ?? 'event')
  }
}

// ---------------------------------------------------------------------------
// Helper: extract plain text from an RPC tool result/partial-result object.
// RPC tool results have shape {content: [{type:'text',text:'...'}], details:{}}.
// Falls back to string coercion for legacy plain-string results.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractResultText(r: any): string {
  if (!r) return ''
  if (typeof r === 'string') return r
  if (Array.isArray(r.content)) {
    return (r.content as Array<{type: string; text?: string}>)
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('')
  }
  return ''
}

// ---------------------------------------------------------------------------
// Helper: update toolExecMap on the last AssistantItem
// ---------------------------------------------------------------------------

function updateLastAssistantToolExec(
  prev: RenderItem[],
  toolCallId: string,
  update: ToolExec | ((existing: ToolExec | undefined) => ToolExec),
): RenderItem[] {
  const next = [...prev]
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].kind === 'assistant') {
      const cur = next[i] as AssistantItem
      const existing = cur.toolExecMap[toolCallId]
      const resolved = typeof update === 'function' ? update(existing) : update
      next[i] = {
        ...cur,
        toolExecMap: { ...cur.toolExecMap, [toolCallId]: resolved },
      }
      return next
    }
  }
  return prev
}

// ---------------------------------------------------------------------------
// Pure items reducer (exported for tests)
// ---------------------------------------------------------------------------

/** Apply one SDK event to the items array, returning the new array. */
export function reduceItems(items: RenderItem[], ev: Record<string, unknown>): RenderItem[] {
  switch (ev.type) {
    case 'session_ready': {
      return [...items, { kind: 'system', subtype: 'ready', text: getSystemText(ev) }]
    }
    case 'error': {
      return [...items, { kind: 'system', subtype: 'error', text: getSystemText(ev) }]
    }
    case 'warning': {
      return [...items, { kind: 'system', subtype: 'warning', text: getSystemText(ev) }]
    }
    case 'compaction_start':
    case 'compaction_end':
    case 'auto_retry_start':
    case 'auto_retry_end': {
      return [...items, { kind: 'system', subtype: 'info', text: getSystemText(ev) }]
    }
    case 'turn_start': {
      // Each turn_start creates a fresh AssistantItem.
      // agent_start does not — turn_start always follows it before any message events.
      return [...items, { kind: 'assistant', blocks: [], toolExecMap: {}, complete: false }]
    }
    case 'message_update': {
      const blocks = extractBlocks(ev.message)
      const next = [...items]
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].kind === 'assistant') {
          const cur = next[i] as AssistantItem
          next[i] = { ...cur, blocks }
          return next
        }
      }
      // No existing assistant item — create one (fallback)
      return [...items, { kind: 'assistant', blocks, toolExecMap: {}, complete: false }]
    }
    case 'message_end': {
      // Only mark the last AssistantItem complete for assistant message_end.
      // User message_end arrives before the assistant turn and must not
      // prematurely complete the empty turn block.
      const msg = ev.message as { role?: string } | undefined
      if (msg?.role === 'user') return items
      const next = [...items]
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].kind === 'assistant') {
          const cur = next[i] as AssistantItem
          next[i] = { ...cur, complete: true }
          return next
        }
      }
      return items
    }
    case 'tool_execution_start': {
      const exec: ToolExec = {
        toolCallId: String(ev.toolCallId),
        toolName: String(ev.toolName),
        args: (ev.args as Record<string, unknown>) ?? {},
        output: '',
        done: false,
        isError: false,
      }
      return updateLastAssistantToolExec(items, exec.toolCallId, exec)
    }
    case 'tool_execution_update': {
      const toolCallId = String(ev.toolCallId)
      const partial = extractResultText(ev.partialResult)
      return updateLastAssistantToolExec(items, toolCallId, existing => ({
        ...(existing ?? { toolCallId, toolName: '', args: {}, output: '', done: false, isError: false }),
        output: partial,
      }))
    }
    case 'tool_execution_end': {
      const toolCallId = String(ev.toolCallId)
      const resultStr = extractResultText(ev.result)
      return updateLastAssistantToolExec(items, toolCallId, existing => ({
        ...(existing ?? { toolCallId, toolName: '', args: {}, output: '', done: false, isError: false }),
        output: resultStr,
        done: true,
        isError: Boolean(ev.isError),
      }))
    }
    // agent_end, queue_update, session_info_changed, thinking_level_changed, turn_end,
    // message_start: no items change
    default:
      return items
  }
}

// ---------------------------------------------------------------------------
// WebSocket reconnect logic
// ---------------------------------------------------------------------------

const WS_BASE_MS = 500
const WS_CAP_MS = 8000
// Auto-scroll threshold: only scroll to bottom when within this many px of the bottom.
const SCROLL_NEAR_BOTTOM_PX = 60

function wsUrl(sessionId: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws/${sessionId}`
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ToolBlock({ block, exec }: { block: ToolCallContent; exec: ToolExec | undefined }) {
  const name = block.name
  const argsStr = (() => {
    try { return JSON.stringify(block.arguments) } catch { return '' }
  })()

  const statusLine = !exec
    ? '⋯ waiting'
    : exec.done
      ? (exec.isError ? '✗ error' : '✓ done')
      : '⋯ running'

  return (
    <div class="pi-session-tool">
      <div class="pi-session-tool-header">┌─ {name} {'─'.repeat(Math.max(0, 42 - name.length))}</div>
      {argsStr && <div class="pi-session-tool-args">│ {argsStr}</div>}
      {exec && exec.output && exec.output.split('\n').map((line, i) => (
        <div key={i} class="pi-session-tool-output">│ {line}</div>
      ))}
      <div class={`pi-session-tool-footer ${exec?.isError ? 'pi-session-tool-error' : exec?.done ? 'pi-session-tool-done' : ''}`}>
        └─ {statusLine} {'─'.repeat(Math.max(0, 40 - statusLine.length))}
      </div>
    </div>
  )
}

/** Extract model + thinkingLevel from a session_ready event. Exported for tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseSessionInfo(ev: any): { model: string; thinkingLevel: string } | null {
  if (ev?.type !== 'session_ready') return null
  return { model: String(ev.model ?? ''), thinkingLevel: String(ev.thinkingLevel ?? '') }
}

export function ThinkingBlock({ block, forceOpen }: { block: ThinkingContent; forceOpen?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div class="pi-session-thinking">
      <button
        class="pi-session-thinking-toggle"
        onClick={() => setOpen(o => !o)}
        type="button"
      >
        {open ? '▾' : '▸'} ⟨thinking⟩
      </button>
      {(forceOpen || open) && (
        <div class="pi-session-thinking-body">
          {block.redacted ? '(redacted)' : block.thinking}
        </div>
      )}
    </div>
  )
}

/**
 * Collapsible container wrapping one SDK turn (one AssistantItem).
 * - Prose (text blocks) is always visible regardless of collapse state.
 * - Collapse only hides tool call rows.
 * - Collapsed summary: ▶ read ×2 · bash ×1
 * - NOTE: no overflow property — would break position:sticky on ancestor user prompt.
 */
function TurnBlock({ item, expandAllThinking }: { item: AssistantItem; expandAllThinking?: boolean }) {
  const [expanded, setExpanded] = useState(true)

  // Count tool calls by name for collapsed summary
  const toolCounts: Record<string, number> = {}
  for (const block of item.blocks) {
    if (block.type === 'toolCall') {
      toolCounts[block.name] = (toolCounts[block.name] ?? 0) + 1
    }
  }
  const hasTools = Object.keys(toolCounts).length > 0
  const summaryText = Object.entries(toolCounts)
    .map(([name, count]) => `${name} ×${count}`)
    .join(' · ')

  return (
    <div class="pi-session-turn-block">
      {hasTools && (
        <button
          class={`pi-session-turn-block-toggle${expanded ? '' : ' pi-session-turn-block-collapsed'}`}
          type="button"
          onClick={() => setExpanded(e => !e)}
          aria-label={expanded ? 'collapse turn' : 'expand turn'}
        >
          {expanded ? '▾' : `▶ ${summaryText}`}
        </button>
      )}
      <div class="pi-session-item pi-session-item-assistant">
        {item.blocks.map((block, i) => {
          if (block.type === 'text') {
            return <div key={i} class="pi-session-text">{block.text}</div>
          }
          if (block.type === 'thinking') {
            return <ThinkingBlock key={i} block={block} forceOpen={expandAllThinking} />
          }
          if (block.type === 'toolCall') {
            // Tool rows are hidden when collapsed; prose always visible
            if (!expanded) return null
            return <ToolBlock key={i} block={block} exec={item.toolExecMap[block.id]} />
          }
          return null
        })}
        {!item.complete && <span class="pi-session-cursor">▌</span>}
      </div>
    </div>
  )
}

function RenderItemView({ item, isSticky, expandAllThinking }: { item: RenderItem; isSticky?: boolean; expandAllThinking?: boolean }) {
  if (item.kind === 'user') {
    return (
      <div class={`pi-session-item pi-session-item-user${isSticky ? ' pi-session-sticky-prompt' : ''}`}>
        <span class="pi-session-prompt-prefix">&gt; </span>{item.text}
      </div>
    )
  }
  if (item.kind === 'assistant') {
    return <TurnBlock item={item} expandAllThinking={expandAllThinking} />
  }
  // system
  return (
    <div class={`pi-session-item pi-session-item-system pi-session-item-system-${item.subtype}`}>
      · {item.text}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Jump-to-bottom for pi-session (uses a messages container ref, not WTerm)
// ---------------------------------------------------------------------------

function PiJumpToBottom({ containerRef }: { containerRef: RefObject<HTMLDivElement> }) {
  const [atBottom, setAtBottom] = useState(true)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => {
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_NEAR_BOTTOM_PX)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    return () => el.removeEventListener('scroll', update)
    // containerRef is a stable ref object; effect runs once after mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (atBottom) return null
  return (
    <button
      type="button"
      class="jump-to-bottom"
      aria-label="Jump to bottom"
      title="Jump to bottom"
      onClick={() => {
        const el = containerRef.current
        if (el) el.scrollTop = el.scrollHeight
      }}
    >
      ↓
    </button>
  )
}

// ---------------------------------------------------------------------------
// PiSessionView
// ---------------------------------------------------------------------------

interface PiSessionViewProps {
  session: Session
  isActive: boolean
}

export function PiSessionView({ session, isActive }: PiSessionViewProps) {
  const [items, setItems] = useState<RenderItem[]>([])
  const [streaming, setStreaming] = useState(false)
  const [wsState, setWsState] = useState<'connecting' | 'open' | 'lost'>('connecting')
  const [inputText, setInputText] = useState('')
  const [sessionInfo, setSessionInfo] = useState<{ model: string; thinkingLevel: string } | null>(null)
  const [expandAllThinking, setExpandAllThinking] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const retryCountRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const messagesRef = useRef<HTMLDivElement>(null)

  // Derive: index of the last user item — sticky while streaming.
  // This is the prompt that triggered the active agent run.
  const lastUserIndex: number = streaming
    ? items.reduce((idx: number, item, i) => (item.kind === 'user' ? i : idx), -1)
    : -1

  // Conditional auto-scroll: only scroll to bottom when already near the bottom.
  // If the user has scrolled up, new content appends silently.
  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distFromBottom < SCROLL_NEAR_BOTTOM_PX) {
      el.scrollTop = el.scrollHeight
    }
  }, [items])

  // Stable event dispatcher — uses reduceItems for all items changes
  // Stable event dispatcher — uses reduceItems for all items changes
  const dispatchEvent = useCallback((ev: Record<string, unknown>) => {
    // Capture session info from session_ready before reducer
    const info = parseSessionInfo(ev)
    if (info) setSessionInfo(info)

    // Items update via pure reducer
    setItems(prev => reduceItems(prev, ev))

    // Streaming state management (not captured by reduceItems)
    switch (ev.type) {
      case 'agent_start': {
        setStreaming(true)
        break
      }
      case 'agent_end': {
        if (!ev.willRetry) setStreaming(false)
        break
      }
      case 'error': {
        setStreaming(false)
        break
      }
    }
  }, [])

  const connect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onopen = null
      wsRef.current.onmessage = null
      wsRef.current.onclose = null
      wsRef.current.onerror = null
      wsRef.current.close()
      wsRef.current = null
    }
    setWsState('connecting')
    const ws = new WebSocket(wsUrl(session.id))
    wsRef.current = ws

    ws.onopen = () => {
      retryCountRef.current = 0
      setWsState('open')
    }

    ws.onmessage = (ev) => {
      const line = String(ev.data).trim()
      if (!line) return
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        dispatchEvent(parsed)
      } catch {
        // ignore malformed lines
      }
    }

    ws.onclose = () => {
      if (wsRef.current !== ws) return // superseded
      setWsState('lost')
      setStreaming(false)
      const delay = Math.min(WS_BASE_MS * Math.pow(2, retryCountRef.current), WS_CAP_MS)
      retryCountRef.current++
      retryTimerRef.current = setTimeout(connect, delay)
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [session.id, dispatchEvent])

  useEffect(() => {
    connect()
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      if (wsRef.current) {
        wsRef.current.onopen = null
        wsRef.current.onmessage = null
        wsRef.current.onclose = null
        wsRef.current.onerror = null
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [connect])

  const sendMessage = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'prompt', text: trimmed }))
    setItems(prev => [...prev, { kind: 'user', text: trimmed }])
    setInputText('')
  }, [])

  const sendAbort = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'abort' }))
  }, [])

  // Dev helper: expose sendMessage on window for agent-browser eval.
  // window.__gmuxSendMessage('text') sends a message to this session.
  // window.__gmuxLaunchPiSdk(cwd) launches a new pi-sdk session (uses cookie auth).
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any
    w.__gmuxSendMessage = (text: string) => sendMessage(text)
    w.__gmuxLaunchPiSdk = (cwd: string) =>
      fetch('/v1/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ launcher_id: 'pi-sdk', cwd }),
      }).then(r => r.json())
    return () => {
      delete w.__gmuxSendMessage
      delete w.__gmuxLaunchPiSdk
    }
  }, [sendMessage])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(inputText)
    }
  }, [inputText, sendMessage])

  // Derive: whether any assistant item contains a thinking block
  const hasThinking = items.some(
    item => item.kind === 'assistant' && (item as AssistantItem).blocks.some(b => b.type === 'thinking')
  )

  return (
    <div
      class="pi-session"
      style={{ display: isActive ? 'flex' : 'none' }}
    >
      {(sessionInfo || hasThinking) && (
        <div class="pi-session-header">
          {sessionInfo && (
            <span class="pi-session-model-badge">
              {sessionInfo.model}{sessionInfo.thinkingLevel ? ` · ${sessionInfo.thinkingLevel}` : ''}
            </span>
          )}
          {hasThinking && (
            <button
              class="pi-session-expand-thinking"
              type="button"
              onClick={() => setExpandAllThinking(e => !e)}
            >
              {expandAllThinking ? '⟨thinking⟩ ▾' : '⟨thinking⟩ ▸'}
            </button>
          )}
        </div>
      )}
      <div class="pi-session-messages-wrap">
        <div class="pi-session-messages" ref={messagesRef}>
          {items.map((item, i) => (
            <RenderItemView
              key={i}
              item={item}
              isSticky={streaming && i === lastUserIndex}
              expandAllThinking={expandAllThinking}
            />
          ))}
        </div>
        <PiJumpToBottom containerRef={messagesRef} />
      </div>

      <div class="pi-session-input-bar">
        {wsState !== 'open' && (
          <span class={`pi-session-ws-state pi-session-ws-state-${wsState}`}>
            {wsState === 'connecting' ? '⋯ connecting' : '✗ lost'}
          </span>
        )}

        {streaming && (
          <button
            class="pi-session-abort-btn"
            type="button"
            onClick={sendAbort}
          >
            ■ abort
          </button>
        )}

        <input
          class="pi-session-input"
          type="text"
          value={inputText}
          onInput={(e) => setInputText((e.target as HTMLInputElement).value)}
          onKeyDown={handleKeyDown}
          placeholder="message…"
          disabled={wsState !== 'open'}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Export guard used by main.tsx
// ---------------------------------------------------------------------------

/** Returns true for sessions driven by the pi-sdk subprocess adapter. */
export function isPiSDKSession(session: { kind: string }): boolean {
  return session.kind === 'pi-sdk' || session.kind === 'pi-sdk-sbx'
}
