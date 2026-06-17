import { describe, expect, it } from 'vitest'
import {
  commandOutputLines,
  promptInputMaxRows,
  promptInputOverflowY,
  promptInputRowsForText,
  turnBlockSummary,
  turnBlockToggleLabel,
} from './pi-session'

describe('pi-session follow-up UI polish helpers', () => {
  it('caps prompt input expansion at six rows', () => {
    expect(promptInputMaxRows).toBe(6)
    expect(promptInputRowsForText('one')).toBe(1)
    expect(promptInputRowsForText('1\n2\n3\n4\n5\n6')).toBe(6)
    expect(promptInputRowsForText('1\n2\n3\n4\n5\n6\n7\n8')).toBe(6)
  })

  it('hides the prompt scrollbar until text exceeds six rows', () => {
    expect(promptInputOverflowY('one')).toBe('hidden')
    expect(promptInputOverflowY('1\n2\n3\n4\n5\n6')).toBe('hidden')
    expect(promptInputOverflowY('1\n2\n3\n4\n5\n6\n7')).toBe('auto')
  })

  it('splits command output text into lines for one prefix per output block', () => {
    expect(commandOutputLines('a\nb\nc')).toEqual(['a', 'b', 'c'])
  })

  it('summarizes thinking and tool blocks together for collapsed turns', () => {
    expect(turnBlockSummary([
      { type: 'thinking', thinking: 'plan' },
      { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: {} },
      { type: 'toolCall', id: 'tc-2', name: 'read', arguments: {} },
      { type: 'text', text: 'visible prose' },
    ])).toBe('thinking ×1 · bash ×1 · read ×1')
  })

  it('labels the turn toggle with the summary when expanded and collapsed', () => {
    expect(turnBlockToggleLabel(true, 'thinking ×1 · bash ×1')).toBe('▾ thinking ×1 · bash ×1')
    expect(turnBlockToggleLabel(false, 'thinking ×1 · bash ×1')).toBe('▶ thinking ×1 · bash ×1')
  })
})
