import { describe, it, expect } from 'vitest'
import { parseSessionInfo } from './pi-session'

describe('parseSessionInfo', () => {
  it('extracts model and thinkingLevel from session_ready event', () => {
    const ev = { type: 'session_ready', model: 'claude-sonnet-4', thinkingLevel: 'high' }
    const info = parseSessionInfo(ev)
    expect(info).toEqual({ model: 'claude-sonnet-4', thinkingLevel: 'high' })
  })

  it('returns null for non-session_ready events', () => {
    expect(parseSessionInfo({ type: 'agent_start' })).toBeNull()
    expect(parseSessionInfo(null)).toBeNull()
    expect(parseSessionInfo({ type: 'error', message: 'oops' })).toBeNull()
  })

  it('coerces missing fields to empty strings', () => {
    const info = parseSessionInfo({ type: 'session_ready' })
    expect(info).toEqual({ model: '', thinkingLevel: '' })
  })

  it('coerces numeric fields to strings', () => {
    const info = parseSessionInfo({ type: 'session_ready', model: 42, thinkingLevel: 0 })
    expect(info).toEqual({ model: '42', thinkingLevel: '0' })
  })
})
