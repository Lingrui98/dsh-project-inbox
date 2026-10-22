/**
 * research-hub 出站 webhook 投递模块（纯模块，不接线）。
 *
 * 设计要点：
 * - 签名：HMAC-SHA256，内容为 `${timestamp}.${body}`，header 值格式 `sha256=<hex>`，
 *   放在 `x-rhub-signature`；时间戳放 `x-rhub-timestamp`（毫秒），事件名放 `x-rhub-event`。
 *   自定义 headers 先合并，签名头最后写入，不允许被覆盖。
 * - 重试：每次投递最多 1 + retries 次尝试（retries 默认 3，即最多 4 次）。
 *   只有网络错误、超时、HTTP 5xx、429 会重试；其余 4xx 视为最终失败。
 *   退避间隔 500ms 起、指数翻倍、上限 5000ms（500 / 1000 / 2000）。
 * - 超时：每次尝试默认 5000ms，可被 target.timeoutMs 覆盖；超时按失败处理并进入重试。
 * - SSRF：只允许 http/https；默认拒绝回环与私网地址
 *   （localhost、127.0.0.0/8、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、
 *   169.254.0.0/16、100.64.0.0/10、0.0.0.0/8、组播与保留段、
 *   IPv6 的 ::1、fc00::/7、fe80::/10、::ffff: 映射的私网 IPv4）。
 *   allowPrivate 显式放开。判定只看 URL 字面主机名，不做 DNS 解析，
 *   因此不防御 DNS rebinding，也不识别十六进制等非点分 IPv4 写法。
 * - 失败只经 logger.warn 记录，从不抛出；dispatch 返回的 Promise 永远 resolve，
 *   调用方可以安全忽略（不阻塞），测试可以 await 获得确定性。
 */
import { createHmac } from 'node:crypto'
import type { HubItem } from './store.js'

/** 收件箱事件名。 */
export type WebhookEvent = 'item.created' | 'item.settled' | 'item.urgent' | 'alert.created'

/** 一个 webhook 投递目标。 */
export interface WebhookTarget {
  /** 投递地址，只允许 http/https。 */
  url: string
  /** 订阅的事件；缺省或空数组表示订阅全部事件。 */
  events?: WebhookEvent[]
  /** HMAC 签名密钥；缺省则不签名。 */
  secret?: string
  /** 附加请求头；签名相关头由模块写入，不允许覆盖。 */
  headers?: Record<string, string>
  /** 单次尝试超时毫秒数，默认 5000。 */
  timeoutMs?: number
  /** 失败后的重试次数，默认 3（总尝试次数为 1 + retries）。 */
  retries?: number
}

/** 投递上下文：目前只有项目归属，用于在 payload 里带上 project 字段。 */
export interface WebhookContext {
  project?: string
}

/** 投递载荷。 */
export interface WebhookPayload {
  version: 1
  event: WebhookEvent
  item: HubItem
  /** 投递发起时间（毫秒时间戳），由 dispatcher 用注入的 now 生成。 */
  deliveredAt: number
  project?: string
}

/** 失败日志出口：只要求 warn。 */
export interface WebhookLogger {
  warn(message: string, ...args: unknown[]): void
}

export type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>

export interface WebhookDispatcherOptions {
  targets: WebhookTarget[]
  logger: WebhookLogger
  /** 可注入 fetch 实现，便于测试；缺省用全局 fetch。 */
  fetchImpl?: WebhookFetch
  /** 可注入时钟，便于测试；缺省 Date.now。 */
  now?: () => number
  /** 可注入退避等待，便于测试；缺省 setTimeout。 */
  sleep?: (ms: number) => Promise<void>
  /** 显式允许回环/私网目标（默认拒绝）。 */
  allowPrivate?: boolean
}

export interface WebhookDispatcher {
  /** 投递事件。永远 resolve，不抛异常；返回值可安全忽略。 */
  dispatch(event: WebhookEvent, item: HubItem, context?: WebhookContext): Promise<void>
}

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_RETRIES = 3
const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 5000

/** 构造投递载荷。deliveredAt 可显式传入以便测试；缺省取当前时间。 */
export function buildWebhookPayload(
  event: WebhookEvent,
  item: HubItem,
  context?: WebhookContext,
  deliveredAt: number = Date.now(),
): WebhookPayload {
  const payload: WebhookPayload = { version: 1, event, item, deliveredAt }
  if (context?.project) payload.project = context.project
  return payload
}

/**
 * 计算签名 header 值：`sha256=` + HMAC-SHA256(secret, `${timestamp}.${body}`) 的 hex。
 * 验签方用相同方式重算并与 header 比较（建议常量时间比较）。
 */
export function signWebhookPayload(secret: string, timestamp: string | number, body: string): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `sha256=${digest}`
}

/** 判定主机名是否为回环或私网地址。 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '::') return true
  // IPv4 映射的 IPv6（点分写法），递归按 IPv4 判定
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h)
  if (mapped) return isPrivateHost(mapped[1])
  // IPv4 映射的 IPv6（URL 归一化后的 hex 写法，如 ::ffff:7f00:1）
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    return isPrivateHost(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
  }
  // IPv6 唯一本地地址 fc00::/7（fc…/fd…）与链路本地 fe80::/10（fe80…febf…）
  if (/^f[cd]/.test(h) && h.includes(':')) return true
  if (/^fe[89ab]/.test(h) && h.includes(':')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a >= 224) return true // 组播（224/4）与保留（240/4）
    return false
  }
  return false
}

function matches(target: WebhookTarget, event: WebhookEvent): boolean {
  if (!target.events || target.events.length === 0) return true
  return target.events.includes(event)
}

function normalizeTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS
}

function normalizeRetries(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : DEFAULT_RETRIES
}

/** 带超时的 fetch：注入的 fetchImpl 不响应 signal 时也能按超时失败。 */
async function fetchWithTimeout(
  fetchImpl: WebhookFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`webhook 投递超时（${timeoutMs}ms）`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 创建 webhook 投递器。 */
export function createWebhookDispatcher(options: WebhookDispatcherOptions): WebhookDispatcher {
  const fetchImpl: WebhookFetch = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const allowPrivate = options.allowPrivate === true
  const logger = options.logger
  const targets = Array.isArray(options.targets) ? options.targets : []

  /** 向单个目标投递；任何失败只记日志。 */
  async function deliver(target: WebhookTarget, event: WebhookEvent, payload: WebhookPayload): Promise<void> {
    let parsed: URL
    try {
      parsed = new URL(target.url)
    } catch {
      logger.warn(`[rhub] webhook 目标 URL 无法解析，已跳过：${String(target.url)}`)
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      logger.warn(`[rhub] webhook 目标只允许 http/https，已跳过：${parsed.toString()}`)
      return
    }
    if (!allowPrivate && isPrivateHost(parsed.hostname)) {
      logger.warn(`[rhub] webhook 目标指向回环/私网地址，已拒绝（allowPrivate 可放开）：${parsed.hostname}`)
      return
    }

    const body = JSON.stringify(payload)
    const timeoutMs = normalizeTimeout(target.timeoutMs)
    const retries = normalizeRetries(target.retries)
    const timestamp = String(now())
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-rhub-event': event,
      'x-rhub-timestamp': timestamp,
      ...(target.headers ?? {}),
    }
    // 签名头最后写入，自定义 headers 不能覆盖
    if (target.secret) headers['x-rhub-signature'] = signWebhookPayload(target.secret, timestamp, body)

    for (let attempt = 1; ; attempt += 1) {
      let retryReason: string | null = null
      try {
        const res = await fetchWithTimeout(fetchImpl, parsed.toString(), { method: 'POST', headers, body }, timeoutMs)
        if (res.ok) return
        if (res.status >= 500 || res.status === 429) {
          retryReason = `HTTP ${res.status}`
        } else {
          logger.warn(`[rhub] webhook 投递失败（不重试）：${parsed.toString()} 事件 ${event}，HTTP ${res.status}`)
          return
        }
      } catch (err) {
        retryReason = err instanceof Error ? err.message : String(err)
      }
      if (attempt > retries) {
        logger.warn(
          `[rhub] webhook 投递放弃：${parsed.toString()} 事件 ${event}，共 ${attempt} 次尝试，最后失败：${retryReason}`,
        )
        return
      }
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS)
      await sleep(delay)
    }
  }

  return {
    dispatch(event, item, context) {
      const payload = buildWebhookPayload(event, item, context, now())
      const jobs = targets
        .filter((target) => matches(target, event))
        .map((target) =>
          deliver(target, event, payload).catch((err) => {
            logger.warn(`[rhub] webhook 投递出现未捕获异常：${err instanceof Error ? err.message : String(err)}`)
          }),
        )
      return Promise.all(jobs).then(() => undefined)
    },
  }
}
