export type PrimaryAgentBridgeClient = Record<string, any>
export type PrimaryAgentBridgeContextEstimate = any
export type PrimaryAgentBridgeMessage = any
export type PrimaryAgentBridgeOutput = any
export type PrimaryAgentBridgeRunResult = any
export type ChatAgentMessage = any
export type ChatAgentClarificationRequest = any
export type ChatAgentOutputMessage = any
export type ChatAgentToolCall = any
export type ChatAgentToolApprovalRequest = any
export type ChatAgentToolResult = any
export type ChatModelClient = any
export type ChatModelEvent = any
export type ChatAgentRuntimeEvent = any
export type ChatModelProviderConfig = any
export type ChatModelReasoningEffort = any
export type ChatModelRequest = any
export type ChatModelResponse = any

export interface ChatAgentRuntimeDependencies {
  createPrimaryAgentBridge(options?: Record<string, unknown>): PrimaryAgentBridgeClient
  getPrimaryAgentBridgeManager(): any
  redactPrimaryAgentBridgeError(error: string | undefined, endpoint?: string, replacement?: string): string | undefined
  codingAgentRunManager: Record<string, any>
  sendCodingAgentRunInput(...args: any[]): any
  startCodingAgentRun(...args: any[]): any
  handleCodingAgentSessionCommand(...args: any[]): Promise<any>
  parseCodingAgentSessionCommand(...args: any[]): any
}

let dependencies: ChatAgentRuntimeDependencies | null = null

export function configureChatAgentRuntime(next: ChatAgentRuntimeDependencies): void {
  dependencies = next
}

function configured(): ChatAgentRuntimeDependencies {
  if (!dependencies) throw new Error('X-Agent chat Agent runtime has not been configured')
  return dependencies
}

export const createPrimaryAgentBridge = (options?: Record<string, unknown>) => (
  configured().createPrimaryAgentBridge(options)
)
export const getPrimaryAgentBridgeManager = () => configured().getPrimaryAgentBridgeManager()
export const redactPrimaryAgentBridgeError = (
  error: string | undefined,
  endpoint?: string,
  replacement?: string,
) => configured().redactPrimaryAgentBridgeError(error, endpoint, replacement)

export const chatCodingAgentRunManager = {
  hasSession: (...args: any[]) => configured().codingAgentRunManager.hasSession(...args),
  stop: (...args: any[]) => configured().codingAgentRunManager.stop(...args),
  isSessionLaunchCompatible: (...args: any[]) => configured().codingAgentRunManager.isSessionLaunchCompatible(...args),
  isSessionProcessing: (...args: any[]) => configured().codingAgentRunManager.isSessionProcessing(...args),
  runIdForSession: (...args: any[]) => configured().codingAgentRunManager.runIdForSession(...args),
  interruptForQueueInsertion: (...args: any[]) => configured().codingAgentRunManager.interruptForQueueInsertion(...args),
  resolveApproval: (...args: any[]) => configured().codingAgentRunManager.resolveApproval(...args),
  resolveClarification: (...args: any[]) => configured().codingAgentRunManager.resolveClarification(...args),
}

export const sendChatCodingAgentRunInput = (...args: any[]) => configured().sendCodingAgentRunInput(...args)
export const startChatCodingAgentRun = (...args: any[]) => configured().startCodingAgentRun(...args)
export const handleChatCodingAgentSessionCommand = (...args: any[]) => configured().handleCodingAgentSessionCommand(...args)
export const parseChatCodingAgentSessionCommand = (...args: any[]) => configured().parseCodingAgentSessionCommand(...args)

