import { request } from '../client'

export interface CcApiProfile {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  createdAt: number
}

export interface CcApiListResponse {
  profiles: CcApiProfile[]
  active_id: string | null
}

export async function fetchCcApiProfiles(): Promise<CcApiListResponse> {
  return request<CcApiListResponse>('/api/hermes/cc-api')
}

export async function createCcApiProfile(input: {
  name: string
  base_url: string
  api_key: string
}): Promise<CcApiListResponse> {
  return request<CcApiListResponse>('/api/hermes/cc-api', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function updateCcApiProfile(id: string, input: {
  name: string
  base_url: string
  api_key: string
}): Promise<CcApiListResponse> {
  return request<CcApiListResponse>(`/api/hermes/cc-api/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export async function deleteCcApiProfile(id: string): Promise<CcApiListResponse> {
  return request<CcApiListResponse>(`/api/hermes/cc-api/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export async function applyCcApiProfile(id: string): Promise<CcApiListResponse> {
  return request<CcApiListResponse>(`/api/hermes/cc-api/${encodeURIComponent(id)}/apply`, {
    method: 'POST',
  })
}

export type CcEffortLevel = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface CcEffortResponse {
  level: CcEffortLevel
  levels: CcEffortLevel[]
}

export async function fetchCcEffort(): Promise<CcEffortResponse> {
  return request<CcEffortResponse>('/api/hermes/cc-api/effort')
}

export async function updateCcEffort(level: CcEffortLevel): Promise<CcEffortResponse> {
  return request<CcEffortResponse>('/api/hermes/cc-api/effort', {
    method: 'PUT',
    body: JSON.stringify({ level }),
  })
}

// hermes-v051:C Agent 管理 → Claude → 压缩设置 (<WebUI home>/coding-agent/claude-context/compression.json).
export interface CcCompressionValues {
  enabled: boolean
  threshold: number
  target_ratio: number
  protect_last_n: number
  protect_first_n: number
}

export interface CcCompressionSettings {
  follow_main: boolean
  own: CcCompressionValues
  main: CcCompressionValues
  effective: CcCompressionValues
}

export async function fetchCcCompression(): Promise<CcCompressionSettings> {
  return request<CcCompressionSettings>('/api/hermes/cc-api/compression')
}

export async function updateCcCompression(patch: {
  follow_main?: boolean
  own?: Partial<CcCompressionValues>
}): Promise<CcCompressionSettings> {
  return request<CcCompressionSettings>('/api/hermes/cc-api/compression', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}
