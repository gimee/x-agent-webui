import { configureAgentLogs } from '../modules/studio/public/agent-logs'
import {
  listLogFiles,
  readLogs,
} from '../modules/hermes/services/runtime/cli'

configureAgentLogs({
  listPrimaryAgentLogFiles: listLogFiles,
  readPrimaryAgentLogs: readLogs,
})
