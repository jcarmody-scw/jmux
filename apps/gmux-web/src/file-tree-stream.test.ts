import { describe, expect, it, vi } from 'vitest'
import { applyFileTreeStreamMessage, buildFileTreeStreamURL, type FileTreeStreamMessage } from './file-tree-stream'

describe('buildFileTreeStreamURL', () => {
  it('builds a websocket URL for the current origin and include-hidden flag', () => {
    const url = buildFileTreeStreamURL('my project', true, 'https://example.test:9443')
    expect(url).toBe('wss://example.test:9443/v1/fs/my%20project/stream?include_hidden=true')
  })

  it('uses ws on http origins and omits include_hidden when false', () => {
    const url = buildFileTreeStreamURL('proj', false, 'http://localhost:8790')
    expect(url).toBe('ws://localhost:8790/v1/fs/proj/stream')
  })
})

describe('applyFileTreeStreamMessage', () => {
  it('applies file deltas through the tree model', () => {
    const batch = vi.fn()
    const setGitStatus = vi.fn()
    const setVersion = vi.fn()
    const msg: FileTreeStreamMessage = {
      type: 'file-delta',
      added: ['src/new.ts'],
      removed: ['old.ts'],
      version: 3,
    }

    applyFileTreeStreamMessage(msg, { batch, setGitStatus, setVersion })

    expect(batch).toHaveBeenCalledWith([
      { type: 'add', path: 'src/new.ts' },
      { type: 'remove', path: 'old.ts' },
    ])
    expect(setVersion).toHaveBeenCalledWith(3)
    expect(setGitStatus).not.toHaveBeenCalled()
  })

  it('applies git status entries through the tree model', () => {
    const batch = vi.fn()
    const setGitStatus = vi.fn()
    const setVersion = vi.fn()
    const msg: FileTreeStreamMessage = {
      type: 'git-status',
      entries: [{ path: 'src/main.go', status: 'modified' }],
      files: 1,
      insertions: 2,
      deletions: 0,
    }

    applyFileTreeStreamMessage(msg, { batch, setGitStatus, setVersion })

    expect(setGitStatus).toHaveBeenCalledWith([{ path: 'src/main.go', status: 'modified' }])
    expect(batch).not.toHaveBeenCalled()
    expect(setVersion).not.toHaveBeenCalled()
  })
})
