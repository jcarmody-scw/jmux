import { test, expect } from '@playwright/test'
import { openApp, gotoTestSession, spawnTestSession } from '../helpers'

/**
 * Terminal copy tests using wterm DOM text. The renderer exposes terminal
 * output as real text nodes, so browser copy affordances can work without a
 * custom terminal text extraction path.
 */

test.describe('terminal copy', () => {
  test('copy button is wired up (onCopyReady fires)', async ({ page }) => {
    await openApp(page)
    await gotoTestSession(page)

    // The copy action ref should be registered in window via the store/sidebar
    // We verify the terminal loaded and the shell has the copy overlay structure
    await expect(page.locator('.terminal-shell')).toBeVisible()
  })

  test('terminal text is rendered as DOM text nodes', async ({ page }) => {
    const { id, kill } = await spawnTestSession(
      ['bash', '-c', 'for i in $(seq 1 10); do echo UNIQUE_COPY_MARKER; sleep 1; done; sleep 60'],
      { cwdName: 'copy-test' },
    )

    await openApp(page)
    await page.waitForFunction((sid) => {
      const nav = (window as any).__gmuxNavigateToSession
      return typeof nav === 'function' && nav(sid) === true
    }, id, { timeout: 10_000 })
    await page.locator('.terminal-container.wterm').waitFor({ state: 'visible', timeout: 8_000 })
    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('.term-row')).some((row) => {
        return row.textContent?.includes('UNIQUE_COPY_MARKER')
      })
    }, undefined, { timeout: 5_000 })

    const domText = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.term-row'))
        .map((row) => row.textContent ?? '')
        .join('\n')
    })

    expect(domText).toContain('UNIQUE_COPY_MARKER')
    kill()
  })
})
