import { describe, expect, it } from 'vitest'
import {
  inputItemForText,
  isSlashCommand,
  slashCommandLabel,
  type CommandItem,
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
