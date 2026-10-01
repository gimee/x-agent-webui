import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

const sessions = Array.from({ length: 155 }, (_, index) => ({
  id: `history-star-${index}`,
  profile: 'default',
  source: index % 2 ? 'cron' : 'cli',
  model: 'test-model',
  provider: 'test-provider',
  title: `History session ${index}`,
  started_at: 1_790_000_000 - index,
  last_active: 1_790_000_000 - index,
  ended_at: null,
  message_count: 1,
  input_tokens: 0,
  output_tokens: 0,
  workspace: null,
}))

async function historyApi(page: Page) {
  await authenticate(page, undefined, 'default')
  await mockHermesApi(page, { initialProfileName: 'default' })
  const groupIncludes: string[][] = []
  const pageOffsets: number[] = []
  await page.route('**/api/studio/sessions/hermes**', async route => {
    const url = new URL(route.request().url())
    const json = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    const limit = Number(url.searchParams.get('limit') || 50)
    if (url.pathname.endsWith('/groups')) {
      const ids = url.searchParams.getAll('include')
      groupIncludes.push(ids)
      // Match the real controller's 100-ID include cap, not an unlimited mock.
      const included = new Set(ids.slice(0, 100))
      return json({ groups: [{ source: 'cli', sessions: sessions.slice(0, limit), hasMore: true }], included: sessions.filter(s => included.has(s.id)) })
    }
    if (url.pathname.endsWith('/hermes')) {
      const offset = Number(url.searchParams.get('offset') || 0)
      pageOffsets.push(offset)
      return json({ sessions: sessions.slice(offset, offset + limit), hasMore: offset + limit < sessions.length, offset, limit })
    }
    return route.fallback()
  })
  await page.route('**/api/studio/sessions/conversations/*/messages/paginated?*', async route => {
    const id = new URL(route.request().url()).pathname.split('/')[5]
    const session = sessions.find(s => s.id === id)
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      session,
      messages: [{ id: 1, session_id: id, role: 'assistant', content: `Answer for ${id}`, timestamp: session?.started_at, tool_name: null, tool_calls: null, tool_call_id: null, reasoning: null, finish_reason: null }],
      total: 1, hasMore: false, offset: 0, limit: 150,
    }) })
  })
  return { groupIncludes, pageOffsets }
}

const row = (page: Page, index: number) => page.locator('.history-panel .session-item').filter({ has: page.getByText(`History session ${index}`, { exact: true }) })

test('History includes more than 100 old stars and the route target without advancing the global cursor', async ({ page }) => {
  const { groupIncludes, pageOffsets } = await historyApi(page)
  const starIds = sessions.slice(50, 152).map(session => session.id)
  await page.addInitScript(ids => {
    localStorage.setItem('hermes_session_stars_v1_default', JSON.stringify(ids))
    localStorage.setItem('hermes_session_stars_v1_research', JSON.stringify(['history-star-3']))
    localStorage.setItem('hermes_session_pins_v1_default', JSON.stringify(['history-star-0']))
  }, starIds)
  await page.goto('/#/hermes/history/session/history-star-154')
  await expect.poll(() => groupIncludes.length).toBe(2)
  expect(groupIncludes.every(ids => ids.length <= 100)).toBe(true)
  expect(new Set(groupIncludes.flat())).toEqual(new Set([...starIds, 'history-star-154']))
  await expect(page.getByText('Answer for history-star-154', { exact: true })).toBeVisible()
  await expect(row(page, 0).getByRole('button', { name: 'Star session', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Starred', exact: true }).click()
  await expect(row(page, 151)).toBeVisible()
  await expect(page.locator('.history-panel .session-item')).toHaveCount(102)
  await expect(row(page, 3)).toHaveCount(0)
  await expect(row(page, 154)).toHaveCount(0)
  await expect(page.locator('.session-empty')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Load more sessions' })).toHaveCount(0)
  await page.getByRole('tab', { name: 'All', exact: true }).click()
  const loadMore = page.getByRole('button', { name: 'Load more sessions' })
  await loadMore.click()
  await expect.poll(() => pageOffsets).toEqual([0, 50])
  await expect(loadMore).toBeEnabled()
  await loadMore.click()
  await expect.poll(() => pageOffsets).toEqual([0, 50, 100])
  await expect(loadMore).toBeEnabled()
  await loadMore.click()
  await expect.poll(() => pageOffsets).toEqual([0, 50, 100, 150])
  await expect(page.locator('.history-panel .session-item')).toHaveCount(155)
  await expect(loadMore).toHaveCount(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('hermes_session_stars_v1_default') || '[]'))).toEqual(starIds)
})

test('History tabs filter stars without changing the open conversation', async ({ page }) => {
  await historyApi(page)
  await page.goto('/#/hermes/history/session/history-star-0')
  await expect(page.getByText('Answer for history-star-0', { exact: true })).toBeVisible()
  const all = page.getByRole('tab', { name: 'All', exact: true })
  const starred = page.getByRole('tab', { name: 'Starred', exact: true })
  await expect(all).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.history-panel input[type="checkbox"]')).toHaveCount(0)
  await row(page, 1).hover()
  await row(page, 1).getByRole('button', { name: 'Star session', exact: true }).click()
  await expect(page).toHaveURL(/history-star-0$/)
  await starred.click()
  await expect(row(page, 1)).toBeVisible()
  await expect(row(page, 0)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Load more sessions' })).toHaveCount(0)
  await row(page, 1).hover()
  await row(page, 1).getByRole('button', { name: 'Unstar session', exact: true }).click()
  await expect(row(page, 1)).toHaveCount(0)
  await expect(page.locator('.session-empty')).toHaveText('No starred sessions')
  await expect(page.getByText('Answer for history-star-0', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/history-star-0$/)
  await all.click()
  await expect(row(page, 0)).toBeVisible()
  await expect(row(page, 1)).toBeVisible()
  await row(page, 1).click({ button: 'right' })
  await expect(page.getByText('Copy Session ID', { exact: true })).toBeVisible()
  await expect(page.getByText(/^(Pin|Unpin)$/)).toHaveCount(0)
})

test('History is one chronological list across sources, including after loading more', async ({ page }) => {
  await historyApi(page)
  await page.goto('/#/hermes/history/session/history-star-49')
  await expect(page.locator('.history-panel .session-item')).toHaveCount(50)
  await expect(page.locator('.session-group-header')).toHaveCount(0)
  expect(await page.locator('.session-item-title').allTextContents()).toEqual(sessions.slice(0,50).map(s=>s.title))
  await page.getByRole('button', {name:'Load more sessions'}).click()
  await expect(page.locator('.history-panel .session-item')).toHaveCount(100)
  expect(await page.locator('.session-item-title').allTextContents()).toEqual(sessions.slice(0,100).map(s=>s.title))
  await expect(page).toHaveURL(/history-star-49$/)
})
