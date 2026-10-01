import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const streamed of [true, false]) {
  test(`assistant segments stay unique across terminal and resume (streamed=${streamed})`, async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    await mockHermesApi(page)
    await page.goto('/#/hermes/chat')
    const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
    await input.fill('Verify assistant identity')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const handle = await page.waitForFunction(() => (window as any).__PW_CHAT_SOCKET__?.emitted.find((e: any) => e.event === 'run')?.payload)
    const run = await handle.jsonValue()
    await page.evaluate(({ run, streamed }) => {
      const socket = (window as any).__PW_CHAT_SOCKET__.latest
      const event = (name: string, i: number, extra: any = {}) => socket.__trigger(name, { event: name, session_id: run.session_id, run_marker: 'run-identity', client_message_id: `am-browser-${i}`, ...extra })
      event('run.started', 1)
      for (const i of [1, 2]) {
        if (streamed) {
          event('reasoning.delta', i, { delta: 'Verified counterexamples' })
          event('message.delta', i, { delta: 'One logical reply per segment.' })
        }
        event('message.interim', i, { text: 'One logical reply per segment.', message_id: 90 + i })
        event('message.interim', i, { text: 'One logical reply per segment.', message_id: 90 + i })
      }
      event('run.completed', 2, { message_id: 92, parsed_content: 'One logical reply per segment.', output: 'One logical reply per segment.' })
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { [run.session_id]: {
        session_id: run.session_id, isWorking: false, messageTotal: 3, messageLoadedCount: 3, hasMoreBefore: false, events: [], messages: [
          { id: 90, role: 'user', content: 'Verify assistant identity', timestamp: 10, client_message_id: run.client_message_id },
          ...[1, 2].map(i => ({ id: 90 + i, role: 'assistant', content: 'One logical reply per segment.', reasoning: streamed ? 'Verified counterexamples' : null, timestamp: 10 + i, run_marker: 'run-identity', client_message_id: `am-browser-${i}`, finish_reason: 'stop' })),
        ],
      } }
    }, { run, streamed })
    const replies = page.locator('p').filter({ hasText: /^One logical reply per segment\.$/ })
    await expect(replies).toHaveCount(2)
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((e: any) => e.event === 'resume').length)).toBeGreaterThan(0)
    await expect(replies).toHaveCount(2)
    await expect(page.locator('p').filter({ hasText: /^Verify assistant identity$/ })).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  })
}

test('late visibility resume cannot put A messages into selected B', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page, { sessions: ['a','b'].map((id,i)=>({id,title:`Session ${id}`,profile:'research',source:'cli',started_at:1,last_active:3-i,message_count:2})) })
  await page.addInitScript(() => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = Object.fromEntries(['a','b'].map(id=>[id,{
      session_id:id,isWorking:false,messageTotal:2,messageLoadedCount:2,hasMoreBefore:false,events:[],messages:[
        {id:`${id}-u`,role:'user',content:`Question ${id}`,timestamp:1},
        {id:`${id}-a`,role:'assistant',content:`Own answer ${id}`,timestamp:2,finish_reason:'stop'},
      ],
    }]))
  })
  await page.goto('/#/hermes/session/a')
  await expect(page.locator('p').filter({hasText:/^Own answer a$/})).toHaveCount(1)
  await page.evaluate(()=>{
    delete (window as any).__PW_CHAT_SOCKET_RESUMES__.a
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(()=>page.evaluate(()=>(window as any).__PW_CHAT_SOCKET__.emitted.filter((e:any)=>e.event==='resume'&&e.payload.session_id==='a').length)).toBeGreaterThan(1)
  await page.evaluate(()=>{location.hash='/hermes/session/b'})
  await expect(page.locator('p').filter({hasText:/^Own answer b$/})).toHaveCount(1)
  await page.evaluate(()=>{
    const state=(window as any).__PW_CHAT_SOCKET__
    const request=state.emitted.filter((e:any)=>e.event==='resume'&&e.payload.session_id==='a').at(-1).payload
    state.latest.__trigger('resumed',{session_id:'a',request_id:request.request_id,isWorking:false,messages:[{id:'late-a',role:'assistant',content:'Late A must not appear in B',timestamp:3}],messageTotal:1,messageLoadedCount:1,hasMoreBefore:false,events:[]})
  })
  await expect(page.locator('p').filter({hasText:/^Own answer b$/})).toHaveCount(1)
  await expect(page.getByText('Late A must not appear in B',{exact:true})).toHaveCount(0)
  await expect(page).toHaveURL(/hermes\/session\/b$/)
})
