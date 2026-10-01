import type { Context, Next } from 'koa'
import './hermes-ops-adapter'
import './agent-log-adapter'
import './mcu-voice-adapter'
import './chat-agent-runtime-adapter'
import './session-agent-runtime-adapter'
import './claude-compression-adapter' // hermes-v051:C
import { apiDocsRoutes } from '../modules/studio'
import { healthRoutes } from './health'
import { themeRoutes } from '../modules/studio/routes/theme'
import { appConnectionRoutes, appRelayRoutes } from './app-relay'
import { devicePublicRoutes, deviceRoutes } from './devices'
import { socialMessageRoutes } from '../modules/studio/routes/social-messages'
import {
  claudeCodeProxyRoutes,
  claudeContextRoutes,
  codexProxyRoutes,
  codingAgentRoutes,
} from './coding-agents'

// Studio and agent route modules composed into one HTTP application.
import { uploadRoutes } from '../modules/studio/routes/upload'
import { appUploadRoutes } from '../modules/studio/routes/app-upload'
import { authPublicRoutes, authProtectedRoutes } from '../modules/studio/routes/auth'
import { mcuDeviceRoutes } from '../modules/studio/routes/mcu-devices'

import { sessionRoutes } from '../modules/studio/routes/sessions'
import { profileRoutes } from '../modules/hermes/routes/profiles'
import { skillRoutes } from '../modules/hermes/routes/skills'
import { skillBundleRoutes } from '../modules/hermes/routes/skill-bundles'
import { pluginRoutes } from '../modules/hermes/routes/plugins'
import { memoryRoutes } from '../modules/hermes/routes/memory'
import { ccApiRoutes } from '../modules/hermes/routes/cc-api'
import { modelRoutes } from '../modules/hermes/routes/models'
import { providerRoutes } from '../modules/hermes/routes/providers'
import { configRoutes } from '../modules/hermes/routes/config'
import { logRoutes } from '../modules/studio/routes/logs'
import { codexAuthRoutes } from '../modules/hermes/routes/codex-auth'
import { nousAuthRoutes } from '../modules/hermes/routes/nous-auth'
import { copilotAuthRoutes } from '../modules/hermes/routes/copilot-auth'
import { xaiAuthRoutes } from '../modules/hermes/routes/xai-auth'
import { anthropicAuthRoutes } from '../modules/hermes/routes/anthropic-auth'
import { minimaxAuthRoutes } from '../modules/hermes/routes/minimax-auth'
import { weixinRoutes } from '../modules/hermes/routes/weixin'
import { fileRoutes } from '../modules/studio/routes/files'
import { downloadRoutes } from '../modules/studio/routes/download'
import { jobRoutes } from '../modules/hermes/routes/jobs'
import { cronHistoryRoutes } from '../modules/hermes/routes/cron-history'
import { kanbanRoutes } from '../modules/hermes/routes/kanban'
import { ttsRoutes, ttsProtectedRoutes } from '../modules/studio/routes/tts'
import { sttProtectedRoutes } from '../modules/studio/routes/stt'
import { mcuFirmwareRoutes } from '../modules/studio/routes/mcu-firmware'
import { mediaRoutes } from '../modules/studio/routes/media'
import { chatRunRoutes } from '../modules/studio/routes/chat-run'
import { chatWebhookPublicRoutes, chatWebhookRoutes } from '../modules/studio/routes/chat-webhooks'
import { performanceMonitorRoutes } from '../modules/studio/routes/performance-monitor'
import { journeyRoutes } from '../modules/hermes/routes/journey'
import { mcpRoutes } from '../modules/hermes/routes/mcp'
import { runtimeVersionRoutes } from '../modules/hermes/routes/runtime-versions'
import { legacyDataMigrationRoutes } from '../modules/hermes/routes/legacy-data-migration'
import { agentStatusRoutes } from '../modules/studio/routes/agent-status'
import { writeGateRoutes } from '../modules/hermes/routes/write-gate'
import { legacyAppApiCompatibility } from '../modules/studio/middleware/legacy-app-api'

/**
 * Register all routes on the Koa app.
 * Public routes are registered first, then auth middleware,
 * then all protected routes.
 */
export function registerRoutes(app: any, authMiddleware: Array<(ctx: Context, next: Next) => Promise<void>>) {
  app.use(legacyAppApiCompatibility)

  // --- Public routes (no auth required) ---
  app.use(healthRoutes.routes())
  app.use(authPublicRoutes.routes())
  app.use(devicePublicRoutes.routes())
  app.use(claudeCodeProxyRoutes.routes())
  app.use(claudeContextRoutes.routes()) // hermes-v051:A loopback + per-launch token (no user session)
  app.use(codexProxyRoutes.routes())
  app.use(ttsRoutes.routes())
  app.use(apiDocsRoutes.routes())
  app.use(chatWebhookPublicRoutes.routes())

  // --- Auth middleware: all routes below require authentication ---
  authMiddleware.forEach((middleware) => app.use(middleware))

  // --- Protected routes (auth required) ---
  app.use(authProtectedRoutes.routes())
  app.use(deviceRoutes.routes())
  app.use(mcuDeviceRoutes.routes())
  app.use(appConnectionRoutes.routes())
  app.use(uploadRoutes.routes())
  app.use(appUploadRoutes.routes())
  app.use(codingAgentRoutes.routes())
  app.use(agentStatusRoutes.routes())
  app.use(themeRoutes.routes())
  app.use(appRelayRoutes.routes())
  app.use(socialMessageRoutes.routes())
  app.use(sessionRoutes.routes())
  app.use(profileRoutes.routes())
  app.use(skillRoutes.routes())
  app.use(skillBundleRoutes.routes())
  app.use(pluginRoutes.routes())
  app.use(memoryRoutes.routes())
  app.use(ccApiRoutes.routes())
  app.use(modelRoutes.routes())
  app.use(providerRoutes.routes())
  app.use(configRoutes.routes())
  app.use(logRoutes.routes())
  app.use(codexAuthRoutes.routes())
  app.use(nousAuthRoutes.routes())
  app.use(copilotAuthRoutes.routes())
  app.use(xaiAuthRoutes.routes())
  app.use(anthropicAuthRoutes.routes())
  app.use(minimaxAuthRoutes.routes())
  app.use(weixinRoutes.routes())
  app.use(chatRunRoutes.routes())
  app.use(chatWebhookRoutes.routes())
  app.use(fileRoutes.routes())
  app.use(downloadRoutes.routes())
  app.use(jobRoutes.routes())
  app.use(cronHistoryRoutes.routes())
  app.use(kanbanRoutes.routes())
  app.use(ttsProtectedRoutes.routes())
  app.use(sttProtectedRoutes.routes())
  app.use(mcuFirmwareRoutes.routes())
  app.use(mediaRoutes.routes())
  app.use(performanceMonitorRoutes.routes())
  app.use(journeyRoutes.routes())
  app.use(mcpRoutes.routes())                   // MCP management
  app.use(runtimeVersionRoutes.routes())         // Runtime and version management
  app.use(legacyDataMigrationRoutes.routes())    // One-time legacy Windows Hermes data migration
  app.use(writeGateRoutes.routes())              // Hermes Agent write approval review
}
