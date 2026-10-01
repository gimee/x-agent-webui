import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

const titles = ['会话标题尽量完整显示，超出可用宽度的文字才使用省略号', 'A_very_long_unbroken_conversation_title_that_must_never_push_actions_outside', '短标题']
const timestamp = Date.parse('2026-09-03T05:55:00Z') / 1000
const sessions = titles.map((title, i) => ({ id: `row-${i}`, title, source: 'cli', profile: 'default', started_at: timestamp, last_active: timestamp + 100 - i, message_count: 1 }))

test.use({ timezoneId: 'Asia/Shanghai', locale: 'zh-CN' })
for (const route of ['/hermes/session/row-0', '/hermes/history']) {
  for (const theme of ['light', 'dark']) {
    for (const width of [1280, 900]) {
      test(`full title and secondary time: ${route} ${theme} ${width}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 850 })
        await authenticate(page, undefined, 'default')
        await mockHermesApi(page, { sessions, initialProfileName: 'default' })
        await page.route('**/api/studio/sessions/hermes?*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ sessions, offset: 0, limit: 50, hasMore: false }) }))
        await page.addInitScript(theme => localStorage.setItem('hermes_brightness', theme), theme)
        await page.goto(`/#${route}`)
        await expect(page.locator('.session-item')).toHaveCount(3)
        await page.mouse.move(width - 10, 800)
        const geometry = () => page.locator('.session-item').evaluateAll(rows => rows.map(row => {
          const box = (selector: string) => {
            const el = row.querySelector<HTMLElement>(selector)!, r = el.getBoundingClientRect(), s = getComputedStyle(el)
            return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, ellipsis: s.textOverflow, whiteSpace: s.whiteSpace }
          }
          return { content: box('.session-item-content'), title: box('.session-item-title'), first: box('.session-item-title-row'), second: box('.session-item-agent-row'), agent: box('.session-item-agent-logo'), time: box('.session-item-time'), star: box('.session-item-star'), close: box('.session-item-delete') }
        }))
        const before = await geometry()
        await testInfo.attach('geometry.json', { body: JSON.stringify(before), contentType: 'application/json' })
        // Soft assertions collect baseline geometry even while the old layout fails.
        expect.soft(await page.locator('.session-item-profile').count()).toBe(0)
        expect.soft(await page.locator('.session-item-title-row .session-item-time').count()).toBe(0)
        expect.soft(await page.locator('.session-item-agent-row .session-item-time').count()).toBe(3)
        expect.soft(await page.locator('.session-item-time').allTextContents()).toEqual(['09-03 13:55', '09-03 13:55', '09-03 13:55'])
        for (const [i, g] of before.entries()) {
          expect.soft(g.title.x).toBe(g.content.x)
          expect.soft(g.title.right).toBe(g.content.right)
          expect.soft(g.title.ellipsis).toBe('ellipsis')
          expect.soft(g.title.whiteSpace).toBe('nowrap')
          expect.soft(g.title.scrollWidth > g.title.clientWidth).toBe(i < 2)
          expect.soft(g.time.right).toBe(g.content.right)
          expect.soft(g.time.y).toBeGreaterThan(g.first.bottom)
          expect.soft(g.time.bottom).toBeLessThanOrEqual(g.second.bottom)
          expect.soft(g.time.scrollWidth).toBeLessThanOrEqual(g.time.clientWidth)
          expect.soft(g.agent.x).toBe(g.content.x)
          expect.soft([g.agent.width, g.agent.height]).toEqual([18, 18])
          expect.soft([g.star.width, g.close.width]).toEqual([16, 16])
          expect.soft(g.star.x - g.content.right).toBe(6)
          expect.soft(g.close.x - g.star.right).toBe(4)
        }
        const row = page.locator('.session-item').first()
        await expect(row.locator('.session-item-star')).toHaveCSS('opacity', '0')
        await row.hover()
        await expect(row.locator('.session-item-star')).toHaveCSS('opacity', '1')
        expect(await geometry()).toEqual(before)
        const url = page.url()
        await row.locator('.session-item-star').click()
        await expect(row.locator('.session-item-star')).toHaveAttribute('aria-pressed', 'true')
        expect(page.url()).toBe(url)
        expect(await geometry()).toEqual(before)
        await page.locator('.session-items').screenshot({ path: testInfo.outputPath('rows.png') })
      })
    }
  }
}
