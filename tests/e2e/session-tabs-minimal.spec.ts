import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

for (const route of ['/hermes/session/old', '/hermes/history']) {
  for (const theme of ['light', 'dark']) {
    for (const width of [1280, 900]) {
      test(`connected square tabs: ${route} ${theme} ${width}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 850 })
        await authenticate(page)
        await mockHermesApi(page, { sessions: [
          { id: 'old', title: 'Existing conversation', source: 'cli', profile: 'default', started_at: 10, last_active: 20, message_count: 1 },
        ] })
        await page.addInitScript(theme => localStorage.setItem('hermes_brightness', theme), theme)
        await page.goto(`/#${route}`)
        const tabs = page.locator('.session-list-tabs')
        await expect(tabs).toBeVisible()
        const geometry = () => tabs.evaluate(el => {
          const rect = el.getBoundingClientRect()
          const header = el.closest('.page-sidebar-top')!
          const headerRect = header.getBoundingClientRect()
          return {
            height: rect.height,
            headerBottom: headerRect.bottom,
            headerBorder: getComputedStyle(header).borderBottomWidth,
            itemsTop: header.parentElement!.querySelector('.session-items')!.getBoundingClientRect().top,
            tabs: Array.from(el.querySelectorAll<HTMLElement>('[role="tab"]')).map(tab => {
              const r = tab.getBoundingClientRect(), s = getComputedStyle(tab)
              return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height,
                radius: s.borderTopLeftRadius, border: s.borderTopWidth, shadow: s.boxShadow,
                background: s.backgroundImage, overflow: tab.scrollWidth > tab.clientWidth,
                leftBorder: s.borderLeftWidth, rightBorder: s.borderRightWidth }
            }),
          }
        })
        const before = await geometry()
        await testInfo.attach('before-switch.json', { body: JSON.stringify(before), contentType: 'application/json' })
        expect.soft(before.tabs.map(t => t.radius)).toEqual(['0px', '0px'])
        expect.soft(before.tabs.map(t => t.border)).toEqual(['1px', '1px'])
        expect.soft(before.tabs.map(t => t.shadow)).toEqual(['none', 'none'])
        expect.soft(before.tabs.map(t => t.background)).toEqual(['none', 'none'])
        // Exactly one shared separator: no gap, no doubled adjoining border.
        expect.soft(before.tabs[1].left - before.tabs[0].right).toBe(0)
        expect.soft(parseFloat(before.tabs[0].rightBorder) + parseFloat(before.tabs[1].leftBorder)).toBe(1)
        expect.soft(before.tabs.map(t => t.bottom)).toEqual([before.headerBottom, before.headerBottom])
        expect.soft(before.tabs.map(t => t.overflow)).toEqual([false, false])
        expect.soft(before.height).toBe(34)
        expect.soft(before.tabs.map(t => t.height)).toEqual([34, 30])
        const originalUrl = page.url()
        const starred = tabs.locator('[data-name="starred"]')
        await starred.click()
        await expect(starred).toHaveAttribute('aria-selected', 'true')
        const after = await geometry()
        expect(after.tabs.map(t => t.height)).toEqual([30, 34])
        expect(after.tabs[1].left - after.tabs[0].right).toBe(0)
        expect(parseFloat(after.tabs[0].rightBorder) + parseFloat(after.tabs[1].leftBorder)).toBe(1)
        expect(after.tabs.map(t => t.bottom)).toEqual([after.headerBottom, after.headerBottom])
        expect(after.itemsTop).toBe(before.itemsTop)
        expect(page.url()).toBe(originalUrl)
        const all = tabs.locator('[data-name="all"]')
        await all.focus()
        await page.keyboard.press('Enter')
        await expect(all).toHaveAttribute('aria-selected', 'true')
        await all.click() // Capture pointer state, not the keyboard focus ring.
        await page.mouse.move(width - 10, 800)
        await testInfo.attach('tabs.png', { body: await page.locator('.page-sidebar-top').screenshot({ path: testInfo.outputPath('tabs.png') }), contentType: 'image/png' })
      })
    }
  }
}
