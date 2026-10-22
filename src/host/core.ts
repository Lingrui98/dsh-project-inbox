/**
 * research-hub 核心：项目发现、会话归因、收件箱操作、回复路由。
 * 所有方法只操作内存 store + 宿主服务，落盘由 store.touch 防抖完成。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AuqQuestionView, Binding, HubItem, HubStore, Project, SessionSnapshot, TurnAlertKind, TurnAlertView } from './store.js'

/** 宿主服务的最小结构面（运行时已验证存在）。 */
export interface HubServices {
  sessionController: any
  sessionQuery: any
  userQuestions: any
  agents: any
}

/** 归因时无区分度的通用词，不参与匹配。 */
const STOP_TOKENS = new Set(['paper', 'papers', 'project', 'exp', 'doc', 'docs', 'the', 'and'])

/** 归一化：小写、非中英数字折叠为空格。 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim()
}

/** 建议路径的停用词比自动绑定宽：'papers' 在标题里是有区分度的线索，仅作建议展示。 */
const SUGGEST_STOP_TOKENS = new Set(['paper', 'project', 'exp', 'doc', 'docs', 'the', 'and'])

function uniq(list: string[]): string[] {
  return [...new Set(list.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()))]
}

/** 从目录名派生别名：全名、去分隔符、逐 token（≥3 字符且非停用词）、token 前缀链。 */
function deriveAliases(dirName: string, displayName: string): string[] {
  const aliases = [dirName, displayName, dirName.replace(/[-_]+/g, '')]
  const tokens = dirName.split(/[-_]+/).filter((t) => t.length >= 3 && !STOP_TOKENS.has(t.toLowerCase()))
  aliases.push(...tokens)
  for (let i = 2; i < tokens.length; i += 1) aliases.push(tokens.slice(0, i).join(' '))
  return uniq(aliases)
}

/** 从 paper.toml 文本里朴素提取第一个 name/title 字段。 */
function paperTomlName(text: string): string | undefined {
  const m = text.match(/^(?:name|title)\s*=\s*["']([^"']+)["']/m)
  return m?.[1]
}

// ── ask_user_question 事件解析 ──────────────────────────────────────────────

/** 前台阻塞提问不可代答时的提示。 */
const AUQ_SESSION_ONLY = '该问题显示在前台会话的提问卡片上，请在会话内回答；回答后此处会自动关闭'
/** 已声明可代答但实际应答失败时的提示。 */
const AUQ_ANSWER_FAILED = '会话中的问题当前不可应答（会话未运行或问题已变化），请在会话内回答'

/**
 * 从 tool/call 记录的 arguments 文本解析问题批。
 * 记录不可读或没有有效问题时返回 null；内容按服务词汇归一（multi_select → multiSelect）。
 */
export function questionsOfArguments(argumentsText: unknown): AuqQuestionView[] | null {
  if (typeof argumentsText !== 'string' || argumentsText.trim() === '') return null
  let parsed: any
  try {
    parsed = JSON.parse(argumentsText)
  } catch {
    return null
  }
  const raw = parsed?.questions
  if (!Array.isArray(raw)) return null
  const questions: AuqQuestionView[] = []
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const id = String((q as any).id ?? '').trim()
    const question = String((q as any).question ?? '').trim()
    if (!id || !question) continue
    const options = Array.isArray((q as any).options)
      ? (q as any).options
        .filter((o: any) => o && typeof o.label === 'string')
        .map((o: any) => ({ label: o.label, ...(typeof o.description === 'string' ? { description: o.description } : {}) }))
      : undefined
    questions.push({
      id,
      question,
      header: typeof (q as any).header === 'string' ? (q as any).header : undefined,
      options,
      multiSelect: Boolean((q as any).multi_select ?? (q as any).multiSelect),
    })
  }
  return questions.length > 0 ? questions : null
}

/** 工具结果或迟答复文本里的回答批；没有可读回答时返回 null。 */
function answersOfContent(content: unknown): { id: string; selected: string[]; custom?: string }[] | null {
  if (!Array.isArray(content)) return null
  const text = content.find((block: any) => block?.type === 'text' && typeof block.text === 'string')
  if (!text) return null
  let parsed: any
  try {
    parsed = JSON.parse((text as any).text)
  } catch {
    return null
  }
  if (!Array.isArray(parsed?.answers)) return null
  return parsed.answers
    .filter((answer: any) => answer && typeof answer.id === 'string')
    .map((answer: any) => ({
      id: String(answer.id),
      selected: Array.isArray(answer.selected) ? answer.selected.filter((s: unknown) => typeof s === 'string') : [],
      ...(typeof answer.custom === 'string' ? { custom: answer.custom } : {}),
    }))
}

/** 工具结果是否是"超时但问题仍可回答"的 pending 载荷。 */
function resultIsPending(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  const text = content.find((block: any) => block?.type === 'text' && typeof block.text === 'string')
  if (!text) return false
  try {
    const parsed = JSON.parse((text as any).text)
    return typeof parsed === 'object' && parsed !== null && parsed.pending === true
  } catch {
    return false
  }
}

/** 回答批 → 一行摘要，写入收件箱历史。 */
function summarizeAnswers(answers: { id: string; selected: string[]; custom?: string }[]): string {
  return answers
    .map((answer) => [...answer.selected, ...(answer.custom ? [answer.custom] : [])].join('、'))
    .filter(Boolean)
    .join('；')
}

/**
 * 折叠一段会话事件，返回仍然可回答的 ask_user_question 调用。
 * 这是 `userQuestions` 投影的镜像版本，区别是不要求 timed 工具：
 * legacy 阻塞式提问同样被跟踪。
 */
export function foldOpenAuqQuestions(events: readonly any[]): { callId: string; questions: AuqQuestionView[] }[] {
  const open = new Map<string, AuqQuestionView[]>()
  for (const event of events) {
    switch (event?.type) {
      case 'tool/call': {
        if (event.data?.name !== 'ask_user_question') break
        const questions = questionsOfArguments(event.data.arguments)
        if (questions) open.set(String(event.data.callId), questions)
        break
      }
      case 'tool/ptc-dispatch': {
        if (event.data?.name !== 'ask_user_question' || event.data.isError) break
        if (!resultIsPending(event.data.content)) break
        const questions = questionsOfArguments(JSON.stringify(event.data.arguments))
        if (questions) open.set(String(event.data.subCallId), questions)
        break
      }
      case 'tool/result': {
        const callId = String(event.data?.message?.toolCallId ?? '')
        if (!callId || !open.has(callId)) break
        // 超时但未回答的问题仍然可回答，保持打开
        if (resultIsPending(event.data?.message?.content)) break
        open.delete(callId)
        break
      }
      case 'user/message': {
        const source = event.data?.source
        if (source?.kind === 'user-question-reply' && source.callId) open.delete(String(source.callId))
        break
      }
      default:
        break
    }
  }
  return [...open.entries()].map(([callId, questions]) => ({ callId, questions }))
}

// ── 会话中断告警 ────────────────────────────────────────────────────────────
//
// 会话因模型服务中断、宿主崩溃或主动取消而停在半途时，agent 本身不会再调用
// hub_post，用户离开会话后无从得知。这里由宿主侧监听 turn/end：
// 实时事件覆盖进程存活期间的失败，冷读回填覆盖崩溃/重启补记的 interrupted。

/** 默认告警的 turn/end 原因标记。aborted 只认 disposed（宿主关闭或插件重载）。 */
export const DEFAULT_ALERT_KINDS = ['error', 'interrupted', 'aborted:disposed']

/** 一次中断告警候选：turn/end 里可进收件箱的事实。 */
export interface TurnAlertCandidate {
  turn: number
  kind: TurnAlertKind
  cause?: string
  code?: string
  detail?: string
  /** 中断事件时间（合成事件复用崩溃前最后一个事件时间）。 */
  time: number
}

/** 取消原因 → 一行说明。 */
const ABORT_CAUSE_TEXT: Record<string, string> = {
  disposed: '宿主关闭或插件重载中止了运行中的回合',
  user: '用户取消了回合',
  parent: '父会话取消了该回合',
  hook: '插件钩子取消了该回合',
  legacy: '历史记录中的取消，原因未知',
}

/** 原因标记是否命中配置：支持 `aborted`（全部原因）与 `aborted:<cause>`。 */
function alertKindEnabled(kinds: readonly string[], kind: TurnAlertKind, cause?: string): boolean {
  for (const token of kinds) {
    if (token === kind) return true
    if (kind === 'aborted' && token === `aborted:${cause}`) return true
    if (token === 'all') return true
  }
  return false
}

/**
 * 从一段会话事件折叠出需要告警的中断回合。
 * 只读取 `turn/end`；completed / blocked / forked 不算中断。
 *
 * 默认只报"日志尾部仍未恢复"的中断：异常 turn/end 之后若已出现新的 turn/start，
 * 说明会话已被继续，旧中断不再打扰用户。实时路径传入单个 turn/end 事件时，
 * 该事件本身就是尾部，行为不变。
 */
export function foldTurnAlerts(
  events: readonly any[],
  kinds: readonly string[] = DEFAULT_ALERT_KINDS,
  options: { tailOnly?: boolean } = {},
): TurnAlertCandidate[] {
  const tailOnly = options.tailOnly !== false
  const found: { candidate: TurnAlertCandidate; index: number }[] = []
  let lastTurnStart = -1
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'turn/start') lastTurnStart = index
    if (event?.type !== 'turn/end') continue
    const reason = event.data?.reason
    const turn = Number(event.data?.turn)
    if (!reason || !Number.isFinite(turn)) continue
    const time = Number(event.time) || Date.now()
    if (reason.kind === 'error') {
      if (!alertKindEnabled(kinds, 'error')) continue
      const code = typeof reason.error?.code === 'string' ? reason.error.code : undefined
      const message = typeof reason.error?.message === 'string' ? reason.error.message : ''
      found.push({
        index,
        candidate: {
          turn,
          kind: 'error',
          code,
          detail: [message, typeof reason.error?.status === 'number' ? `HTTP ${reason.error.status}` : ''].filter(Boolean).join('，') || undefined,
          time,
        },
      })
    } else if (reason.kind === 'interrupted') {
      if (!alertKindEnabled(kinds, 'interrupted')) continue
      found.push({ index, candidate: { turn, kind: 'interrupted', detail: '会话进程在回合运行中被中断（宿主崩溃或重启）', time } })
    } else if (reason.kind === 'max-tokens') {
      if (!alertKindEnabled(kinds, 'max-tokens')) continue
      found.push({ index, candidate: { turn, kind: 'max-tokens', detail: '输出达到 token 上限，回合提前结束', time } })
    } else if (reason.kind === 'aborted') {
      const cause = typeof reason.reason?.kind === 'string' ? reason.reason.kind : 'legacy'
      if (!alertKindEnabled(kinds, 'aborted', cause)) continue
      found.push({ index, candidate: { turn, kind: 'aborted', cause, detail: ABORT_CAUSE_TEXT[cause] ?? `回合被取消（${cause}）`, time } })
    }
  }
  if (!tailOnly) return found.map((entry) => entry.candidate)
  const tail = found[found.length - 1]
  return tail && tail.index > lastTurnStart ? [tail.candidate] : []
}

/** 失败码是否值得展示：UNKNOWN 是宿主对非 LLM 错误的兜底码，没有信息量。 */
function showableCode(code?: string): string | undefined {
  return code && code !== 'UNKNOWN' ? code : undefined
}

/** 告警条目标题：一眼看出中断类别。 */
export function alertTitle(candidate: TurnAlertCandidate): string {
  if (candidate.kind === 'error') {
    const code = showableCode(candidate.code)
    return `会话中断：回合执行失败${code ? `（${code}）` : ''}`
  }
  if (candidate.kind === 'interrupted') return '会话中断：会话进程崩溃'
  if (candidate.kind === 'max-tokens') return '会话中断：输出达到上限'
  return candidate.cause === 'disposed' ? '会话中断：宿主关闭时回合被中止' : '会话中断：回合被取消'
}

/** 告警条目正文：轮次、原因、继续方式。 */
export function alertBody(candidate: TurnAlertCandidate): string {
  const code = showableCode(candidate.code)
  const reason = candidate.kind === 'error'
    ? `回合执行失败${code ? `（${code}）` : ''}`
    : candidate.detail || '回合在完成前结束'
  return [
    `轮次：第 ${candidate.turn} 轮运行中被中断。`,
    `原因：${reason}。`,
    candidate.kind === 'error' && candidate.detail ? `详情：${candidate.detail}` : '',
    '如何继续：回复任意内容会继续该会话，也可以跳转到会话处理。确认无需处理时忽略本条。',
  ].filter(Boolean).join('\n')
}

/** 告警条目去重键：同一会话同一轮只告警一次。 */
export function alertKeyOf(sessionId: string, turn: number): string {
  return `${sessionId}#${turn}`
}

/**
 * 冷读观测里 `interrupted` 可能是合成的：session-query 会给"末尾回合未闭合"的
 * 冷日志补一条 interrupted 关闭事件。别的进程里正在运行的会话（例如无人值守的
 * headless 任务）同样是冷日志，直接告警会误报。因此 prepared 观测的 interrupted
 * 要等最后活动静默足够久才判定为真中断；未满足条件时推迟（deferred），不推进扫描游标。
 */
export interface AlertSelection {
  /** 现在就该投递的候选。 */
  alerts: TurnAlertCandidate[]
  /** 有候选因静默时间不足被推迟，本轮不应推进扫描游标。 */
  deferred: boolean
}

export function selectAlertCandidates(
  candidates: readonly TurnAlertCandidate[],
  options: {
    /** 观测来源：live 表示会话在本进程存活，prepared 表示冷读。 */
    source: 'live' | 'prepared'
    now: number
    /** 回填时间窗（毫秒）。 */
    windowMs: number
    /** prepared 观测的 interrupted 需要静默多久才判定为真（毫秒）。 */
    interruptedGraceMs: number
  },
): AlertSelection {
  const alerts: TurnAlertCandidate[] = []
  let deferred = false
  for (const candidate of candidates) {
    if (candidate.time < options.now - options.windowMs) continue
    if (candidate.kind === 'interrupted' && options.source !== 'live') {
      if (options.now - candidate.time < options.interruptedGraceMs) {
        deferred = true
        continue
      }
    }
    alerts.push(candidate)
  }
  return { alerts, deferred }
}

/** 一条会话事件日志里的首条用户消息；没有用户消息时返回 undefined。 */
export function firstUserMessageEvent(events: readonly any[] | undefined): any | undefined {
  if (!Array.isArray(events)) return undefined
  return events.find((event) => event?.type === 'user/message')
}

/**
 * 一条用户消息是否来自程序化运行。
 *
 * Web 客户端发送的消息总带 `rpcId`；headless 从 stdin 读入的任务只有 `kind: "user"`。
 * 因此「来源是普通用户输入、但没有客户端标识」就是脚本或无人值守进程的一次性运行。
 */
export function isProgrammaticUserSource(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false
  const record = source as { kind?: unknown; rpcId?: unknown }
  if (record.kind !== 'user') return false
  return typeof record.rpcId !== 'string' || record.rpcId.length === 0
}

export class Hub {
  /** 归因缓存：title 变化时重算。 */
  private inferCache = new Map<string, { title: string; first?: string; projectId: string | null }>()

  constructor(
    private store: HubStore,
    private services: HubServices,
    /** 待扫描的项目根。每项本身算一个项目，含 paper.toml/.git 的子目录另算。 */
    private projectsRoots: readonly string[],
  ) {}

  /** 只读数据面（面板载荷组装用）。 */
  get data() {
    return this.store.data
  }

  /** 面板批量路径的写回标脏。 */
  touch(): void {
    this.store.touch()
  }

  /** rescan 用：失效会话列表缓存，下一次面板读取强制回源。 */
  invalidateCaches(): void {
    this.listCache = null
  }

  // ── 回收站与程序化会话 ──────────────────────────────────────────────────

  /** 程序化判定结果；undefined 表示尚未判定。 */
  programmaticVerdict(sessionId: string): boolean | undefined {
    const cached = this.store.data.programmatic?.[sessionId]
    return typeof cached === 'boolean' ? cached : undefined
  }

  /** 记录判定。首条用户消息不会变化，同一会话只写一次。 */
  recordProgrammaticVerdict(sessionId: string, programmatic: boolean): void {
    if (this.store.data.programmatic?.[sessionId] === programmatic) return
    if (!this.store.data.programmatic) this.store.data.programmatic = {}
    this.store.data.programmatic[sessionId] = programmatic
    this.store.touch()
  }

  /** 用户或 agent 显式绑定的会话优先，自动回收不动它们。 */
  hasExplicitBinding(sessionId: string): boolean {
    const binding = this.store.data.bindings[sessionId]
    return binding !== undefined && (binding.locked || binding.by !== 'auto')
  }

  /** 会话是否已在回收站。 */
  isTrashed(sessionId: string): boolean {
    return this.store.data.trashed?.[sessionId] !== undefined
  }

  /** 会话是否被人工恢复过；恢复视为长期豁免。 */
  isTrashExempt(sessionId: string): boolean {
    return this.store.data.trashExempt?.[sessionId] !== undefined
  }

  /** 把会话扫进回收站；已在回收站时返回 false。 */
  trashSession(sessionId: string): boolean {
    if (this.isTrashed(sessionId)) return false
    if (!this.store.data.trashed) this.store.data.trashed = {}
    this.store.data.trashed[sessionId] = Date.now()
    this.store.touch()
    return true
  }

  /** 恢复会话，并长期豁免自动回收。 */
  restoreSession(sessionId: string): void {
    if (this.store.data.trashed) delete this.store.data.trashed[sessionId]
    if (!this.store.data.trashExempt) this.store.data.trashExempt = {}
    this.store.data.trashExempt[sessionId] = Date.now()
    this.store.touch()
  }

  // ── 项目 ────────────────────────────────────────────────────────────────

  /** 扫描每个项目根：含 paper.toml 或 .git 的子目录登记为项目；根目录本身也算一个项目。 */
  discoverProjects(): void {
    const found = new Map<string, { name: string; aliases: string[] }>()
    const addDir = (dir: string, display: string) => {
      const previous = found.get(dir)
      found.set(dir, {
        name: display,
        aliases: uniq([...(previous?.aliases ?? []), ...deriveAliases(dir, display)]),
      })
    }
    for (const root of this.projectsRoots) {
      try {
        if (!existsSync(root)) continue
        const rootName = basename(root) || 'projects'
        addDir(rootName, rootName)
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue
          const dir = join(root, entry.name)
          const toml = join(dir, 'paper.toml')
          const isProject = existsSync(toml) || existsSync(join(dir, '.git'))
          if (!isProject) continue
          let display = entry.name
          try {
            if (existsSync(toml)) display = paperTomlName(readFileSync(toml, 'utf8')) ?? entry.name
          } catch { /* 读不到就用目录名 */ }
          addDir(entry.name, display)
        }
      } catch { /* 单个根扫描失败不影响其他根 */ }
    }

    let changed = false
    for (const [id, info] of found) {
      const existing = this.store.data.projects.find((p) => p.id === id)
      if (!existing) {
        this.store.data.projects.push({ id, name: info.name, aliases: info.aliases, source: 'discovered', createdAt: Date.now() })
        changed = true
      } else if (existing.source === 'discovered') {
        // 自动派生别名只增不删，保留用户后来加的
        const merged = uniq([...existing.aliases, ...info.aliases])
        if (merged.length !== existing.aliases.length) { existing.aliases = merged; changed = true }
        if (existing.name !== info.name && existing.name === existing.id) { existing.name = info.name; changed = true }
      }
    }
    if (changed) this.store.touch()
  }

  resolveProject(input: string): Project | undefined {
    const n = norm(input)
    if (!n) return undefined
    const projects = this.store.data.projects
    const exact = projects.find((p) => norm(p.id) === n || norm(p.name) === n || p.aliases.some((a) => norm(a) === n))
    if (exact) return exact
    // 包含匹配：别名是输入的子串，或输入是某别名的子串（≥3 字符）
    let best: { p: Project; score: number } | undefined
    for (const p of projects) {
      for (const a of [p.id, p.name, ...p.aliases]) {
        const na = norm(a)
        if (na.length < 3) continue
        if (n.includes(na) || na.includes(n)) {
          const score = na.length
          if (!best || score > best.score) best = { p, score }
        }
      }
    }
    return best?.p
  }

  addProject(name: string, aliases: string[] = []): Project {
    const id = name.trim().replace(/\s+/g, '-')
    const existing = this.store.data.projects.find((p) => p.id === id)
    if (existing) return existing
    const project: Project = { id, name, aliases: uniq([name, ...aliases]), source: 'manual', createdAt: Date.now() }
    this.store.data.projects.push(project)
    this.store.touch()
    return project
  }

  // ── 会话归因 ─────────────────────────────────────────────────────────────

  /** 显式绑定存在则用显式绑定，否则用推断缓存。返回 null 表示未分配。 */
  async bindFor(sessionId: string): Promise<Binding> {
    const explicit = this.store.data.bindings[sessionId]
    if (explicit && (explicit.locked || explicit.by !== 'auto')) return explicit
    const inferred = await this.inferSession(sessionId)
    if (inferred) {
      const binding: Binding = { projectId: inferred, locked: false, by: 'auto', updatedAt: Date.now() }
      if (!explicit || explicit.projectId !== inferred) {
        this.store.data.bindings[sessionId] = binding
        this.syncPendingItems(sessionId, inferred)
        this.store.touch()
      }
      return binding
    }
    return explicit ?? { projectId: null, locked: false, by: 'auto', updatedAt: Date.now() }
  }

  setBinding(sessionId: string, projectId: string | null, by: 'user' | 'agent'): Binding {
    // A user choosing “unassigned” is an explicit decision. Keep it locked so
    // the next panel scan does not immediately infer the previous project again.
    const binding: Binding = { projectId, locked: by === 'user', by, updatedAt: Date.now() }
    this.store.data.bindings[sessionId] = binding
    // Existing pending messages follow the session's explicit project choice.
    // This prevents a message created before auto-binding from staying orphaned.
    for (const item of this.store.data.items) {
      if (item.sessionId === sessionId && item.status === 'pending') item.projectId = projectId
    }
    this.store.touch()
    return binding
  }

  /** 标题缓存：readTitleSnapshots 全量约 126ms/会话，面板轮询必须走缓存。持久化到 store。 */
  private titleCache = new Map<string, { title: string; at: number }>()
  private titleRefreshRunning = false
  /** 会话列表缓存（sessionController.list 约 0.5-1.6s，轮询不重复拉）。 */
  private listCache: { at: number; items: any[] } | null = null
  /** 会话列表刷新的单飞句柄：并发的面板与定时器共享同一次拉取。 */
  private syncRunning: Promise<void> | null = null
  /** 子 agent → 父会话缓存。 */
  private parentCache = new Map<string, string | null>()

  /** 同步读缓存标题；没有返回 undefined。 */
  cachedTitle(sessionId: string): string | undefined {
    const hit = this.titleCache.get(sessionId)
    if (hit) return hit.title
    const persisted = this.store.data.titles?.[sessionId]
    if (persisted) {
      this.titleCache.set(sessionId, persisted)
      return persisted.title
    }
    return undefined
  }

  /**
   * 面板首页用的会话快照（纯内存，零 IO）。
   * 快照来自上一次后台刷新，持久化在 store 里，重启后第一帧也能立即渲染。
   */
  panelSessions(): SessionSnapshot[] {
    return this.store.data.sessions?.items ?? []
  }

  /** 是否已有会话快照；没有说明是首次安装，面板需要阻塞拉一次列表。 */
  hasSnapshot(): boolean {
    return (this.store.data.sessions?.items.length ?? 0) > 0
  }

  /**
   * 后台刷新会话列表快照：单飞 + 节流，绝不阻塞面板。
   * 同时填充 listSessionsCached 的缓存，供回填与程序化扫描共用。
   */
  async syncSessions(force = false): Promise<void> {
    if (this.syncRunning) return this.syncRunning
    const snapshotAt = this.store.data.sessions?.at ?? 0
    // 面板每 8 秒轮询一次；15 秒内不重复拉，足够新又不浪费。
    if (!force && Date.now() - snapshotAt < 15_000) return
    const task = (async () => {
      try {
        const listed = await this.services.sessionController.list({})
        const items = listed?.items ?? []
        this.listCache = { at: Date.now(), items }
        const next: SessionSnapshot[] = []
        for (const raw of items) {
          const id = String(raw?.sessionId ?? raw?.id ?? '')
          if (!id) continue
          // 只存面板会展示的会话：子代理、子会话、空白会话永不出现在首页。
          if (raw?.origin === 'subagent' || raw?.parentSessionId || raw?.blank) continue
          next.push({
            id,
            updatedAt: Number(raw?.updatedAt) || 0,
            running: Boolean(raw?.running),
            ...(raw?.origin ? { origin: String(raw.origin) } : {}),
          })
        }
        const previous = JSON.stringify(this.store.data.sessions?.items ?? [])
        this.store.data.sessions = { at: Date.now(), items: next }
        if (JSON.stringify(next) !== previous) this.store.touch()
      } catch {
        // 刷新失败保留上次快照；下一轮轮询再试。
      }
    })()
    this.syncRunning = task
    try {
      await task
    } finally {
      if (this.syncRunning === task) this.syncRunning = null
    }
  }

  /** 会话列表（30 秒缓存，单飞）：回填与程序化扫描用，面板首页不再走这里。 */
  async listSessionsCached(): Promise<any[]> {
    const cached = this.listCache
    if (cached && Date.now() - cached.at < 30_000) return cached.items
    // 内存里还没有列表（刚重载）时必须强制拉一次，不能只靠快照节流。
    await this.syncSessions(cached === null)
    return this.listCache?.items ?? []
  }

  /** 子 agent 会话的父会话（inspect 读 header，不激活 Agent；结果缓存）。 */
  async parentOf(sessionId: string): Promise<string | null> {
    if (this.parentCache.has(sessionId)) return this.parentCache.get(sessionId) ?? null
    let parent: string | null = null
    try {
      const inspection = await this.services.sessionController.inspect(sessionId)
      parent = inspection?.meta?.parentSession ? String(inspection.meta.parentSession) : null
    } catch { /* 读不到按无父处理 */ }
    this.parentCache.set(sessionId, parent)
    return parent
  }

  /** 后台分批刷新标题（stale-while-revalidate，绝不阻塞面板），并持久化。 */
  refreshTitles(sessionQuery: any, sessionIds: string[]): void {
    if (this.titleRefreshRunning) return
    const keep = new Set(sessionIds)
    const stale = sessionIds.filter((id) => {
      const c = this.titleCache.get(id) ?? this.store.data.titles?.[id]
      // 标题基本不变：10 分钟内不重复读，readTitleSnapshots 约 126ms/会话。
      return !c || Date.now() - c.at > 600_000
    })
    if (stale.length === 0) return
    this.titleRefreshRunning = true
    void (async () => {
      try {
        for (let i = 0; i < stale.length; i += 30) {
          const chunk = stale.slice(i, i + 30)
          try {
            const results = await sessionQuery.readTitleSnapshots(chunk)
            for (const r of results ?? []) {
              if (r?.status === 'fulfilled') {
                this.titleCache.set(String(r.sessionId), { title: r.value?.title?.title ?? '', at: Date.now() })
              }
            }
          } catch { /* 单批失败跳过 */ }
        }
        // 持久化：只保留当前可见会话的标题，控制存储体积
        const titles: Record<string, { title: string; at: number }> = {}
        for (const id of keep) {
          const c = this.titleCache.get(id)
          if (c) titles[id] = c
        }
        this.store.data.titles = titles
        this.store.touch()
      } finally {
        this.titleRefreshRunning = false
      }
    })()
  }

  /** 纯匹配：文本与各项目别名求分，最高分的唯一项目胜出，平局返回 null。 */
  matchText(text: string): string | null {
    const t = norm(text)
    let best: { id: string; score: number } | undefined
    let tied = false
    for (const p of this.store.data.projects) {
      let score = 0
      for (const a of [p.id, p.name, ...p.aliases]) {
        const na = norm(a)
        if (na.length < 3 || STOP_TOKENS.has(na)) continue
        if (t.includes(na)) score = Math.max(score, na.length)
      }
      if (score > 0) {
        if (!best || score > best.score) { best = { id: p.id, score }; tied = false }
        else if (score === best.score && best.id !== p.id) tied = true
      }
    }
    return best && !tied ? best.id : null
  }

  /** 读首条用户消息（深度扫描用，逐会话有 IO 成本）。 */
  async scanFirstUserMessage(sessionId: string): Promise<string> {
    try {
      const docs = await this.services.sessionQuery.filterEvents(sessionId, [{ kind: 'type', values: ['user/message'] }])
      const first = docs?.[0]?.text
      return typeof first === 'string' ? first.slice(0, 1500) : ''
    } catch {
      return ''
    }
  }

  /** 完整推断：标题 + 首条用户消息。结果按标题缓存，标题变化时重算。 */
  async inferSession(sessionId: string): Promise<string | null> {
    let title = ''
    try {
      const obs = await this.services.sessionQuery.readTitle(sessionId)
      title = obs?.title ?? ''
    } catch { /* 标题读不到 */ }
    const first = await this.scanFirstUserMessage(sessionId)
    const cached = this.inferCache.get(sessionId)
    if (cached && cached.title === title && cached.first === first) return cached.projectId
    const projectId = this.matchText(title + '\n' + first)
    this.inferCache.set(sessionId, { title, first, projectId })
    return projectId
  }

  /** 轻量推断：只用给定标题。面板批量路径用。 */
  inferFromTitle(sessionId: string, title: string): string | null {
    const cached = this.inferCache.get(sessionId)
    if (cached && cached.title === title && cached.first === undefined) return cached.projectId
    const projectId = this.matchText(title)
    if (projectId) this.inferCache.set(sessionId, { title, projectId })
    return projectId
  }

  /** 深度推断结果写缓存并持久化；重启后标题不变就直接复用，不再冷读日志。 */
  commitInferred(sessionId: string, title: string, projectId: string | null): void {
    this.inferCache.set(sessionId, { title, projectId })
    const inferred = (this.store.data.inferred ??= {})
    inferred[sessionId] = { title, projectId, at: Date.now() }
    this.store.touch()
  }

  /** 已持久化的推断结论；只有标题一致时才可信（标题变了要重扫）。 */
  cachedInference(sessionId: string, title: string): { known: boolean; projectId: string | null } {
    const hit = this.inferCache.get(sessionId)
    if (hit && hit.title === title) return { known: true, projectId: hit.projectId }
    const saved = this.store.data.inferred?.[sessionId]
    if (saved && saved.title === title) {
      this.inferCache.set(sessionId, { title, projectId: saved.projectId })
      return { known: true, projectId: saved.projectId }
    }
    return { known: false, projectId: null }
  }

  /** 丢弃不可见会话的持久化推断结论，控制存储体积。 */
  pruneInferred(keep: ReadonlySet<string>): void {
    const inferred = this.store.data.inferred
    if (!inferred) return
    let changed = false
    for (const id of Object.keys(inferred)) {
      if (!keep.has(id)) { delete inferred[id]; changed = true }
    }
    if (changed) this.store.touch()
  }

  /** 是否已有该标题下的推断结论（含"扫描过但不匹配"的 null 结论）。 */
  hasFreshInference(sessionId: string, title: string): boolean {
    const cached = this.inferCache.get(sessionId)
    return Boolean(cached) && cached!.title === title
  }

  /** 带分数的匹配：用于"建议"展示，平局也给出最优候选（是否采纳由人决定）。 */
  matchTextScored(text: string): { id: string; score: number } | null {
    const t = norm(text)
    let best: { id: string; score: number } | null = null
    for (const p of this.store.data.projects) {
      let score = 0
      for (const a of [p.id, p.name, ...p.aliases]) {
        const na = norm(a)
        if (na.length < 3 || SUGGEST_STOP_TOKENS.has(na)) continue
        if (t.includes(na)) score = Math.max(score, na.length)
      }
      if (score > 0 && (!best || score > best.score)) best = { id: p.id, score }
    }
    return best
  }

  /** 建议缓存：深度扫描后按标题+首条消息的文本打分，比纯标题准。 */
  private suggestCache = new Map<string, { title: string; suggested: string | null }>()

  /** 给未绑定会话的建议项目：缓存优先，否则按标题打分（零 IO）。 */
  suggestFor(sessionId: string, title: string): string | null {
    const cached = this.suggestCache.get(sessionId)
    if (cached && cached.title === title) return cached.suggested
    if (!title) return null
    const suggested = this.matchTextScored(title)?.id ?? null
    this.suggestCache.set(sessionId, { title, suggested })
    return suggested
  }

  /** 深度扫描后回填建议（文本含首条用户消息，采纳权仍在人）。 */
  commitSuggest(sessionId: string, title: string, suggested: string | null): void {
    this.suggestCache.set(sessionId, { title, suggested })
  }

  // ── 收件箱 ───────────────────────────────────────────────────────────────

  private async sessionTitle(sessionId: string): Promise<string> {
    try {
      const obs = await this.services.sessionQuery.readTitle(sessionId)
      return obs?.title ?? ''
    } catch {
      return ''
    }
  }

  async addItem(input: {
    sessionId: string
    type: HubItem['type']
    title: string
    body?: string
    priority?: 'normal' | 'urgent'
    source: HubItem['source']
    projectId?: string | null
    auq?: HubItem['auq']
    alert?: HubItem['alert']
  }): Promise<HubItem> {
    let projectId = input.projectId
    if (projectId === undefined) {
      projectId = (await this.bindFor(input.sessionId)).projectId
      // 子 agent 没有自己的归属时，归到父会话的项目
      if (projectId === null) {
        const parent = await this.parentOf(input.sessionId)
        if (parent) projectId = (await this.bindFor(parent)).projectId
      }
    }
    const item: HubItem = {
      id: randomUUID(),
      projectId,
      sessionId: input.sessionId,
      sessionTitle: await this.sessionTitle(input.sessionId),
      type: input.type,
      title: input.title.slice(0, 200),
      body: (input.body ?? '').slice(0, 4000),
      priority: input.priority === 'urgent' ? 'urgent' : 'normal',
      status: 'pending',
      source: input.source,
      createdAt: Date.now(),
      auq: input.auq,
      alert: input.alert,
      // AUQ 条目默认不可代答；会话投影确认 continued 后才置真。
      auqAnswerable: input.source === 'auq' ? false : undefined,
    }
    this.store.data.items.push(item)
    this.store.touch()
    return item
  }

  private auqInflight = new Map<string, Promise<string>>()

  /** 会话恢复运行的时刻（内存态）：用于抵消"告警写入前会话已开新一轮"的竞态。 */
  private resumeMarks = new Map<string, number>()

  /** AUQ 镜像：同一会话内 callId 只建一条。返回消息 id，重复时返回已有 id。 */
  async upsertAuqItem(sessionId: string, callId: string, questions: AuqQuestionView[]): Promise<string> {
    const existing = this.findAuqItem(sessionId, callId)
    if (existing) return existing.id
    const key = `${sessionId}\u0000${callId}`
    const inflight = this.auqInflight.get(key)
    if (inflight) return inflight
    const task = (async () => {
      const current = this.findAuqItem(sessionId, callId)
      if (current) return current.id
      const first = questions[0]
      const title = (first?.header || first?.question || '待回答问题').slice(0, 200)
      const body = questions
        .map((q, i) => {
          const opts = (q.options ?? []).map((o) => `  - ${o.label}${o.description ? `：${o.description}` : ''}`).join('\n')
          return `${questions.length > 1 ? `问题 ${i + 1}：` : ''}${q.question}${opts ? `\n${opts}` : ''}`
        })
        .join('\n\n')
        .slice(0, 4000)
      const item = await this.addItem({
        sessionId,
        type: 'question',
        title,
        body,
        source: 'auq',
        auq: { callId, questions },
      })
      return item.id
    })()
    this.auqInflight.set(key, task)
    try {
      return await task
    } finally {
      if (this.auqInflight.get(key) === task) this.auqInflight.delete(key)
    }
  }

  /** 幂等终态：只有 pending 能迁移。 */
  settleItem(id: string, status: 'answered' | 'dismissed', answerText?: string): HubItem | undefined {
    const item = this.store.data.items.find((it) => it.id === id)
    if (!item || item.status !== 'pending') return item
    item.status = status
    item.settledAt = Date.now()
    if (answerText !== undefined) item.answerText = answerText.slice(0, 4000)
    this.store.touch()
    return item
  }

  syncPendingItems(sessionId: string, projectId: string | null): void {
    let changed = false
    for (const item of this.store.data.items) {
      if (item.sessionId === sessionId && item.status === 'pending' && item.projectId !== projectId) {
        item.projectId = projectId
        changed = true
      }
    }
    if (changed) this.store.touch()
  }

  findAuqItem(sessionId: string, callId: string): HubItem | undefined {
    return this.store.data.items.find((it) => it.source === 'auq' && it.sessionId === sessionId && it.auq?.callId === callId)
  }

  /**
   * 刷新一个会话内 AUQ 条目能否由指挥中心代答。
   * 只有会话投影里处于 continued 的问题可以；前台阻塞提问的应答权在会话卡片上。
   */
  syncAuqAnswerable(sessionId: string, continuedCallIds: ReadonlySet<string>): void {
    let changed = false
    for (const item of this.store.data.items) {
      if (item.sessionId !== sessionId || item.source !== 'auq') continue
      const answerable = continuedCallIds.has(item.auq?.callId ?? '')
      if (item.auqAnswerable !== answerable) {
        item.auqAnswerable = answerable
        changed = true
      }
    }
    if (changed) this.store.touch()
  }

  /**
   * 按会话事件镜像 ask_user_question。
   * 与 user-questions 投影不同，这里不依赖 tool/call 是否属于 timed 工具，
   * 因此 legacy 阻塞式提问同样进入收件箱。
   */
  async mirrorAskUserQuestion(sessionId: string, event: any): Promise<void> {
    const type = event?.type
    if (type === 'tool/call') {
      if (event.data?.name !== 'ask_user_question') return
      const questions = questionsOfArguments(event.data.arguments)
      if (!questions) return
      await this.upsertAuqItem(sessionId, String(event.data.callId), questions)
      return
    }
    if (type === 'tool/ptc-dispatch') {
      if (event.data?.name !== 'ask_user_question' || event.data.isError) return
      if (!resultIsPending(event.data.content)) return
      const questions = questionsOfArguments(JSON.stringify(event.data.arguments))
      if (questions) await this.upsertAuqItem(sessionId, String(event.data.subCallId), questions)
      return
    }
    if (type === 'tool/result') {
      const callId = String(event.data?.message?.toolCallId ?? '')
      const item = callId ? this.findAuqItem(sessionId, callId) : undefined
      if (!item || item.status !== 'pending') return
      const content = event.data?.message?.content
      // 时间到但用户仍可回答：保持待处理
      if (resultIsPending(content)) return
      const answers = answersOfContent(content)
      if (answers && answers.length > 0) this.settleItem(item.id, 'answered', summarizeAnswers(answers) || '（已在会话内回答）')
      else this.settleItem(item.id, 'dismissed', '问题在会话侧关闭')
      return
    }
    if (type === 'user/message') {
      const source = event.data?.source
      if (source?.kind !== 'user-question-reply' || !source.callId) return
      const item = this.findAuqItem(sessionId, String(source.callId))
      if (!item || item.status !== 'pending') return
      const answers = answersOfContent(event.data?.content) ?? []
      this.settleItem(item.id, 'answered', summarizeAnswers(answers) || '（已在会话内回答）')
    }
  }

  // ── 中断告警 ─────────────────────────────────────────────────────────────

  /** 是否已有该会话该轮的告警条目（去重键丢失时的兜底）。 */
  private hasAlertItem(sessionId: string, turn: number): boolean {
    return this.store.data.items.some(
      (it) => it.type === 'alert' && it.sessionId === sessionId && it.alert?.turn === turn,
    )
  }

  /**
   * 写入中断告警条目。同一会话同一轮只建一条，跨实时/回填/重启都不重复。
   * 若会话在告警落库前已开新一轮，条目直接置为已回答，只保留历史。
   */
  async recordTurnAlerts(sessionId: string, candidates: readonly TurnAlertCandidate[]): Promise<HubItem[]> {
    const alertKeys = (this.store.data.alertKeys ??= {})
    const created: HubItem[] = []
    for (const candidate of candidates) {
      const key = alertKeyOf(sessionId, candidate.turn)
      if (alertKeys[key]) continue
      if (this.hasAlertItem(sessionId, candidate.turn)) {
        alertKeys[key] = 'existing'
        continue
      }
      // 先占位，避免并发实时事件与回填重复建条
      alertKeys[key] = 'pending'
      const alert: TurnAlertView = {
        turn: candidate.turn,
        kind: candidate.kind,
        ...(candidate.cause ? { cause: candidate.cause } : {}),
        ...(candidate.code ? { code: candidate.code } : {}),
        ...(candidate.detail ? { detail: candidate.detail.slice(0, 500) } : {}),
      }
      let item: HubItem
      try {
        item = await this.addItem({
          sessionId,
          type: 'alert',
          title: alertTitle(candidate),
          body: alertBody(candidate),
          source: 'system',
          alert,
        })
      } catch (error) {
        // 建条失败就撤掉占位，下一轮还能重试
        delete alertKeys[key]
        throw error
      }
      alertKeys[key] = item.id
      const resumedAt = this.resumeMarks.get(sessionId) ?? 0
      if (resumedAt > candidate.time) this.settleItem(item.id, 'answered', '会话已恢复运行')
      created.push(item)
    }
    this.store.touch()
    return created
  }

  /**
   * 会话开新一轮（或用户已在会话内继续）时收掉待处理告警。
   * 返回结算的条目数；同时记录恢复时刻供 recordTurnAlerts 判竞态。
   */
  settleAlertsForSession(sessionId: string, answerText = '会话已恢复运行'): number {
    this.resumeMarks.set(sessionId, Date.now())
    let settled = 0
    for (const item of this.store.data.items) {
      if (item.type === 'alert' && item.sessionId === sessionId && item.status === 'pending') {
        this.settleItem(item.id, 'answered', answerText)
        settled += 1
      }
    }
    return settled
  }

  /** 冷读回填是否需要扫描该会话：可见时间窗内且日志在上次扫描后更新过。 */
  shouldScanSession(sessionId: string, updatedAt: number, minUpdatedAt: number): boolean {
    if (!(updatedAt >= minUpdatedAt)) return false
    const scanned = this.store.data.alertScans?.[sessionId]
    return !(scanned && scanned.updatedAt >= updatedAt)
  }

  /** 记下扫描游标：同一 updatedAt 的会话不重复冷读。 */
  markSessionScanned(sessionId: string, updatedAt: number): void {
    const scans = (this.store.data.alertScans ??= {})
    scans[sessionId] = { at: Date.now(), updatedAt }
    this.store.touch()
  }

  /** 丢弃不可见会话的扫描游标，控制存储体积。 */
  pruneScanCursors(keep: ReadonlySet<string>): void {
    const scans = this.store.data.alertScans
    if (!scans) return
    let changed = false
    for (const id of Object.keys(scans)) {
      if (!keep.has(id)) {
        delete scans[id]
        changed = true
      }
    }
    if (changed) this.store.touch()
  }

  // ── AUQ 镜像游标 ─────────────────────────────────────────────────────────
  //
  // 会话日志没有更新时重复 observeSession 只是白读（每次 130-250ms），
  // 因此记录每个会话已同步到的 updatedAt，面板轮询只同步真正变化的会话。

  /** 该会话已同步到的日志版本；没有游标返回 undefined。 */
  auqCursor(sessionId: string): { at: number; updatedAt: number } | undefined {
    return this.store.data.auqScans?.[sessionId]
  }

  /** 记录 AUQ 镜像同步游标。 */
  markAuqSynced(sessionId: string, updatedAt: number): void {
    const scans = (this.store.data.auqScans ??= {})
    scans[sessionId] = { at: Date.now(), updatedAt }
    this.store.touch()
  }

  /** 丢弃不可见会话的 AUQ 游标，控制存储体积。 */
  pruneAuqCursors(keep: ReadonlySet<string>): void {
    const scans = this.store.data.auqScans
    if (!scans) return
    let changed = false
    for (const id of Object.keys(scans)) {
      if (!keep.has(id)) {
        delete scans[id]
        changed = true
      }
    }
    if (changed) this.store.touch()
  }

  moveItem(id: string, projectId: string | null): HubItem | undefined {
    const item = this.store.data.items.find((it) => it.id === id)
    if (!item) return undefined
    item.projectId = projectId
    this.store.touch()
    return item
  }

  /** 排序：pending 在前，urgent 优先，同级 FIFO；已处理按处理时间倒序。 */
  sortedItems(projectId?: string | null): HubItem[] {
    const items = this.store.data.items.filter((it) => projectId === undefined || it.projectId === projectId)
    const rank = (it: HubItem) => (it.status === 'pending' ? 0 : 1)
    return [...items].sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b)
      if (a.status === 'pending') {
        const pa = a.priority === 'urgent' ? 0 : 1
        const pb = b.priority === 'urgent' ? 0 : 1
        if (pa !== pb) return pa - pb
        return a.createdAt - b.createdAt
      }
      return (b.settledAt ?? 0) - (a.settledAt ?? 0)
    })
  }

  // ── 回复路由 ─────────────────────────────────────────────────────────────

  /** AUQ 结构化回答；问题已不在可答状态时返回 false。 */
  private async tryAnswerAuq(item: HubItem, answers: { id: string; selected: string[]; custom?: string }[]): Promise<boolean> {
    if (!item.auq) return false
    const res = await this.services.sessionController.resolveAgent(item.sessionId)
    if (!('agent' in res)) return false
    try {
      return this.services.userQuestions.answer(res.agent, item.auq.callId, { answers }) === true
    } catch {
      return false
    }
  }

  private async promptSession(sessionId: string, text: string): Promise<void> {
    await this.services.sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, new AbortController().signal)
  }

  /** 不可代答时的统一提示：前台阻塞提问只能在前台会话的卡片上回答。 */
  private assertAuqAnswerable(item: HubItem): void {
    if (item.auqAnswerable !== true) throw new Error(AUQ_SESSION_ONLY)
  }

  /**
   * 快捷回复：AUQ 条目只在可代答时走结构化应答。
   * 前台阻塞提问不投递 queue 消息，也不结算条目，避免出现"已答复但会话未解锁"。
   */
  async reply(itemId: string, text: string): Promise<{ via: 'answer' | 'prompt' }> {
    const item = this.store.data.items.find((it) => it.id === itemId)
    if (!item) throw new Error('消息不存在')
    if (item.status !== 'pending') throw new Error('消息已处理')
    if (item.source === 'auq') {
      this.assertAuqAnswerable(item)
      const questions = item.auq?.questions ?? []
      const answers = questions.map((q) => ({ id: q.id, selected: [] as string[], custom: text }))
      if (!(await this.tryAnswerAuq(item, answers))) throw new Error(AUQ_ANSWER_FAILED)
      this.settleItem(itemId, 'answered', text)
      return { via: 'answer' }
    }
    await this.promptSession(item.sessionId, text)
    this.settleItem(itemId, 'answered', text)
    return { via: 'prompt' }
  }

  /** AUQ 选项应答：仅在可代答时提交结构化答案；否则报错并保持待处理。 */
  async answerStructured(itemId: string, answers: { id: string; selected: string[]; custom?: string }[]): Promise<{ via: 'answer' | 'prompt' }> {
    const item = this.store.data.items.find((it) => it.id === itemId)
    if (!item) throw new Error('消息不存在')
    if (item.status !== 'pending') throw new Error('消息已处理')
    if (item.source !== 'auq' || !item.auq) throw new Error('该消息不支持选项应答')
    this.assertAuqAnswerable(item)
    if (!(await this.tryAnswerAuq(item, answers))) throw new Error(AUQ_ANSWER_FAILED)
    const summary = answers
      .map((a) => [...a.selected, ...(a.custom ? [a.custom] : [])].join('、'))
      .filter(Boolean)
      .join('；')
    this.settleItem(itemId, 'answered', summary)
    return { via: 'answer' }
  }

  /** 会话被处置/移除时，把它的 pending AUQ 镜像标为已关闭，避免永远悬挂。 */
  settleSessionOrphans(sessionId: string, reason: string): void {
    let changed = false
    for (const item of this.store.data.items) {
      if (item.sessionId === sessionId && item.status === 'pending' && item.source === 'auq') {
        item.status = 'dismissed'
        item.settledAt = Date.now()
        item.answerText = reason
        changed = true
      }
    }
    if (changed) this.store.touch()
  }
}
