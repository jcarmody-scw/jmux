import { describe, it, expect } from 'vitest'
import { sessionEnvironmentIcon, sidebarVisibleSessions } from './sidebar'

describe('sessionEnvironmentIcon', () => {
  it('returns sandbox icon for pi-sbx kind', () => {
    expect(sessionEnvironmentIcon('pi-sbx')).toBe('🏖️')
  })

  it('returns host icon for pi kind', () => {
    expect(sessionEnvironmentIcon('pi')).toBe('🏡')
  })

  it('returns host icon for shell kind', () => {
    expect(sessionEnvironmentIcon('shell')).toBe('🏡')
  })

  it('returns host icon for claude kind', () => {
    expect(sessionEnvironmentIcon('claude')).toBe('🏡')
  })

  it('returns host icon for codex kind', () => {
    expect(sessionEnvironmentIcon('codex')).toBe('🏡')
  })

  it('returns host icon for unknown kinds', () => {
    expect(sessionEnvironmentIcon('anything-else')).toBe('🏡')
  })

  it('returns rpc icon for pi-rpc kind', () => {
    expect(sessionEnvironmentIcon('pi-rpc')).toBe('⚡')
  })

  it('returns sandbox rpc icon for pi-rpc-sbx kind', () => {
    expect(sessionEnvironmentIcon('pi-rpc-sbx')).toBe('🏖️⚡')
  })
})

describe('sidebarVisibleSessions', () => {
  it('shows only alive sessions', () => {
    const alive = { id: 'alive', alive: true } as any
    const dead = { id: 'dead', alive: false } as any
    const resumable = { id: 'resumable', alive: false, resumable: true } as any

    expect(sidebarVisibleSessions([alive, dead, resumable])).toEqual([alive])
  })
})
