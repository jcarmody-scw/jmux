import { syntaxTree } from '@codemirror/language'
import { EditorState, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import { shouldShowSource } from 'codemirror-live-markdown'

export interface TaskMarker {
  from: number
  to: number
  checked: boolean
}

export function taskMarkerToggleText(markerText: string): string {
  return /^\[[xX]\]$/.test(markerText) ? '[ ]' : '[x]'
}

export function parseTaskMarkers(state: EditorState): TaskMarker[] {
  const markers: TaskMarker[] = []

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'TaskMarker') return

      const markerText = state.doc.sliceString(node.from, node.to)
      markers.push({
        from: node.from,
        to: node.to,
        checked: /^\[[xX]\]$/.test(markerText),
      })
    },
  })

  return markers
}

function toggleTaskMarker(view: EditorView, from: number, to: number) {
  const current = view.state.doc.sliceString(from, to)
  view.dispatch({
    changes: { from, to, insert: taskMarkerToggleText(current) },
    selection: { anchor: from + 2 },
  })
  view.focus()
}

class TaskCheckboxWidget extends WidgetType {
  constructor(
    private readonly from: number,
    private readonly to: number,
    private readonly checked: boolean,
  ) {
    super()
  }

  eq(other: TaskCheckboxWidget): boolean {
    return this.from === other.from && this.to === other.to && this.checked === other.checked
  }

  toDOM(view: EditorView): HTMLElement {
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.className = 'cm-task-checkbox'
    checkbox.checked = this.checked
    checkbox.setAttribute('aria-label', this.checked ? 'Mark task incomplete' : 'Mark task complete')

    checkbox.addEventListener('mousedown', event => {
      event.preventDefault()
      event.stopPropagation()
    })

    checkbox.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      toggleTaskMarker(view, this.from, this.to)
    })

    return checkbox
  }

  ignoreEvent(): boolean {
    return true
  }
}

function buildTaskListDecorations(state: EditorState): DecorationSet {
  const decorations = parseTaskMarkers(state)
    .filter(marker => !shouldShowSource(state, marker.from, marker.to))
    .map(marker => Decoration.replace({
      widget: new TaskCheckboxWidget(marker.from, marker.to, marker.checked),
      inclusive: false,
    }).range(marker.from, marker.to))

  return Decoration.set(decorations, true)
}

export const taskListField = StateField.define<DecorationSet>({
  create(state) {
    return buildTaskListDecorations(state)
  },

  update(decorations, transaction) {
    if (transaction.docChanged || transaction.selection) {
      return buildTaskListDecorations(transaction.state)
    }

    return decorations.map(transaction.changes)
  },

  provide: field => EditorView.decorations.from(field),
})
