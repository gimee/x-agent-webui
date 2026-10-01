/**
 * Centralized schema definitions for all Hermes SQLite tables.
 * All table schemas are defined here for unified management and migration.
 */

// ============================================================================
// Usage Store (usage-store.ts)
// ============================================================================

export const USAGE_TABLE = 'session_usage'

export const USAGE_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  session_id: 'TEXT NOT NULL',
  run_id: "TEXT NOT NULL DEFAULT ''",
  source: "TEXT NOT NULL DEFAULT ''",
  agent: "TEXT NOT NULL DEFAULT ''",
  usage_scope: "TEXT NOT NULL DEFAULT 'run'",
  purpose: "TEXT NOT NULL DEFAULT ''",
  api_calls: 'INTEGER NOT NULL DEFAULT 0',
  input_tokens: 'INTEGER NOT NULL DEFAULT 0',
  output_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_read_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_write_tokens: 'INTEGER NOT NULL DEFAULT 0',
  reasoning_tokens: 'INTEGER NOT NULL DEFAULT 0',
  model: "TEXT NOT NULL DEFAULT ''",
  provider: "TEXT NOT NULL DEFAULT ''",
  profile: "TEXT NOT NULL DEFAULT 'default'",
  is_estimated: 'INTEGER NOT NULL DEFAULT 0',
  created_at: 'INTEGER NOT NULL DEFAULT 0',
}

export const USAGE_RUN_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_usage_run
  ON ${USAGE_TABLE}(session_id, run_id, source) WHERE run_id <> ''`

// ============================================================================
// Session Store (session-store.ts)
// ============================================================================

export const SESSIONS_TABLE = 'sessions'

export const SESSIONS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  profile: 'TEXT NOT NULL DEFAULT \'default\'',
  source: 'TEXT NOT NULL DEFAULT \'api_server\'',
  agent: 'TEXT NOT NULL DEFAULT \'\'',
  agent_mode: 'TEXT NOT NULL DEFAULT \'\'',
  agent_session_id: 'TEXT NOT NULL DEFAULT \'\'',
  agent_native_session_id: 'TEXT NOT NULL DEFAULT \'\'',
  user_id: 'TEXT',
  model: 'TEXT NOT NULL DEFAULT \'\'',
  provider: 'TEXT NOT NULL DEFAULT \'\'',
  api_mode: 'TEXT NOT NULL DEFAULT \'\'',
  reasoning_effort: 'TEXT NOT NULL DEFAULT \'\'',
  // hermes-v0.4.5: last Claude API call's context size (input + cache + output); 0 = unknown.
  context_tokens: 'INTEGER NOT NULL DEFAULT 0',
  title: 'TEXT',
  parent_session_id: 'TEXT',
  fork_point_message_id: 'TEXT',
  started_at: 'INTEGER NOT NULL',
  ended_at: 'INTEGER',
  end_reason: 'TEXT',
  message_count: 'INTEGER NOT NULL DEFAULT 0',
  tool_call_count: 'INTEGER NOT NULL DEFAULT 0',
  input_tokens: 'INTEGER NOT NULL DEFAULT 0',
  output_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_read_tokens: 'INTEGER NOT NULL DEFAULT 0',
  cache_write_tokens: 'INTEGER NOT NULL DEFAULT 0',
  reasoning_tokens: 'INTEGER NOT NULL DEFAULT 0',
  billing_provider: 'TEXT',
  estimated_cost_usd: 'REAL NOT NULL DEFAULT 0',
  actual_cost_usd: 'REAL',
  cost_status: 'TEXT NOT NULL DEFAULT \'\'',
  preview: 'TEXT NOT NULL DEFAULT \'\'',
  last_active: 'INTEGER NOT NULL',
  is_archived: 'INTEGER NOT NULL DEFAULT 0',
  push_enabled: 'INTEGER NOT NULL DEFAULT 0',
  workspace: 'TEXT',
  history_revision: 'INTEGER NOT NULL DEFAULT 0',
}

export const MESSAGES_TABLE = 'messages'

export const MESSAGES_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  session_id: 'TEXT NOT NULL',
  role: 'TEXT NOT NULL',
  content: 'TEXT NOT NULL DEFAULT \'\'',
  display_role: 'TEXT',
  display_content: 'TEXT',
  tool_call_id: 'TEXT',
  tool_calls: 'TEXT',
  tool_name: 'TEXT',
  run_marker: 'TEXT',
  client_message_id: 'TEXT',
  timestamp: 'INTEGER NOT NULL',
  token_count: 'INTEGER',
  finish_reason: 'TEXT',
  reasoning: 'TEXT',
  reasoning_details: 'TEXT',
  reasoning_content: 'TEXT',
  // hermes-v050:T6 JSON {messageCode, messageParams} of a coded command receipt; content stays English.
  command_data: 'TEXT',
}

export const MESSAGES_INDEXES = {
  idx_messages_session_id: 'CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)',
  uniq_messages_session_client_message_id: 'CREATE UNIQUE INDEX IF NOT EXISTS uniq_messages_session_client_message_id ON messages(session_id, client_message_id) WHERE client_message_id IS NOT NULL',
}
export const MESSAGES_INDEX = MESSAGES_INDEXES.idx_messages_session_id

export const SKILL_USAGE_EVENTS_TABLE = 'skill_usage_events'

export const SKILL_USAGE_EVENTS_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  source: "TEXT NOT NULL DEFAULT 'studio'",
  message_id: 'INTEGER NOT NULL',
  session_id: 'TEXT NOT NULL',
  run_id: "TEXT NOT NULL DEFAULT ''",
  profile: "TEXT NOT NULL DEFAULT 'default'",
  agent: "TEXT NOT NULL DEFAULT ''",
  skill: 'TEXT NOT NULL',
  action: 'TEXT NOT NULL',
  timestamp: 'INTEGER NOT NULL',
}

export const SKILL_USAGE_EVENTS_INDEXES = {
  uniq_skill_usage_source_message: 'CREATE UNIQUE INDEX IF NOT EXISTS uniq_skill_usage_source_message ON skill_usage_events(source, profile, message_id)',
  idx_skill_usage_profile_timestamp: 'CREATE INDEX IF NOT EXISTS idx_skill_usage_profile_timestamp ON skill_usage_events(profile, timestamp)',
  idx_skill_usage_agent_timestamp: 'CREATE INDEX IF NOT EXISTS idx_skill_usage_agent_timestamp ON skill_usage_events(agent, timestamp)',
  idx_skill_usage_skill_timestamp: 'CREATE INDEX IF NOT EXISTS idx_skill_usage_skill_timestamp ON skill_usage_events(skill, timestamp)',
  idx_skill_usage_session: 'CREATE INDEX IF NOT EXISTS idx_skill_usage_session ON skill_usage_events(session_id)',
}

export const SKILL_USAGE_SYNC_TABLE = 'skill_usage_sync_state'

export const SKILL_USAGE_SYNC_SCHEMA: Record<string, string> = {
  source: 'TEXT PRIMARY KEY',
  last_message_id: 'INTEGER NOT NULL DEFAULT 0',
  updated_at: 'INTEGER NOT NULL DEFAULT 0',
}

// ============================================================================
// Chat Run Webhooks
// ============================================================================

export const CHAT_WEBHOOK_ENDPOINTS_TABLE = 'chat_webhook_endpoints'

export const CHAT_WEBHOOK_ENDPOINTS_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  name: 'TEXT NOT NULL',
  url: 'TEXT NOT NULL',
  secret: "TEXT NOT NULL DEFAULT ''",
  event_types_json: "TEXT NOT NULL DEFAULT '[]'",
  profiles_json: "TEXT NOT NULL DEFAULT '[]'",
  enabled: 'INTEGER NOT NULL DEFAULT 1',
  include_content: 'INTEGER NOT NULL DEFAULT 0',
  include_user_content: 'INTEGER NOT NULL DEFAULT 0',
  allow_private_network: 'INTEGER NOT NULL DEFAULT 0',
  max_retries: 'INTEGER NOT NULL DEFAULT 3',
  created_at: 'INTEGER NOT NULL',
  updated_at: 'INTEGER NOT NULL',
}

export const CHAT_WEBHOOK_ENDPOINTS_INDEXES = {
  idx_chat_webhook_endpoints_enabled: 'CREATE INDEX IF NOT EXISTS idx_chat_webhook_endpoints_enabled ON chat_webhook_endpoints(enabled)',
}

// ============================================================================
// Workspace Run Changes
// ============================================================================

export const WORKSPACE_RUN_CHANGES_TABLE = 'workspace_run_changes'

export const WORKSPACE_RUN_CHANGES_SCHEMA: Record<string, string> = {
  change_id: 'TEXT PRIMARY KEY',
  room_id: "TEXT NOT NULL DEFAULT ''",
  message_id: "TEXT NOT NULL DEFAULT ''",
  assistant_message_id: "TEXT NOT NULL DEFAULT ''",
  session_id: 'TEXT NOT NULL',
  run_id: 'TEXT NOT NULL DEFAULT \'\'',
  source: 'TEXT NOT NULL DEFAULT \'run\'',
  workspace: 'TEXT NOT NULL DEFAULT \'\'',
  workspace_kind: 'TEXT NOT NULL DEFAULT \'git\'',
  started_at: 'INTEGER NOT NULL DEFAULT 0',
  finished_at: 'INTEGER NOT NULL DEFAULT 0',
  files_changed: 'INTEGER NOT NULL DEFAULT 0',
  additions: 'INTEGER NOT NULL DEFAULT 0',
  deletions: 'INTEGER NOT NULL DEFAULT 0',
  truncated: 'INTEGER NOT NULL DEFAULT 0',
  total_patch_bytes: 'INTEGER NOT NULL DEFAULT 0',
  created_at: 'INTEGER NOT NULL',
}

export const WORKSPACE_RUN_CHANGE_FILES_TABLE = 'workspace_run_change_files'

export const WORKSPACE_RUN_CHANGE_FILES_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  change_id: 'TEXT NOT NULL',
  session_id: 'TEXT NOT NULL',
  path: 'TEXT NOT NULL',
  old_path: 'TEXT',
  change_type: 'TEXT NOT NULL DEFAULT \'modified\'',
  additions: 'INTEGER NOT NULL DEFAULT 0',
  deletions: 'INTEGER NOT NULL DEFAULT 0',
  size_before: 'INTEGER',
  size_after: 'INTEGER',
  patch: 'TEXT',
  patch_bytes: 'INTEGER NOT NULL DEFAULT 0',
  truncated: 'INTEGER NOT NULL DEFAULT 0',
  binary: 'INTEGER NOT NULL DEFAULT 0',
  created_at: 'INTEGER NOT NULL',
}

export const WORKSPACE_RUN_CHANGES_INDEXES = {
  idx_workspace_run_changes_session: 'CREATE INDEX IF NOT EXISTS idx_workspace_run_changes_session ON workspace_run_changes(session_id, created_at)',
  idx_workspace_run_changes_assistant_message: 'CREATE INDEX IF NOT EXISTS idx_workspace_run_changes_assistant_message ON workspace_run_changes(session_id, assistant_message_id, created_at)',
  idx_workspace_run_changes_run: 'CREATE INDEX IF NOT EXISTS idx_workspace_run_changes_run ON workspace_run_changes(run_id)',
  idx_workspace_run_changes_room: 'CREATE INDEX IF NOT EXISTS idx_workspace_run_changes_room ON workspace_run_changes(room_id, created_at)',
}

export const WORKSPACE_RUN_CHANGE_FILES_INDEXES = {
  idx_workspace_run_change_files_change: 'CREATE INDEX IF NOT EXISTS idx_workspace_run_change_files_change ON workspace_run_change_files(change_id)',
  idx_workspace_run_change_files_session: 'CREATE INDEX IF NOT EXISTS idx_workspace_run_change_files_session ON workspace_run_change_files(session_id, created_at)',
}

// ============================================================================
// ============================================================================

// ============================================================================
// Compression Snapshot (compression-snapshot.ts)
// ============================================================================

export const COMPRESSION_SNAPSHOT_TABLE = 'chat_compression_snapshots'

export const COMPRESSION_SNAPSHOT_SCHEMA: Record<string, string> = {
  session_id: 'TEXT PRIMARY KEY',
  summary: 'TEXT NOT NULL DEFAULT \'\'',
  last_message_index: 'INTEGER NOT NULL DEFAULT 0',
  message_count_at_time: 'INTEGER NOT NULL DEFAULT 0',
  compressed_through_message_id: 'INTEGER',
  protected_head_through_message_id: 'INTEGER',
  history_revision: 'INTEGER NOT NULL DEFAULT 0',
  updated_at: 'INTEGER NOT NULL',
}

// ============================================================================
// Model Context (model-context.ts)
// ============================================================================

export const MODEL_CONTEXT_TABLE = 'model_context'

export const MODEL_CONTEXT_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  profile: "TEXT NOT NULL DEFAULT 'default'",
  provider: 'TEXT NOT NULL',
  model: 'TEXT NOT NULL',
  context_limit: 'INTEGER NOT NULL',
}

export const MODEL_CONTEXT_INDEX = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_model_context_profile_provider_model ON model_context(profile, provider, model)'
export const LEGACY_MODEL_CONTEXT_INDEX = 'idx_model_context_provider_model'

// ============================================================================
// Provider Configuration Audit
// ============================================================================

export const PROVIDER_AUDIT_TABLE = 'provider_audit_events'

export const PROVIDER_AUDIT_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  created_at: 'INTEGER NOT NULL',
  actor_user_id: 'INTEGER',
  actor_username: "TEXT NOT NULL DEFAULT ''",
  actor_role: "TEXT NOT NULL DEFAULT ''",
  profile: "TEXT NOT NULL DEFAULT 'default'",
  provider_id: 'TEXT NOT NULL',
  provider_label: "TEXT NOT NULL DEFAULT ''",
  action: 'TEXT NOT NULL',
  fields_json: "TEXT NOT NULL DEFAULT '[]'",
  result: "TEXT NOT NULL DEFAULT 'success'",
  details_json: "TEXT NOT NULL DEFAULT '{}'",
  revision_before: "TEXT NOT NULL DEFAULT ''",
  revision_after: "TEXT NOT NULL DEFAULT ''",
}

export const PROVIDER_AUDIT_INDEXES = {
  idx_provider_audit_created: 'CREATE INDEX IF NOT EXISTS idx_provider_audit_created ON provider_audit_events(created_at)',
  idx_provider_audit_profile: 'CREATE INDEX IF NOT EXISTS idx_provider_audit_profile ON provider_audit_events(profile, created_at)',
  idx_provider_audit_provider: 'CREATE INDEX IF NOT EXISTS idx_provider_audit_provider ON provider_audit_events(provider_id, created_at)',
}

// ============================================================================
// Users and Profile Access
// ============================================================================

export const USERS_TABLE = 'users'

export const USERS_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  username: 'TEXT NOT NULL UNIQUE',
  password_hash: 'TEXT NOT NULL',
  role: "TEXT NOT NULL DEFAULT 'admin'",
  status: "TEXT NOT NULL DEFAULT 'active'",
  created_at: 'INTEGER NOT NULL',
  updated_at: 'INTEGER NOT NULL',
  last_login_at: 'INTEGER',
  avatar: "TEXT NOT NULL DEFAULT ''",
}

export const USER_PROFILES_TABLE = 'user_profiles'

export const USER_PROFILES_SCHEMA: Record<string, string> = {
  user_id: 'INTEGER NOT NULL',
  profile_name: "TEXT NOT NULL DEFAULT 'default'",
  is_default: 'INTEGER NOT NULL DEFAULT 0',
  created_at: 'INTEGER NOT NULL',
}

export const USER_PROFILES_INDEXES = {
  idx_user_profiles_user: 'CREATE INDEX IF NOT EXISTS idx_user_profiles_user ON user_profiles(user_id)',
  idx_user_profiles_profile: 'CREATE INDEX IF NOT EXISTS idx_user_profiles_profile ON user_profiles(profile_name)',
  idx_user_profiles_default: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_default ON user_profiles(user_id) WHERE is_default = 1',
}

export const USER_THEMES_TABLE = 'user_themes'

export const USER_THEMES_SCHEMA: Record<string, string> = {
  user_id: 'INTEGER PRIMARY KEY',
  font_size: 'INTEGER NOT NULL DEFAULT 14',
  text_color: 'TEXT',
  accent_color: 'TEXT',
  background_filename: 'TEXT',
  background_original_name: 'TEXT',
  background_mime: 'TEXT',
  created_at: 'INTEGER NOT NULL',
  updated_at: 'INTEGER NOT NULL',
}

// ============================================================================
// Social Messages
// ============================================================================

export const SOCIAL_MESSAGE_ACCOUNTS_TABLE = 'social_message_accounts'

export const SOCIAL_MESSAGE_ACCOUNTS_SCHEMA: Record<string, string> = {
  user_id: 'INTEGER NOT NULL',
  platform: 'TEXT NOT NULL',
  credentials_json: "TEXT NOT NULL DEFAULT '{}'",
  active: 'INTEGER NOT NULL DEFAULT 0',
  recipient: "TEXT NOT NULL DEFAULT ''",
  recipient_type: "TEXT NOT NULL DEFAULT ''",
  binding_locale: "TEXT NOT NULL DEFAULT 'en'",
  binding_notified: 'INTEGER NOT NULL DEFAULT 0',
  created_at: 'INTEGER NOT NULL',
  updated_at: 'INTEGER NOT NULL',
}

export const SOCIAL_MESSAGE_ACCOUNTS_INDEXES = {
  idx_social_message_accounts_user: 'CREATE INDEX IF NOT EXISTS idx_social_message_accounts_user ON social_message_accounts(user_id)',
  uniq_social_message_accounts_active_user: 'CREATE UNIQUE INDEX IF NOT EXISTS uniq_social_message_accounts_active_user ON social_message_accounts(user_id) WHERE active = 1',
}

export const SOCIAL_MESSAGE_RUNTIME_STATES_TABLE = 'social_message_runtime_states'

export const SOCIAL_MESSAGE_RUNTIME_STATES_SCHEMA: Record<string, string> = {
  user_id: 'INTEGER NOT NULL',
  platform: 'TEXT NOT NULL',
  account_key: 'TEXT NOT NULL',
  state_json: "TEXT NOT NULL DEFAULT '{}'",
  updated_at: 'INTEGER NOT NULL',
}

export const SOCIAL_MESSAGE_RUNTIME_STATES_INDEXES = {
  idx_social_message_runtime_states_user: 'CREATE INDEX IF NOT EXISTS idx_social_message_runtime_states_user ON social_message_runtime_states(user_id)',
}

// ============================================================================
// LAN Devices
// ============================================================================

export const DEVICES_TABLE = 'devices'

export const DEVICES_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  status: "TEXT NOT NULL DEFAULT 'none'",
  inbound_status: "TEXT NOT NULL DEFAULT 'none'",
  outbound_status: "TEXT NOT NULL DEFAULT 'none'",
  device_public_key: "TEXT NOT NULL DEFAULT ''",
  computer_name: "TEXT NOT NULL DEFAULT ''",
  endpoint_kind: "TEXT NOT NULL DEFAULT 'custom'",
  ip: "TEXT NOT NULL DEFAULT ''",
  http_port: 'INTEGER NOT NULL DEFAULT 0',
  url: "TEXT NOT NULL DEFAULT ''",
  os_json: "TEXT NOT NULL DEFAULT '{}'",
  hermes_agent_version: "TEXT NOT NULL DEFAULT ''",
  hermes_web_ui_version: "TEXT NOT NULL DEFAULT ''",
  response_ms: 'INTEGER NOT NULL DEFAULT 0',
  requested_at: 'INTEGER NOT NULL DEFAULT 0',
  decided_at: 'INTEGER',
  outbound_requested_at: 'INTEGER NOT NULL DEFAULT 0',
  outbound_decided_at: 'INTEGER',
  inbound_history_deleted_at: 'INTEGER',
  last_seen_at: 'INTEGER NOT NULL DEFAULT 0',
  updated_at: 'INTEGER NOT NULL',
}

export const DEVICES_INDEXES = {
  idx_devices_status: 'CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status)',
  idx_devices_last_seen: 'CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_at)',
}

// ============================================================================
// MCU Devices
// ============================================================================

export const MCU_DEVICES_TABLE = 'mcu_devices'

export const MCU_DEVICES_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  name: "TEXT NOT NULL DEFAULT ''",
  device_code: 'TEXT NOT NULL UNIQUE',
  is_official: 'INTEGER NOT NULL DEFAULT 0',
  created_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
}

export const MCU_DEVICES_INDEXES = {
  idx_mcu_devices_created_at: 'CREATE INDEX IF NOT EXISTS idx_mcu_devices_created_at ON mcu_devices(created_at)',
}

// ============================================================================
// App Connections
// ============================================================================

export const APP_CONNECTIONS_TABLE = 'app_connections'

export const APP_CONNECTIONS_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  device_code: 'TEXT NOT NULL',
  device_name: "TEXT NOT NULL DEFAULT ''",
  device_brand: "TEXT NOT NULL DEFAULT ''",
  device_model: "TEXT NOT NULL DEFAULT ''",
  connection_type: "TEXT NOT NULL DEFAULT 'lan'",
  user_id: 'INTEGER NOT NULL',
  cloud_user_id: 'INTEGER NOT NULL DEFAULT 0',
  token_hash: "TEXT NOT NULL DEFAULT ''",
  token_expires_at: 'INTEGER NOT NULL DEFAULT 0',
  last_connected_at: 'INTEGER NOT NULL DEFAULT 0',
  revoked_at: 'INTEGER',
  cloud_revocation_pending: 'INTEGER NOT NULL DEFAULT 0',
  created_at: 'INTEGER NOT NULL',
  updated_at: 'INTEGER NOT NULL',
}

export const APP_CONNECTIONS_INDEXES = {
  uniq_app_connections_device_type_cloud_user: 'CREATE UNIQUE INDEX IF NOT EXISTS uniq_app_connections_device_type_cloud_user ON app_connections(device_code, connection_type, cloud_user_id)',
  idx_app_connections_user: 'CREATE INDEX IF NOT EXISTS idx_app_connections_user ON app_connections(user_id)',
  idx_app_connections_cloud_user: 'CREATE INDEX IF NOT EXISTS idx_app_connections_cloud_user ON app_connections(cloud_user_id)',
  idx_app_connections_updated_at: 'CREATE INDEX IF NOT EXISTS idx_app_connections_updated_at ON app_connections(updated_at)',
}

export const APP_AUTHORIZATION_CODES_TABLE = 'app_authorization_codes'

export const APP_AUTHORIZATION_CODES_SCHEMA: Record<string, string> = {
  id: 'TEXT PRIMARY KEY',
  code_hash: 'TEXT NOT NULL UNIQUE',
  created_by_user_id: 'INTEGER NOT NULL',
  expires_at: 'INTEGER NOT NULL',
  used_at: 'INTEGER',
  used_by_device_code: "TEXT NOT NULL DEFAULT ''",
  created_at: 'INTEGER NOT NULL',
}

export const APP_AUTHORIZATION_CODES_INDEXES = {
  idx_app_authorization_codes_expires_at: 'CREATE INDEX IF NOT EXISTS idx_app_authorization_codes_expires_at ON app_authorization_codes(expires_at)',
  idx_app_authorization_codes_created_by_user: 'CREATE INDEX IF NOT EXISTS idx_app_authorization_codes_created_by_user ON app_authorization_codes(created_by_user_id)',
}

export const STT_PROVIDER_SETTINGS_TABLE = 'stt_provider_settings'

export const STT_PROVIDER_SETTINGS_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  user_id: 'INTEGER NOT NULL',
  provider: 'TEXT NOT NULL',
  settings_json: `TEXT NOT NULL DEFAULT '{}'`,
  secrets_json: `TEXT NOT NULL DEFAULT '{}'`,
  created_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
  updated_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
}

export const STT_PROVIDER_SETTINGS_INDEXES = {
  idx_stt_provider_settings_user: 'CREATE INDEX IF NOT EXISTS idx_stt_provider_settings_user ON stt_provider_settings(user_id)',
  idx_stt_provider_settings_user_provider: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_stt_provider_settings_user_provider ON stt_provider_settings(user_id, provider)',
}

export const STT_USER_SETTINGS_TABLE = 'stt_user_settings'

export const STT_USER_SETTINGS_SCHEMA: Record<string, string> = {
  user_id: 'INTEGER PRIMARY KEY',
  active_provider: "TEXT NOT NULL DEFAULT 'browser'",
  created_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
  updated_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
}

export const STT_PROFILE_PROVIDER_SETTINGS_TABLE = 'stt_profile_provider_settings'

export const STT_PROFILE_PROVIDER_SETTINGS_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  profile: "TEXT NOT NULL DEFAULT 'default'",
  provider: 'TEXT NOT NULL',
  settings_json: `TEXT NOT NULL DEFAULT '{}'`,
  secrets_json: `TEXT NOT NULL DEFAULT '{}'`,
  created_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
  updated_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
}

export const STT_PROFILE_PROVIDER_SETTINGS_INDEXES = {
  idx_stt_profile_provider_settings_profile: 'CREATE INDEX IF NOT EXISTS idx_stt_profile_provider_settings_profile ON stt_profile_provider_settings(profile)',
  idx_stt_profile_provider_settings_profile_provider: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_stt_profile_provider_settings_profile_provider ON stt_profile_provider_settings(profile, provider)',
}

export const STT_PROFILE_SETTINGS_TABLE = 'stt_profile_settings'

export const STT_PROFILE_SETTINGS_SCHEMA: Record<string, string> = {
  profile: "TEXT PRIMARY KEY DEFAULT 'default'",
  active_provider: "TEXT NOT NULL DEFAULT 'browser'",
  created_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
  updated_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
}

export const TTS_PROVIDER_SETTINGS_TABLE = 'tts_provider_settings'

export const TTS_PROVIDER_SETTINGS_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  user_id: 'INTEGER NOT NULL',
  provider: 'TEXT NOT NULL',
  settings_json: `TEXT NOT NULL DEFAULT '{}'`,
  secrets_json: `TEXT NOT NULL DEFAULT '{}'`,
  created_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
  updated_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
}

export const TTS_PROVIDER_SETTINGS_INDEXES = {
  idx_tts_provider_settings_user: 'CREATE INDEX IF NOT EXISTS idx_tts_provider_settings_user ON tts_provider_settings(user_id)',
  idx_tts_provider_settings_user_provider: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_tts_provider_settings_user_provider ON tts_provider_settings(user_id, provider)',
}

export const TTS_USER_SETTINGS_TABLE = 'tts_user_settings'

export const TTS_USER_SETTINGS_SCHEMA: Record<string, string> = {
  user_id: 'INTEGER PRIMARY KEY',
  active_provider: "TEXT NOT NULL DEFAULT 'edge'",
  created_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
  updated_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
}

export const TTS_PROFILE_PROVIDER_SETTINGS_TABLE = 'tts_profile_provider_settings'

export const TTS_PROFILE_PROVIDER_SETTINGS_SCHEMA: Record<string, string> = {
  id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  profile: "TEXT NOT NULL DEFAULT 'default'",
  provider: 'TEXT NOT NULL',
  settings_json: `TEXT NOT NULL DEFAULT '{}'`,
  secrets_json: `TEXT NOT NULL DEFAULT '{}'`,
  created_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
  updated_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
}

export const TTS_PROFILE_PROVIDER_SETTINGS_INDEXES = {
  idx_tts_profile_provider_settings_profile: 'CREATE INDEX IF NOT EXISTS idx_tts_profile_provider_settings_profile ON tts_profile_provider_settings(profile)',
  idx_tts_profile_provider_settings_profile_provider: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_tts_profile_provider_settings_profile_provider ON tts_profile_provider_settings(profile, provider)',
}

export const TTS_PROFILE_SETTINGS_TABLE = 'tts_profile_settings'

export const TTS_PROFILE_SETTINGS_SCHEMA: Record<string, string> = {
  profile: "TEXT PRIMARY KEY DEFAULT 'default'",
  active_provider: "TEXT NOT NULL DEFAULT 'edge'",
  created_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
  updated_at: `INTEGER NOT NULL DEFAULT (strftime('%s','now'))`,
}

// ============================================================================
// ============================================================================

// ============================================================================
// Schema Sync Utilities
// ============================================================================

import { getDb, getStoragePath } from './index'

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

/**
 * 检查表是否存在
 */
function tableExists(db: NonNullable<ReturnType<typeof getDb>>, tableName: string): boolean {
  const result = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(tableName)
  return !!result
}

/**
 * 创建表（带完整 schema）
 */
function createTable(
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
  schema: Record<string, string>,
  primaryKey?: string
): void {
  const colDefs = Object.entries(schema).map(([col, def]) => `${quoteIdentifier(col)} ${def}`)

  // 只在 schema 中没有主键时才添加复合主键
  const hasPrimaryKeyInSchema = Object.values(schema).some((def) =>
    def.toUpperCase().includes("PRIMARY KEY")
  )

  if (primaryKey && !hasPrimaryKeyInSchema) {
    colDefs.push(`PRIMARY KEY (${primaryKey})`)
  }

  db.exec(`CREATE TABLE ${quoteIdentifier(tableName)} (${colDefs.join(', ')})`)
}

function canAddColumnToExistingTable(schemaDef: string): boolean {
  const normalized = schemaDef.toUpperCase()
  if (normalized.includes('PRIMARY KEY')) return false
  if (normalized.includes('NOT NULL') && !normalized.includes('DEFAULT')) return false
  return true
}

function addMissingSafeColumns(
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
  schema: Record<string, string>,
): void {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>
  const existingColumns = new Set(columns.map(col => col.name))

  for (const [columnName, columnDef] of Object.entries(schema)) {
    if (existingColumns.has(columnName)) continue
    if (!canAddColumnToExistingTable(columnDef)) {
      console.warn(`[Schema] ${tableName}.${columnName} cannot be added safely to existing table; skipping`)
      continue
    }
    db.exec(`ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${quoteIdentifier(columnName)} ${columnDef}`)
  }
}

function createIndexes(
  db: NonNullable<ReturnType<typeof getDb>>,
  indexes?: Record<string, string>,
): void {
  if (!indexes) return

  for (const [indexName, indexSQL] of Object.entries(indexes)) {
    if (indexExists(db, indexName)) continue
    db.exec(indexSQL)
  }
}

function indexExists(
  db: NonNullable<ReturnType<typeof getDb>>,
  indexName: string,
): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`
  ).get(indexName))
}

function migrateLegacySttProviderSettingsUserIdDefault(
  db: NonNullable<ReturnType<typeof getDb>>,
): void {
  if (!tableExists(db, STT_PROVIDER_SETTINGS_TABLE)) return

  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(STT_PROVIDER_SETTINGS_TABLE)})`).all() as Array<{
    name: string
    dflt_value: string | null
  }>
  const userIdColumn = columns.find((column) => column.name === 'user_id')

  if (!userIdColumn || userIdColumn.dflt_value === null) {
    return
  }

  const replacementTableName = `${STT_PROVIDER_SETTINGS_TABLE}__rebuilt`
  const preservedColumns = ['id', 'user_id', 'provider', 'settings_json', 'secrets_json', 'created_at', 'updated_at']
  const quotedPreservedColumns = preservedColumns.map((column) => quoteIdentifier(column)).join(', ')

  db.exec('BEGIN')
  try {
    db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(replacementTableName)}`)
    createTable(db, replacementTableName, STT_PROVIDER_SETTINGS_SCHEMA)
    db.exec(
      `INSERT INTO ${quoteIdentifier(replacementTableName)} (${quotedPreservedColumns}) ` +
      `SELECT ${quotedPreservedColumns} FROM ${quoteIdentifier(STT_PROVIDER_SETTINGS_TABLE)}`
    )
    db.exec(`DROP TABLE ${quoteIdentifier(STT_PROVIDER_SETTINGS_TABLE)}`)
    db.exec(`ALTER TABLE ${quoteIdentifier(replacementTableName)} RENAME TO ${quoteIdentifier(STT_PROVIDER_SETTINGS_TABLE)}`)
    createIndexes(db, STT_PROVIDER_SETTINGS_INDEXES)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function copyLegacyProviderSettingsToDefaultProfile(
  db: NonNullable<ReturnType<typeof getDb>>,
  sourceTableName: string,
  targetTableName: string,
): void {
  if (!tableExists(db, sourceTableName) || !tableExists(db, targetTableName)) return

  db.prepare(
    `INSERT OR IGNORE INTO ${quoteIdentifier(targetTableName)} ` +
    `(profile, provider, settings_json, secrets_json, created_at, updated_at) ` +
    `SELECT 'default', old.provider, old.settings_json, old.secrets_json, old.created_at, old.updated_at ` +
    `FROM ${quoteIdentifier(sourceTableName)} old ` +
    `WHERE old.provider IS NOT NULL ` +
    `AND NOT EXISTS (` +
    `SELECT 1 FROM ${quoteIdentifier(sourceTableName)} newer ` +
    `WHERE newer.provider = old.provider ` +
    `AND (newer.updated_at > old.updated_at OR (newer.updated_at = old.updated_at AND newer.rowid > old.rowid))` +
    `)`
  ).run()
}

function copyLegacyActiveSettingsToDefaultProfile(
  db: NonNullable<ReturnType<typeof getDb>>,
  sourceTableName: string,
  targetTableName: string,
): void {
  if (!tableExists(db, sourceTableName) || !tableExists(db, targetTableName)) return

  db.prepare(
    `INSERT OR IGNORE INTO ${quoteIdentifier(targetTableName)} ` +
    `(profile, active_provider, created_at, updated_at) ` +
    `SELECT 'default', active_provider, created_at, updated_at ` +
    `FROM ${quoteIdentifier(sourceTableName)} ` +
    `WHERE active_provider IS NOT NULL ` +
    `ORDER BY updated_at DESC, rowid DESC ` +
    `LIMIT 1`
  ).run()
}

function tableHasColumn(
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
  columnName: string,
): boolean {
  if (!tableExists(db, tableName)) return false
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>
  return columns.some(column => column.name === columnName)
}

function pruneDuplicateProfileProviderSettings(
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
): void {
  if (!tableHasColumn(db, tableName, 'profile') || !tableHasColumn(db, tableName, 'provider')) return

  db.prepare(
    `DELETE FROM ${quoteIdentifier(tableName)} ` +
    `WHERE rowid NOT IN (` +
    `SELECT kept.rowid FROM ${quoteIdentifier(tableName)} kept ` +
    `WHERE NOT EXISTS (` +
    `SELECT 1 FROM ${quoteIdentifier(tableName)} newer ` +
    `WHERE newer.profile = kept.profile ` +
    `AND newer.provider = kept.provider ` +
    `AND (newer.updated_at > kept.updated_at OR (newer.updated_at = kept.updated_at AND newer.rowid > kept.rowid))` +
    `)` +
    `)`
  ).run()
}

function pruneDuplicateProfileActiveSettings(
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
): void {
  if (!tableHasColumn(db, tableName, 'profile')) return

  db.prepare(
    `DELETE FROM ${quoteIdentifier(tableName)} ` +
    `WHERE rowid NOT IN (` +
    `SELECT kept.rowid FROM ${quoteIdentifier(tableName)} kept ` +
    `WHERE NOT EXISTS (` +
    `SELECT 1 FROM ${quoteIdentifier(tableName)} newer ` +
    `WHERE newer.profile = kept.profile ` +
    `AND (newer.updated_at > kept.updated_at OR (newer.updated_at = kept.updated_at AND newer.rowid > kept.rowid))` +
    `)` +
    `)`
  ).run()
}

function ensureProfileSettingsIndexes(
  db: NonNullable<ReturnType<typeof getDb>>,
  activeTableName: string,
  activeIndexName: string,
  providerTableName: string,
  providerIndexes: Record<string, string>,
): void {
  pruneDuplicateProfileActiveSettings(db, activeTableName)
  pruneDuplicateProfileProviderSettings(db, providerTableName)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(activeIndexName)} ON ${quoteIdentifier(activeTableName)}(profile)`)
  createIndexes(db, providerIndexes)
}

/**
 * 主同步函数
 * - 表不存在：创建
 * - 表存在：只追加安全的新列，不删除、不重建、不修改主键/类型
 */
export function syncTable(
  tableName: string,
  schema: Record<string, string>,
  options?: {
    primaryKey?: string  // 主键定义，如 "roomId, agentId" 或 "id"
    indexes?: Record<string, string>  // 索引定义
  }
): void {
  const db = getDb()
  if (!db) return

  // 1. 表不存在 → 直接创建
  if (!tableExists(db, tableName)) {
    createTable(db, tableName, schema, options?.primaryKey)

    // 创建索引
    createIndexes(db, options?.indexes)
    return
  }

  addMissingSafeColumns(db, tableName, schema)
  if (tableName === MESSAGES_TABLE && tableHasColumn(db, MESSAGES_TABLE, 'client_message_id')) {
    db.prepare(
      `UPDATE ${quoteIdentifier(MESSAGES_TABLE)}
       SET client_message_id = NULL
       WHERE client_message_id IS NOT NULL
         AND id NOT IN (
           SELECT MIN(id) FROM ${quoteIdentifier(MESSAGES_TABLE)}
           WHERE client_message_id IS NOT NULL
           GROUP BY session_id, client_message_id
         )`,
    ).run()
  }
}

function cleanupHistoricalZeroLineWorkspaceDiffs(
  db: NonNullable<ReturnType<typeof getDb>>,
): void {
  const zeroLinePredicate = 'additions = 0 AND deletions = 0'
  const affectedRows = db.prepare(
    `SELECT DISTINCT change_id FROM ${WORKSPACE_RUN_CHANGE_FILES_TABLE} WHERE ${zeroLinePredicate}`,
  ).all() as Array<{ change_id: string }>
  if (affectedRows.length === 0) return

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`DELETE FROM ${WORKSPACE_RUN_CHANGE_FILES_TABLE} WHERE ${zeroLinePredicate}`).run()
    const aggregate = db.prepare(
      `SELECT COUNT(*) AS files_changed, COALESCE(SUM(additions), 0) AS additions,
        COALESCE(SUM(deletions), 0) AS deletions, COALESCE(MAX(truncated), 0) AS truncated,
        COALESCE(SUM(patch_bytes), 0) AS total_patch_bytes
       FROM ${WORKSPACE_RUN_CHANGE_FILES_TABLE} WHERE change_id = ?`,
    )
    const updateParent = db.prepare(
      `UPDATE ${WORKSPACE_RUN_CHANGES_TABLE}
       SET files_changed = ?, additions = ?, deletions = ?, truncated = ?, total_patch_bytes = ?
       WHERE change_id = ?`,
    )
    const deleteParent = db.prepare(`DELETE FROM ${WORKSPACE_RUN_CHANGES_TABLE} WHERE change_id = ?`)

    for (const { change_id: changeId } of affectedRows) {
      const totals = aggregate.get(changeId) as {
        files_changed: number
        additions: number
        deletions: number
        truncated: number
        total_patch_bytes: number
      }
      if (totals.files_changed === 0) {
        deleteParent.run(changeId)
      } else {
        updateParent.run(
          totals.files_changed,
          totals.additions,
          totals.deletions,
          totals.truncated,
          totals.total_patch_bytes,
          changeId,
        )
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// ============================================================================
// Unified Initializer
// ============================================================================

/**
 * Initialize missing Hermes SQLite tables with proper schemas.
 * Existing tables only receive safe additive columns.
 * Call this once at application bootstrap.
 */
export function initAllHermesTables(): void {
  const db = getDb()
  if (!db) return

  try {
    // Usage store
    syncTable(USAGE_TABLE, USAGE_SCHEMA, { primaryKey: 'id' })
    db.exec(USAGE_RUN_INDEX)

    // Session store
    syncTable(SESSIONS_TABLE, SESSIONS_SCHEMA)
    syncTable(MESSAGES_TABLE, MESSAGES_SCHEMA, { indexes: MESSAGES_INDEXES })
    createIndexes(db, MESSAGES_INDEXES)
    syncTable(SKILL_USAGE_EVENTS_TABLE, SKILL_USAGE_EVENTS_SCHEMA, {
      indexes: SKILL_USAGE_EVENTS_INDEXES,
    })
    syncTable(SKILL_USAGE_SYNC_TABLE, SKILL_USAGE_SYNC_SCHEMA, { primaryKey: 'source' })
    syncTable(CHAT_WEBHOOK_ENDPOINTS_TABLE, CHAT_WEBHOOK_ENDPOINTS_SCHEMA, {
      indexes: CHAT_WEBHOOK_ENDPOINTS_INDEXES,
    })
    syncTable(WORKSPACE_RUN_CHANGES_TABLE, WORKSPACE_RUN_CHANGES_SCHEMA, {
      indexes: WORKSPACE_RUN_CHANGES_INDEXES,
    })
    syncTable(WORKSPACE_RUN_CHANGE_FILES_TABLE, WORKSPACE_RUN_CHANGE_FILES_SCHEMA, {
      indexes: WORKSPACE_RUN_CHANGE_FILES_INDEXES,
    })
    cleanupHistoricalZeroLineWorkspaceDiffs(db)


    // Compression snapshot
    syncTable(COMPRESSION_SNAPSHOT_TABLE, COMPRESSION_SNAPSHOT_SCHEMA)

    // Model context. Existing rows are assigned to the default profile; replace
    // the legacy cross-profile uniqueness constraint with a profile-scoped one.
    syncTable(MODEL_CONTEXT_TABLE, MODEL_CONTEXT_SCHEMA)
    db.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(LEGACY_MODEL_CONTEXT_INDEX)}`)
    db.exec(MODEL_CONTEXT_INDEX)

    // Provider configuration audit
    syncTable(PROVIDER_AUDIT_TABLE, PROVIDER_AUDIT_SCHEMA, {
      indexes: PROVIDER_AUDIT_INDEXES,
    })

    // Users and profile access
    syncTable(USERS_TABLE, USERS_SCHEMA)
    syncTable(USER_PROFILES_TABLE, USER_PROFILES_SCHEMA, {
      primaryKey: 'user_id, profile_name',
      indexes: USER_PROFILES_INDEXES,
    })
    syncTable(USER_THEMES_TABLE, USER_THEMES_SCHEMA)

    // User-scoped Social Messages accounts. Only one account per user may be active.
    syncTable(SOCIAL_MESSAGE_ACCOUNTS_TABLE, SOCIAL_MESSAGE_ACCOUNTS_SCHEMA, {
      primaryKey: 'user_id, platform',
      indexes: SOCIAL_MESSAGE_ACCOUNTS_INDEXES,
    })
    syncTable(SOCIAL_MESSAGE_RUNTIME_STATES_TABLE, SOCIAL_MESSAGE_RUNTIME_STATES_SCHEMA, {
      primaryKey: 'user_id, platform',
      indexes: SOCIAL_MESSAGE_RUNTIME_STATES_INDEXES,
    })
    createIndexes(db, SOCIAL_MESSAGE_ACCOUNTS_INDEXES)
    createIndexes(db, SOCIAL_MESSAGE_RUNTIME_STATES_INDEXES)

    // LAN devices and link request status
    syncTable(DEVICES_TABLE, DEVICES_SCHEMA, {
      indexes: DEVICES_INDEXES,
    })

    // MCU devices
    syncTable(MCU_DEVICES_TABLE, MCU_DEVICES_SCHEMA, {
      indexes: MCU_DEVICES_INDEXES,
    })

    // App authorization codes and connected mobile devices
    syncTable(APP_CONNECTIONS_TABLE, APP_CONNECTIONS_SCHEMA, {
      indexes: APP_CONNECTIONS_INDEXES,
    })
    db.exec('DROP INDEX IF EXISTS uniq_app_connections_device_type')
    createIndexes(db, APP_CONNECTIONS_INDEXES)
    db.exec(`
      UPDATE ${APP_CONNECTIONS_TABLE}
      SET cloud_revocation_pending = 0
      WHERE connection_type = 'cloud' AND cloud_user_id = 0 AND cloud_revocation_pending <> 0
    `)
    syncTable(APP_AUTHORIZATION_CODES_TABLE, APP_AUTHORIZATION_CODES_SCHEMA, {
      indexes: APP_AUTHORIZATION_CODES_INDEXES,
    })

    syncTable(STT_PROVIDER_SETTINGS_TABLE, STT_PROVIDER_SETTINGS_SCHEMA, {
      indexes: STT_PROVIDER_SETTINGS_INDEXES,
    })
    syncTable(STT_USER_SETTINGS_TABLE, STT_USER_SETTINGS_SCHEMA)
    migrateLegacySttProviderSettingsUserIdDefault(db)
    syncTable(STT_PROFILE_PROVIDER_SETTINGS_TABLE, STT_PROFILE_PROVIDER_SETTINGS_SCHEMA, {
      indexes: STT_PROFILE_PROVIDER_SETTINGS_INDEXES,
    })
    syncTable(STT_PROFILE_SETTINGS_TABLE, STT_PROFILE_SETTINGS_SCHEMA)
    ensureProfileSettingsIndexes(
      db,
      STT_PROFILE_SETTINGS_TABLE,
      'idx_stt_profile_settings_profile',
      STT_PROFILE_PROVIDER_SETTINGS_TABLE,
      STT_PROFILE_PROVIDER_SETTINGS_INDEXES,
    )
    copyLegacyProviderSettingsToDefaultProfile(db, STT_PROVIDER_SETTINGS_TABLE, STT_PROFILE_PROVIDER_SETTINGS_TABLE)
    copyLegacyActiveSettingsToDefaultProfile(db, STT_USER_SETTINGS_TABLE, STT_PROFILE_SETTINGS_TABLE)
    syncTable(TTS_PROVIDER_SETTINGS_TABLE, TTS_PROVIDER_SETTINGS_SCHEMA, {
      indexes: TTS_PROVIDER_SETTINGS_INDEXES,
    })
    syncTable(TTS_USER_SETTINGS_TABLE, TTS_USER_SETTINGS_SCHEMA)
    syncTable(TTS_PROFILE_PROVIDER_SETTINGS_TABLE, TTS_PROFILE_PROVIDER_SETTINGS_SCHEMA, {
      indexes: TTS_PROFILE_PROVIDER_SETTINGS_INDEXES,
    })
    syncTable(TTS_PROFILE_SETTINGS_TABLE, TTS_PROFILE_SETTINGS_SCHEMA)
    ensureProfileSettingsIndexes(
      db,
      TTS_PROFILE_SETTINGS_TABLE,
      'idx_tts_profile_settings_profile',
      TTS_PROFILE_PROVIDER_SETTINGS_TABLE,
      TTS_PROFILE_PROVIDER_SETTINGS_INDEXES,
    )
    copyLegacyProviderSettingsToDefaultProfile(db, TTS_PROVIDER_SETTINGS_TABLE, TTS_PROFILE_PROVIDER_SETTINGS_TABLE)
    copyLegacyActiveSettingsToDefaultProfile(db, TTS_USER_SETTINGS_TABLE, TTS_PROFILE_SETTINGS_TABLE)

  } catch (e) {
    console.error('Error initializing Hermes SQLite tables:', e)
    console.error(`[Schema] Database initialization failed. Existing database was left untouched: ${getStoragePath()}`)
    throw e
  }
}
