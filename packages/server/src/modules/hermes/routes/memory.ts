import Router from '@koa/router'
import * as ctrl from '../controllers/memory'

export const memoryRoutes = new Router()

memoryRoutes.get('/api/hermes/memory', ctrl.get)
memoryRoutes.post('/api/hermes/memory', ctrl.save)
// hermes-v0.1.2: per-instance agent write lock for global memory (MEMORY.md / USER.md)
memoryRoutes.get('/api/hermes/memory/lock', ctrl.getLock)
memoryRoutes.put('/api/hermes/memory/lock', ctrl.setLock)
memoryRoutes.post('/api/hermes/memory/sync-claude', ctrl.syncClaude)
