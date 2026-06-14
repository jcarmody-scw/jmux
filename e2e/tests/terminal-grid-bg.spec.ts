import { test, expect } from '@playwright/test'
import { openApp, gotoTestSession } from '../helpers'

/**
 * Regression test for the "whole terminal takes one bright colour" bug.
 *
 * Older wterm/ghostty rendering set the grid container's background from the
 * bottom-right cell, which caused a bright TUI footer/status colour to fill
 * the whole terminal. The default wterm core should keep that colour scoped
 * to the cell while the terminal container background remains neutral.
 */
test.describe('terminal grid background', () => {
  test('coloured bottom-right cell does not bleed across the terminal', async ({ page }) => {
    await openApp(page)
    await gotoTestSession(page)

    // Drive the renderer into the bug state: position the cursor at the
    // bottom-right cell, set a bright background, print a space, reset.
    await page.evaluate(() => {
      const term = (window as any).__gmuxTerm
      const rows: number = term.rows
      const cols: number = term.cols
      const seq = `\x1b[${rows};${cols}H\x1b[48;2;180;60;200m \x1b[0m`
      term.write(new TextEncoder().encode(seq))
    })

    // The terminal surface must not inherit the bright cell background.
    const backgrounds = await page.evaluate(() => {
      const term = (window as any).__gmuxTerm
      const grid = term.element.querySelector('.term-grid') as HTMLElement | null
      const target = grid ?? term.element
      return {
        inline: target.style.background || target.style.backgroundColor || '',
        computed: getComputedStyle(target).backgroundColor,
      }
    })
    expect(backgrounds.inline).not.toContain('180, 60, 200')
    expect(backgrounds.computed).not.toBe('rgb(180, 60, 200)')
  })
})
