import { reactive, toRaw } from 'vue'

// hermes-v050:C3 流式 delta 按帧合并响应式通知。
// 数据立即写进原始对象，store 里任何同步读取（拼接下一个 delta、边界检测、快照对账）拿到的永远是最新值；
// 只把「通知视图」推迟到下一帧（后台标签页 rAF 不跑时由兜底定时器补上），每帧最多一次，
// 一帧内到达的多个 delta 只让 MessageList / MessageItem / MarkdownRenderer 重算一遍。
// 非 delta 事件（tool.started、run.completed 等）进入前先 flushStreamingText()，保证事件顺序不变。

export type StreamingTextField = 'content' | 'reasoning'

type PendingField = { notified: string | undefined; hadKey: boolean }

const FALLBACK_FLUSH_MS = 120
const pendingWrites = new Map<object, Map<StreamingTextField, PendingField>>()
let frameHandle: number | null = null
let timerHandle: ReturnType<typeof setTimeout> | null = null

function canDeferToFrame(): boolean {
  return typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function'
}

function scheduleFlush(): void {
  if (frameHandle === null) {
    frameHandle = requestAnimationFrame(() => {
      frameHandle = null
      flushStreamingText()
    })
  }
  if (timerHandle === null) {
    timerHandle = setTimeout(() => {
      timerHandle = null
      flushStreamingText()
    }, FALLBACK_FLUSH_MS)
  }
}

export function writeStreamingText(
  target: { content: string; reasoning?: string },
  field: StreamingTextField,
  value: string,
): void {
  const raw = toRaw(target) as Record<string, unknown>
  if ((raw as unknown) === target || !canDeferToFrame()) {
    ;(target as Record<string, unknown>)[field] = value
    return
  }
  let fields = pendingWrites.get(raw)
  if (!fields) {
    fields = new Map()
    pendingWrites.set(raw, fields)
  }
  if (!fields.has(field)) {
    fields.set(field, {
      notified: raw[field] as string | undefined,
      hadKey: Object.prototype.hasOwnProperty.call(raw, field),
    })
  }
  raw[field] = value
  scheduleFlush()
}

export function hasPendingStreamingText(): boolean {
  return pendingWrites.size > 0
}

export function flushStreamingText(): void {
  if (frameHandle !== null) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameHandle)
    frameHandle = null
  }
  if (timerHandle !== null) {
    clearTimeout(timerHandle)
    timerHandle = null
  }
  if (pendingWrites.size === 0) return
  const entries = [...pendingWrites]
  pendingWrites.clear()
  for (const [raw, fields] of entries) {
    const proxy = reactive(raw) as Record<string, unknown>
    const target = raw as Record<string, unknown>
    for (const [field, { notified, hadKey }] of fields) {
      const latest = target[field]
      if (latest === notified && hadKey) continue
      // 先把原始对象退回上次已通知的值，再经代理写入最新值，Vue 才会判定「有变化」并触发依赖。
      if (hadKey) target[field] = notified
      else delete target[field]
      proxy[field] = latest
    }
  }
}

const STREAMING_TEXT_EVENTS = new Set(['message.delta', 'reasoning.delta', 'thinking.delta'])

export function isStreamingTextEvent(event: unknown): boolean {
  return STREAMING_TEXT_EVENTS.has(String(event || ''))
}
