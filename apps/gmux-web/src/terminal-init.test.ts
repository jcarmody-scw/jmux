import { describe, it, expect } from 'vitest'

describe('terminal prefetch cache', () => {
  it('exports prefetchCache as an empty Map', async () => {
    const { prefetchCache } = await import('./terminal-init')
    expect(prefetchCache).toBeInstanceOf(Map)
    expect(prefetchCache.size).toBe(0)
  })
})

