/**
 * s-22: Session header and sidebar — decision log, retry states, compaction notices.
 *
 * Tests for:
 *   - reducePiHeaderState — pure reducer for compaction/retry header state
 *   - formatPiHeaderBadges — derives badge strings from PiHeaderState
 */
import { describe, it, expect } from 'vitest'
import {
  reducePiHeaderState,
  formatPiHeaderBadges,
  initialPiHeaderState,
  type PiHeaderState,
} from './pi-session'

// ---------------------------------------------------------------------------
// reducePiHeaderState — compaction events
// ---------------------------------------------------------------------------

describe('reducePiHeaderState — compaction', () => {
  it('starts in clean state', () => {
    const state = initialPiHeaderState
    expect(state.compacting).toBe(false)
    expect(state.lastCompactionResult).toBeNull()
  })

  it('sets compacting=true on compaction_start', () => {
    const state = reducePiHeaderState(initialPiHeaderState, {
      type: 'compaction_start',
      reason: 'threshold',
    })
    expect(state.compacting).toBe(true)
    expect(state.lastCompactionResult).toBeNull()
  })

  it('clears compacting and sets result on compaction_end success', () => {
    const active = reducePiHeaderState(initialPiHeaderState, { type: 'compaction_start', reason: 'threshold' })
    const done = reducePiHeaderState(active, { type: 'compaction_end', aborted: false })
    expect(done.compacting).toBe(false)
    expect(done.lastCompactionResult).toBe('done')
  })

  it('clears compacting and sets result on compaction_end aborted', () => {
    const active = reducePiHeaderState(initialPiHeaderState, { type: 'compaction_start', reason: 'threshold' })
    const done = reducePiHeaderState(active, { type: 'compaction_end', aborted: true })
    expect(done.compacting).toBe(false)
    expect(done.lastCompactionResult).toBe('aborted')
  })

  it('clears compaction result on next compaction_start', () => {
    const firstDone = reducePiHeaderState(
      reducePiHeaderState(initialPiHeaderState, { type: 'compaction_start', reason: 'x' }),
      { type: 'compaction_end', aborted: false },
    )
    const secondStart = reducePiHeaderState(firstDone, { type: 'compaction_start', reason: 'y' })
    expect(secondStart.compacting).toBe(true)
    expect(secondStart.lastCompactionResult).toBeNull()
  })

  it('ignores unrelated events', () => {
    const state = reducePiHeaderState(initialPiHeaderState, { type: 'session_ready', model: 'claude' })
    expect(state).toEqual(initialPiHeaderState)
  })
})

// ---------------------------------------------------------------------------
// reducePiHeaderState — retry events
// ---------------------------------------------------------------------------

describe('reducePiHeaderState — retry', () => {
  it('sets retrying=true and captures attempt details on auto_retry_start', () => {
    const state = reducePiHeaderState(initialPiHeaderState, {
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 500,
      errorMessage: 'overload',
    })
    expect(state.retrying).toBe(true)
    expect(state.retryAttempt).toBe(1)
    expect(state.retryMax).toBe(3)
    expect(state.lastRetryResult).toBeNull()
  })

  it('clears retrying and sets success on auto_retry_end success', () => {
    const active = reducePiHeaderState(initialPiHeaderState, {
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 500,
    })
    const done = reducePiHeaderState(active, {
      type: 'auto_retry_end',
      success: true,
      attempt: 1,
    })
    expect(done.retrying).toBe(false)
    expect(done.lastRetryResult).toBe('success')
  })

  it('clears retrying and sets failure on auto_retry_end failure', () => {
    const active = reducePiHeaderState(initialPiHeaderState, {
      type: 'auto_retry_start',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1000,
    })
    const done = reducePiHeaderState(active, {
      type: 'auto_retry_end',
      success: false,
      attempt: 2,
      finalError: 'gave up',
    })
    expect(done.retrying).toBe(false)
    expect(done.lastRetryResult).toBe('failed')
  })

  it('retains attempt/max after retry ends', () => {
    const active = reducePiHeaderState(initialPiHeaderState, {
      type: 'auto_retry_start',
      attempt: 2,
      maxAttempts: 4,
      delayMs: 500,
    })
    const done = reducePiHeaderState(active, { type: 'auto_retry_end', success: true, attempt: 2 })
    expect(done.retryAttempt).toBe(2)
    expect(done.retryMax).toBe(4)
  })

  it('clears retry result on next auto_retry_start', () => {
    let state = reducePiHeaderState(initialPiHeaderState, { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 0 })
    state = reducePiHeaderState(state, { type: 'auto_retry_end', success: false, attempt: 1, finalError: 'err' })
    state = reducePiHeaderState(state, { type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 500 })
    expect(state.retrying).toBe(true)
    expect(state.retryAttempt).toBe(2)
    expect(state.lastRetryResult).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// reducePiHeaderState — decision log events
// ---------------------------------------------------------------------------

describe('reducePiHeaderState — decision log', () => {
  it('records decision events from note text', () => {
    const state = reducePiHeaderState(initialPiHeaderState, {
      type: 'decision',
      note: 'Use sidebar badges for retry state',
    })
    expect(state.decisions).toEqual(['Use sidebar badges for retry state'])
  })

  it('records decision_log events from message text', () => {
    const state = reducePiHeaderState(initialPiHeaderState, {
      type: 'decision_log',
      message: 'Keep compaction notices in the session header',
    })
    expect(state.decisions).toEqual(['Keep compaction notices in the session header'])
  })

  it('records task log decision events', () => {
    const state = reducePiHeaderState(initialPiHeaderState, {
      type: 'task_log',
      kind: 'DECISION',
      text: 'Show three recent decisions only',
    })
    expect(state.decisions).toEqual(['Show three recent decisions only'])
  })

  it('keeps the three most recent unique decisions', () => {
    let state = initialPiHeaderState
    state = reducePiHeaderState(state, { type: 'decision', note: 'first' })
    state = reducePiHeaderState(state, { type: 'decision', note: 'second' })
    state = reducePiHeaderState(state, { type: 'decision', note: 'third' })
    state = reducePiHeaderState(state, { type: 'decision', note: 'fourth' })
    state = reducePiHeaderState(state, { type: 'decision', note: 'second' })
    expect(state.decisions).toEqual(['second', 'fourth', 'third'])
  })

  it('ignores non-decision log events', () => {
    const state = reducePiHeaderState(initialPiHeaderState, {
      type: 'task_log',
      kind: 'PROGRESS',
      text: 'Implemented UI',
    })
    expect(state.decisions).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// formatPiHeaderBadges
// ---------------------------------------------------------------------------

describe('formatPiHeaderBadges', () => {
  it('returns empty array for clean state', () => {
    expect(formatPiHeaderBadges(initialPiHeaderState)).toEqual([])
  })

  it('returns compacting badge during compaction', () => {
    const state: PiHeaderState = {
      ...initialPiHeaderState,
      compacting: true,
    }
    const badges = formatPiHeaderBadges(state)
    expect(badges).toHaveLength(1)
    expect(badges[0]).toMatch(/compact/i)
  })

  it('returns done badge after successful compaction', () => {
    const state: PiHeaderState = {
      ...initialPiHeaderState,
      lastCompactionResult: 'done',
    }
    const badges = formatPiHeaderBadges(state)
    expect(badges).toHaveLength(1)
    expect(badges[0]).toMatch(/compact/i)
    expect(badges[0]).toMatch(/done/i)
  })

  it('returns aborted badge after aborted compaction', () => {
    const state: PiHeaderState = {
      ...initialPiHeaderState,
      lastCompactionResult: 'aborted',
    }
    const badges = formatPiHeaderBadges(state)
    expect(badges).toHaveLength(1)
    expect(badges[0]).toMatch(/compact/i)
    expect(badges[0]).toMatch(/aborted/i)
  })

  it('returns retry badge during active retry', () => {
    const state: PiHeaderState = {
      ...initialPiHeaderState,
      retrying: true,
      retryAttempt: 2,
      retryMax: 3,
    }
    const badges = formatPiHeaderBadges(state)
    expect(badges).toHaveLength(1)
    expect(badges[0]).toMatch(/retry/i)
    expect(badges[0]).toContain('2')
    expect(badges[0]).toContain('3')
  })

  it('returns success badge after retry succeeds', () => {
    const state: PiHeaderState = {
      ...initialPiHeaderState,
      lastRetryResult: 'success',
    }
    const badges = formatPiHeaderBadges(state)
    expect(badges).toHaveLength(1)
    expect(badges[0]).toMatch(/retry/i)
    expect(badges[0]).toMatch(/ok|success/i)
  })

  it('returns failed badge after retry fails', () => {
    const state: PiHeaderState = {
      ...initialPiHeaderState,
      lastRetryResult: 'failed',
    }
    const badges = formatPiHeaderBadges(state)
    expect(badges).toHaveLength(1)
    expect(badges[0]).toMatch(/retry/i)
    expect(badges[0]).toMatch(/fail/i)
  })

  it('returns both compaction and retry badges when both are active', () => {
    const state: PiHeaderState = {
      ...initialPiHeaderState,
      compacting: true,
      retrying: true,
      retryAttempt: 1,
      retryMax: 3,
    }
    const badges = formatPiHeaderBadges(state)
    expect(badges).toHaveLength(2)
  })

  it('prefers active state over last result for compaction', () => {
    // If compacting is true and lastCompactionResult is also set (edge),
    // active state takes priority.
    const state: PiHeaderState = {
      ...initialPiHeaderState,
      compacting: true,
      lastCompactionResult: 'done',
    }
    const badges = formatPiHeaderBadges(state)
    expect(badges[0]).toMatch(/compact/i)
    expect(badges[0]).not.toMatch(/done/i)
  })
})
