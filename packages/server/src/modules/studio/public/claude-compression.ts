// hermes-v051:C Studio-owned port for Agent 管理 → Claude → 压缩设置. The Hermes cc-api controller serves
// GET/PUT /api/hermes/cc-api/compression; the Coding Agents module owns compression.json and the
// resolution rules; bootstrap (claude-compression-adapter.ts) wires the two, so agent modules never import
// each other (docs/harness/server-module-boundaries.md).

/** Wire shape of one value set (the same snake_case keys as config.yaml `compression`). */
export interface ClaudeCompressionDocumentValues {
  enabled: boolean
  threshold: number
  target_ratio: number
  protect_last_n: number
  protect_first_n: number
}

export interface ClaudeCompressionDocument {
  follow_main: boolean
  own: ClaudeCompressionDocumentValues
  main: ClaudeCompressionDocumentValues
  effective: ClaudeCompressionDocumentValues
}

export type ClaudeCompressionUpdateResult =
  | { ok: true; settings: ClaudeCompressionDocument }
  | { ok: false; error: string }

export interface ClaudeCompressionSettingsDependencies {
  read: (profile: string) => Promise<ClaudeCompressionDocument>
  update: (profile: string, body: unknown) => Promise<ClaudeCompressionUpdateResult>
}

let dependencies: ClaudeCompressionSettingsDependencies | null = null

export function configureClaudeCompressionSettings(next: ClaudeCompressionSettingsDependencies): void {
  dependencies = next
}

function configured(): ClaudeCompressionSettingsDependencies {
  if (!dependencies) throw new Error('X-Agent Claude compression settings have not been configured')
  return dependencies
}

export function readClaudeCompressionSettings(profile: string): Promise<ClaudeCompressionDocument> {
  return configured().read(profile)
}

export function updateClaudeCompressionSettings(profile: string, body: unknown): Promise<ClaudeCompressionUpdateResult> {
  return configured().update(profile, body)
}
