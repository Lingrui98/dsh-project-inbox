/**
 * @dsh-external/dsh-project-inbox — client 侧：指挥中心面板（卡片式）。
 *
 * 挂载点：
 * - sidebar.panellist：入口图标 + 待处理角标（轻量 badge 端点轮询）。
 * - main（key = research-hub）：指挥中心页。首页为项目卡片网格，点卡片进详情。
 *
 * 数据通道：POST /rhub/api/<method>（host 侧 webServer 前缀路由，loopback 围栏）。
 * 无 JSX：rolldown 构建 externals 里的 react，运行时用宿主模块表的 React。
 */
import React from 'react'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'
import { HUB_CSS } from './styles.js'
import { pickStrings } from './strings.js'
import { assignItems, groupItems, normalizeLayout } from './layout.js'
import type { LayoutSectionSource } from './layout.js'

const h = React.createElement
const PANEL_ID = 'research-hub'
const API_BASE = '/rhub/api'
// 模块级解析一次文案字典：locale 在面板生命周期内不变。
const T = pickStrings()

// ── 跨面板状态（模块级）：指挥中心的当前视图 + 跳转后的返回目标 ──────────────
// HubPage 卸载/重挂载时视图不丢；跳转会话后头部出现"返回指挥中心"按钮。
let hubView: string | null = null
let returnTarget: { sessionId: string } | null = null
/** 跳转探针：retain 主视图引用（唯一同时持有的一个，下次跳转或返回时释放）。 */
let currentProbe: { release(): void } | null = null
let probeReleaseTimer: ReturnType<typeof setTimeout> | null = null
let probeWatchCleanup: (() => void) | null = null
function releaseCurrentProbe(): void {
  if (probeReleaseTimer) clearTimeout(probeReleaseTimer)
  probeReleaseTimer = null
  try { currentProbe?.release?.() } catch { /* 忽略 */ }
  currentProbe = null
  try { probeWatchCleanup?.() } catch { /* 忽略 */ }
  probeWatchCleanup = null
}
const returnListeners = new Set<() => void>()
function setReturnTarget(v: { sessionId: string } | null): void {
  returnTarget = v
  for (const fn of returnListeners) fn()
}

// ── 类型（与 host 侧面板载荷对齐） ────────────────────────────────────────────

interface Counts { questions: number; deliverables: number; urgent: number; alerts: number }
interface SessionView {
  id: string
  title: string
  running: boolean
  updatedAt: number
  projectId: string | null
  bindBy: string
  bindLocked: boolean
  suggested?: string | null
}
interface ProjectView {
  id: string
  name: string
  aliases: string[]
  source: string
  counts: Counts
  sessions: SessionView[]
}
interface HubItemView {
  id: string
  projectId: string | null
  sessionId: string
  sessionTitle: string
  sessionRunning: boolean
  sessionVisible: boolean
  type: 'question' | 'deliverable' | 'alert'
  title: string
  body: string
  priority: 'normal' | 'urgent'
  status: 'pending' | 'answered' | 'dismissed'
  source: 'tool' | 'auq' | 'system'
  createdAt: number
  settledAt?: number
  answerText?: string
  auq?: {
    callId: string
    questions: { id: string; question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[]
  }
  /** 会话中断告警的原因事实；仅 type 为 alert 的条目存在（source 恒为 system）。 */
  alert?: {
    turn: number
    /** 与 host 侧 turn/end 的 reason.kind 对齐。 */
    kind: 'error' | 'interrupted' | 'max-tokens' | 'aborted'
    /** 仅 aborted：user / parent / hook / disposed / legacy。 */
    cause?: string
    /** 仅 error：模型失败码，例如 PI_AI_ERROR。 */
    code?: string
    detail?: string
  }
  /** AUQ 条目能否在指挥中心代答；false 表示只能去会话内回答。 */
  answerable?: boolean
}
interface PanelData {
  now: number
  pending: number
  projects: ProjectView[]
  unassignedSessions: SessionView[]
  unassignedCounts: Counts
  trashedSessions: { id: string; title: string; at: number }[]
  items: HubItemView[]
  /** 可选布局配置（"全部待处理"视图的分区与分组）；缺省与固定渲染等价。 */
  layout?: unknown
}

// ── API ──────────────────────────────────────────────────────────────────────

async function api<T = any>(method: string, payload?: any): Promise<T> {
  const res = await fetch(`${API_BASE}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  const data = await res.json().catch(() => null)
  if (!data || data.ok !== true) throw new Error(data?.error?.message ?? T.requestFailed(res.status))
  return data.value as T
}

// ── 样式（只用宿主 theme token） ─────────────────────────────────────────────

const C = {
  base: 'var(--dsw-alias-bg-base, #f7f7f8)',
  surface: 'var(--dsw-alias-bg-layer-1, #ffffff)',
  surface2: 'var(--dsw-alias-bg-layer-2, #f1f1f2)',
  overlay: 'var(--dsw-alias-bg-overlay, #ffffff)',
  border: 'var(--dsw-alias-border-l1, rgba(0,0,0,0.16))',
  borderStrong: 'var(--dsw-alias-border-l2, rgba(0,0,0,0.28))',
  brand: 'var(--dsw-alias-brand-primary, #4a4a4a)',
  text: 'var(--dsw-alias-label-primary, #202020)',
  text2: 'var(--dsw-alias-label-secondary, #626262)',
  text3: 'var(--dsw-alias-label-secondary, #626262)',
  muted: 'var(--dsw-alias-label-secondary, #626262)',
  ok: 'var(--dsw-alias-state-success-primary, #4a4a4a)',
  warn: 'var(--dsw-alias-state-warn-primary, #4a4a4a)',
  err: 'var(--dsw-alias-state-error-primary, #4a4a4a)',
  info: 'var(--dsw-alias-brand-primary, #4a4a4a)',
}

const S: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
    color: C.text, background: C.base, fontSize: 13, isolation: 'isolate',
  },
  header: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 14, padding: '16px clamp(18px, 3vw, 40px)',
    background: C.surface, borderBottom: `1px solid ${tint(C.text2, 14)}`, flexShrink: 0,
  },
  content: {
    flex: 1, overflowY: 'auto', padding: '28px clamp(18px, 3vw, 40px) 40px',
    minWidth: 0, background: `radial-gradient(ellipse at 90% 0%, ${tint('#6589df', 5)}, transparent 55%), ${C.base}`,
  },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))',
    gap: 16, width: '100%', maxWidth: 1600, margin: '0 auto', alignItems: 'start',
  },
  pcard: {
    minWidth: 0,
    background: C.surface, border: `1px solid ${tint(C.text2, 18)}`, borderRadius: 18,
    padding: '18px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 12,
    boxShadow: `0 2px 4px ${tint(C.text, 3)}, 0 8px 24px ${tint(C.text, 3)}`,
    transition: 'transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease, background 160ms ease',
  },
  card: {
    background: C.surface, border: `1px solid ${tint(C.text2, 18)}`, borderRadius: 14,
    padding: '18px', marginBottom: 12,
    boxShadow: `0 2px 8px ${tint(C.text, 3)}`,
  },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  muted: { color: C.muted, fontSize: 12, lineHeight: 1.45 },
  body2: {
    color: C.text2, fontSize: 13, whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere', marginTop: 12, padding: '0 0 2px',
    maxHeight: 240, overflowY: 'auto', lineHeight: 1.8,
  },
  textarea: {
    width: '100%', boxSizing: 'border-box', marginTop: 14, padding: '10px 12px', fontSize: 12, minHeight: 58,
    background: tint(C.text2, 4), color: C.text, border: `1px solid ${tint(C.text2, 22)}`,
    borderRadius: 10, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.65,
    transition: 'border-color 150ms ease, background 150ms ease',
  },
  btn: {
    minHeight: 32, padding: '6px 11px', fontSize: 12, fontWeight: 550, borderRadius: 8,
    border: `1px solid ${tint(C.text2, 24)}`, background: C.surface, color: C.text, cursor: 'pointer',
    transition: 'background 140ms ease, border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease',
  },
  btnPrimary: {
    minHeight: 30, padding: '6px 13px', fontSize: 12, fontWeight: 650, borderRadius: 9,
    border: `1px solid color-mix(in srgb, ${C.brand} 45%, transparent)`,
    background: `color-mix(in srgb, ${C.brand} 18%, transparent)`,
    color: C.text, cursor: 'pointer', transition: 'background 140ms ease, border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease',
  },
  chip: {
    display: 'inline-flex', alignItems: 'center', padding: '3px 9px', fontSize: 11, fontWeight: 500, borderRadius: 8,
    background: C.surface2, border: `1px solid ${C.border}`, color: C.text2,
  },
  select: {
    minHeight: 29, background: C.surface2, color: C.text, border: `1px solid ${C.borderStrong}`,
    borderRadius: 8, fontSize: 12, padding: '4px 6px',
  },
}

function buttonHover(baseBackground = C.surface, hoverBackground = tint(C.brand, 9), baseBorder = tint(C.text2, 24), hoverBorder = tint(C.brand, 48)) {
  return {
    onMouseEnter: (e: any) => {
      if (e.currentTarget.disabled) return
      e.currentTarget.style.background = hoverBackground
      e.currentTarget.style.borderColor = hoverBorder
      e.currentTarget.style.boxShadow = `0 2px 8px ${tint(C.brand, 12)}`
    },
    onMouseLeave: (e: any) => {
      e.currentTarget.style.background = baseBackground
      e.currentTarget.style.borderColor = baseBorder
      e.currentTarget.style.boxShadow = 'none'
    },
  }
}

function pill(text: string, color: string, key?: string) {
  return h('span', {
    key,
    style: {
      display: 'inline-flex', alignItems: 'center', fontSize: 11, fontWeight: 600,
      padding: '3px 8px', borderRadius: 6, color: C.text, gap: 5,
      background: tint(color, 9),
      border: `1px solid ${tint(color, 16)}`, lineHeight: '17px',
      whiteSpace: 'nowrap',
    },
  }, [
    h('span', { key: 'dot', 'aria-hidden': true, style: { width: 4, height: 4, borderRadius: '50%', background: color, flexShrink: 0 } }),
    text,
  ])
}

function ago(now: number, time: number): string {
  const s = Math.max(0, Math.floor((now - time) / 1000))
  if (s < 60) return T.agoSeconds(s)
  const m = Math.floor(s / 60)
  if (m < 60) return T.agoMinutes(m)
  const hr = Math.floor(m / 60)
  if (hr < 24) return T.agoHours(hr)
  return T.agoDays(Math.floor(hr / 24))
}

// ── 内联 SVG 图标（currentColor 跟随主题文字色，不依赖 emoji 字体） ───────────

const ICON_PATHS: Record<string, React.ReactNode[]> = {
  compass: [
    h('circle', { key: 'c', cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'currentColor', strokeWidth: 2 }),
    h('polygon', { key: 'n', points: '15.5,8.5 13.1,13.1 8.5,15.5 10.9,10.9', fill: 'currentColor' }),
  ],
  folder: [
    h('path', { key: 'p', d: 'M3 5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5z', fill: 'currentColor' }),
  ],
  inbox: [
    h('path', { key: 'p', d: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 9v7h14v-7h-4.2a3.2 3.2 0 0 1-5.6 0H5z', fill: 'currentColor' }),
  ],
  tray: [
    h('path', { key: 'a', d: 'M4 4h16a1 1 0 0 1 1 1v4H3V5a1 1 0 0 1 1-1z', fill: 'currentColor' }),
    h('path', { key: 'b', d: 'M4 11h16v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8zm6 3v2h4v-2h-4z', fill: 'currentColor' }),
  ],
  question: [
    h('circle', { key: 'c', cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'currentColor', strokeWidth: 2 }),
    h('path', { key: 'q', d: 'M9.6 9.2a2.5 2.5 0 0 1 4.9.6c0 1.6-1.7 2-2.3 3v.7', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
    h('circle', { key: 'd', cx: 12, cy: 17, r: 1.1, fill: 'currentColor' }),
  ],
  warning: [
    h('path', { key: 't', d: 'M10.3 3.9a2 2 0 0 1 3.4 0l8 13.6a2 2 0 0 1-1.7 3H4a2 2 0 0 1-1.7-3l8-13.6z', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinejoin: 'round' }),
    h('path', { key: 'e', d: 'M12 9.4v4.4', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
    h('circle', { key: 'd', cx: 12, cy: 17, r: 1.1, fill: 'currentColor' }),
  ],
  package: [
    h('path', { key: 'p', d: 'M12 2l8 4v12l-8 4-8-4V6l8-4zm0 2.2L6.6 7 12 9.8 17.4 7 12 4.2zM6.5 8.6V18l4.5 2.2v-9.4l-4.5-2.2zm11 0l-4.5 2.2v9.4l4.5-2.2V8.6z', fill: 'currentColor' }),
  ],
  arrow: [h('path', { key: 'p', d: 'M5 12h14m-5-5 5 5-5 5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' })],
  check: [h('path', { key: 'p', d: 'm5 12 4 4L19 6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' })],
  plus: [h('path', { key: 'p', d: 'M12 5v14M5 12h14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' })],
  refresh: [h('path', { key: 'p', d: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' })],
  activity: [h('path', { key: 'p', d: 'M3 12h4l3-7 4 14 3-7h4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' })],
  trash: [
    h('path', { key: 'p', d: 'M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9zm3 2v8h1.5v-8H9zm4.5 0v8H15v-8h-1.5z', fill: 'currentColor' }),
  ],
}

function Icon(props: { name: keyof typeof ICON_PATHS; size?: number; color?: string }) {
  return h('svg', {
    viewBox: '0 0 24 24',
    width: props.size ?? 14,
    height: props.size ?? 14,
    'aria-hidden': true, focusable: false,
    style: { display: 'inline-block', verticalAlign: '-2px', flexShrink: 0, color: props.color ?? 'currentColor' },
  }, ICON_PATHS[props.name])
}

// ── 项目色相：按 id 哈希稳定取色，color-mix 低透明组合，亮暗主题都安全 ───────

const HUES = ['#4f7dd8', '#2f9e67', '#b7791f', '#8a5fd6', '#c94b58', '#2fa3a8']

function projectHue(id: string): string {
  let n = 0
  for (let i = 0; i < id.length; i += 1) n = (n * 31 + id.charCodeAt(i)) >>> 0
  return HUES[n % HUES.length]
}

function tint(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`
}

function sessionLabel(s: { id: string; title: string }): string {
  return s.title || s.id.slice(0, 8)
}

// ── 会话芯片（点击跳转会话） ──────────────────────────────────────────────────

function SessionChip(props: { item: HubItemView; onJump: (id: string) => void }) {
  const { item } = props
  return h('button', {
    type: 'button',
    style: {
      ...S.chip, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', minWidth: 0, boxSizing: 'border-box',
      transition: 'background 140ms ease, border-color 140ms ease, color 140ms ease',
    },
    title: T.jumpToSessionTitle(item.sessionId),
    onMouseEnter: (e: any) => {
      e.currentTarget.style.background = tint(C.info, 9)
      e.currentTarget.style.borderColor = tint(C.info, 46)
      e.currentTarget.style.color = C.text
    },
    onMouseLeave: (e: any) => {
      e.currentTarget.style.background = C.surface2
      e.currentTarget.style.borderColor = C.border
      e.currentTarget.style.color = C.text2
    },
    onClick: (e: any) => { e.stopPropagation(); props.onJump(item.sessionId) },
  }, [
    h('span', {
      key: 'dot',
      style: {
        width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
        background: item.sessionRunning ? C.ok : C.text3,
        boxShadow: item.sessionRunning ? `0 0 0 3px ${tint(C.ok, 14)}` : 'none',
      },
    }),
    h('span', { key: 't', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.sessionTitle || item.sessionId.slice(0, 8)),
  ])
}

// ── 消息卡片 ──────────────────────────────────────────────────────────────────

function ItemCard(props: { item: HubItemView; now: number; onChanged: () => void; onJump: (id: string) => void; embedded?: boolean }) {
  const { item } = props
  const [text, setText] = React.useState('')
  const [selected, setSelected] = React.useState<Record<string, string[]>>({})
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [expanded, setExpanded] = React.useState(false)

  const pending = item.status === 'pending'
  const questions = item.auq?.questions ?? []
  // 前台阻塞提问只能在前台会话的卡片上回答；指挥中心只展示，不提供应答控件。
  const sessionOnly = pending && item.source === 'auq' && item.answerable !== true
  const withOptions = pending && !sessionOnly && item.source === 'auq' && questions.some((q) => (q.options?.length ?? 0) > 0)
  const isAlert = item.type === 'alert'
  // 中断告警的回复会继续该会话，所以标语和 placeholder 都与问题、交付区分。
  const typeLabel = item.type === 'question'
    ? pending ? T.typeQuestionPending : T.typeQuestion
    : isAlert
      ? pending ? T.typeAlertPending : T.typeAlert
      : pending ? T.typeDeliverablePending : T.typeDeliverable

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      props.onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (qid: string, label: string, multi: boolean) => {
    setSelected((prev) => {
      const cur = prev[qid] ?? []
      const next = cur.includes(label) ? cur.filter((l) => l !== label) : multi ? [...cur, label] : [label]
      return { ...prev, [qid]: next }
    })
  }

  const canSubmitOptions = questions.every((q, i) => (selected[q.id]?.length ?? 0) > 0 || (i === 0 && text.trim() !== ''))
  const canSubmitText = text.trim().length > 0

  const submitOptions = () => {
    if (busy || !canSubmitOptions) return
    return run(async () => {
      const answers = questions.map((q, i) => ({
        id: q.id,
        selected: selected[q.id] ?? [],
        ...(i === 0 && text.trim() ? { custom: text.trim() } : {}),
      }))
      await api('answerStructured', { itemId: item.id, answers })
    })
  }

  const submitText = () => {
    if (busy || !canSubmitText) return
    return run(async () => {
      await api('reply', { itemId: item.id, text: text.trim() })
    })
  }

  const typeIcon = item.type === 'question' ? 'question' : isAlert ? 'warning' : 'package'
  const typeColor = item.type === 'question' ? C.warn : isAlert ? C.err : C.ok
  const children: React.ReactNode[] = [
    h('div', { key: 'type', style: { ...S.row, gap: 6, marginBottom: 9 } }, [
      h(Icon, { key: 'icon', name: typeIcon, size: 14, color: typeColor }),
      h('span', { key: 'label', style: { fontSize: 11, fontWeight: 650, color: C.text2 } }, typeLabel),
      item.priority === 'urgent' && pending ? pill(T.pillUrgent, C.err, 'urgent') : null,
      item.source === 'auq' && pending ? pill(T.pillSessionQuestion, C.info, 'auq') : null,
      item.source === 'system' ? pill(T.pillSessionInterrupt, C.err, 'system') : null,
      sessionOnly ? pill(T.pillSessionOnly, C.text3, 'sessiononly') : null,
      h('span', { key: 'age', style: { ...S.muted, marginLeft: 'auto', fontSize: 11 } }, ago(props.now, item.createdAt)),
    ]),
    h('div', { key: 'head', style: { fontWeight: 650, fontSize: 14, lineHeight: 1.65, color: C.text, overflowWrap: 'anywhere' } }, item.title),
    h('div', { key: 'meta', style: { ...S.row, marginTop: 6 } }, [
      h(SessionChip, { key: 'chip', item, onJump: props.onJump }),
      !item.sessionVisible ? h('span', { key: 'gone', style: S.muted }, T.sessionNotInList) : null,
    ]),
  ]

  if (item.body) {
    const long = item.body.length > 200
    children.push(
      h('div', {
        key: 'body',
        id: `rh-body-${item.id}`,
        style: long && !expanded
          ? { ...S.body2, maxHeight: 58, overflow: 'hidden', position: 'relative' }
          : long && expanded
            ? { ...S.body2, maxHeight: 'none', overflow: 'visible' }
            : S.body2,
      }, item.body),
      long
        ? h('button', {
          key: 'expand', type: 'button', 'aria-expanded': expanded, 'aria-controls': `rh-body-${item.id}`,
          style: { fontSize: 11, color: C.text2, cursor: 'pointer', marginTop: 5, display: 'inline-block', border: 0, background: 'transparent', padding: '3px 0', textDecoration: 'underline', textUnderlineOffset: 3 },
          onClick: () => setExpanded(!expanded),
        }, expanded ? T.collapse : T.expandAll(item.body.length))
        : null,
    )
  }

  if (withOptions) {
    children.push(
      h('div', { key: 'opts', style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 } },
        questions.map((q) =>
          h('div', { key: q.id }, [
            questions.length > 1 ? h('div', { key: 'qt', style: { fontSize: 12, marginBottom: 4, color: C.text2 } }, q.question) : null,
            h('div', { key: 'chips', style: S.row },
              (q.options ?? []).map((o) => {
                const on = (selected[q.id] ?? []).includes(o.label)
                return h('button', {
                  key: o.label, type: 'button', 'aria-pressed': on, disabled: busy,
                  title: o.description,
                  onClick: () => toggle(q.id, o.label, Boolean(q.multiSelect)),
                  style: {
                    ...S.chip,
                    cursor: 'pointer',
                    padding: '3px 10px',
                    color: on ? C.text : C.text2,
                    background: on ? tint(C.info, 18) : 'transparent',
                    border: `1px solid ${on ? tint(C.info, 58) : C.border}`,
                    boxShadow: on ? `0 0 0 2px ${tint(C.info, 8)}` : 'none',
                    transition: 'background 140ms ease, border-color 140ms ease, box-shadow 140ms ease',
                  },
                }, o.label)
              }),
            ),
          ]),
        ),
      ),
    )
  }

  if (pending && sessionOnly) {
    children.push(
      h('div', { key: 'hint', style: S.body2 }, T.sessionOnlyHint),
      h('div', { key: 'actions', className: 'rh-message-actions', style: { ...S.row, marginTop: 8 } }, [
        h('button', {
          key: 'jump', style: { ...S.btnPrimary, opacity: busy ? 0.55 : 1 }, disabled: busy,
          onClick: () => props.onJump(item.sessionId),
          ...buttonHover(tint(C.brand, 18), tint(C.brand, 28), tint(C.brand, 45), tint(C.brand, 65)),
        }, T.goAnswerInSession),
        h('button', {
          key: 'dismiss', className: 'rh-subtle-action',
          style: { ...S.btn, color: C.text3, opacity: busy ? 0.55 : 1, marginLeft: 'auto' }, disabled: busy,
          onClick: () => run(() => api('dismiss', { itemId: item.id })),
        }, T.dismiss),
        error ? h('span', { key: 'err', role: 'alert', style: { color: C.err, fontSize: 12 } }, error) : null,
      ]),
    )
  } else if (pending) {
    children.push(
      h('textarea', {
        key: 'reply',
        style: S.textarea,
        'aria-label': T.replyAriaLabel(item.title),
        placeholder: withOptions
          ? T.placeholderWithOptions
          : isAlert ? T.placeholderAlert : T.placeholderText,
        value: text,
        disabled: busy,
        onChange: (e: any) => setText(e.target.value),
        onKeyDown: (e: any) => {
          if (!e.isComposing && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            if (withOptions) void submitOptions()
            else void submitText()
          }
        },
      }),
      h('div', { key: 'actions', className: 'rh-message-actions', style: { ...S.row, marginTop: 8 } }, [
        withOptions
          ? h('button', {
             key: 'send', style: { ...S.btnPrimary, opacity: canSubmitOptions && !busy ? 1 : 0.5 }, disabled: busy || !canSubmitOptions,
             'aria-busy': busy, onClick: submitOptions,
             ...buttonHover(tint(C.brand, 18), tint(C.brand, 28), tint(C.brand, 45), tint(C.brand, 65)),
           }, busy ? T.submitting : T.submitOptions)
          : h('button', { key: 'send', style: { ...S.btnPrimary, opacity: busy || !canSubmitText ? 0.5 : 1 }, disabled: busy || !canSubmitText, onClick: submitText, ...buttonHover(tint(C.brand, 18), tint(C.brand, 28), tint(C.brand, 45), tint(C.brand, 65)) }, busy ? T.sending : T.reply),
        item.type === 'deliverable'
          ? h('button', {
             key: 'ack', style: { ...S.btn, color: C.text, background: tint(C.ok, 6), borderColor: tint(C.ok, 32), opacity: busy ? 0.55 : 1 }, disabled: busy,
             onClick: () => run(() => api('ack', { itemId: item.id })),
             ...buttonHover(tint(C.ok, 6), tint(C.ok, 12), tint(C.ok, 32), tint(C.ok, 48)),
           }, busy ? T.processing : T.ack)
          : null,
        h('button', {
           key: 'jump', style: { ...S.btn, opacity: busy ? 0.55 : 1 }, disabled: busy, onClick: () => props.onJump(item.sessionId),
           ...buttonHover(),
         }, T.jumpToSession),
        h('button', {
           key: 'dismiss', className: 'rh-subtle-action', style: { ...S.btn, color: C.text3, opacity: busy ? 0.55 : 1, marginLeft: 'auto' }, disabled: busy,
           onClick: () => run(() => api('dismiss', { itemId: item.id })),
         }, T.dismiss),
        error ? h('span', { key: 'err', role: 'alert', style: { color: C.err, fontSize: 12 } }, error) : null,
      ]),
    )
  } else {
    children.push(
      h('div', { key: 'settled', style: { ...S.row, marginTop: 8 } }, [
        pill(item.status === 'answered' ? T.statusAnswered : T.statusDismissed, item.status === 'answered' ? C.ok : C.text3, 'st'),
        h('span', { key: 'time', style: S.muted }, item.settledAt ? ago(props.now, item.settledAt) : ''),
        h('button', {
           key: 'reopen', style: { ...S.btn, minHeight: 27, padding: '4px 9px', opacity: busy ? 0.55 : 1 }, disabled: busy,
           onClick: () => run(() => api('reopen', { itemId: item.id })),
           ...buttonHover(),
         }, busy ? T.processing : T.reopen),
      ]),
      item.answerText ? h('div', { key: 'ans', style: S.body2 }, T.answerPrefix(item.answerText)) : null,
    )
  }

  // embedded：收件箱已提供外层表面，消息本体不再重复画框。
  const shellStyle: React.CSSProperties = props.embedded
    ? {
      padding: '12px 0 4px', borderTop: `1px solid ${tint(C.text2, 14)}`, marginTop: 9,
    }
    : {
      ...S.card,
      borderLeft: `3px solid ${item.priority === 'urgent' && pending ? C.err : tint(typeColor, pending ? 62 : 28)}`,
      background: pending ? C.surface : tint(typeColor, 3),
    }

  return h('div', { className: 'rh-message', style: shellStyle }, children)
}

// ── 会话绑定行 ────────────────────────────────────────────────────────────────

function SessionBindRow(props: { session: SessionView; projects: ProjectView[]; onChanged: () => void; onJump: (id: string) => void }) {
  const { session } = props
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const suggestedProject = session.suggested ? props.projects.find((p) => p.id === session.suggested) : undefined

  const bind = async (projectId: string | null) => {
    setBusy(true)
    setError('')
    try {
      await api('bind', { sessionId: session.id, projectId })
      props.onChanged()
    } finally {
      setBusy(false)
    }
  }

  const onSelect = async (value: string) => {
    if (value === '__new__') {
      const name = window.prompt(T.newProjectPromptBind)
      if (!name?.trim()) return
      setBusy(true)
      try {
        const created = await api<{ id: string }>('addProject', { name: name.trim() })
        await api('bind', { sessionId: session.id, projectId: created.id })
        props.onChanged()
      } finally {
        setBusy(false)
      }
      return
    }
    await bind(value === '' ? null : value)
  }

  return h('div', {
    className: 'rh-session-row',
    style: { padding: '13px 2px', borderBottom: `1px solid ${tint(C.text2, 11)}` },
  }, [
    h('span', {
      key: 'dot',
      style: { width: 6, height: 6, borderRadius: '50%', background: session.running ? C.ok : tint(C.text3, 45),
        boxShadow: session.running ? `0 0 0 3px ${tint(C.ok, 12)}` : 'none' },
    }),
    h('button', {
      key: 'title', type: 'button',
      style: { font: 'inherit', textAlign: 'left', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer', border: 0, background: 'transparent', color: C.text, padding: '3px 0', fontSize: 12 },
      title: sessionLabel(session), onClick: () => props.onJump(session.id),
    }, sessionLabel(session)),
    h('button', {
      key: 'trash', type: 'button', disabled: busy,
      title: T.trashTitle, 'aria-label': T.trashAriaLabel(sessionLabel(session)),
      className: 'rh-subtle-action', style: { ...S.btn, color: C.text3, display: 'inline-flex', minHeight: 26, padding: 5, opacity: busy ? 0.45 : 1 },
      onClick: () => {
        if (busy) return
        setBusy(true)
        void api('trashSession', { sessionId: session.id }).then(props.onChanged).catch((e) => setError(String(e))).finally(() => setBusy(false))
      },
    }, h(Icon, { name: 'trash', size: 12 })),
    h('div', { key: 'controls', className: 'rh-session-row-controls' }, [
      suggestedProject && session.projectId === null
        ? h('button', {
          key: 'suggest', type: 'button', disabled: busy, title: T.suggestTitle,
          style: { ...S.chip, cursor: 'pointer', color: C.text, border: `1px dashed ${tint(C.brand, 45)}`, background: tint(C.brand, 6) },
          onClick: () => void bind(suggestedProject.id).catch((e) => setError(String(e))),
        }, T.suggestChip(suggestedProject.name))
        : null,
      h('select', {
        key: 'sel', style: { ...S.select, minHeight: 27, fontSize: 11, background: tint(C.text2, 4), borderColor: tint(C.text2, 20) },
        'aria-label': T.projectSelectAria(sessionLabel(session)), disabled: busy,
        value: session.projectId ?? '', onChange: (e: any) => void onSelect(e.target.value).catch((err) => setError(String(err))),
      }, [
        h('option', { key: 'none', value: '' }, T.unassignedOption),
        ...props.projects.map((p) => h('option', { key: p.id, value: p.id }, p.name)),
        h('option', { key: 'new', value: '__new__' }, T.newProjectOption),
      ]),
      session.bindLocked ? pill(T.pillLocked, C.text2, 'lock') : session.bindBy === 'agent' ? pill(T.pillSelfReported, C.text3, 'by') : null,
    ]),
    error ? h('div', { key: 'error', role: 'alert', style: { gridColumn: '2 / -1', color: C.err, fontSize: 11, overflowWrap: 'anywhere' } }, error) : null,
  ])
}

// ── 首页会话预览：只使用 panel 已有数据，不额外读取会话日志 ────────────────────

function SessionPreview(props: { sessions: SessionView[]; now: number; onJump: (id: string) => void }) {
  const recent = [...props.sessions]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .slice(0, 3)
  return h('div', {
    style: { borderTop: `1px solid ${tint(C.text2, 13)}`, paddingTop: 11 },
  }, [
    h('div', { key: 'label', style: { ...S.muted, fontSize: 10, marginBottom: 6, letterSpacing: '0.04em' } }, T.recentSessions),
    recent.length > 0
      ? recent.map((session) => h('button', {
        key: session.id,
        type: 'button', className: 'rh-session-link',
        title: T.openSessionTitle(sessionLabel(session), session.running),
        onClick: (e: any) => { e.stopPropagation(); props.onJump(session.id) },
        style: {
          display: 'flex', alignItems: 'center', gap: 7, width: '100%', minWidth: 0,
          minHeight: 33, padding: '6px', border: '1px solid transparent', borderRadius: 7,
          background: 'transparent', color: C.text2, font: 'inherit', fontSize: 12,
          textAlign: 'left', cursor: 'pointer', lineHeight: 1.5,
        },
        ...buttonHover('transparent', tint(C.info, 7), 'transparent', tint(C.info, 24)),
      }, [
        h('span', {
          key: 'dot', role: 'img', 'aria-label': session.running ? T.runningAria : T.idleAria,
          style: { width: 5, height: 5, borderRadius: '50%', flexShrink: 0, background: session.running ? C.ok : tint(C.text2, 40) },
        }),
        h('span', {
          key: 'title', className: 'rh-session-title', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', transition: 'color 150ms ease' },
        }, sessionLabel(session)),
        h('span', { key: 'age', style: { fontSize: 10, flexShrink: 0, color: C.text3 } }, ago(props.now, session.updatedAt)),
      ]))
      : h('div', { key: 'empty', style: { ...S.muted, padding: '6px', fontSize: 12 } }, T.noSessionsInProject),
  ])
}

// ── 首页常驻收件箱：独立于项目网格，空箱时仍然保留 ────────────────────────────

function HomeInbox(props: {
  items: HubItemView[]; projects: ProjectView[]; now: number; total?: number; counts?: Counts
  onOpen: () => void; onChanged: () => void; onJump: (id: string) => void
}) {
  const pending = props.items.filter((item) => item.status === 'pending')
    .sort((a, b) => Number(b.priority === 'urgent') - Number(a.priority === 'urgent') || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const total = props.total ?? pending.length
  const urgent = props.counts?.urgent ?? pending.filter((item) => item.priority === 'urgent').length
  const questions = props.counts?.questions ?? pending.filter((item) => item.type === 'question').length
  const alerts = props.counts?.alerts ?? pending.filter((item) => item.type === 'alert').length
  const tone = urgent > 0 || alerts > 0 ? C.err : HUES[0]
  return h('section', {
    'aria-label': T.inboxAriaLabel, className: 'rh-inbox',
    style: {
      border: `1px solid ${tint(tone, 22)}`, borderRadius: 20,
      padding: '22px', marginBottom: 28,
      background: `radial-gradient(ellipse at 0% 0%, ${tint(tone, 11)}, transparent 65%), ${C.surface}`,
      boxShadow: `0 4px 20px ${tint(tone, 5)}`, minWidth: 0,
    },
  }, [
    h('div', { key: 'head', className: 'rh-inbox-heading', style: { ...S.row, gap: 14 } }, [
      h('span', {
        key: 'icon', className: 'rh-inbox-heading-icon', style: { display: 'inline-flex', padding: 13, borderRadius: 14, background: tint(tone, 11), color: tone, boxShadow: `inset 0 0 0 1px ${tint(tone, 14)}` },
      }, h(Icon, { name: 'inbox', size: 23 })),
      h('div', { key: 'title', style: { flex: 1, minWidth: 150 } }, [
        h('div', { key: 'eyebrow', style: { color: C.text2, fontSize: 10, letterSpacing: '0.1em', fontWeight: 650, marginBottom: 3 } }, total > 0 ? T.eyebrowAttention : T.eyebrowAllClear),
        h('h2', { key: 'h', style: { margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1.4 } }, T.inboxHeadline(total)),
        h('div', { key: 'desc', style: { ...S.muted, marginTop: 5, fontSize: 11 } }, T.inboxDesc),
      ]),
      urgent > 0 ? pill(T.pillUrgentCount(urgent), C.err, 'urgent') : null,
      alerts > 0 ? pill(T.pillAlertsCount(alerts), C.err, 'alerts') : null,
      questions > 0 ? pill(T.pillQuestionsCount(questions), C.warn, 'questions') : null,
      total - questions - alerts > 0 ? pill(T.pillDeliverablesCount(total - questions - alerts), C.ok, 'deliverables') : null,
      h('button', {
        key: 'open', type: 'button', style: { ...S.btn, padding: '8px 13px', borderColor: tint(tone, 28), background: tint(tone, 7) }, onClick: props.onOpen, ...buttonHover(tint(tone, 7), tint(tone, 13), tint(tone, 28), tint(tone, 45)),
      }, total > 3 ? T.viewAll(total) : T.openInbox),
    ]),
    pending.length > 0
      ? h('div', {
        key: 'messages', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', alignItems: 'start', gap: 14, marginTop: 16 },
      }, pending.slice(0, 3).map((item) => h('div', {
        key: item.id, style: { minWidth: 0, borderRadius: 13, padding: '14px', background: C.surface, border: `1px solid ${tint(C.text2, 17)}`, boxShadow: `0 2px 6px ${tint(C.text, 3)}` },
      }, [
        h('div', {
          key: 'project', style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, fontWeight: 600, color: C.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, [
          h('span', { key: 'dot', style: { width: 6, height: 6, borderRadius: 2, flexShrink: 0, background: projectHue(item.projectId ?? 'unassigned') } }),
          h('span', { key: 'name', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.projects.find((project) => project.id === item.projectId)?.name ?? T.unassignedName),
        ]),
        h(ItemCard, { key: 'item', item, now: props.now, onChanged: props.onChanged, onJump: props.onJump, embedded: true }),
      ])))
      : h('div', {
        key: 'empty', className: 'rh-inbox-empty', style: { ...S.row, padding: '16px', marginTop: 18, borderRadius: 12, gap: 12, color: C.text2, border: `1px dashed ${tint(tone, 23)}` },
      }, [
        h('span', { key: 'check', style: { display: 'inline-flex', padding: 7, borderRadius: '50%', background: tint(C.ok, 10) } }, h(Icon, { name: 'check', size: 17, color: C.ok })),
        h('div', { key: 'text' }, [
          h('div', { key: 'title', style: { color: C.text, fontWeight: 550, fontSize: 13 } }, T.inboxEmptyTitle),
          h('div', { key: 'desc', style: { fontSize: 11, marginTop: 2 } }, T.inboxEmptyDesc),
        ]),
      ]),
    total > 3
      ? h('button', {
        key: 'more', type: 'button', onClick: props.onOpen,
        style: { ...S.btn, width: '100%', marginTop: 12, background: 'transparent' },
        ...buttonHover('transparent'),
      }, T.inboxMore(total - Math.min(pending.length, 3)))
      : null,
  ])
}

// ── 等宽瀑布流：细网格行跨度填空，不改 DOM 顺序或卡片自然高度 ─────────────────

function ProjectGrid(props: { children: React.ReactNode }) {
  const gridRef = React.useRef<HTMLDivElement | null>(null)
  React.useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid || typeof ResizeObserver === 'undefined') return
    let frame = 0
    let disposed = false
    const cards = new Set<HTMLElement>()
    const layout = () => {
      if (disposed) return
      // offsetHeight 不受 hover 的 transform 影响。先读后写，避免逐卡交替回流。
      const spans = [...cards].map((card) => [card, Math.ceil(card.offsetHeight) + 16] as const)
      for (const [card, span] of spans) card.style.gridRowEnd = `span ${span}`
      grid.style.gridAutoRows = '1px'
      grid.style.rowGap = '0px'
      grid.dataset.masonry = 'ready'
    }
    const schedule = () => {
      if (frame || disposed) return
      frame = requestAnimationFrame(() => { frame = 0; layout() })
    }
    const observer = new ResizeObserver(schedule)
    const sync = () => {
      const live = new Set(Array.from(grid.children) as HTMLElement[])
      for (const card of cards) if (!live.has(card)) { observer.unobserve(card); cards.delete(card) }
      for (const card of live) if (!cards.has(card)) { cards.add(card); observer.observe(card, { box: 'border-box' }) }
      layout()
    }
    observer.observe(grid)
    const mutations = new MutationObserver(sync)
    mutations.observe(grid, { childList: true })
    sync()
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      mutations.disconnect()
      for (const card of cards) card.style.removeProperty('grid-row-end')
      grid.style.removeProperty('grid-auto-rows')
      grid.style.removeProperty('row-gap')
      delete grid.dataset.masonry
    }
  }, [])
  return h('div', { ref: gridRef, className: 'rh-project-grid', style: S.grid }, props.children)
}

// ── 项目卡片（首页网格单元） ──────────────────────────────────────────────────

function ProjectCard(props: {
  name: string
  icon: string
  /** 项目主题色（卡片强调条与图标底色块）。 */
  hue: string
  counts: Counts
  sessions: SessionView[]
  /** 待处理消息仅显示标题，完整回复集中在收件箱或项目详情。 */
  pendingItems?: HubItemView[]
  now: number
  note?: string
  onOpen: () => void
  onChanged: () => void
  onJump: (id: string) => void
}) {
  const { counts, hue } = props
  const [hover, setHover] = React.useState(false)
  const pendingItems = props.pendingItems ?? []
  return h('div', {
    // 整卡支持鼠标点击；键盘通过项目名 button 进入，避免嵌套交互角色。
    role: 'group', className: 'rh-project',
    'aria-label': props.name,
    style: {
      ...S.pcard,
      '--rh-hue': hue,
      background: `linear-gradient(135deg, ${tint(hue, 6)}, transparent 55%), ${C.surface}`,
      borderColor: hover ? tint(hue, 48) : tint(C.text2, 18),
      cursor: 'pointer',
      transform: hover ? 'translateY(-2px)' : 'none',
      boxShadow: hover ? `0 6px 24px ${tint(hue, 12)}, 0 2px 4px ${tint(C.text, 3)}` : S.pcard.boxShadow,
    },
    title: T.openProjectTitle,
    onClick: props.onOpen,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
  }, [
    h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 9 } }, [
      h('span', {
        key: 'iconchip',
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 36, height: 36, borderRadius: 11, flexShrink: 0,
          background: tint(hue, 11), color: `color-mix(in srgb, ${hue} 78%, ${C.text})`,
          boxShadow: `inset 0 0 0 1px ${tint(hue, 14)}`,
        },
      }, h(Icon, { name: props.icon, size: 18 })),
      h('button', {
        key: 'name', type: 'button',
        style: { font: 'inherit', fontWeight: 650, fontSize: 14, letterSpacing: '-0.015em', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', color: C.text, background: 'transparent', border: 0, padding: '5px 0', cursor: 'pointer' },
        onClick: (e: any) => { e.stopPropagation(); props.onOpen() },
      }, props.name),
      h('span', { key: 'arrow', className: 'rh-project-arrow', 'aria-hidden': true, style: { color: C.text2, display: 'inline-flex' } }, h(Icon, { name: 'arrow', size: 15 })),
    ]),
    counts.questions + counts.deliverables + (counts.alerts ?? 0) > 0
      ? h('div', { key: 'counts', style: S.row }, [
        counts.urgent > 0 ? pill(T.pillUrgentCount(counts.urgent), C.err, 'u') : null,
        (counts.alerts ?? 0) > 0 ? pill(T.pillAlertsCount(counts.alerts), C.err, 'a') : null,
        counts.questions > 0 ? pill(T.cardPillQuestions(counts.questions), C.warn, 'q') : null,
        counts.deliverables > 0 ? pill(T.cardPillDeliverables(counts.deliverables), C.ok, 'd') : null,
      ])
      : null,
    // 项目卡只露出简短摘要，避免同一消息出现两份独立回复草稿。
    pendingItems.length > 0
      ? h('div', { key: 'items', style: { display: 'flex', flexDirection: 'column', gap: 7, padding: '10px', borderRadius: 9, background: tint(hue, 5) } },
        pendingItems.slice(0, 2).map((item) => h('div', {
          key: item.id, title: item.title,
          style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, color: C.text2, fontSize: 12, lineHeight: 1.5 },
        }, [
          h(Icon, {
            key: 'icon',
            name: item.type === 'question' ? 'question' : item.type === 'alert' ? 'warning' : 'package',
            size: 12,
            color: item.priority === 'urgent' || item.type === 'alert' ? C.err : item.type === 'question' ? C.warn : C.ok,
          }),
          h('span', { key: 'title', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title),
        ])),
      )
      : null,
    h(SessionPreview, { key: 'sessions', sessions: props.sessions, now: props.now, onJump: props.onJump }),
    h('div', { key: 'foot', style: { ...S.muted, display: 'flex', gap: 10, alignItems: 'center' } }, [
      h('span', { key: 's' }, T.cardSessions(props.sessions.length, props.sessions.length > 3)),
      props.note ? h('span', { key: 'n', style: { flex: 1, fontSize: 10 } }, props.note)
        : props.sessions.some((session) => session.running)
          ? h('span', { key: 'running', style: { display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 'auto', color: C.ok, fontSize: 10 } }, [h(Icon, { key: 'i', name: 'activity', size: 12 }), T.cardRunning(props.sessions.filter((s) => s.running).length)])
          : null,
    ]),
  ])
}

// ── 主面板 ────────────────────────────────────────────────────────────────────

function HubPage(props: { ctx: any }) {
  const [data, setData] = React.useState<PanelData | null>(null)
  const [selected, setSelectedRaw] = React.useState<string | null>(hubView) // null = 卡片首页；模块级记忆
  const [error, setError] = React.useState('')
  const [initialError, setInitialError] = React.useState('')
  const [syncError, setSyncError] = React.useState('')
  const [showHistory, setShowHistory] = React.useState(false)
  const [rescanning, setRescanning] = React.useState(false)
  const setSelected = (v: string | null) => {
    hubView = v
    setSelectedRaw(v)
  }

  const [loadedAt, setLoadedAt] = React.useState(0)
  const load = React.useCallback(async () => {
    try {
      setData(await api<PanelData>('panel'))
      setLoadedAt(Date.now())
      setSyncError('')
      setInitialError('')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setSyncError(message)
      setInitialError((current) => current || message)
    }
  }, [])

  React.useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 8000)
    return () => clearInterval(timer)
  }, [load])

  const jump = React.useCallback((sessionId: string) => {
    // 诊断版跳转：任何失败都显示在面板头部，不静默
    void (async () => {
      // 跳转后抓取客户端现场快照回传 host（排障）
      const capture = (phase: string) => {
        try {
          const sessions = props.ctx.get('sessions')
          const snap = sessions?.list?.getSnapshot?.()
          const row = snap?.byId?.[sessionId]
          const retain = sessions?.retainInfo?.(sessionId)?.getSnapshot?.()
          let binding: unknown = null
          try {
            const b = sessions?.binding?.(sessionId)
            binding = b ? { keys: Object.keys(b) } : null
          } catch (e) { binding = 'err:' + String(e).slice(0, 80) }
          const uw = props.ctx.get('uiWorkspace')
          void api('jumpReport', {
            phase,
            sessionId,
            catalog: { phase: snap?.phase, known: snap?.ids?.includes?.(sessionId), retainedBy: row?.retainedBy ?? null },
            retainInfo: retain ?? null,
            binding,
            uwCtor: uw?.constructor?.name ?? null,
            sameSessions: uw ? uw.sessions === sessions : null,
            href: location.href,
          }).catch(() => {})
        } catch { /* 采样失败忽略 */ }
      }
      try {
        const uw = props.ctx.get('uiWorkspace')
        if (!uw || typeof uw.openSession !== 'function') {
          setError(T.jumpNoWorkspace)
          return
        }
        // 先让宿主把冷会话的 Agent 拉活（对齐原生侧栏打开会话的完整路径），再切面板
        const warm = await api<{ ok: boolean; error?: string }>('warm', { sessionId })
        if (!warm.ok) {
          setError(T.warmFailed(warm.error ?? T.unknownReason))
          return
        }
        const sessions = props.ctx.get('sessions')
        const ids: string[] | undefined = sessions?.list?.getSnapshot?.()?.ids
        const known = !Array.isArray(ids) || ids.includes(sessionId)
        console.log('[research-hub] 跳转会话', sessionId, '目录内:', known)
        setReturnTarget({ sessionId })
        capture('before')
        // 主路径：retain 主视图引用（实测可靠）；openSession 作为导航器的记账辅助。
        // 探针只在目标会话仍是当前主视图时保留。用户从侧栏切换到其他会话或新建会话后，立即释放探针，不能阻塞原生导航。
        releaseCurrentProbe()
        try {
          currentProbe = sessions?.retain?.(sessionId, { source: 'mainView' }) ?? null
          const list = sessions?.list
          const onListChange = () => {
            const snapshot = list?.getSnapshot?.()
            const currentId = snapshot?.byId && Object.values<any>(snapshot.byId).find((row) => (row?.retainedBy?.mainView ?? 0) > 0)?.id
            if (currentId && currentId !== sessionId) {
              setReturnTarget(null)
              releaseCurrentProbe()
            }
          }
          const unsubscribe = list?.subscribe?.(onListChange)
          probeWatchCleanup = () => { try { unsubscribe?.() } catch { /* 忽略 */ } }
        } catch (e) {
          console.error('[research-hub] retain 失败', e)
        }
        try {
          uw.openSession(sessionId)
        } catch (error) {
          setReturnTarget(null)
          releaseCurrentProbe()
          throw error
        }
        capture('sync')
        // Allow the host navigation bookkeeping to settle, then release the temporary retain.
        // Keeping this probe forever prevents the native sidebar from selecting another session.
        probeReleaseTimer = setTimeout(() => releaseCurrentProbe(), 1500)
        if (!known) setError(T.jumpNotInCatalog(sessionId.slice(0, 14)))
        setTimeout(() => capture('t+1.2s'), 1200)
        setTimeout(() => capture('t+4s'), 4000)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        console.error('[research-hub] 跳转会话失败', sessionId, e)
        setError(T.jumpFailed(message))
        capture('error')
      }
    })()
  }, [props.ctx])

  if (!data) {
    return h('div', { style: { ...S.root, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 } }, [
      h('span', { key: 'message', role: 'status', style: S.muted }, initialError || error || T.loading),
      initialError
        ? h('button', { key: 'retry', type: 'button', style: S.btn, onClick: () => void load(), ...buttonHover() }, T.retry)
        : null,
    ])
  }

  const itemCard = (it: HubItemView) =>
    h(ItemCard, { key: it.id, item: it, now: data.now, onChanged: load, onJump: jump })

  const emptyBlock = (tone: string, icon: keyof typeof ICON_PATHS, emptyText: string) =>
    h('div', {
      key: 'e',
      style: { ...S.muted, display: 'flex', alignItems: 'center', gap: 7, padding: '10px 12px', borderRadius: 9, background: tint(tone, 5), border: `1px solid ${tint(tone, 18)}` },
    }, [h(Icon, { key: 'i', name: icon, size: 14, color: tone }), h('span', { key: 't' }, emptyText)])

  // 分区骨架：标题行 + 主体。key 用标题文本，与 0.1.4 固定渲染一致。
  const renderSection = (title: string, tone: string, icon: keyof typeof ICON_PATHS, count: number, body: React.ReactNode) =>
    h('section', { key: title, className: 'rh-section', style: { marginBottom: 22, minWidth: 0 } }, [
      h('h2', { key: 't', className: 'rh-section-heading' }, [
        h('span', { key: 'icon', style: { padding: 6, borderRadius: 8, color: tone, background: tint(tone, 9), display: 'inline-flex' } }, h(Icon, { name: icon, size: 14 })),
        h('span', { key: 'label' }, title),
        h('span', { key: 'count', style: { color: C.text2, fontSize: 11, fontWeight: 500, background: tint(C.text2, 7), padding: '1px 7px', borderRadius: 5 } }, count),
      ]),
      body,
    ])

  // kind 同时决定标题文案与色调/图标；不再从标题文本反推，避免英文标题失配。
  const section = (kind: 'alerts' | 'questions' | 'deliverables' | 'pending' | 'history' | 'unassignedItems', list: HubItemView[], emptyText?: string) => {
    const tone = kind === 'questions' ? C.warn
      : kind === 'deliverables' ? C.ok
      : kind === 'alerts' ? C.err
      : kind === 'history' ? C.text3
      : C.brand
    const icon = kind === 'questions' ? 'question' : kind === 'deliverables' ? 'package' : kind === 'alerts' ? 'warning' : 'inbox'
    const title = kind === 'alerts' ? T.sectionAlerts
      : kind === 'questions' ? T.sectionPendingQuestions
      : kind === 'deliverables' ? T.sectionPendingDeliverables
      : kind === 'history' ? T.sectionHistory
      : kind === 'pending' ? T.sectionPending
      : T.sectionUnassignedItems
    const body = list.length > 0
      ? list.map(itemCard)
      : emptyText
        ? emptyBlock(tone, icon, emptyText)
        : null
    return renderSection(title, tone, icon, list.length, body)
  }

  const sessionSection = (title: string, sessions: SessionView[]) =>
    h('section', { key: title, style: { marginBottom: 22, minWidth: 0 } }, [
      h('h2', { key: 't', className: 'rh-section-heading' }, [
        h('span', { key: 'icon', style: { padding: 6, borderRadius: 8, color: C.info, background: tint(C.info, 9), display: 'inline-flex' } }, h(Icon, { name: 'compass', size: 14 })),
        h('span', { key: 'title' }, title),
        h('span', { key: 'count', style: { color: C.text2, fontSize: 11, fontWeight: 500, background: tint(C.text2, 7), padding: '1px 7px', borderRadius: 5 } }, sessions.length),
      ]),
      h('div', { key: 'list', style: { background: C.surface, borderRadius: 14, border: `1px solid ${tint(C.text2, 17)}`, padding: '4px 12px' } }, sessions.length > 0
        ? sessions.map((s) => h(SessionBindRow, { key: s.id, session: s, projects: data.projects, onChanged: load, onJump: jump }))
        : h('div', { style: { ...S.muted, padding: '16px 4px' } }, T.noSessionsInProject)),
    ])

  const pageTitle = selected === null ? T.hubName
    : selected === '__all__' ? T.pageTitleAll
    : selected === '__unassigned__' ? T.unassignedName
    : selected === '__trash__' ? T.pageTitleTrash
    : data.projects.find((p) => p.id === selected)?.name ?? selected
  const sessionTotal = data.projects.reduce((n, p) => n + p.sessions.length, data.unassignedSessions.length)
  const runningTotal = data.projects.reduce((n, p) => n + p.sessions.filter((s) => s.running).length, data.unassignedSessions.filter((s) => s.running).length)
  const header = h('div', { key: 'header', className: 'rh-toolbar', style: S.header }, [
    selected !== null
      ? h('button', { key: 'back', style: S.btn, onClick: () => setSelected(null), ...buttonHover() }, T.back)
      : h('span', { key: 'icon', style: { display: 'inline-flex', padding: 10, borderRadius: 12, color: C.text, background: tint(HUES[0], 12) } }, h(Icon, { name: 'compass', size: 22 })),
    h('div', { key: 'identity', style: { flex: 1, minWidth: 140 } }, [
      h('div', { key: 'eyebrow', style: { color: C.text2, fontSize: 10, letterSpacing: '0.07em', marginBottom: 2 } }, selected === null ? T.eyebrowHome : T.eyebrowDetail),
      h('h1', { key: 'title', style: { fontSize: 18, fontWeight: 700, letterSpacing: '-0.035em', margin: 0, lineHeight: 1.4, overflowWrap: 'anywhere' } }, pageTitle),
    ]),
    h('div', { key: 'actions', className: 'rh-toolbar-actions', style: { ...S.row, gap: 8 } }, [
      loadedAt > 0 ? h('span', {
        key: 'upd', className: 'rh-toolbar-sync', style: { ...S.muted, fontSize: 10, marginRight: 5, display: 'inline-flex', alignItems: 'center', gap: 5, color: syncError ? C.err : C.text2 }, title: syncError ? T.syncFailTitle : T.syncOkTitle,
      }, [h('span', { key: 'dot', style: { width: 5, height: 5, borderRadius: '50%', background: syncError ? C.err : C.ok } }), syncError ? T.syncFailed : T.updatedAt(new Date(loadedAt).toLocaleTimeString(T.timeLocale, { hour: '2-digit', minute: '2-digit' }))]) : null,
      h('button', {
        key: 'refresh', style: { ...S.btn, opacity: rescanning ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 },
        disabled: rescanning, 'aria-busy': rescanning, ...buttonHover(),
        onClick: () => {
          setRescanning(true)
          void api('rescan')
            .then((v) => { setData(v as PanelData); setLoadedAt(Date.now()); setSyncError('') })
            .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setRescanning(false))
        },
      }, [h(Icon, { key: 'i', name: 'refresh', size: 13 }), rescanning ? T.scanning : T.rescan]),
      h('button', {
        key: 'new', style: { ...S.btnPrimary, display: 'inline-flex', alignItems: 'center', gap: 5 },
        ...buttonHover(tint(C.brand, 18), tint(C.brand, 28), tint(C.brand, 45), tint(C.brand, 65)),
        onClick: () => {
          const name = window.prompt(T.newProjectPrompt)
          if (name?.trim()) void api('addProject', { name: name.trim() }).then(load).catch((e) => setError(String(e)))
        },
      }, [h(Icon, { key: 'i', name: 'plus', size: 13 }), T.newProject]),
    ]),
  ])

  // ── 首页：常驻收件箱在上，项目网格与最近会话在下 ──
  let body: React.ReactNode
  if (selected === null) {
    const cards: React.ReactNode[] = []
    const sorted = [...data.projects].sort(
      (a, b) => (b.counts.questions + b.counts.deliverables + b.counts.urgent * 10 + (b.counts.alerts ?? 0) * 10)
        - (a.counts.questions + a.counts.deliverables + a.counts.urgent * 10 + (a.counts.alerts ?? 0) * 10)
        || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    )
    for (const p of sorted) {
      cards.push(h(ProjectCard, {
        key: p.id,
        name: p.name,
        icon: 'folder',
        hue: projectHue(p.id),
        counts: p.counts,
        sessions: p.sessions,
        pendingItems: data.items.filter((it) => it.projectId === p.id && it.status === 'pending'),
        now: data.now,
        onOpen: () => setSelected(p.id),
        onChanged: load,
        onJump: jump,
      }))
    }
    if (data.unassignedSessions.length > 0 || data.unassignedCounts.questions + data.unassignedCounts.deliverables + (data.unassignedCounts.alerts ?? 0) > 0) {
      cards.push(h(ProjectCard, {
        key: '__unassigned__',
        name: T.unassignedName,
        icon: 'tray',
        hue: C.text3,
        counts: data.unassignedCounts,
        sessions: data.unassignedSessions,
        pendingItems: data.items.filter((it) => it.projectId === null && it.status === 'pending'),
        now: data.now,
        note: T.unassignedNote,
        onOpen: () => setSelected('__unassigned__'),
        onChanged: load,
        onJump: jump,
      }))
    }
    body = h('div', { key: 'home', style: { width: '100%', maxWidth: 1600, margin: '0 auto' } }, [
      h(HomeInbox, {
        key: 'inbox', items: data.items, projects: data.projects, now: data.now, total: data.pending,
        counts: data.projects.reduce((sum, p) => ({
          questions: sum.questions + p.counts.questions,
          deliverables: sum.deliverables + p.counts.deliverables,
          urgent: sum.urgent + p.counts.urgent,
          alerts: (sum.alerts ?? 0) + (p.counts.alerts ?? 0),
        }), { ...data.unassignedCounts }),
        onOpen: () => setSelected('__all__'), onChanged: load, onJump: jump,
      }),
      h('div', { key: 'projects-head', style: { ...S.row, marginBottom: 16, gap: 12 } }, [
        h('div', { key: 'heading', style: { flex: 1, minWidth: 180 } }, [
          h('h2', { key: 'title', style: { margin: 0, fontSize: 17, fontWeight: 650, letterSpacing: '-0.02em' } }, T.overviewTitle),
          h('span', { key: 'desc', style: { ...S.muted, fontSize: 11 } }, T.overviewDesc(data.projects.length, sessionTotal, runningTotal)),
        ]),
        h('span', { key: 'spacer', style: { flex: 1 } }),
        data.trashedSessions.length > 0
          ? h('button', {
            key: 'trash', type: 'button', style: { ...S.btn, color: C.text2 },
            onClick: () => setSelected('__trash__'), ...buttonHover(),
          }, [h(Icon, { key: 'icon', name: 'trash', size: 12 }), T.trashButton(data.trashedSessions.length)])
          : null,
      ]),
      cards.length > 0
        ? h(ProjectGrid, { key: 'grid' }, cards)
        : h('div', { key: 'empty', style: S.muted }, T.noProjects),
    ])
  } else if (selected === '__trash__') {
    body = h('div', { key: 'trash', style: { maxWidth: 860 } }, [
      h('div', { key: 't', style: { fontSize: 13, fontWeight: 600, marginBottom: 8, color: C.text2 } }, T.trashHeading(data.trashedSessions.length)),
      data.trashedSessions.length === 0
        ? h('div', { key: 'e', style: S.muted }, T.trashEmpty)
        : data.trashedSessions.map((s) =>
          h('div', { key: s.id, style: { ...S.row, padding: '7px 0', borderBottom: `1px solid ${C.border}` } }, [
            h(Icon, { key: 'i', name: 'trash', size: 13, color: C.text3 }),
            h('span', { key: 't', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.title || s.id.slice(0, 13)),
            h('span', { key: 'a', style: S.muted }, T.trashedAt(ago(data.now, s.at))),
            h('button', {
              key: 'restore',
              style: S.btn,
              onClick: () => void api('restoreSession', { sessionId: s.id }).then(load),
            }, T.restore),
          ]),
        ),
    ])
  } else if (selected === '__all__') {
    // 分区布局：panel 载荷可带可选 layout；缺省布局与 0.1.4 固定渲染逐节点等价。
    const layout = normalizeLayout(data.layout)
    const sections = layout.sections ?? []
    const grouped = assignItems(data.items, layout)
    const groupBy = layout.groupBy ?? 'none'
    // source 决定标题文案与色调/图标；与 section() 的映射保持一致。
    const sectionMeta: Record<LayoutSectionSource, { tone: string; icon: keyof typeof ICON_PATHS; title: string; empty?: string }> = {
      alerts: { tone: C.err, icon: 'warning', title: T.sectionAlerts, empty: T.emptyAlerts },
      questions: { tone: C.warn, icon: 'question', title: T.sectionPendingQuestions, empty: T.emptyQuestions },
      deliverables: { tone: C.ok, icon: 'package', title: T.sectionPendingDeliverables, empty: T.emptyDeliverables },
      pending: { tone: C.brand, icon: 'inbox', title: T.sectionPending, empty: T.emptyPending },
      history: { tone: C.text3, icon: 'inbox', title: T.sectionHistory },
      all: { tone: C.brand, icon: 'inbox', title: T.pageTitleAll, empty: T.emptyPending },
    }
    const groupLabel = (key: string): string => {
      if (groupBy === 'project') return data.projects.find((p) => p.id === key)?.name ?? (key === 'unassigned' ? T.unassignedName : key)
      if (groupBy === 'kind') return key === 'alert' ? T.sectionAlerts : key === 'question' ? T.sectionPendingQuestions : key === 'deliverable' ? T.sectionPendingDeliverables : key
      if (groupBy === 'priority') return key === 'urgent' ? T.pillUrgent : key
      return key
    }
    body = h('div', { className: 'rh-inbox-grid' }, sections.map((sec) => {
      const meta = sectionMeta[sec.source]
      const title = sec.title ?? meta.title
      const list = grouped.get(sec.id) ?? []
      const content = sec.collapsed
        ? null
        : list.length > 0
          ? groupBy === 'none'
            // 默认路径：分组头不存在，DOM 与固定渲染一致。
            ? list.map(itemCard)
            : groupItems(list, groupBy).flatMap((group) => [
              h('div', { key: `g:${group.key}`, style: { ...S.muted, fontSize: 11, fontWeight: 600, margin: '10px 0 6px' } }, groupLabel(group.key)),
              ...group.items.map(itemCard),
            ])
          : meta.empty
            ? emptyBlock(meta.tone, meta.icon, meta.empty)
            : null
      return renderSection(title, meta.tone, meta.icon, list.length, content)
    }))
  } else if (selected === '__unassigned__') {
    const pendingItems = data.items.filter((it) => it.projectId === null && it.status === 'pending')
    body = h('div', { className: 'rh-detail-grid' }, [
      sessionSection(T.sectionUnassignedSessions, data.unassignedSessions),
      section('unassignedItems', pendingItems, T.emptyUnassignedItems),
    ])
  } else {
    const project = data.projects.find((p) => p.id === selected)
    const items = data.items.filter((it) => it.projectId === selected)
    const pendingItems = items.filter((it) => it.status === 'pending')
    const history = items.filter((it) => it.status !== 'pending')
    body = h('div', { className: 'rh-detail-grid' }, [
      sessionSection(T.sectionProjectSessions, project?.sessions ?? []),
      h('div', { key: 'messages' }, [
        section('pending', pendingItems, T.emptyPending),
        h('button', { key: 'hist-head', type: 'button', 'aria-expanded': showHistory, style: { ...S.btn, ...S.row, cursor: 'pointer', marginBottom: 14, background: 'transparent' }, onClick: () => setShowHistory(!showHistory) }, [
          h('span', { key: 'arrow', style: { ...S.muted, fontSize: 10 } }, showHistory ? '⌄' : '›'),
          h('span', { key: 't', style: { fontSize: 12, color: C.text2 } }, T.historyToggle(history.length)),
        ]),
        showHistory ? section('history', history) : null,
      ]),
    ])
  }

  return h('div', { className: 'rh-root', style: S.root }, [
    header,
    h('style', { key: 'styles' }, HUB_CSS),
    h('div', { key: 'content', className: 'rh-content', style: S.content }, [
      error ? h('div', { key: 'error', role: 'alert', style: { maxWidth: 1600, margin: '0 auto 18px', padding: '10px 14px', borderRadius: 10, color: C.err, background: tint(C.err, 8), border: `1px solid ${tint(C.err, 20)}` } }, error) : null,
      syncError && data ? h('div', { key: 'sync-error', role: 'status', style: { maxWidth: 1600, margin: '0 auto 18px', padding: '9px 12px', borderRadius: 10, color: C.err, background: tint(C.err, 6), border: `1px solid ${tint(C.err, 18)}`, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
        h('span', { key: 'message', style: { flex: 1, minWidth: 180 } }, T.syncErrorBanner(loadedAt > 0 ? T.lastGoodData : T.cachedData, syncError)),
        h('button', { key: 'retry', type: 'button', style: { ...S.btn, minHeight: 28, padding: '4px 9px', color: C.err, borderColor: tint(C.err, 30), background: tint(C.err, 5) }, onClick: () => void load(), ...buttonHover(tint(C.err, 5), tint(C.err, 12), tint(C.err, 30), tint(C.err, 48)) }, T.retry),
      ]) : null,
      h('div', { key: 'canvas', style: { maxWidth: 1600, margin: '0 auto' } }, body),
    ]),
  ])
}

// ── panellist 图标（含角标） ──────────────────────────────────────────────────

function HubIcon() {
  const [badge, setBadge] = React.useState<{ pending: number; urgent: number; alerts?: number } | null>(null)
  React.useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const v = await api<{ pending: number; urgent: number; alerts?: number }>('badge')
        if (alive) setBadge(v)
      } catch { /* 轮询失败保持旧值 */ }
    }
    void tick()
    const timer = setInterval(() => void tick(), 15000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  return h('span', { style: { position: 'relative', display: 'inline-flex' } }, [
    h(Icon, { key: 'i', name: 'compass', size: 16 }),
    badge && badge.pending > 0
      ? h('span', {
        key: 'b',
        style: {
          position: 'absolute', top: -6, right: -8, minWidth: 14, height: 14, borderRadius: 7,
          background: `color-mix(in srgb, ${badge.urgent > 0 || (badge.alerts ?? 0) > 0 ? C.err : C.warn} 18%, transparent)`,
          color: badge.urgent > 0 || (badge.alerts ?? 0) > 0 ? C.err : C.warn,
          fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px',
        },
      }, badge.pending > 99 ? '99+' : String(badge.pending))
      : null,
  ])
}

// ── 会话头部"返回指挥中心"按钮（仅在从指挥中心跳转过来的会话上显示） ──────────

// session scope 的 sessionId 指向这个头部实际显示的会话。
// mainView 引用可能同时存在多个，更新时间不代表当前显示的会话。
function HubReturnBar(props: { ctx: any; sessionId: string }) {
  const [, force] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    const fn = () => force()
    returnListeners.add(fn)
    return () => { returnListeners.delete(fn) }
  }, [])
  if (!returnTarget || props.sessionId !== returnTarget.sessionId) return null
  return h('button', {
    style: {
      ...S.btn, display: 'inline-flex', alignItems: 'center', gap: 5,
      color: C.info, borderColor: `color-mix(in srgb, ${C.info} 40%, transparent)`,
    },
    title: T.returnTitle,
    onClick: () => {
      setReturnTarget(null)
      // 探针引用在返回时释放：openSession 成功的会话由导航器继续持有，没成功的正常关闭
      releaseCurrentProbe()
      try {
        props.ctx.get('layout')?.selectPanel(PANEL_ID)
      } catch (e) {
        console.error('[research-hub] 返回指挥中心失败', e)
      }
    },
  }, T.returnLabel)
}

// ── 注册 ──────────────────────────────────────────────────────────────────────

type ClientContext = {
  slots: SlotsService
  get(name: string): any
  effect(cb: () => () => void, label?: string): () => void
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('main', () =>
    (ctx.slots as any).register({ name: 'main', key: PANEL_ID },
      () => h(HubPage, { ctx }),
    ),
  ), 'research-hub: main panel')

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () =>
    (ctx.slots as any).register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => T.hubName },
      HubIcon,
    ),
  ), 'research-hub: panellist icon')

  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () =>
    (ctx.slots as any).register({
        name: 'conversation.session.header.utilities',
        id: 'research-hub-return',
        order: 30,
        // sessionId 由 session scope 提供，不通过业务注入重复覆盖。
        inject: () => ({ ctx }),
      },
      HubReturnBar,
    ),
  ), 'research-hub: return button')
}
