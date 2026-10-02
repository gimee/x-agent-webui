/// <reference types="node" />
import { expect, test, type Page, type Route } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2V9sAAAAASUVORK5CYII=',
  'base64',
)

const PROFILE = 'research'
const LIVE_ID = 'claude-live-images'
const HISTORY_A_ID = 'claude-history-a'
const HISTORY_B_ID = 'claude-history-b'
const HERMES_ID = 'hermes-generic-images'

const SPECIAL_PATH = '/workspace/图片 folder/with space # 百分号%.png'
const SPECIAL_MARKDOWN_PATH = '/workspace/%E5%9B%BE%E7%89%87%20folder/with%20space%20%23%20%E7%99%BE%E5%88%86%E5%8F%B7%25.png'
const FORBIDDEN_PATH = '/workspace/图片 folder/forbidden # 百分号%.png'
const FORBIDDEN_MARKDOWN_PATH = '/workspace/%E5%9B%BE%E7%89%87%20folder/forbidden%20%23%20%E7%99%BE%E5%88%86%E5%8F%B7%25.png'
const HERMES_PATH = '/tmp/hermes-old-image.png'
const EXTERNAL_IMAGE = 'https://example.com/external.png'

const imageMarkdown = (alt: string, path: string) => `![${alt}](${path})`

function sessionSummary(
  id: string,
  title: string,
  source: 'coding_agent' | 'cli' = 'coding_agent',
) {
  const codingAgent = source === 'coding_agent'
  return {
    id,
    profile: PROFILE,
    source,
    ...(codingAgent ? { agent: 'claude', agent_mode: 'scoped', agent_session_id: `${id}-native` } : {}),
    model: 'test-model',
    provider: 'test-provider',
    title,
    preview: title,
    started_at: 1_790_000_000,
    ended_at: null,
    last_active: 1_790_000_100,
    message_count: 2,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: null,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: 'estimated',
    workspace: codingAgent ? '/workspace/claude project' : null,
  }
}

type Summary = ReturnType<typeof sessionSummary>

type FixtureMessage = {
  id: number
  session_id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  tool_call_id: null
  tool_calls: null
  tool_name: null
  run_marker: null
  token_count: null
  finish_reason: string | null
  reasoning: null
}

function message(id: number, sessionId: string, role: FixtureMessage['role'], content: string): FixtureMessage {
  return {
    id,
    session_id: sessionId,
    role,
    content,
    timestamp: 1_790_000_000 + id,
    tool_call_id: null,
    tool_calls: null,
    tool_name: null,
    run_marker: null,
    token_count: null,
    finish_reason: role === 'assistant' ? 'stop' : null,
    reasoning: null,
  }
}

function sessionContent(alt: string) {
  return [
    imageMarkdown(alt, SPECIAL_MARKDOWN_PATH),
    imageMarkdown('external-image', EXTERNAL_IMAGE),
    imageMarkdown('forbidden-image', FORBIDDEN_MARKDOWN_PATH),
  ].join('\n\n')
}

function histories(): Record<string, { summary: Summary; messages: FixtureMessage[] }> {
  const a = sessionSummary(HISTORY_A_ID, 'Claude image A')
  const b = sessionSummary(HISTORY_B_ID, 'Claude image B')
  const hermes = sessionSummary(HERMES_ID, 'Hermes generic image', 'cli')
  return {
    [HISTORY_A_ID]: {
      summary: a,
      messages: [
        message(1, HISTORY_A_ID, 'user', 'Show image A'),
        message(2, HISTORY_A_ID, 'assistant', sessionContent('history-a-image')),
      ],
    },
    [HISTORY_B_ID]: {
      summary: b,
      messages: [
        message(1, HISTORY_B_ID, 'user', 'Show image B'),
        message(2, HISTORY_B_ID, 'assistant', sessionContent('history-b-image')),
      ],
    },
    [HERMES_ID]: {
      summary: hermes,
      messages: [
        message(1, HERMES_ID, 'user', 'Keep the old Hermes image URL'),
        message(2, HERMES_ID, 'assistant', imageMarkdown('hermes-image', HERMES_PATH)),
      ],
    },
  }
}

function json(route: Route, value: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(value),
  })
}

type ImageRequest = {
  kind: 'session' | 'generic' | 'external'
  url: string
  sessionId?: string
  profile?: string
  path?: string
  status: number
}

type Fixture = ReturnType<typeof histories>

async function setup(page: Page) {
  const fixture = histories()
  const liveSummary = sessionSummary(LIVE_ID, 'Claude live images')
  const liveContent = [
    imageMarkdown('live-local-image', SPECIAL_MARKDOWN_PATH),
    imageMarkdown('live-external-image', EXTERNAL_IMAGE),
    imageMarkdown('live-forbidden-image', FORBIDDEN_MARKDOWN_PATH),
  ].join('\n\n')
  let liveMessages = [
    message(1, LIVE_ID, 'user', 'Start a Claude image turn'),
  ]
  const summaries = [liveSummary, ...Object.values(fixture).map(item => item.summary)]
  const imageRequests: ImageRequest[] = []
  const unexpected: string[] = []

  await authenticate(page, TEST_ACCESS_KEY, PROFILE)
  await page.addInitScript(({ sessionId, payload }) => {
    window.localStorage.setItem('hermes_active_session_research', sessionId)
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { [sessionId]: payload }
  }, {
    sessionId: LIVE_ID,
    payload: {
      session_id: LIVE_ID,
      profile: PROFILE,
      isWorking: false,
      workspace: liveSummary.workspace,
      messages: liveMessages,
      events: [],
    },
  })

  const api = await mockHermesApi(page, {
    initialProfileName: PROFILE,
    sessions: summaries,
  })

  // This route is intentionally installed after mockHermesApi so it can replace only
  // the synthetic session/file responses while retaining the shared fixture defaults.
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url

    if (request.method() === 'GET' && pathname === '/api/studio/sessions') {
      const profile = url.searchParams.get('profile') || PROFILE
      return json(route, { sessions: summaries.filter(item => (item.profile || 'default') === profile) })
    }

    if (request.method() === 'GET' && pathname === '/api/studio/sessions/hermes') {
      const profile = url.searchParams.get('profile') || PROFILE
      const offset = Number(url.searchParams.get('offset') || 0)
      const limit = Number(url.searchParams.get('limit') || 50)
      const page = summaries.filter(item => (item.profile || 'default') === profile).slice(offset, offset + limit)
      return json(route, { sessions: page, offset, limit, hasMore: offset + limit < summaries.length })
    }

    const paginated = pathname.match(/^\/api\/studio\/sessions\/conversations\/([^/]+)\/messages\/paginated$/)
    if (request.method() === 'GET' && paginated) {
      const sessionId = decodeURIComponent(paginated[1])
      const profile = url.searchParams.get('profile') || PROFILE
      const target = sessionId === LIVE_ID
        ? { summary: liveSummary, messages: liveMessages }
        : fixture[sessionId]
      if (!target || target.summary.profile !== profile) return json(route, { error: 'synthetic session not found' }, 404)
      return json(route, {
        session: target.summary,
        messages: target.messages,
        workspaceRunChanges: [],
        total: target.messages.length,
        offset: Number(url.searchParams.get('offset') || 0),
        limit: Number(url.searchParams.get('limit') || 150),
        hasMore: false,
      })
    }

    const fullDetail = pathname.match(/^\/api\/studio\/sessions\/hermes\/([^/]+)$/)
    if (request.method() === 'GET' && fullDetail) {
      const sessionId = decodeURIComponent(fullDetail[1])
      const target = sessionId === LIVE_ID
        ? { summary: liveSummary, messages: liveMessages }
        : fixture[sessionId]
      if (!target) return json(route, { error: 'synthetic session not found' }, 404)
      return json(route, { session: { ...target.summary, messages: target.messages } })
    }

    const sessionImage = pathname.match(/^\/api\/studio\/sessions\/([^/]+)\/workspace-file\/content$/)
    if (request.method() === 'GET' && sessionImage) {
      const sessionId = decodeURIComponent(sessionImage[1])
      const path = url.searchParams.get('path') || ''
      imageRequests.push({
        kind: 'session',
        url: request.url(),
        sessionId,
        profile: url.searchParams.get('profile') || undefined,
        path,
        status: path === FORBIDDEN_PATH ? 403 : 200,
      })
      if (path === FORBIDDEN_PATH) return route.fulfill({ status: 403, contentType: 'image/png', body: Buffer.alloc(0) })
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1X1 })
    }

    if (request.method() === 'GET' && pathname === '/api/studio/files/download') {
      imageRequests.push({
        kind: 'generic',
        url: request.url(),
        path: url.searchParams.get('path') || undefined,
        profile: url.searchParams.get('profile') || undefined,
        status: 400,
      })
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'generic image access is not allowed' }) })
    }

    if (request.method() === 'GET' && url.origin === 'https://example.com' && pathname === '/external.png') {
      imageRequests.push({ kind: 'external', url: request.url(), status: 200 })
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1X1 })
    }

    return route.fallback()
  })

  return {
    fixture,
    liveSummary,
    liveContent,
    imageRequests,
    unexpected,
    api,
    setLiveMessages(messages: FixtureMessage[]) { liveMessages = messages },
  }
}

async function waitForImage(page: Page, alt: string, scope = '') {
  const image = page.locator(`${scope} img[alt="${alt}"]`).last()
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  return image
}

function image(page: Page, alt: string, scope = '') {
  return page.locator(`${scope} img[alt="${alt}"]`).last()
}

async function waitForRun(page: Page) {
  const handle = await page.waitForFunction(() => {
    const state = (window as any).__PW_CHAT_SOCKET__
    const runs = state?.emitted?.filter((item: any) => item.event === 'run') || []
    return runs.at(-1)?.payload || null
  })
  return handle.jsonValue() as Promise<{ session_id: string; input: string }>
}

async function openHistory(page: Page, sessionId: string) {
  await page.goto(`/#/hermes/history/session/${sessionId}?profile=${PROFILE}`)
  await expect(page.locator('.history-message-list-shell')).toBeVisible()
}

test.describe('Claude coding-agent workspace images', () => {
  test.setTimeout(45_000)

  test('resolves local Markdown images on live Claude messages, preserves external URLs, previews, reloads, and fails closed', async ({ page }) => {
    const harness = await setup(page)
    await page.goto('/#/hermes/chat')

    const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
    await expect(input).toBeVisible()
    await input.fill('Send a synthetic Claude image turn')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const run = await waitForRun(page)
    expect(run.session_id).toBe(LIVE_ID)

    await page.evaluate(({ sessionId, content }) => {
      const socket = (window as any).__PW_CHAT_SOCKET__.latest
      socket.__trigger('run.started', { event: 'run.started', session_id: sessionId, run_id: 'image-run-1' })
      socket.__trigger('message.delta', { event: 'message.delta', session_id: sessionId, run_id: 'image-run-1', delta: content })
      socket.__trigger('run.completed', { event: 'run.completed', session_id: sessionId, run_id: 'image-run-1', output: content })
    }, { sessionId: LIVE_ID, content: harness.liveContent })

    const localImage = await waitForImage(page, 'live-local-image', '.message-list-shell')
    const externalImage = await waitForImage(page, 'live-external-image', '.message-list-shell')
    const forbiddenImage = image(page, 'live-forbidden-image', '.message-list-shell')
    await expect(forbiddenImage).toBeVisible()
    await expect.poll(() => forbiddenImage.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(0)

    const localUrl = await localImage.getAttribute('src')
    expect(localUrl).toBeTruthy()
    const parsedLocalUrl = new URL(localUrl!, 'http://127.0.0.1:14178')
    expect(parsedLocalUrl.pathname).toBe(`/api/studio/sessions/${LIVE_ID}/workspace-file/content`)
    expect(parsedLocalUrl.searchParams.get('path')).toBe(SPECIAL_PATH)
    expect(parsedLocalUrl.searchParams.get('profile')).toBe(PROFILE)
    expect(parsedLocalUrl.searchParams.get('token')).toBe(TEST_ACCESS_KEY)
    expect(await externalImage.getAttribute('src')).toBe(EXTERNAL_IMAGE)
    expect(harness.imageRequests.filter(request => request.kind === 'generic')).toEqual([])
    expect(harness.imageRequests.filter(request => request.path === FORBIDDEN_PATH)).toEqual([
      expect.objectContaining({ kind: 'session', sessionId: LIVE_ID, profile: PROFILE, status: 403 }),
    ])

    await localImage.click()
    const overlay = page.locator('.image-preview-overlay')
    await expect(overlay).toBeVisible()
    await expect(overlay.locator('img')).toHaveAttribute('src', new URL(localUrl!, await page.url()).href)
    await overlay.click({ position: { x: 2, y: 2 } })
    await expect(overlay).toHaveCount(0)

    const persistedLiveMessages = [
      message(1, LIVE_ID, 'user', 'Start a Claude image turn'),
      message(2, LIVE_ID, 'assistant', harness.liveContent),
    ]
    harness.setLiveMessages(persistedLiveMessages)
    await page.addInitScript(({ sessionId, payload }) => {
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { [sessionId]: payload }
    }, {
      sessionId: LIVE_ID,
      payload: {
        session_id: LIVE_ID,
        profile: PROFILE,
        isWorking: false,
        workspace: harness.liveSummary.workspace,
        messages: persistedLiveMessages,
        events: [],
      },
    })
    await page.reload()
    await waitForImage(page, 'live-local-image', '.message-list-shell')
    expect(harness.imageRequests.some(request => request.kind === 'session' && request.sessionId === LIVE_ID && request.path === SPECIAL_PATH)).toBe(true)
    expect(harness.api.unexpectedRequests).toEqual([])
  })

  test('keeps explicit session/profile ownership through history A/B reloads and preserves Hermes generic URLs', async ({ page }) => {
    const harness = await setup(page)

    await openHistory(page, HISTORY_A_ID)
    const historyAImage = await waitForImage(page, 'history-a-image', '.history-message-list-shell')
    const historyAUrl = await historyAImage.getAttribute('src')
    expect(new URL(historyAUrl!, 'http://127.0.0.1:14178').pathname).toBe(`/api/studio/sessions/${HISTORY_A_ID}/workspace-file/content`)
    expect(new URL(historyAUrl!, 'http://127.0.0.1:14178').searchParams.get('path')).toBe(SPECIAL_PATH)
    expect(new URL(historyAUrl!, 'http://127.0.0.1:14178').searchParams.get('profile')).toBe(PROFILE)
    expect(harness.fixture[HISTORY_A_ID].summary.source).toBe('coding_agent')
    expect(harness.fixture[HISTORY_A_ID].summary.agent).toBe('claude')
    expect(harness.fixture[HISTORY_A_ID].summary.workspace).toBeTruthy()

    await page.reload()
    await waitForImage(page, 'history-a-image', '.history-message-list-shell')
    await page.locator('.session-item').filter({ hasText: 'Claude image B' }).click()
    await expect(page).toHaveURL(new RegExp(`session/${HISTORY_B_ID}\\?profile=${PROFILE}$`))
    const historyBImage = await waitForImage(page, 'history-b-image', '.history-message-list-shell')
    const historyBUrl = await historyBImage.getAttribute('src')
    const parsedHistoryBUrl = new URL(historyBUrl!, 'http://127.0.0.1:14178')
    expect(parsedHistoryBUrl.pathname).toBe(`/api/studio/sessions/${HISTORY_B_ID}/workspace-file/content`)
    expect(parsedHistoryBUrl.searchParams.get('path')).toBe(SPECIAL_PATH)
    expect(parsedHistoryBUrl.searchParams.get('profile')).toBe(PROFILE)
    expect(harness.imageRequests.filter(request => request.kind === 'session' && request.path === SPECIAL_PATH).some(request => request.sessionId === HISTORY_A_ID)).toBe(true)
    expect(harness.imageRequests.filter(request => request.kind === 'session' && request.path === SPECIAL_PATH).some(request => request.sessionId === HISTORY_B_ID)).toBe(true)
    expect(harness.imageRequests.filter(request => request.kind === 'generic')).toEqual([])

    await openHistory(page, HERMES_ID)
    const hermesImage = image(page, 'hermes-image', '.history-message-list-shell')
    await expect(hermesImage).toBeVisible()
    const hermesUrl = new URL((await hermesImage.getAttribute('src'))!, 'http://127.0.0.1:14178')
    expect(hermesUrl.pathname).toBe('/api/studio/files/download')
    expect(hermesUrl.searchParams.get('path')).toBe(HERMES_PATH)
    expect(hermesUrl.searchParams.get('profile')).toBe(PROFILE)
    expect(hermesUrl.searchParams.get('token')).toBe(TEST_ACCESS_KEY)
    expect(harness.imageRequests.some(request => request.kind === 'generic' && request.path === HERMES_PATH && request.status === 400)).toBe(true)
    expect(harness.api.unexpectedRequests).toEqual([])
  })
})
