import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

const sessions = [
  { id:'old', title:'Old conversation', source:'cli', profile:'research', started_at:10, last_active:100, message_count:1 },
  { id:'new', title:'Newest conversation', source:'cli', profile:'research', started_at:9, last_active:300, message_count:1 },
  { id:'middle', title:'Middle conversation', source:'cli', profile:'research', started_at:11, last_active:200, message_count:1 },
]
for (const dark of [false, true]) test(`flat chat list and bordered raised tabs (${dark ? 'dark':'light'})`, async ({ page }) => {
  await authenticate(page)
  await mockChatSocket(page)
  await mockHermesApi(page, { sessions })
  await page.addInitScript(dark => localStorage.setItem('hermes_brightness', dark ? 'dark' : 'light'), dark)
  await page.goto('/#/hermes/session/old')
  await expect(page.locator('.session-item')).toHaveCount(3)
  await expect(page.locator('.session-group-header, .session-item-category-tag')).toHaveCount(0)
  expect(await page.locator('.session-item-title').allTextContents()).toEqual(['Newest conversation','Middle conversation','Old conversation'])
  // Initialize the real theme, not just its CSS class: Naive UI shares the same state.
  const all = page.locator('.session-list-tabs [role="tab"][data-name="all"]')
  const starred = page.locator('.session-list-tabs [role="tab"][data-name="starred"]')
  const geometry = () => page.locator('.session-list-tabs').evaluate(el => {
    const tabs=Array.from(el.querySelectorAll('[role="tab"]'))
    return { container:el.getBoundingClientRect().height, tabs:tabs.map(t => { const r=t.getBoundingClientRect(),s=getComputedStyle(t); return {top:r.top,bottom:r.bottom,height:r.height,border:s.borderTopWidth,fill:s.backgroundColor} }) }
  })
  const first = await geometry()
  expect(first.container).toBe(34)
  const overflow=await page.locator('.session-list-tabs [role=tab]').evaluateAll(els=>els.map(e=>e.scrollWidth>e.clientWidth))
  expect(overflow).toEqual([false,false])
  expect(first.tabs.map(t=>t.height)).toEqual([34,30])
  expect(first.tabs[1].top-first.tabs[0].top).toBe(4)
  expect(first.tabs[1].bottom).toBe(first.tabs[0].bottom)
  expect(first.tabs.map(t=>t.border)).toEqual(['1px','1px'])
  await starred.click()
  const second=await geometry()
  expect(second.tabs.map(t=>t.height)).toEqual([30,34])
  expect(second.container).toBe(first.container)
  expect(second.tabs[0].bottom).toBe(first.tabs[0].bottom)
  await all.click()
  await page.locator('.session-item').first().click({button:'right'})
  await expect(page.getByText('Move to category', {exact:true})).toHaveCount(0)
  await all.click()
  await page.getByRole('button',{name:'New Chat',exact:true}).click()
  await expect(page.getByText('Category',{exact:true})).toHaveCount(0)
  await expect(page.getByRole('button',{name:'Create',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Create',exact:true}).click()
  await page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)').fill('New flat list conversation')
  await page.getByRole('button',{name:'Send',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=> (window as any).__PW_CHAT_SOCKET__?.emitted?.filter((e:any)=>e.event==='run').length || 0)).toBe(1)
  const payload=await page.evaluate(()=> (window as any).__PW_CHAT_SOCKET__.emitted.find((e:any)=>e.event==='run').payload)
  expect(payload).not.toHaveProperty('category_id')
  expect(payload.input).toBe('New flat list conversation')
})
