import type { Browser } from 'playwright'
import type { SwarmAuthConfig } from '../../contracts'
import type { SwarmAuthSessionPort } from '../../ports'

export class PlaywrightAuthSessionAdapter implements SwarmAuthSessionPort {
  async createStorageState(browser: Browser, auth: SwarmAuthConfig, password: string): Promise<unknown> {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
    const page = await ctx.newPage()

    try {
      await page.goto(auth.loginUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      await page.fill(auth.usernameSelector, auth.username, { timeout: 8_000 })
      await page.fill(auth.passwordSelector, password, { timeout: 8_000 })
      await page.click(auth.submitSelector, { timeout: 8_000 })

      if (auth.successIndicator?.trim()) {
        await page.waitForSelector(auth.successIndicator, { timeout: 15_000 })
      } else {
        await page.waitForTimeout(Math.max(500, auth.waitAfterLoginMs || 3000))
      }

      return await ctx.storageState()
    } catch (err: any) {
      throw new Error(`SWARM_AUTH_LOGIN_FAILED: ${err?.message || 'Login failed'}`)
    } finally {
      await ctx.close()
    }
  }
}
