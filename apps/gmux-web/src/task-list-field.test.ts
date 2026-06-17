import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { TaskList } from '@lezer/markdown'
import { parseTaskMarkers, taskMarkerToggleText } from './task-list-field'

function stateFor(doc: string) {
  return EditorState.create({
    doc,
    extensions: [markdown({ extensions: [TaskList] })],
  })
}

describe('parseTaskMarkers', () => {
  it('finds unchecked, lowercase checked, and uppercase checked task markers', () => {
    const state = stateFor('- [ ] todo\n- [x] done\n- [X] uppercase\n')

    expect(parseTaskMarkers(state)).toEqual([
      { from: 2, to: 5, checked: false },
      { from: 13, to: 16, checked: true },
      { from: 24, to: 27, checked: true },
    ])
  })

  it('ignores plain list items without task markers', () => {
    const state = stateFor('- normal\n- [ ] task\n')

    expect(parseTaskMarkers(state)).toEqual([
      { from: 11, to: 14, checked: false },
    ])
  })

  it('finds nested task markers', () => {
    const state = stateFor('- parent\n  - [x] child\n')

    expect(parseTaskMarkers(state)).toEqual([
      { from: 13, to: 16, checked: true },
    ])
  })
})

describe('taskMarkerToggleText', () => {
  it('toggles checked and unchecked marker text', () => {
    expect(taskMarkerToggleText('[ ]')).toBe('[x]')
    expect(taskMarkerToggleText('[x]')).toBe('[ ]')
    expect(taskMarkerToggleText('[X]')).toBe('[ ]')
  })
})
