// hermes-v051:C Settings → Context compression: the single place that turns a profile's config.yaml
// `compression` section into effective values. Hermes chat compression (chat-run/compression.ts) and
// Claude's "与主设置同步" (coding-agents/services/claude-compression-settings.ts) both call it, so the
// two can never drift apart on ranges or defaults.

export interface CompressionSectionValues {
  enabled: boolean
  threshold: number
  targetRatio: number
  protectLastN: number
  protectFirstN: number
}

function clampRatio(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, n))
}

export function normalizeCompressionSection(section: unknown): CompressionSectionValues {
  const raw: Record<string, any> = section && typeof section === 'object' ? section as Record<string, any> : {}
  return {
    enabled: raw.enabled !== false,
    threshold: clampRatio(raw.threshold, 0.5, 0.05, 0.95),
    targetRatio: clampRatio(raw.target_ratio, 0.2, 0.01, 0.8),
    protectLastN: clampInt(raw.protect_last_n, 20, 0, 500),
    protectFirstN: clampInt(raw.protect_first_n, 3, 0, 100),
  }
}
