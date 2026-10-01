// hermes-v051:C Wire the Studio Claude-compression port (used by the Hermes cc-api controller) to the
// Coding Agents implementation that owns <WebUI home>/coding-agent/claude-context/compression.json.
import { configureClaudeCompressionSettings } from '../modules/studio/public/claude-compression'
import { getWebUiHome } from '../modules/studio/public/config'
import {
  readClaudeCompressionDocument,
  updateClaudeCompressionDocument,
} from '../modules/coding-agents/services/claude-compression-settings'

configureClaudeCompressionSettings({
  read: profile => readClaudeCompressionDocument(getWebUiHome(), profile),
  update: (profile, body) => updateClaudeCompressionDocument(getWebUiHome(), profile, body),
})
