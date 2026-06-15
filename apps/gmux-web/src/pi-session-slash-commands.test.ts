import { describe, expect, it } from 'vitest'
import {
  extractCommandNames,
  inputItemForText,
  isSlashCommand,
  reduceItems,
  slashCommandArgs,
  slashCommandLabel,
  type CommandItem,
  type RenderItem,
} from './pi-session'

describe('slash command helpers', () => {
  it('detects slash commands after trimming leading whitespace', () => {
    expect(isSlashCommand('/help')).toBe(true)
    expect(isSlashCommand('  /model sonnet')).toBe(true)
  })

  it('does not treat bare slash or normal text as commands', () => {
    expect(isSlashCommand('/')).toBe(false)
    expect(isSlashCommand(' / ')).toBe(false)
    expect(isSlashCommand('hello /help')).toBe(false)
  })

  it('returns the command token as a label', () => {
    expect(slashCommandLabel('/help')).toBe('/help')
    expect(slashCommandLabel('  /model sonnet')).toBe('/model')
  })

  it('falls back to /command for invalid labels', () => {
    expect(slashCommandLabel('hello')).toBe('/command')
  })

  it('creates command render items for slash command input', () => {
    const item = inputItemForText('/compact') as CommandItem
    expect(item.kind).toBe('command')
    expect(item.text).toBe('/compact')
    expect(item.label).toBe('/compact')
  })

  it('keeps normal input as user render items', () => {
    const item = inputItemForText('hello')
    expect(item.kind).toBe('user')
    expect(item.text).toBe('hello')
  })
})

describe('slash command polish', () => {
  it('splits the command label from arguments for first-class row rendering', () => {
    const item = inputItemForText('/task done') as CommandItem
    expect(item.kind).toBe('command')
    expect(item.label).toBe('/task')
    expect(item.args).toBe('done')
    expect(item.status).toBe('pending')
    expect(slashCommandArgs('/task done')).toBe('done')
  })

  it('marks slash commands as unknown when a loaded command registry does not include them', () => {
    const item = inputCommands('/does-not-exist please', ['task', 'mcp'])
    expect(item.kind).toBe('command')
    expect(item.label).toBe('/does-not-exist')
    expect(item.status).toBe('unknown')
    expect(item.statusText).toBe('unknown command')
  })

  it('keeps known registered slash commands pending until RPC acknowledges them', () => {
    const item = inputCommands('/task done', ['task', 'mcp'])
    expect(item.kind).toBe('command')
    expect(item.status).toBe('pending')
    expect(item.statusText).toBe('running')
  })

  it('updates the last command row when pi-rpc accepts or rejects the prompt command', () => {
    let items: RenderItem[] = [inputItemForText('/task done') as CommandItem]
    items = reduceItems(items, { type: 'response', command: 'prompt', success: true })
    expect((items[0] as CommandItem).status).toBe('accepted')
    expect((items[0] as CommandItem).statusText).toBe('accepted')

    items = [inputItemForText('/task done') as CommandItem]
    items = reduceItems(items, { type: 'response', command: 'prompt', success: false, error: 'Unknown command: task' })
    expect((items[0] as CommandItem).status).toBe('error')
    expect((items[0] as CommandItem).statusText).toBe('Unknown command: task')
  })

  it('renders extension notifications as command output rows', () => {
    const items = reduceItems([inputItemForText('/task done') as CommandItem], {
      type: 'extension_ui_request',
      method: 'notify',
      message: 'Task t-1449 closed.',
      notifyType: 'info',
    })
    expect(items).toHaveLength(2)
    expect(items[1]).toEqual({
      kind: 'command-output',
      subtype: 'info',
      text: 'Task t-1449 closed.',
    })
  })

  it('extracts command names from get_commands responses', () => {
    expect(extractCommandNames({
      type: 'response',
      command: 'get_commands',
      success: true,
      data: { commands: [{ name: 'task' }, { name: 'skill:verify' }] },
    })).toEqual(['task', 'skill:verify'])
  })
})

function inputCommands(text: string, names: string[]): CommandItem {
  return inputItemForText(text, new Set(names)) as CommandItem
}
