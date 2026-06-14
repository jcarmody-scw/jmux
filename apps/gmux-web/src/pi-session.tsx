// PiSessionView — terminal-style chat UI for pi-rpc and pi-rpc-sbx sessions.
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
  details?: unknown
  done: boolean
  isError: boolean
}

export type ToolExecMap = Record<string, ToolExec>

export interface ActiveToolStatus {
  id: string
  name: string
  label: string
  detail: string
}

export interface InputAreaState {
  activeTools: ActiveToolStatus[]
  steeringQueue: string[]
  followUpQueue: string[]
}

export const initialInputAreaState: InputAreaState = {
  activeTools: [],
  steeringQueue: [],
  followUpQueue: [],
}

export interface PromptPayload {
  type: 'prompt'
  text: string
  streamingBehavior?: 'steer'
}

// ---------------------------------------------------------------------------
// Render items
// ---------------------------------------------------------------------------

interface UserItem {
  kind: 'user'
  text: string
}

export type CommandStatus = 'pending' | 'accepted' | 'handled' | 'error' | 'unknown'

export interface CommandItem {
  kind: 'command'
  text: string
  label: string
  args: string
  status: CommandStatus
  statusText: string
}

export interface CommandOutputItem {
  kind: 'command-output'
  subtype: 'info' | 'warning' | 'error'
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

export type RenderItem = UserItem | CommandItem | CommandOutputItem | AssistantItem | SystemItem

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

/** Return true when text is a non-empty slash command such as /help or /model sonnet. */
export function isSlashCommand(text: string): boolean {
  const trimmed = text.trimStart().trimEnd()
  return /^\/\S+/.test(trimmed) && trimmed !== '/'
}

/** Return the slash command token for display, for example /model from /model sonnet. */
export function slashCommandLabel(text: string): string {
  const trimmed = text.trimStart()
  const token = trimmed.split(/\s+/, 1)[0]
  return /^\/\S+/.test(token) && token !== '/' ? token : '/command'
}

/** Return the arguments after the slash command token, for example sonnet from /model sonnet. */
export function slashCommandArgs(text: string): string {
  const trimmed = text.trimStart()
  const label = slashCommandLabel(trimmed)
  if (label === '/command') return ''
  return trimmed.slice(label.length).trimStart()
}

function commandNameFromLabel(label: string): string {
  return label.startsWith('/') ? label.slice(1) : label
}

function commandStatusForLabel(label: string, knownCommands?: ReadonlySet<string>): Pick<CommandItem, 'status' | 'statusText'> {
  if (knownCommands && !knownCommands.has(commandNameFromLabel(label))) {
    return { status: 'unknown', statusText: 'unknown command' }
  }
  return { status: 'pending', statusText: 'running' }
}

/** Create the local render item shown after user input is sent. */
export function inputItemForText(text: string, knownCommands?: ReadonlySet<string>): UserItem | CommandItem {
  const trimmed = text.trim()
  if (isSlashCommand(trimmed)) {
    const label = slashCommandLabel(trimmed)
    return {
      kind: 'command',
      text: trimmed,
      label,
      args: slashCommandArgs(trimmed),
      ...commandStatusForLabel(label, knownCommands),
    }
  }
  return { kind: 'user', text: trimmed }
}

/** Extract command names from a pi-rpc get_commands response. */
export function extractCommandNames(ev: Record<string, unknown>): string[] | null {
  if (ev.type !== 'response' || ev.command !== 'get_commands' || ev.success !== true) return null
  const data = ev.data as { commands?: Array<{ name?: unknown }> } | undefined
  if (!Array.isArray(data?.commands)) return []
  return data.commands
    .map(command => command.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
}

function toolDetail(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'bash':
      return String(args.command ?? '')
    case 'read':
    case 'edit':
    case 'write':
      return String(args.path ?? '')
    default:
      return ''
  }
}

export function reduceInputAreaState(state: InputAreaState, ev: Record<string, unknown>): InputAreaState {
  switch (ev.type) {
    case 'tool_execution_start': {
      const id = String(ev.toolCallId)
      const name = String(ev.toolName)
      const args = (ev.args as Record<string, unknown>) ?? {}
      const active: ActiveToolStatus = {
        id,
        name,
        label: name,
        detail: toolDetail(name, args),
      }
      return {
        ...state,
        activeTools: [...state.activeTools.filter(tool => tool.id !== id), active],
      }
    }
    case 'tool_execution_end': {
      const id = String(ev.toolCallId)
      return { ...state, activeTools: state.activeTools.filter(tool => tool.id !== id) }
    }
    case 'queue_update': {
      return {
        ...state,
        steeringQueue: Array.isArray(ev.steering) ? ev.steering.map(String) : state.steeringQueue,
        followUpQueue: Array.isArray(ev.followUp) ? ev.followUp.map(String) : state.followUpQueue,
      }
    }
    case 'agent_end':
    case 'error':
      return { ...state, activeTools: [] }
    default:
      return state
  }
}

export function formatActiveToolStatus(state: InputAreaState): string {
  if (!state.activeTools.length) return ''
  if (state.activeTools.length === 1) {
    const tool = state.activeTools[0]
    return tool.detail ? `running ${tool.label}: ${tool.detail}` : `running ${tool.label}`
  }
  return `running ${state.activeTools.length} tools`
}

export function createPromptPayload(text: string, isStreaming: boolean): PromptPayload {
  return isStreaming
    ? { type: 'prompt', text, streamingBehavior: 'steer' }
    : { type: 'prompt', text }
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
// Exported pure helpers for tool call rendering (s-19)
// ---------------------------------------------------------------------------

/** Count added/removed lines in a unified diff string. */
export function parseDiffStats(patch: string): { added: number; removed: number } {
  let added = 0, removed = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

/** Return the one-line collapsed summary for a tool call row. */
export function toolHeadline(
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>,
  exec: ToolExec | undefined,
): string {
  const status = !exec
    ? '⋯ waiting'
    : exec.done
      ? (exec.isError ? '✗ error' : '✓ done')
      : '⋯ running'

  switch (toolName) {
    case 'bash': {
      const cmd = String(args.command ?? '')
      return `bash  ${cmd}  ${status}`
    }
    case 'read': {
      const p = String(args.path ?? '')
      return `read  ${p}  ${status}`
    }
    case 'edit': {
      const p = String(args.path ?? '')
      if (exec?.done && !exec.isError) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const patch = (exec.details as any)?.patch ?? ''
        const { added, removed } = parseDiffStats(patch)
        return `edit  ${p}  +${added} −${removed}  ${status}`
      }
      return `edit  ${p}  ${status}`
    }
    case 'write': {
      const p = String(args.path ?? '')
      return `write  ${p}  ${status}`
    }
    default: {
      return `${toolName}  ${status}`
    }
  }
}

/** Parse a unified diff into renderable lines tagged with a CSS class. */
export function renderDiffLines(patch: string): Array<{ cls: string; text: string }> {
  if (!patch) return []
  return patch.split('\n').map(line => {
    if (line.startsWith('+') && !line.startsWith('+++')) return { cls: 'pi-session-tool-diff-add', text: line }
    if (line.startsWith('-') && !line.startsWith('---')) return { cls: 'pi-session-tool-diff-del', text: line }
    if (line.startsWith('@@')) return { cls: 'pi-session-tool-diff-meta', text: line }
    return { cls: '', text: line }
  })
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

function updateLastCommandItem(
  prev: RenderItem[],
  update: (item: CommandItem) => CommandItem,
  options: { includeUnknown?: boolean } = {},
): RenderItem[] {
  const next = [...prev]
  for (let i = next.length - 1; i >= 0; i--) {
    const item = next[i]
    if (item.kind === 'command') {
      const cur = item as CommandItem
      if (cur.status === 'unknown' && !options.includeUnknown) return prev
      next[i] = update(cur)
      return next
    }
    if (item.kind !== 'command-output') return prev
  }
  return prev
}

function commandOutputFromNotify(ev: Record<string, unknown>): CommandOutputItem | null {
  if (ev.type !== 'extension_ui_request' || ev.method !== 'notify') return null
  const notifyType = ev.notifyType === 'warning' || ev.notifyType === 'error' ? ev.notifyType : 'info'
  const message = String(ev.message ?? '')
  if (!message) return null
  return { kind: 'command-output', subtype: notifyType, text: message }
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        details: (ev.result as any)?.details ?? undefined,
        done: true,
        isError: Boolean(ev.isError),
      }))
    }
    case 'response': {
      if (ev.command !== 'prompt') return items
      const success = ev.success === true
      return updateLastCommandItem(items, item => ({
        ...item,
        status: success ? 'accepted' : 'error',
        statusText: success ? 'accepted' : String(ev.error ?? 'command failed'),
      }), { includeUnknown: !success })
    }
    case 'extension_ui_request': {
      const output = commandOutputFromNotify(ev)
      if (!output) return items
      const withHandledCommand = updateLastCommandItem(items, item => ({
        ...item,
        status: item.status === 'error' || item.status === 'unknown' ? item.status : 'handled',
        statusText: item.status === 'error' || item.status === 'unknown' ? item.statusText : 'output',
      }), { includeUnknown: true })
      return [...withHandledCommand, output]
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
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  // In dev (vite), VITE_DEV_PROXY_PORT is the daemon port and location.port is
  // the vite port. Connect directly to the daemon so auth cookies (which are
  // not port-scoped) are included and we don't rely on vite WS proxying.
  const daemonPort = import.meta.env.VITE_DEV_PROXY_PORT as string | undefined
  const host = (daemonPort && daemonPort !== location.port)
    ? `${location.hostname}:${daemonPort}`
    : location.host
  return `${wsProto}//${host}/ws/${sessionId}`
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ToolBlock({ block, exec }: { block: ToolCallContent; exec: ToolExec | undefined }) {
  const [open, setOpen] = useState(false)
  const headline = toolHeadline(block.name, block.arguments, exec)

  // Determine whether there is any detail content to show
  const hasDetail = !!(exec && (exec.output || (block.name === 'write' && block.arguments.content)))

  // Detail panel content varies by tool
  function DetailContent() {
    if (!exec) return null
    if (block.name === 'edit') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const patch = (exec.details as any)?.patch ?? ''
      const lines = renderDiffLines(patch)
      if (!lines.length) return <span class="pi-session-tool-detail-empty">(no diff)</span>
      return (
        <>
          {lines.map((l, i) => (
            <span key={i} class={l.cls || 'pi-session-tool-diff-ctx'}>{l.text}{"\n"}</span>
          ))}
        </>
      )
    }
    if (block.name === 'write') {
      const content = String(block.arguments.content ?? '')
      return <>{content}</>
    }
    // bash, read, and fallback: plain output
    return <>{exec.output || '(no output)'}</>
  }

  return (
    <div class="pi-session-tool-row">
      <button
        class={`pi-session-tool-headline${exec?.isError ? ' pi-session-tool-headline-err' : exec?.done ? ' pi-session-tool-headline-done' : ''}`}
        type="button"
        onClick={() => hasDetail && setOpen(o => !o)}
        style={hasDetail ? undefined : { cursor: 'default' }}
      >
        <span class="pi-session-tool-chevron">{open ? '▼' : '▶'}</span>
        {headline}
      </button>
      {open && hasDetail && (
        <pre class="pi-session-tool-detail">
          <DetailContent />
        </pre>
      )}
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
  if (item.kind === 'command') {
    return (
      <div class={`pi-session-item pi-session-item-command pi-session-item-command-${item.status}`}>
        <span class="pi-session-command-label">{item.label}</span>
        {item.args && <span class="pi-session-command-args">{item.args}</span>}
        <span class="pi-session-command-status">{item.statusText}</span>
      </div>
    )
  }
  if (item.kind === 'command-output') {
    return (
      <div class={`pi-session-item pi-session-command-output pi-session-command-output-${item.subtype}`}>
        <span class="pi-session-command-output-prefix">↳</span>
        <span class="pi-session-command-output-text">{item.text}</span>
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
  const [commandNames, setCommandNames] = useState<Set<string> | null>(null)
  const [inputArea, setInputArea] = useState<InputAreaState>(initialInputAreaState)

  const wsRef = useRef<WebSocket | null>(null)
  const retryCountRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const messagesRef = useRef<HTMLDivElement>(null)

  // Derive: index of the last user or command item — sticky while streaming.
  // This is the prompt or command that triggered the active agent run.
  const lastUserIndex: number = streaming
    ? items.reduce((idx: number, item, i) => (item.kind === 'user' || item.kind === 'command' ? i : idx), -1)
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
    // Capture session info and command registry before reducer
    const info = parseSessionInfo(ev)
    if (info) setSessionInfo(info)
    const names = extractCommandNames(ev)
    if (names) setCommandNames(new Set(names))

    // Items update via pure reducer
    setItems(prev => reduceItems(prev, ev))

    setInputArea(prev => reduceInputAreaState(prev, ev))
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
      ws.send(JSON.stringify({ id: 'gmux-web-get-commands', type: 'get_commands' }))
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
    ws.send(JSON.stringify(createPromptPayload(trimmed, streaming)))
    setItems(prev => [...prev, inputItemForText(trimmed, commandNames ?? undefined)])
    setInputText('')
  }, [commandNames, streaming])

  const sendAbort = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'abort' }))
  }, [])

  // Dev helper: expose sendMessage on window for agent-browser eval.
  // window.__gmuxSendMessage('text') sends a message to this session.
  // window.__gmuxLaunchPiRpc(cwd) launches a new pi-rpc session (uses cookie auth).
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any
    w.__gmuxSendMessage = (text: string) => sendMessage(text)
    w.__gmuxLaunchPiRpc = (cwd: string) =>
      fetch('/v1/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ launcher_id: 'pi-rpc', cwd }),
      }).then(r => r.json())
    return () => {
      delete w.__gmuxSendMessage
      delete w.__gmuxLaunchPiRpc
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
  const activeToolStatus = formatActiveToolStatus(inputArea)
  const hasPendingQueue = inputArea.steeringQueue.length > 0 || inputArea.followUpQueue.length > 0
  const inputPlaceholder = streaming ? 'steer the running turn…' : 'message…'

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

      {(activeToolStatus || hasPendingQueue) && (
        <div class="pi-session-input-status">
          {activeToolStatus && <span class="pi-session-active-tool-status">{activeToolStatus}</span>}
          {inputArea.steeringQueue.length > 0 && (
            <span class="pi-session-queue-chip">steer ×{inputArea.steeringQueue.length}: {inputArea.steeringQueue[0]}</span>
          )}
          {inputArea.followUpQueue.length > 0 && (
            <span class="pi-session-queue-chip">follow-up ×{inputArea.followUpQueue.length}: {inputArea.followUpQueue[0]}</span>
          )}
        </div>
      )}
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
          placeholder={inputPlaceholder}
          disabled={wsState !== 'open'}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Export guard used by main.tsx
// ---------------------------------------------------------------------------

/** Returns true for sessions driven by the pi-rpc subprocess adapter. */
export function isPiRPCSession(session: { kind: string }): boolean {
  return session.kind === 'pi-rpc' || session.kind === 'pi-rpc-sbx'
}
