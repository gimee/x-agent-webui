const SOURCE_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  api_server: 'API Server',
  cli: 'CLI',
  coding_agent: 'Coding Agent',
  global_agent: 'Global Agent',
  discord: 'Discord',
  slack: 'Slack',
  matrix: 'Matrix',
  whatsapp: 'WhatsApp',
  signal: 'Signal',
  email: 'Email',
  sms: 'SMS',
  dingtalk: 'DingTalk',
  feishu: 'Feishu',
  wecom: 'WeCom',
  weixin: 'WeChat',
  bluebubbles: 'iMessage',
  mattermost: 'Mattermost',
  cron: 'Cron',
}

// hermes-v050:U28 translated source names (Chinese aligned with the sidebar:
// 全局 / 编程工具). Brand and protocol names (CLI, Telegram, ...) stay as-is.
const SOURCE_LABEL_KEYS: Record<string, string> = {
  api_server: 'settings.tabs.apiServer',
  coding_agent: 'session.source.codingAgent',
  global_agent: 'sidebar.globalAgent',
  email: 'session.source.email',
  sms: 'session.source.sms',
  dingtalk: 'session.source.dingtalk',
  feishu: 'socialMessages.platforms.feishu',
  wecom: 'session.source.wecom',
  weixin: 'session.source.weixin',
  cron: 'session.source.cron',
}

export function getSourceLabel(source?: string, t?: (key: string) => string): string {
  if (!source) return ''
  const key = t ? SOURCE_LABEL_KEYS[source] : undefined
  if (key && t) return t(key)
  return SOURCE_LABELS[source] || source
}

export function formatTimestampMs(timestamp: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function formatTimestampSeconds(timestamp: number): string {
  return formatTimestampMs(timestamp * 1000)
}

// Fixed local-time format for session rows only; other date labels stay unchanged.
export function formatSessionListTimestamp(timestamp: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
