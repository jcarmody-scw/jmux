import { describe, it, expect } from 'vitest'
import {
  parseDiffStats,
  toolHeadline,
  renderDiffLines,
  reduceItems,
  type AssistantItem,
  type ToolExec,
} from './pi-session'

// ---------------------------------------------------------------------------
// parseDiffStats
// ---------------------------------------------------------------------------

describe('parseDiffStats', () => {
  it('counts added and removed lines', () => {
    const patch = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,4 +1,5 @@',
      ' context',
      '-removed line',
      '-another removed',
      '+added line',
      '+another added',
      '+third added',
      ' context',
    ].join('\n')
    const stats = parseDiffStats(patch)
    expect(stats.added).toBe(3)
    expect(stats.removed).toBe(2)
  })

  it('ignores +++ and --- header lines', () => {
    const patch = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n')
    const stats = parseDiffStats(patch)
    expect(stats.added).toBe(1)
    expect(stats.removed).toBe(1)
  })

  it('returns zero for empty string', () => {
    expect(parseDiffStats('')).toEqual({ added: 0, removed: 0 })
  })

  it('returns zero for patch with only context lines', () => {
    const patch = ' context line\n context line 2'
    expect(parseDiffStats(patch)).toEqual({ added: 0, removed: 0 })
  })
})

// ---------------------------------------------------------------------------
// toolHeadline
// ---------------------------------------------------------------------------

describe('toolHeadline', () => {
  const baseExec = (overrides: Partial<ToolExec> = {}): ToolExec => ({
    toolCallId: 'tc_1',
    toolName: 'bash',
    args: {},
    output: '',
    done: false,
    isError: false,
    ...overrides,
  })

  it('bash — shows full command', () => {
    const exec = baseExec({ toolName: 'bash', done: true, isError: false })
    const args = { command: 'npm test --testPathPattern=auth' }
    const hl = toolHeadline('bash', args, exec)
    expect(hl).toContain('bash')
    expect(hl).toContain('npm test --testPathPattern=auth')
    expect(hl).toContain('✓')
  })

  it('read — shows path', () => {
    const exec = baseExec({ toolName: 'read', done: true, isError: false })
    const args = { path: 'src/auth/token.ts' }
    const hl = toolHeadline('read', args, exec)
    expect(hl).toContain('read')
    expect(hl).toContain('src/auth/token.ts')
    expect(hl).toContain('✓')
  })

  it('edit — shows path and diff stats when done', () => {
    const patch = '--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n-old\n+new\n+extra\n context'
    const exec = baseExec({
      toolName: 'edit',
      done: true,
      isError: false,
      details: { patch },
    })
    const args = { path: 'src/auth/token.ts' }
    const hl = toolHeadline('edit', args, exec)
    expect(hl).toContain('edit')
    expect(hl).toContain('src/auth/token.ts')
    expect(hl).toContain('+2')
    expect(hl).toContain('−1')
    expect(hl).toContain('✓')
  })

  it('edit — shows path without stats when not yet done', () => {
    const exec = baseExec({ toolName: 'edit', done: false, isError: false })
    const args = { path: 'src/auth/token.ts' }
    const hl = toolHeadline('edit', args, exec)
    expect(hl).toContain('edit')
    expect(hl).toContain('src/auth/token.ts')
    expect(hl).toContain('⋯')
  })

  it('write — shows path', () => {
    const exec = baseExec({ toolName: 'write', done: true, isError: false })
    const args = { path: 'src/newfile.ts', content: 'hello' }
    const hl = toolHeadline('write', args, exec)
    expect(hl).toContain('write')
    expect(hl).toContain('src/newfile.ts')
    expect(hl).toContain('✓')
  })

  it('unknown tool — shows name', () => {
    const exec = baseExec({ toolName: 'web_search', done: true, isError: false })
    const args = { query: 'hello' }
    const hl = toolHeadline('web_search', args, exec)
    expect(hl).toContain('web_search')
    expect(hl).toContain('✓')
  })

  it('status: error', () => {
    const exec = baseExec({ toolName: 'bash', done: true, isError: true })
    const hl = toolHeadline('bash', { command: 'exit 1' }, exec)
    expect(hl).toContain('✗')
  })

  it('status: running (exec exists, not done)', () => {
    const exec = baseExec({ toolName: 'bash', done: false, isError: false })
    const hl = toolHeadline('bash', { command: 'sleep 1' }, exec)
    expect(hl).toContain('⋯')
  })

  it('status: waiting (no exec)', () => {
    const hl = toolHeadline('bash', { command: 'sleep 1' }, undefined)
    expect(hl).toContain('⋯')
  })
})

// ---------------------------------------------------------------------------
// renderDiffLines
// ---------------------------------------------------------------------------

describe('renderDiffLines', () => {
  const patch = [
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -1,3 +1,3 @@',
    ' context',
    '-removed',
    '+added',
    ' context2',
  ].join('\n')

  it('tags addition lines with diff-add class', () => {
    const lines = renderDiffLines(patch)
    const added = lines.filter(l => l.cls === 'pi-session-tool-diff-add')
    expect(added).toHaveLength(1)
    expect(added[0].text).toBe('+added')
  })

  it('tags deletion lines with diff-del class', () => {
    const lines = renderDiffLines(patch)
    const deleted = lines.filter(l => l.cls === 'pi-session-tool-diff-del')
    expect(deleted).toHaveLength(1)
    expect(deleted[0].text).toBe('-removed')
  })

  it('tags hunk headers with diff-meta class', () => {
    const lines = renderDiffLines(patch)
    const meta = lines.filter(l => l.cls === 'pi-session-tool-diff-meta')
    expect(meta.length).toBeGreaterThanOrEqual(1)
    expect(meta.some(l => l.text.startsWith('@@'))).toBe(true)
  })

  it('context lines and headers have no special class', () => {
    const lines = renderDiffLines(patch)
    const plain = lines.filter(l => l.cls === '')
    // context lines + --- and +++ header lines
    expect(plain.length).toBeGreaterThan(0)
  })

  it('returns empty array for empty string', () => {
    expect(renderDiffLines('')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// reduceItems — details captured on tool_execution_end
// ---------------------------------------------------------------------------

describe('reduceItems — details captured', () => {
  it('stores details from tool_execution_end result', () => {
    const patch = '--- a/f\n+++ b/f\n-old\n+new'
    let items = reduceItems([], { type: 'turn_start' })
    items = reduceItems(items, {
      type: 'tool_execution_start',
      toolCallId: 'tc_1',
      toolName: 'edit',
      args: { path: 'src/foo.ts' },
    })
    items = reduceItems(items, {
      type: 'tool_execution_end',
      toolCallId: 'tc_1',
      toolName: 'edit',
      result: {
        content: [{ type: 'text', text: 'changed' }],
        details: { patch, diff: 'display diff', firstChangedLine: 3 },
      },
      isError: false,
    })

    const assistant = items.find(i => i.kind === 'assistant') as AssistantItem
    const exec = assistant.toolExecMap.tc_1
    expect(exec).toBeDefined()
    expect(exec.details).toEqual({ patch, diff: 'display diff', firstChangedLine: 3 })
    expect(exec.done).toBe(true)
    expect(exec.output).toBe('changed')
  })

  it('details is undefined when result has no details', () => {
    let items = reduceItems([], { type: 'turn_start' })
    items = reduceItems(items, {
      type: 'tool_execution_start',
      toolCallId: 'tc_2',
      toolName: 'bash',
      args: { command: 'ls' },
    })
    items = reduceItems(items, {
      type: 'tool_execution_end',
      toolCallId: 'tc_2',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'file.ts' }] },
      isError: false,
    })

    const assistant = items.find(i => i.kind === 'assistant') as AssistantItem
    const exec = assistant.toolExecMap.tc_2
    expect(exec.details).toBeUndefined()
  })
})
