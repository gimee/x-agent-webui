// hermes-v050:U27 — display-only masking of credentials in a coding agent's
// settings.json (e.g. env.ANTHROPIC_AUTH_TOKEN). The editor keeps the raw text
// as its only data; this module only derives the text that is shown while the
// credentials are hidden, so a masked string can never be saved.

const SENSITIVE_NAME = /TOKEN|KEY|SECRET|PASSWORD/i

// hermes-v050:F-10 Values up to 16 characters (passwords, short keys) are hidden completely
// behind a fixed-length mask; the CC API table rule showed a 4-character value whole and hid
// 1 of 13. Longer values keep that table's format (components/layout/CcApiBadge.vue maskKey).
const SHORT_SECRET_MAX_LENGTH = 16
const SHORT_SECRET_MASK = '••••••••'

export function maskSecretValue(key: string): string {
  if (!key) return ''
  if (key.length <= SHORT_SECRET_MAX_LENGTH) return SHORT_SECRET_MASK
  return `${key.slice(0, 8)}…${key.slice(-4)}`
}

// Names of sensitive, non-empty string values under `env`; null when the text
// is not valid JSON right now (then every sensitive-looking name is masked).
function sensitiveEnvNames(content: string): Set<string> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  const env = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).env : null
  if (!env || typeof env !== 'object' || Array.isArray(env)) return new Set()
  return new Set(Object.entries(env as Record<string, unknown>)
    .filter(([name, value]) => SENSITIVE_NAME.test(name) && typeof value === 'string' && value !== '')
    .map(([name]) => name))
}

function decodeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw
  }
}

const STRING_PAIR = /"((?:[^"\\\n]|\\.)*)"(\s*:\s*)"((?:[^"\\\n]|\\.)*)"/g

export function maskSettingsSecrets(content: string): string {
  if (!content) return content
  const names = sensitiveEnvNames(content)
  if (names && names.size === 0) return content
  return content.replace(STRING_PAIR, (whole, rawName: string, separator: string, rawValue: string) => {
    if (!rawValue) return whole
    const name = decodeJsonString(rawName)
    if (names ? !names.has(name) : !SENSITIVE_NAME.test(name)) return whole
    return `"${rawName}"${separator}${JSON.stringify(maskSecretValue(decodeJsonString(rawValue)))}`
  })
}

export function hasSettingsSecrets(content: string): boolean {
  return maskSettingsSecrets(content) !== content
}
