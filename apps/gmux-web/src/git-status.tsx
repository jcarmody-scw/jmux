/**
 * GitStatus — inline git change indicator for the file tree header.
 *
 * Subscribes to the `gitStatusBySlug` signal in store.ts, which is updated
 * by git-status SSE events pushed from the daemon's GitWatcher. On mount,
 * performs a one-shot HTTP fetch to populate state before the first push
 * event arrives. No polling interval.
 *
 * Clicking the badge navigates to the diff panel.
 */

import { useState, useEffect, useCallback } from 'preact/hooks'
import { navigateToDiffView, gitStatusBySlug } from './store'
import type { GitStatusResult } from './store'

// ── Pure helpers (exported for tests) ──

export type { GitStatusResult }

interface FormattedGitStat {
  files: string
  insertions: string | null
  deletions: string | null
}

/** Format a GitStatusResult into display strings for each part. */
export function formatGitStat(r: GitStatusResult): FormattedGitStat {
  return {
    files: `${r.files}~`,
    insertions: r.insertions > 0 ? `+${r.insertions}` : null,
    deletions: r.deletions > 0 ? `\u2212${r.deletions}` : null,
  }
}

// ── Component ──

export function GitStatus({
  projectSlug,
  cwd,
}: {
  projectSlug: string
  cwd: string
}) {
  // Initialise from the signal (may already have data from a previous event).
  const [status, setStatus] = useState<GitStatusResult | null>(
    () => gitStatusBySlug.value.get(projectSlug) ?? null,
  )

  // One-shot fetch on mount to populate before the first push event.
  const fetchInitial = useCallback(async () => {
    try {
      const resp = await fetch(`/v1/git/${encodeURIComponent(projectSlug)}/status`)
      if (!resp.ok) return
      const json = await resp.json()
      if (json.ok && json.data) {
        setStatus(json.data as GitStatusResult)
      }
    } catch {
      // network error — silently ignore, keep last known state
    }
  }, [projectSlug])

  useEffect(() => {
    void fetchInitial()
  }, [fetchInitial])

  // Subscribe to push events from the store signal.
  useEffect(() => {
    const unsub = gitStatusBySlug.subscribe(map => {
      const v = map.get(projectSlug)
      if (v !== undefined) setStatus(v)
    })
    return unsub
  }, [projectSlug])

  if (!status || status.files === 0) return null

  const fmt = formatGitStat(status)

  const handleClick = (e: MouseEvent) => {
    e.stopPropagation()
    navigateToDiffView(projectSlug, cwd)
  }

  return (
    <button
      class="git-status-badge"
      onClick={handleClick}
      title="Open diff"
    >
      <span class="git-status-files">{fmt.files}</span>
      {fmt.insertions && <span class="git-status-ins">{fmt.insertions}</span>}
      {fmt.deletions && <span class="git-status-del">{fmt.deletions}</span>}
    </button>
  )
}
