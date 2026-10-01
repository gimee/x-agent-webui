import Router from '@koa/router'
import { CLAUDE_CONTEXT_API, claudeContextSettings, claudeContextSummary } from '../controllers/claude-context'

// hermes-v051:A registered before the user-auth middleware: loopback + per-launch bearer token only.
export const claudeContextRoutes = new Router()

claudeContextRoutes.post(`${CLAUDE_CONTEXT_API}/summary`, claudeContextSummary)
claudeContextRoutes.post(`${CLAUDE_CONTEXT_API}/settings`, claudeContextSettings)
