import { test, expect } from '@playwright/test'
import { openApp, spawnTestSession } from '../helpers'

/**
 * Regression test for: "switching gmux sessions causes WS connection to
 * take ages to re-establish."
 *
 * The live-session path no longer performs scrollback prefetch before or during
 * the WS handshake. The browser should switch sessions by opening the WS
 * immediately, without issuing a scrollback HTTP request for live sessions.
 */

const WS_OPEN_DEADLINE_MS = 1_500

test.describe('session switch — WS connects immediately for live sessions', () => {
  test('WS opens quickly without live-session scrollback prefetch', async ({ page }) => {
    const fromSession = await spawnTestSession(
      ['bash', '-c', 'echo FROM-SESSION-READY; sleep 60'],
      { cwdName: `switch-from-${Date.now()}` },
    )
    const toSession = await spawnTestSession(
      ['bash', '-c', 'printf "line-%d\\n" $(seq 1 50); sleep 60'],
      { cwdName: `switch-to-${Date.now()}` },
    )

    try {
      await openApp(page)

      // Navigate to the "from" session and let it settle.
      await page.waitForFunction((id) => {
        const navigate = (window as any).__gmuxNavigateToSession
        if (typeof navigate !== 'function') return false
        return navigate(id) === true
      }, fromSession.id, { timeout: 10_000 })
      await page.locator('.terminal-shell .terminal-container.wterm.focused').waitFor({ state: 'visible', timeout: 5_000 })
      await page.waitForTimeout(1_500)

      // Track whether the scrollback prefetch endpoint is called. Live sessions
      // should use only the WS snapshot path.
      const scrollbackUrl = `/v1/sessions/${encodeURIComponent(toSession.id)}/scrollback`
      let prefetchRequested = false
      await page.route(`**${scrollbackUrl}*`, async (route) => {
        prefetchRequested = true
        await route.continue()
      })

      // Install a WS open-time trap.
      await page.evaluate(() => {
        ;(window as any).__gmuxWsOpenAt = null
        const OrigWS = window.WebSocket
        ;(window as any).__gmuxWsProxy = class extends OrigWS {
          constructor(...args: ConstructorParameters<typeof WebSocket>) {
            super(...args)
            this.addEventListener('open', () => {
              if ((window as any).__gmuxWsOpenAt === null) {
                ;(window as any).__gmuxWsOpenAt = Date.now()
              }
            })
          }
        }
        window.WebSocket = (window as any).__gmuxWsProxy
      })

      const switchStart = Date.now()

      await page.waitForFunction((id) => {
        const navigate = (window as any).__gmuxNavigateToSession
        if (typeof navigate !== 'function') return false
        return navigate(id) === true
      }, toSession.id, { timeout: 10_000 })

      // WS must open quickly without waiting for a scrollback prefetch.
      const wsOpenAt = await page.waitForFunction(
        () => (window as any).__gmuxWsOpenAt as number | null,
        null,
        { timeout: WS_OPEN_DEADLINE_MS + 500 },
      )
      const elapsed = await wsOpenAt.evaluate(v => v as number) - switchStart
      console.log(`[session-switch] WS open in ${elapsed}ms`)

      expect(
        elapsed,
        `WS should open in <${WS_OPEN_DEADLINE_MS}ms`,
      ).toBeLessThan(WS_OPEN_DEADLINE_MS)

      // Terminal must finish loading.
      await expect(page.locator('.terminal-loading')).not.toBeVisible({ timeout: 5_000 })
      await expect(page.locator('.terminal-shell .terminal-container.wterm.focused')).toBeVisible()

      // Live sessions should not request scrollback prefetch.
      expect(prefetchRequested, 'live sessions skip scrollback prefetch').toBe(false)
    } finally {
      fromSession.kill()
      toSession.kill()
    }
  })
})
