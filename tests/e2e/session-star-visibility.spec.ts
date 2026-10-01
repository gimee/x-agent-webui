import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

const sessions = [
  { id: 'visibility-a', title: 'Visibility Alpha', source: 'cli', profile: 'default', started_at: 10, last_active: 30, message_count: 1 },
  { id: 'visibility-b', title: 'Visibility Beta', source: 'cli', profile: 'default', started_at: 11, last_active: 20, message_count: 1 },
]
async function openList(page: Page, route: string) {
  await authenticate(page, undefined, 'default')
  await mockHermesApi(page, { sessions, initialProfileName: 'default' })
  await page.route('**/api/studio/sessions/hermes?*', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ sessions, offset: 0, limit: 50, hasMore: false }),
  }))
  await page.addInitScript(() => {
    localStorage.setItem('hermes_session_stars_v1_default', JSON.stringify(['visibility-a']))
  })
  await page.goto(`/#${route}`)
  await expect(page.locator('.session-item')).toHaveCount(2)
  await page.mouse.move(1200, 800)
}

for (const route of ['/hermes/session/visibility-a', '/hermes/history']) {
  test(`star follows close visibility and preserves layout: ${route}`, async ({ page }) => {
    await openList(page, route)
    const rows = page.locator('.session-item')
    const originalUrl = page.url()
    for (const title of ['Visibility Alpha', 'Visibility Beta']) {
      const row = rows.filter({ hasText: title })
      const star = row.locator('.session-item-star')
      const close = row.locator('.session-item-delete')
      const before = await row.boundingBox()
      await expect(star).toHaveCSS('opacity', '0')
      await expect(star).toHaveCSS('pointer-events', 'none')
      await expect(close).toHaveCSS('opacity', '0')
      await row.hover()
      await expect(star).toHaveCSS('opacity', '1')
      await expect(close).toHaveCSS('opacity', '1')
      await expect(star).toHaveCSS('pointer-events', 'auto')
      expect(await row.boundingBox()).toEqual(before)
      // Hovering one row must not reveal the other row's actions.
      await expect(rows.filter({ hasNotText: title }).locator('.session-item-star')).toHaveCSS('opacity', '0')
      const wasStarred = await star.getAttribute('aria-pressed')
      await star.click()
      await expect(star).toHaveAttribute('aria-pressed', wasStarred === 'true' ? 'false' : 'true')
      await expect(page).toHaveURL(originalUrl)
      // Same focus-within accessibility contract as the existing close button.
      await star.evaluate(el => (el as HTMLElement).blur())
      await page.mouse.move(1200, 800)
      await expect(star).toHaveCSS('opacity', '0')
      await expect(close).toHaveCSS('opacity', '0')
      await star.focus()
      await expect(star).toHaveCSS('opacity', '1')
      await expect(close).toHaveCSS('opacity', '1')
      await page.keyboard.press('Enter')
      await expect(star).toHaveAttribute('aria-pressed', wasStarred!)
      await expect(page).toHaveURL(originalUrl)
      await star.evaluate(el => (el as HTMLElement).blur())
    }
  })
}

test.describe('touch access', () => {
  test.use({ hasTouch: true })
  for (const route of ['/hermes/session/visibility-a', '/hermes/history']) {
    test(`star remains available like close without hover: ${route}`, async ({ page }) => {
      await openList(page, route)
      expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true)
      const row = page.locator('.session-item').filter({ hasText: 'Visibility Beta' })
      const star = row.locator('.session-item-star')
      await expect(star).toHaveCSS('opacity', '0.5')
      await expect(row.locator('.session-item-delete')).toHaveCSS('opacity', '0.5')
      await expect(star).toHaveCSS('pointer-events', 'auto')
      const url = page.url()
      await star.tap()
      await expect(star).toHaveAttribute('aria-pressed', 'true')
      await expect(page).toHaveURL(url)
    })
  }
})
