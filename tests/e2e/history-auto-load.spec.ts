import { expect, test, type Page, type Route } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

const PAGE_SIZE = 150
const shell = '.history-message-list-shell'
const viewport = `${shell} .virtual-message-list`
const rows = `${viewport} .virtual-row[data-message-id]:not([data-virtual-inactive])`
// More than two background intervals: a stopped task must stay stopped.
const QUIET_MS = 1_500

type Conversation = ReturnType<typeof conversation>
type PageRequest = {
  id: string
  profile: string
  offset: number
  limit: number
  started: number
  finished?: number
  frame?: number
}
type Hold = ReturnType<typeof deferred>
type HarnessOptions = {
  hold?: { id: string; profile?: string; offset: number; gate: Hold }
  failure?: 'null' | '500'
}

function conversation(id: string, total: number, profile = 'default') {
  const summary = {
    id, profile, title: `Synthetic ${profile} ${id}`, source: 'cli',
    model: 'test-model', provider: 'test-provider', preview: 'Synthetic pagination fixture',
    started_at: 1_790_000_000, last_active: 1_790_010_000, ended_at: null,
    message_count: total, tool_call_count: 0, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
    billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null,
    cost_status: '', workspace: null,
  }
  const messages = Array.from({ length: total }, (_, index) => ({
    id: index + 1, session_id: id, role: index % 2 ? 'assistant' : 'user',
    content: `${profile}/${id} synthetic message ${index + 1}`,
    timestamp: summary.started_at + index, tool_call_id: null, tool_calls: null,
    tool_name: null, run_marker: null, token_count: null, finish_reason: null, reasoning: null,
  }))
  return { summary, messages }
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

const evidence = new WeakMap<Page, {
  requests: PageRequest[]
  unexpected: string[]
  errors: string[]
  gates: Hold[]
}>()

async function setup(page: Page, conversations: Conversation[], options: HarnessOptions = {}) {
  await authenticate(page, undefined, 'default')
  await mockHermesApi(page, { initialProfileName: 'default', sessions: [] })
  const requests: PageRequest[] = []
  const unexpected: string[] = []
  const errors: string[] = []
  const gates = options.hold ? [options.hold.gate] : []
  evidence.set(page, { requests, unexpected, errors, gates })
  page.on('pageerror', error => errors.push(error.message))
  // Real Vue app + real Chrome; all backend requests stay synthetic. Never start a chat run.
  await page.routeWebSocket(/\/socket\.io\//, socket => socket.close())
  await page.addInitScript(() => {
    const probe = { frames: 0, wheelEvents: 0 }
    ;(window as any).__HISTORY_E2E_PROBE__ = probe
    const tick = () => { probe.frames++; requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    window.addEventListener('wheel', () => { probe.wheelEvents++ }, { passive: true })
  })
  let inFlight = 0
  let maxInFlight = 0
  let failurePending = Boolean(options.failure)
  let heldOnce = false
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({
    status, contentType: 'application/json', body: JSON.stringify(value),
  })
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    const { pathname } = url
    // Do not allow a CDN, socket transport, or unknown API to hit a real service.
    if (pathname.startsWith('/socket.io/')) return route.abort()
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return route.abort()
    const match = pathname.match(/^\/api\/studio\/sessions\/conversations\/([^/]+)\/messages\/paginated$/)
    if (match) {
      const request: PageRequest = {
        id: decodeURIComponent(match[1]), profile: url.searchParams.get('profile') || 'default',
        offset: Number(url.searchParams.get('offset')), limit: Number(url.searchParams.get('limit')),
        started: Date.now(),
      }
      requests.push(request)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        request.frame = await page.evaluate(() => (window as any).__HISTORY_E2E_PROBE__.frames)
        const target = conversations.find(c => c.summary.id === request.id && c.summary.profile === request.profile)
        if (!target) {
          unexpected.push(`Unknown conversation ${request.profile}/${request.id}`)
          return await json(route, { error: 'Unknown synthetic conversation' }, 404)
        }
        const hold = options.hold
        if (hold && !heldOnce && request.id === hold.id && request.profile === (hold.profile || 'default') && request.offset === hold.offset) {
          heldOnce = true
          await hold.gate.promise
        }
        if (failurePending && request.offset === PAGE_SIZE) {
          failurePending = false
          return await json(route, options.failure === 'null' ? null : { error: 'Synthetic page failure' }, options.failure === '500' ? 500 : 200)
        }
        // Real endpoint pages backwards from the latest messages, ascending within each page.
        const end = Math.max(0, target.messages.length - request.offset)
        const start = Math.max(0, end - request.limit)
        return await json(route, {
          session: target.summary, messages: target.messages.slice(start, end),
          total: target.messages.length, offset: request.offset, limit: request.limit, hasMore: start > 0,
        })
      } finally {
        request.finished = Date.now()
        inFlight--
      }
    }
    if (pathname === '/api/studio/sessions/hermes') {
      const profile = url.searchParams.get('profile') || 'default'
      const items = conversations.filter(c => c.summary.profile === profile).map(c => c.summary)
      const offset = Number(url.searchParams.get('offset') || 0)
      const limit = Number(url.searchParams.get('limit') || 50)
      return json(route, { sessions: items.slice(offset, offset + limit), offset, limit, hasMore: offset + limit < items.length })
    }
    if (pathname === '/api/studio/sessions/hermes/groups') {
      const profile = url.searchParams.get('profile') || 'default'
      return json(route, {
        groups: [], included: conversations.filter(c => c.summary.profile === profile && url.searchParams.getAll('include').includes(c.summary.id)).map(c => c.summary),
      })
    }
    if (/^\/api\/studio\/sessions\/hermes\/[^/]+$/.test(pathname)) {
      unexpected.push(`Unexpected full-detail fallback: ${pathname}`)
      return json(route, { error: 'Pagination must not fall back to full history' }, 404)
    }
    if (route.request().method() !== 'GET' && /\/(chat|run|sessions)(\/|$)/.test(pathname)) {
      unexpected.push(`Forbidden mutation: ${route.request().method()} ${pathname}`)
      return json(route, { error: 'No real chat sessions in this test' }, 403)
    }
    return route.fallback()
  })
  return {
    requests,
    offsets: (id: string, profile = 'default') => requests.filter(r => r.id === id && r.profile === profile).map(r => r.offset),
    maxInFlight: () => maxInFlight,
  }
}

async function openHistory(page: Page, id: string, profile = 'default') {
  await page.goto(`/#/hermes/history/session/${id}?profile=${profile}`)
  await expect(page.locator(viewport)).toBeVisible()
}

// Read-only probe of the actual mounted component's public prop. It proves the complete
// ordered data set while separate DOM assertions prove virtualization (offscreen rows
// deliberately do not exist in the DOM). Never calls loaders or mutates Vue/store state.
async function loadedHistory(page: Page) {
  return page.locator(shell).evaluate(element => {
    // A component-root element can be tagged with its parent's vnode owner;
    // start at a rendered descendant so the ancestor chain includes the list.
    let component = (element.querySelector('.virtual-row') as any)?.__vueParentComponent
    while (component && !component.props?.session) component = component.parent
    const session = component?.props?.session
    if (!session) throw new Error('Mounted HistoryMessageList session prop not found; run Vite with NODE_ENV=development')
    return {
      id: session.id as string, profile: session.profile as string,
      loaded: session.loadedMessageCount as number, hasMore: session.hasMoreBefore as boolean,
      messages: session.messages.map((m: { id: string; content: string }) => ({ id: m.id, content: m.content })),
    }
  })
}

function expectedMessages(target: Conversation) {
  return target.messages.map(m => ({ id: String(m.id), content: m.content }))
}

async function expectComplete(page: Page, target: Conversation) {
  await expect.poll(async () => (await loadedHistory(page)).loaded, { timeout: 12_000 }).toBe(target.messages.length)
  const loaded = await loadedHistory(page)
  expect(loaded.messages).toEqual(expectedMessages(target))
  expect(new Set(loaded.messages.map(m => m.id)).size).toBe(target.messages.length)
  expect(loaded.hasMore).toBe(false)
}

async function bottomGap(page: Page) {
  return page.locator(viewport).evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)
}

async function frames(page: Page, count = 4) {
  await page.evaluate(async count => {
    for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }, count)
}

test.describe('history automatic message pagination', () => {
  test.setTimeout(35_000)

  test.afterEach(async ({ page }, testInfo) => {
    const result = evidence.get(page)
    if (!result) return
    for (const gate of result.gates) gate.release()
    await testInfo.attach('synthetic-history-evidence', { body: JSON.stringify(result, (key, value) => key === 'gates' ? undefined : value, 2), contentType: 'application/json' })
    expect(result.unexpected).toEqual([])
    expect(result.errors).toEqual([])
  })

  test('automatically loads every page in a unique serial sequence without scroll input; keeps bottom and bounded DOM', async ({ page }, testInfo) => {
    const target = conversation('auto-all', 1_201)
    const gate = deferred()
    const api = await setup(page, [target], { hold: { id: target.summary.id, offset: PAGE_SIZE, gate } })
    await openHistory(page, target.summary.id)
    await expect(page.getByText(target.messages.at(-1)!.content, { exact: true })).toBeVisible()
    await expect.poll(() => api.offsets(target.summary.id)).toEqual([0, 150])
    expect((await loadedHistory(page)).loaded).toBe(150)
    const initialRows = await page.locator(rows).count()
    expect(initialRows).toBeGreaterThan(0)
    expect(initialRows).toBeLessThan(100)
    gate.release()
    // No wheel(), scrollTop assignment, scrollIntoView() or navigation after entry.
    await expectComplete(page, target)
    const expectedOffsets = Array.from({ length: Math.ceil(target.messages.length / PAGE_SIZE) }, (_, i) => i * PAGE_SIZE)
    expect(api.offsets(target.summary.id)).toEqual(expectedOffsets)
    expect(api.maxInFlight()).toBe(1)
    for (let i = 1; i < api.requests.length; i++) {
      expect(api.requests[i].started).toBeGreaterThanOrEqual(api.requests[i - 1].finished!)
      expect(api.requests[i].frame!).toBeGreaterThan(api.requests[i - 1].frame!)
    }
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(4)
    const finalRows = await page.locator(rows).count()
    const pooledRows = await page.locator(`${viewport} .virtual-row`).count()
    expect(finalRows).toBeLessThan(100)
    expect(pooledRows).toBeLessThan(150)
    expect(finalRows).toBeLessThan(initialRows * 3 + 10)
    await expect(page.getByText(target.messages.at(-1)!.content, { exact: true })).toBeVisible()
    expect(await page.evaluate(() => (window as any).__HISTORY_E2E_PROBE__.wheelEvents)).toBe(0)
    await page.waitForTimeout(QUIET_MS)
    expect(api.offsets(target.summary.id)).toEqual(expectedOffsets)
    await testInfo.attach('virtual-dom-counts', { body: JSON.stringify({ total: target.messages.length, initialRows, finalRows, pooledRows, bottomGap: await bottomGap(page) }), contentType: 'application/json' })
  })

  test('shows the latest 150 immediately while the next response is still held', async ({ page }) => {
    const target = conversation('slow-page', 451)
    const gate = deferred()
    const api = await setup(page, [target], { hold: { id: target.summary.id, offset: 150, gate } })
    await openHistory(page, target.summary.id)
    // The gate is deliberately unresolved: rendering cannot depend on all older pages.
    await expect(page.getByText(target.messages.at(-1)!.content, { exact: true })).toBeVisible()
    expect((await loadedHistory(page)).messages).toEqual(expectedMessages(target).slice(-150))
    await expect.poll(() => api.offsets(target.summary.id)).toEqual([0, 150])
    await page.waitForTimeout(QUIET_MS)
    expect(api.offsets(target.summary.id)).toEqual([0, 150])
    expect((await loadedHistory(page)).loaded).toBe(150)
    gate.release()
    await expectComplete(page, target)
  })

  test('preserves the reading anchor in pixels when the user scrolls during an in-flight older page', async ({ page }, testInfo) => {
    const target = conversation('anchor', 451)
    const gate = deferred()
    const api = await setup(page, [target], { hold: { id: target.summary.id, offset: 150, gate } })
    await openHistory(page, target.summary.id)
    await expect.poll(() => api.offsets(target.summary.id)).toEqual([0, 150])
    await expect.poll(() => bottomGap(page)).toBeLessThanOrEqual(4)
    await page.locator(viewport).hover()
    await page.mouse.wheel(0, -3_000)
    await expect.poll(() => bottomGap(page)).toBeGreaterThan(1_000)
    await frames(page, 10)
    const anchor = await page.locator(viewport).evaluate(el => {
      const rect = el.getBoundingClientRect()
      const visible = [...el.querySelectorAll<HTMLElement>('.virtual-row[data-message-id]:not([data-virtual-inactive])')]
        .find(row => row.getBoundingClientRect().bottom > rect.top && row.getBoundingClientRect().top < rect.bottom)
      if (!visible) throw new Error('No visible reading anchor')
      return { id: visible.dataset.messageId!, top: visible.getBoundingClientRect().top - rect.top, scrollTop: el.scrollTop }
    })
    expect(anchor.scrollTop).toBeGreaterThan(120)
    expect(anchor.id).not.toBe(String(target.messages.length))
    gate.release()
    await expectComplete(page, target)
    await frames(page, 35)
    const anchorRow = page.locator(`${rows}[data-message-id="${anchor.id}"]`)
    await expect(anchorRow).toBeVisible()
    const after = await anchorRow.evaluate(el => el.getBoundingClientRect().top - el.closest('.virtual-message-list')!.getBoundingClientRect().top)
    expect(Math.abs(after - anchor.top)).toBeLessThanOrEqual(4)
    expect(await bottomGap(page)).toBeGreaterThan(1_000)
    await testInfo.attach('reading-anchor-pixels', { body: JSON.stringify({ before: anchor, after, delta: after - anchor.top }), contentType: 'application/json' })
  })

  test('discards the delayed A page after clicking B and never requests A again', async ({ page }) => {
    const a = conversation('switch-a', 601)
    const b = conversation('switch-b', 301)
    const gate = deferred()
    const api = await setup(page, [a, b], { hold: { id: a.summary.id, offset: 150, gate } })
    await openHistory(page, a.summary.id)
    await expect.poll(() => api.offsets(a.summary.id)).toEqual([0, 150])
    await page.getByText(b.summary.title, { exact: true }).first().click()
    await expect(page).toHaveURL(/session\/switch-b\?profile=default$/)
    await expect(page.getByText(b.messages.at(-1)!.content, { exact: true })).toBeVisible()
    gate.release()
    await expectComplete(page, b)
    await page.waitForTimeout(QUIET_MS)
    expect(api.offsets(a.summary.id)).toEqual([0, 150])
    expect(api.offsets(b.summary.id)).toEqual([0, 150, 300])
    expect((await loadedHistory(page)).messages).toEqual(expectedMessages(b))
    await expect(page.locator(rows).filter({ hasText: 'default/switch-a' })).toHaveCount(0)
  })

  test('discards an old page when the same session id changes profile in the same document', async ({ page }) => {
    const oldProfile = conversation('shared-id', 601, 'default')
    const newProfile = conversation('shared-id', 301, 'research')
    const gate = deferred()
    const api = await setup(page, [oldProfile, newProfile], { hold: { id: 'shared-id', profile: 'default', offset: 150, gate } })
    await openHistory(page, 'shared-id')
    await expect.poll(() => api.offsets('shared-id')).toEqual([0, 150])
    // SPA deep link: a full page reload would hide stale-response bugs by destroying the old app.
    await page.evaluate(() => { window.location.hash = '#/hermes/history/session/shared-id?profile=research' })
    await expect.poll(() => api.offsets('shared-id', 'research')).toContain(0)
    await expect(page.getByText(newProfile.messages.at(-1)!.content, { exact: true })).toBeVisible()
    gate.release()
    await expectComplete(page, newProfile)
    await page.waitForTimeout(QUIET_MS)
    expect(api.offsets('shared-id', 'default')).toEqual([0, 150])
    expect(api.offsets('shared-id', 'research')).toEqual([0, 150, 300])
    expect((await loadedHistory(page)).profile).toBe('research')
    expect((await loadedHistory(page)).messages).toEqual(expectedMessages(newProfile))
  })

  for (const failure of ['null', '500'] as const) {
    test(`stops after a ${failure} page response and resumes from the failed offset only on Retry`, async ({ page }) => {
      const target = conversation(`failure-${failure}`, 451)
      const api = await setup(page, [target], { failure })
      await openHistory(page, target.summary.id)
      await expect.poll(() => api.offsets(target.summary.id)).toEqual([0, 150])
      const retry = page.getByRole('button', { name: 'Retry', exact: true })
      await expect(retry).toBeVisible()
      await page.waitForTimeout(QUIET_MS)
      expect(api.offsets(target.summary.id)).toEqual([0, 150])
      expect((await loadedHistory(page)).messages).toEqual(expectedMessages(target).slice(-150))
      await retry.click()
      await expectComplete(page, target)
      expect(api.offsets(target.summary.id)).toEqual([0, 150, 150, 300, 450])
      await expect(retry).toHaveCount(0)
    })
  }

  test('stops requesting pages after leaving History while an older response is pending', async ({ page }) => {
    const target = conversation('leave-history', 601)
    const gate = deferred()
    const api = await setup(page, [target], { hold: { id: target.summary.id, offset: 150, gate } })
    await openHistory(page, target.summary.id)
    await expect.poll(() => api.offsets(target.summary.id)).toEqual([0, 150])
    // Theme is a real route and does not create or resume a live chat session.
    await page.evaluate(() => { window.location.hash = '#/hermes/theme' })
    await expect(page.locator(shell)).toHaveCount(0)
    gate.release()
    await page.waitForTimeout(QUIET_MS)
    expect(api.offsets(target.summary.id)).toEqual([0, 150])
    await expect(page.locator(shell)).toHaveCount(0)
  })
})
