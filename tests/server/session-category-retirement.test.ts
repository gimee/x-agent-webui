import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
describe('retired session category compatibility', () => {
  let db: any
  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({getDb:()=>db,isSqliteAvailable:()=>true,getStoragePath:()=>':memory:'}))
  })
  afterEach(() => { db.close(); vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index'); vi.resetModules() })
  it('new databases and routes no longer expose session categories', async () => {
    const {initAllHermesTables}=await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='session_categories'").all()).toEqual([])
    expect(db.prepare('PRAGMA table_info(sessions)').all().map((x:any)=>x.name)).not.toContain('category_id')
    const routes=readFileSync('packages/server/src/modules/studio/routes/sessions.ts','utf8')
    expect(routes).not.toMatch(/session-categories|:id\/category/)
  })
  it('keeps legacy classified sessions and messages through repeated initialization and new writes', async () => {
    const {SESSIONS_SCHEMA,initAllHermesTables}=await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    const legacy={...SESSIONS_SCHEMA, category_id:'INTEGER'}
    db.exec('CREATE TABLE sessions ('+Object.entries(legacy).map(([k,v])=>k+' '+v).join(',')+')')
    db.exec("CREATE TABLE session_categories(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO session_categories VALUES(7,'old category')")
    db.exec("INSERT INTO sessions(id,profile,source,title,started_at,last_active,category_id) VALUES('old','default','cli','old conversation',10,20,7)")
    initAllHermesTables()
    const {addMessage,createSession,getSessionDetail}=await import('../../packages/server/src/modules/studio/repositories/session-store')
    addMessage({session_id:'old',role:'user',content:'preserved question',timestamp:30})
    initAllHermesTables()
    createSession({id:'new',profile:'default',source:'cli',title:'new conversation'})
    addMessage({session_id:'new',role:'assistant',content:'new answer',timestamp:40})
    const old=getSessionDetail('old')!
    expect(old.messages.map(m=>m.content)).toEqual(['preserved question'])
    expect('category_id' in old).toBe(false)
    expect(db.prepare("SELECT category_id FROM sessions WHERE id='old'").get().category_id).toBe(7)
    expect(db.prepare('SELECT name FROM session_categories WHERE id=7').get().name).toBe('old category')
    expect(getSessionDetail('new')!.messages.map(m=>m.content)).toEqual(['new answer'])
  })
})
