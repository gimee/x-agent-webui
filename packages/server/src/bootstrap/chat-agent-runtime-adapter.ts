import './agent-profile-adapter'
import { AgentBridgeClient } from '../modules/hermes/services/bridge/client'
import { getAgentBridgeManager } from '../modules/hermes/services/bridge/manager'
import { redactAgentBridgeError } from '../modules/hermes/services/bridge/redact'
import { codingAgentRunManager } from '../modules/coding-agents/services/runtime/run-manager'
import { sendCodingAgentRunInput, startCodingAgentRun } from '../modules/coding-agents'
import {
  handleCodingAgentSessionCommand,
  parseCodingAgentSessionCommand,
} from '../modules/coding-agents/services/session-command'
import { configureChatAgentRuntime } from '../modules/studio/public/chat-agent-runtime'

configureChatAgentRuntime({
  createPrimaryAgentBridge: options => new AgentBridgeClient(options),
  getPrimaryAgentBridgeManager: getAgentBridgeManager,
  redactPrimaryAgentBridgeError: redactAgentBridgeError,
  codingAgentRunManager,
  sendCodingAgentRunInput,
  startCodingAgentRun,
  handleCodingAgentSessionCommand,
  parseCodingAgentSessionCommand,
})
