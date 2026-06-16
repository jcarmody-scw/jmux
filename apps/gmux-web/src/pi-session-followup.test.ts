import { describe, expect, it } from 'vitest'
import {
  commandOutputLines,
  promptInputMaxRows,
  promptInputRowsForText,
  turnBlockSummary,
} from './pi-session'

describe('pi-session follow-up UI polish helpers', () => {
  it('caps prompt input expansion at six rows', () => {
    expect(promptInputMaxRows).toBe(6)
    expect(promptInputRowsForText('one')).toBe(1)
    expect(promptInputRowsForText('1\n2\n3\n4\n5\n6')).toBe(6)
    expect(promptInputRowsForText('1\n2\n3\n4\n5\n6\n7\n8')).toBe(6)
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
})
