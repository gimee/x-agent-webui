import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const sessions = [
  {
    id: 'stars-all-1', title: 'Starred Alpha', source: 'cli', model: 'test-model', provider: 'test-provider', profile: 'research', workspace: '/tmp/stars', started_at: 1_800_000_000, ended_at: null, last_active: 1_800_000_300, message_count: 1,
  },
  {
    id: 'stars-all-2', title: 'Unstarred Beta', source: 'cli', model: 'test-model', provider: 'test-provider', profile: 'research', workspace: '/tmp/stars', started_at: 1_800_000_100, ended_at: null, last_active: 1_800_000_200, message_count: 1,
  },
  {
    id: 'stars-other-profile', title: 'Other Profile', source: 'cli', model: 'test-model', provider: 'test-provider', profile: 'default', workspace: '/tmp/stars', started_at: 1_800_000_050, ended_at: null, last_active: 1_800_000_150, message_count: 1,
  },
]

async function openStarsChat(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('hermes_show_recent_sessions_v1', 'false')
    localStorage.setItem('hermes_active_profile_name', 'research')
    if (!localStorage.getItem('hermes_session_stars_v1_research')) localStorage.setItem('hermes_session_stars_v1_research', JSON.stringify(['stars-all-1']))
  })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockChatSocket(page)
  await mockHermesApi(page, { sessions })
  await page.goto('/#/hermes/session/stars-all-1')
  await expect(page.locator('.chat-panel')).toBeVisible()
  if (page.viewportSize()!.width <= 768) {
    await page.evaluate(() => window.dispatchEvent(new Event('hermes:open-page-sidebar')))
  }
  await expect(page.locator('.session-item')).toHaveCount(3)
}

test('defaults to all sessions and filters the starred tab by active profile', async ({ page }) => {
  await openStarsChat(page)

  await expect(page.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.session-item')).toHaveCount(3)

  await page.getByRole('tab', { name: 'Starred' }).click()
  await expect(page.locator('.session-item')).toHaveCount(1)
  await expect(page.locator('.session-item')).toContainText('Starred Alpha')
  await expect(page.locator('.session-item')).not.toContainText('Other Profile')
})

test('unstar removes the session immediately without navigating', async ({ page }) => {
  await openStarsChat(page)
  const activeUrl = page.url()
  await page.getByRole('tab', { name: 'Starred' }).click()
  const item = page.locator('.session-item').filter({ hasText: 'Starred Alpha' })
  await item.hover()
  await item.getByRole('button', { name: 'Unstar session' }).click()
  await expect(page.locator('.session-item')).toHaveCount(0)
  await expect(page).toHaveURL(activeUrl)
})

test('retains the mobile session-list close button', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openStarsChat(page)
  const close = page.locator('.session-close-btn')
  await expect(close).toBeVisible()
  await close.click()
  await expect(close).toBeHidden()
})

test('star icon matches delete size, turns yellow and survives reload without navigation', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', msg => { if (msg.type() === 'warning' && msg.text().includes('Failed to resolve component')) errors.push(msg.text()) })
  await openStarsChat(page)
  const item = page.locator('.session-item').filter({ hasText: 'Unstarred Beta' })
  const star = item.locator('.session-item-star')
  const url = page.url()
  const geometry = await item.evaluate(row => {
    const star = row.querySelector('.session-item-star')!
    const del = row.querySelector('.session-item-delete')!
    const sr = star.getBoundingClientRect(), dr = del.getBoundingClientRect()
    const si = star.querySelector('svg')!.getBoundingClientRect(), di = del.querySelector('svg')!.getBoundingClientRect()
    return { star: [sr.width,sr.height], del: [dr.width,dr.height], starIcon: [si.width,si.height], deleteIcon: [di.width,di.height], order: sr.right <= dr.left }
  })
  expect(geometry).toEqual({ star: [16,16], del: [16,16], starIcon: [12,12], deleteIcon: [12,12], order: true })
  await item.hover()
  await star.click()
  await expect(page).toHaveURL(url)
  await expect(star).toHaveAttribute('aria-pressed', 'true')
  await expect(star).toHaveCSS('color', 'rgb(245, 197, 66)')
  await expect(star.locator('svg')).toHaveAttribute('fill', 'currentColor')
  await page.getByRole('tab', { name: 'Starred', exact: true }).click()
  await expect(page.locator('.session-item')).toHaveCount(2)
  await page.reload()
  await expect(page.getByRole('tab', { name: 'All', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(star).toHaveAttribute('aria-pressed', 'true')
  await star.focus()
  await page.keyboard.press('Enter')
  await expect(star).toHaveAttribute('aria-pressed', 'false')
  await expect(star.locator('svg')).toHaveAttribute('fill', 'none')
  await expect(page).toHaveURL(url)
  expect(errors).toEqual([])
})

test('a starred cross-profile row from All remains findable in Starred', async ({ page }) => {
  await openStarsChat(page)
  const item = page.locator('.session-item').filter({ hasText: 'Other Profile' })
  await item.hover()
  await item.getByRole('button', { name: 'Star session', exact: true }).click()
  await page.getByRole('tab', { name: 'Starred', exact: true }).click()
  await expect(item).toBeVisible()
  await expect(item.getByRole('button', { name: 'Unstar session', exact: true })).toBeVisible()
})
