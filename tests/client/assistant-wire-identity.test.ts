// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const state = vi.hoisted(() => ({ resume: undefined as undefined | ((data: any) => void), event: undefined as any, reconnect: undefined as any, handlers: undefined as any }))
vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: vi.fn((_body: any, event: any, _done: any, _error: any, _started: any, options: any) => { state.event = event; state.reconnect = options?.onReconnectResume; return { abort: vi.fn() } }),
  resumeSession: vi.fn((_sid: string, cb: (data: any) => void) => { state.resume = cb }),
  registerSessionHandlers: vi.fn((_sid: string, handlers: any) => { state.handlers = handlers }), unregisterSessionHandlers: vi.fn((_sid: string, handlers: any) => { state.handlers = handlers }),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(), respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()), onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()), onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))
vi.mock('@/api/studio/sessions', () => ({
  fetchSessions: vi.fn(async () => []), fetchSessionMessagesPage: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []), fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  archiveSession: vi.fn(), deleteSession: vi.fn(), setSessionModel: vi.fn(),
  setSessionPushEnabled: vi.fn(), setSessionReasoningEffort: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: vi.fn(() => false) }))
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: (_p: string, n: string) => `/download/${n}` }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))
vi.mock('@/utils/completion-notification', () => ({ showCompletionNotification: vi.fn() }))
vi.mock('@/utils/session-sync', () => ({ subscribeSessionSync: vi.fn(() => vi.fn()), publishSessionSync: vi.fn() }))

import { useChatStore, type Session } from '@/stores/hermes/chat'

const session = (): Session => ({ id: 's1', title: '', messages: [], createdAt: 1, updatedAt: 1, source: 'cli', profile: 'default', messageCount: 3, messageTotal: 3, loadedMessageCount: 3, hasMoreBefore: false })
const raw = (id: number, role: any, content: string, extra: any = {}) => ({ id, session_id: 's1', role, content, timestamp: 10, tool_call_id: null, tool_calls: null, tool_name: null, run_marker: extra.run_marker ?? null, finish_reason: role === 'assistant' ? 'stop' : null, reasoning: null, ...extra })


const wire = (event: string, extra: any = {}, identity = 'am-segment-1') => ({ event, session_id: 's1', run_marker: 'run-1', client_message_id: identity, ...extra })
const persisted = (id=1001, identity='am-segment-1', content='Deployed and verified.') => raw(id, 'assistant', content, {client_message_id:identity,run_marker:'run-1',reasoning:'Verification summary'})
const snapshot = (messages: any[], working=false) => ({session_id:'s1',messages,messageTotal:10,messageLoadedCount:messages.length,hasMoreBefore:true,isWorking:working,events:[]})
async function setup(resumed=false) {
 const store=useChatStore(),s=session();store.sessions=[s];store.activeSessionId=s.id;store.activeSession=s
 if(resumed){const pending=store.switchSession(s.id);state.resume!(snapshot([],true));await pending}
 else await store.sendMessage('probe')
 const event = resumed ? (e:any)=>{ const names:Record<string,string>={'run.started':'onRunStarted','message.delta':'onMessageDelta','message.interim':'onMessageInterim','reasoning.delta':'onReasoningDelta','tool.started':'onToolStarted','run.completed':'onRunCompleted','run.failed':'onRunFailed'};state.handlers[names[e.event]](e) } : state.event
 event(wire('run.started'));return {store,s,event}
}
describe('assistant wire identity in actual Pinia store',()=>{
 beforeEach(()=>{vi.clearAllMocks();state.resume=undefined;state.event=undefined;state.handlers=undefined;localStorage.clear();setActivePinia(createPinia())})
 for(const resumed of [false,true]) {
  it(`stream/interim/persisted snapshot is one assistant, resumed=${resumed}`,async()=>{
   const {s,event}=await setup(resumed)
   event(wire('reasoning.delta',{delta:'Verification summary'}));event(wire('message.delta',{delta:'Deployed and verified.'}));event(wire('message.interim',{text:'Deployed and verified.',message_id:1001}))
   let assistants=s.messages.filter(m=>m.role==='assistant');expect(assistants).toHaveLength(1);expect(assistants[0].clientMessageId).toBe('am-segment-1');expect(assistants[0].id).toBe('1001')
   if(!resumed){state.reconnect(snapshot([persisted()]));state.reconnect(snapshot([persisted()]))}
   event(wire('message.interim',{text:'Deployed and verified.',message_id:1001}))
   event(wire('run.completed',{output:'Deployed and verified.',parsed_content:'Deployed and verified.',parsed_reasoning:'Verification summary',message_id:1001}))
   assistants=s.messages.filter(m=>m.role==='assistant');expect(assistants).toHaveLength(1);expect(assistants[0].reasoning).toBe('Verification summary')
  })
  it(`same-text segments in one run stay distinct, resumed=${resumed}`,async()=>{
   const {s,event}=await setup(resumed)
   for(const i of [1,2]){event(wire('reasoning.delta',{delta:'Verification summary'},`am-${i}`));event(wire('message.delta',{delta:'Same answer'},`am-${i}`));event(wire('message.interim',{text:'Same answer',message_id:90+i},`am-${i}`))}
   event(wire('run.completed',{output:'Same answer',parsed_content:'Same answer',message_id:92},'am-2'))
   expect(s.messages.filter(m=>m.role==='assistant').map(m=>m.clientMessageId)).toEqual(['am-1','am-2'])
   if(!resumed){state.reconnect(snapshot([persisted(91,'am-1','Same answer'),persisted(92,'am-2','Same answer')]))}
   expect(s.messages.filter(m=>m.role==='assistant')).toHaveLength(2)
  })
  it(`terminal-only and reasoning-only final use persisted identity, resumed=${resumed}`,async()=>{
   const {s,event}=await setup(resumed)
   event(wire('reasoning.delta',{delta:'Verification summary'}));event(wire('run.completed',{output:'Deployed and verified.',message_id:1001}))
   expect(s.messages.filter(m=>m.role==='assistant')).toHaveLength(1);expect(s.messages.find(m=>m.role==='assistant')?.id).toBe('1001')
  })
  it(`failed partial assistant retains identity for snapshot, resumed=${resumed}`,async()=>{
   const {s,event}=await setup(resumed)
   event(wire('message.delta',{delta:'Partial'}));event(wire('run.failed',{error:'Interrupted',message_id:91}))
   expect(s.messages.find(m=>m.role==='assistant')?.id).toBe('91');expect(s.messages.find(m=>m.role==='assistant')?.isStreaming).toBe(false)
  })
 }
 for(const resumed of [false,true]) it(`does not put aggregate output into a later reasoning-only segment, resumed=${resumed}`,async()=>{
  const {s,event}=await setup(resumed)
  event(wire('message.delta',{delta:'First answer'},'am-first'))
  event(wire('message.interim',{text:'First answer',message_id:9},'am-first'))
  event(wire('reasoning.delta',{delta:'Final thought without body'},'am-last'))
  event(wire('run.completed',{message_id:10,output:'First answer',assistant_content:'',assistant_reasoning:'Final thought without body'},'am-last'))
  expect(s.messages.filter(m=>m.role==='assistant').map(m=>m.content)).toEqual(['First answer',''])
  expect(s.messages.filter(m=>m.role==='assistant')[1].reasoning).toBe('Final thought without body')
 })
 it('transfers a reasoning-only assistant into its identified tool row without a ghost on resume',async()=>{
  const {s,event}=await setup();event(wire('reasoning.delta',{delta:'Verification summary'}))
  event({event:'tool.started',session_id:'s1',run_marker:'run-1',tool_call_id:'call-1',tool:'terminal',arguments:{},assistant_client_message_id:'am-segment-1',assistant_message_id:90})
  expect(s.messages.filter(m=>m.role==='assistant')).toHaveLength(0)
  expect(s.messages.find(m=>m.role==='tool')?.reasoning).toBe('Verification summary')
  state.reconnect(snapshot([raw(90,'assistant','',{client_message_id:'am-segment-1',run_marker:'run-1',reasoning:'Verification summary',tool_calls:[{id:'call-1',type:'function',function:{name:'terminal',arguments:'{}'}}],finish_reason:'tool_calls'})],true))
  expect(s.messages.filter(m=>m.role==='assistant')).toHaveLength(0)
  expect(s.messages.filter(m=>m.role==='tool')).toHaveLength(1)
 })
 it('does not append delayed deltas to a completed identified segment',async()=>{
  const {s,event}=await setup();event(wire('message.interim',{text:'Final body',message_id:9}))
  event(wire('message.delta',{delta:'Final body',message_id:9}));event(wire('reasoning.delta',{delta:'Late duplicate',message_id:9}))
  expect(s.messages.filter(m=>m.role==='assistant').map(m=>m.content)).toEqual(['Final body'])
  expect(s.messages.filter(m=>m.role==='assistant')[0].reasoning).toBeUndefined()
 })
 it('terminal-only reply followed by snapshot remains one and retains distinct next final',async()=>{
  const {s,event}=await setup();event(wire('run.completed',{output:'Only final',message_id:8}))
  state.reconnect(snapshot([persisted(8,'am-segment-1','Only final')]))
  expect(s.messages.filter(m=>m.role==='assistant').map(m=>m.content)).toEqual(['Only final'])
 })
 it('continues a canonical in-flight snapshot without a second assistant',async()=>{
  const {s,event}=await setup();event(wire('message.delta',{delta:'First'}))
  state.reconnect(snapshot([raw(88,'assistant','First',{client_message_id:'am-segment-1',run_marker:'run-1',finish_reason:null})],true))
  event(wire('message.delta',{delta:' second'}));event(wire('message.interim',{text:'First second',message_id:88}))
  expect(s.messages.filter(m=>m.role==='assistant').map(m=>m.content)).toEqual(['First second'])
 })
})
