import type { GitStatusEntry } from '@pierre/trees'

export type FileTreeStreamMessage =
  | { type: 'file-delta'; added?: string[]; removed?: string[]; version: number }
  | { type: 'git-status'; files?: number; insertions?: number; deletions?: number; entries?: GitStatusEntry[] }
  | { type: 'hello'; version?: number }
  | { type: 'error'; message: string }

export interface FileTreeStreamModel {
  batch(ops: Array<{ type: 'add' | 'remove'; path: string }>): void
  setGitStatus(entries: GitStatusEntry[]): void
  setVersion(version: number): void
}

export function buildFileTreeStreamURL(
  projectSlug: string,
  includeHidden: boolean,
  origin = window.location.origin,
): string {
  const url = new URL(`/v1/fs/${encodeURIComponent(projectSlug)}/stream`, origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  if (includeHidden) url.searchParams.set('include_hidden', 'true')
  return url.toString()
}

export function applyFileTreeStreamMessage(msg: FileTreeStreamMessage, model: FileTreeStreamModel): void {
  if (msg.type === 'file-delta') {
    const added = msg.added ?? []
    const removed = msg.removed ?? []
    if (added.length > 0 || removed.length > 0) {
      model.batch([
        ...added.map(path => ({ type: 'add' as const, path })),
        ...removed.map(path => ({ type: 'remove' as const, path })),
      ])
    }
    model.setVersion(msg.version)
    return
  }

  if (msg.type === 'git-status') {
    model.setGitStatus(msg.entries ?? [])
  }
}
