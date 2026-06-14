import { describe, expect, it } from 'vitest'
import {
  buildTaskProgressSummary,
  buildTurnScrubberItems,
  shouldAutoScrollMessages,
  taskProgressFromExtensionEvent,
  type RenderItem,
  type TaskProgress,
} from './pi-session'

const user = (text: string): RenderItem => ({ kind: 'user', text })
const command = (text: string, label = '/task'): RenderItem => ({
  kind: 'command',
  text,
  label,
  args: text.slice(label.length).trimStart(),
  status: 'handled',
  statusText: 'output',
})
const assistant = (text: string): RenderItem => ({
  kind: 'assistant',
  blocks: [{ type: 'text', text }],
  toolExecMap: {},
  complete: true,
})

describe('s-21 turn scrubber helpers', () => {
  it('creates one scrubber entry per user or command turn', () => {
    const items: RenderItem[] = [
      user('Fix the failing auth test and keep the change small'),
      assistant('ok'),
      command('/task status'),
      assistant('done'),
    ]

    expect(buildTurnScrubberItems(items, -1)).toEqual([
      {
        id: 'turn-0',
        itemIndex: 0,
        label: 'Fix the failing auth test and keep the change small',
        title: 'Fix the failing auth test and keep the change small',
        active: false,
      },
      {
        id: 'turn-2',
        itemIndex: 2,
        label: '/task status',
        title: '/task status',
        active: false,
      },
    ])
  })

  it('marks the active streaming turn', () => {
    const items: RenderItem[] = [user('first'), assistant('ok'), user('second')]

    expect(buildTurnScrubberItems(items, 2).map(item => item.active)).toEqual([false, true])
  })

  it('does not auto-scroll when navigation locked the scroll position', () => {
    expect(shouldAutoScrollMessages({ distanceFromBottom: 12, nearBottomPx: 60, navigationLocked: true })).toBe(false)
  })

  it('auto-scrolls only when unlocked and near the bottom', () => {
    expect(shouldAutoScrollMessages({ distanceFromBottom: 12, nearBottomPx: 60, navigationLocked: false })).toBe(true)
    expect(shouldAutoScrollMessages({ distanceFromBottom: 120, nearBottomPx: 60, navigationLocked: false })).toBe(false)
  })
})

describe('s-21 task progress helpers', () => {
  it('summarizes task progress counts', () => {
    const task: TaskProgress = {
      title: 'pi rpc right panel',
      status: 'IN_PROGRESS',
      steps: [
        { id: 's1', title: 'Plan', status: 'DONE' },
        { id: 's2', title: 'Implement', status: 'IN_PROGRESS' },
        { id: 's3', title: 'Verify', status: 'PENDING' },
      ],
    }

    expect(buildTaskProgressSummary(task)).toEqual({ done: 1, total: 3, label: '1 / 3' })
  })

  it('handles tasks with no steps', () => {
    expect(buildTaskProgressSummary({ title: 'empty', status: 'OPEN', steps: [] })).toEqual({ done: 0, total: 0, label: '0 / 0' })
  })

  it('extracts current task id from captain status UI events', () => {
    expect(taskProgressFromExtensionEvent({
      type: 'extension_ui_request',
      method: 'setStatus',
      statusKey: 'captain-task',
      statusText: 't-1720',
    })).toEqual({ title: 't-1720', status: 'IN_PROGRESS', steps: [] })
  })
})
