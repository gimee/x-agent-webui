import Router from '@koa/router'
import * as ctrl from '../controllers/cc-api'

export const ccApiRoutes = new Router()

ccApiRoutes.get('/api/hermes/cc-api', ctrl.list)
// Registered before /:id so 'effort' is never taken as a profile id.
ccApiRoutes.get('/api/hermes/cc-api/effort', ctrl.getEffort)
ccApiRoutes.put('/api/hermes/cc-api/effort', ctrl.setEffort)
// hermes-v051:C Also before /:id so 'compression' is never taken as a profile id.
ccApiRoutes.get('/api/hermes/cc-api/compression', ctrl.getCompression)
ccApiRoutes.put('/api/hermes/cc-api/compression', ctrl.setCompression)
ccApiRoutes.post('/api/hermes/cc-api', ctrl.create)
ccApiRoutes.put('/api/hermes/cc-api/:id', ctrl.update)
ccApiRoutes.delete('/api/hermes/cc-api/:id', ctrl.remove)
ccApiRoutes.post('/api/hermes/cc-api/:id/apply', ctrl.apply)
