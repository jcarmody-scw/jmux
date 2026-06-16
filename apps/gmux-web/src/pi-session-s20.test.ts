import { describe, expect, it } from 'vitest'
import {
  createPromptPayload,
  formatActiveToolStatus,
  initialInputAreaState,
  reduceInputAreaState,
} from './pi-session'

describe('s-20 input area state', () => {
  it('tracks active tool execution for the status bar', () => {
    let state = initialInputAreaState
    state = reduceInputAreaState(state, {
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'bash',
      args: { command: 'npm test' },
    })

    expect(state.activeTools).toEqual([
      { id: 'tool-1', name: 'bash', label: 'bash', detail: 'npm test' },
    ])
    expect(formatActiveToolStatus(state)).toBe('running bash: npm test')

    state = reduceInputAreaState(state, { type: 'tool_execution_end', toolCallId: 'tool-1' })
    expect(state.activeTools).toEqual([])
    expect(formatActiveToolStatus(state)).toBe('')
  })

  it('tracks pending steering and follow-up queue updates', () => {
    const state = reduceInputAreaState(initialInputAreaState, {
      type: 'queue_update',
      steering: ['Focus on tests', 'Then polish UI'],
      followUp: ['Summarize changes'],
    })

    expect(state.steeringQueue).toEqual(['Focus on tests', 'Then polish UI'])
    expect(state.followUpQueue).toEqual(['Summarize changes'])
  })

  it('clears queue state when queue_update sends empty arrays', () => {
    const queued = reduceInputAreaState(initialInputAreaState, {
      type: 'queue_update',
      steering: ['Focus on tests'],
      followUp: ['Summarize changes'],
    })

    const cleared = reduceInputAreaState(queued, {
      type: 'queue_update',
      steering: [],
      followUp: [],
    })

    expect(cleared.steeringQueue).toEqual([])
    expect(cleared.followUpQueue).toEqual([])
  })
})

describe('s-20 prompt payloads', () => {
  it('sends normal prompts without streaming behaviour while idle', () => {
    expect(createPromptPayload('hello', false)).toEqual({ type: 'prompt', text: 'hello' })
  })

  it('sends prompts as steering messages while streaming', () => {
    expect(createPromptPayload('focus on tests', true)).toEqual({
      type: 'prompt',
      text: 'focus on tests',
      streamingBehavior: 'steer',
    })
  })
})
