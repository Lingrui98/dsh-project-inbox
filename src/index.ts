/**
 * @dsh-external/dsh-research-hub — host 侧：跨会话项目指挥中心。
 *
 * 职责：
 * 1. 项目注册表：扫描项目根（含 paper.toml/.git 的子目录）+ 手动添加。
 * 2. 会话归因：显式绑定（用户/agent 自报）> 内容推断（标题+首条消息匹配别名）。
 * 3. 消息通道：hub_register / hub_post 两个工具；ask_user_question 瀑布事件被动镜像。
 * 4. 回复路由：AUQ 走 userQuestions.answer 结构化应答，其余走 sessionController.prompt。
 * 5. 程序化会话（headless/脚本一次性运行）不参与指挥中心，自动进入回收站。
 * 6. 面板 API：POST /rhub/api/<method>（loopback Host 头围栏）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import {
  Hub,
  DEFAULT_ALERT_KINDS,
  firstUserMessageEvent,
  foldTurnAlerts,
  foldOpenAuqQuestions,
  isProgrammaticUserSource,
  selectAlertCandidates,
  type HubServices,
} from './host/core.js'
import { HubStore, type HubItem } from './host/store.js'

export const name = '@dsh-external/dsh-research-hub'
export const inject = ['tools', 'systemPrompt', 'webServer', 'sessionController', 'userQuestions', 'agents', 'sessionQuery', 'sessionProjections', 'timer', 'workspaceController']

export const Config = z.object({
  projectsRoot: z.string().default(process.env.DSH_RESEARCH_HUB_PROJECTS_ROOT || process.cwd()),
  /** 固定项目发现范围：非空时替代 projectsRoot，项目不再随宿主启动目录变化。 */
  projectsRoots: z.array(z.string()).default([]),
  storeFile: z.string().default(''),
  /** 需要告警的 turn/end 原因标记，见 DEFAULT_ALERT_KINDS。 */
  alertKinds: z.array(z.string()).default([...DEFAULT_ALERT_KINDS]),
  /** 冷读回填只回看最近多少小时的会话日志。 */
  alertBackfillHours: z.number().default(72),
  /**
   * 冷读观测的 interrupted 需要静默多少分钟才判定为真中断。
   * 别的进程里正在运行的会话在冷读里同样是"末尾回合未闭合"。
   */
  alertInterruptedGraceMinutes: z.number().default(30),
  /**
   * 首条用户消息不带客户端标识的会话自动进入回收站。
   * 这类会话是 headless 或脚本的一次性运行，工作由注册任务的主会话承接。
   */
  autoTrashProgrammatic: z.boolean().default(true),
})

interface ConfigShape {
  projectsRoot: string
  projectsRoots: string[]
  storeFile: string
  alertKinds: string[]
  alertBackfillHours: number
  alertInterruptedGraceMinutes: number
  autoTrashProgrammatic: boolean
}

type AppContext = Context & {
  tools: any
  systemPrompt: any
  webServer: any
  sessionController: any
  userQuestions: any
  agents: any
  sessionQuery: any
  sessionProjections: any
  workspaceController: any
  setInterval(fn: () => void, ms: number): unknown
}

// ── HTTP 辅助（对齐 dsh-sidebar-qa 的已验证模式）─────────────────────────────

class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message)
  }
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > 1 << 20) throw new ApiError('bad-request', '请求体过大')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError('bad-request', '请求体不是合法 JSON')
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** loopback Host 头围栏：只接受本机回环地址（防 DNS 重绑定/跨站调用）。 */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (!host) return false
  const hostname = host.replace(/:\d+$/, '').toLowerCase()
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

function requireString(payload: any, key: string): string {
  const value = payload?.[key]
  if (typeof value !== 'string' || value.trim() === '') throw new ApiError('bad-request', `缺少字段 ${key}`)
  return value
}

// ── 面板载荷 ────────────────────────────────────────────────────────────────

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

/** 实时归档集合：由 workspaceController.follow 长驻订阅维护（baseline + archived 增量都是全量帧）。 */
const archivedLive = new Set<string>()
let auqSyncRunning = false
let visibleSessionIdsCache: { at: number; ids: Set<string> } | null = null

/**
 * 重建 AUQ 镜像：只同步可能变化的会话。
 *
 * 旧实现每 30 秒对所有可见会话 observeSession（每次 130-250ms），空闲会话也被
 * 反复全量重读。现在按会话日志的 updatedAt 增量：日志没更新就跳过；运行中的
 * 会话每 60 秒兜底一次；仍有待答问题的会话每 120 秒兜底一次。
 */
async function reconcileAuqMirrors(
  hub: Hub,
  ctx: AppContext,
  sessions: { id: string; running: boolean; updatedAt: number }[],
): Promise<void> {
  if (auqSyncRunning || sessions.length === 0) return
  const now = Date.now()
  const pendingAuq = new Set(
    hub.data.items.filter((it) => it.status === 'pending' && it.source === 'auq').map((it) => it.sessionId),
  )
  const targets = sessions.filter((view) => {
    const cursor = hub.auqCursor(view.id)
    if (!cursor || view.updatedAt > cursor.updatedAt) return true
    if (view.running && now - cursor.at > 60_000) return true
    return pendingAuq.has(view.id) && now - cursor.at > 120_000
  })
  if (targets.length === 0) return
  auqSyncRunning = true
  try {
    for (let i = 0; i < targets.length; i += 4) {
      await Promise.all(targets.slice(i, i + 4).map(async (view) => {
        const sessionId = view.id
        let ok = false
        try {
          const observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'all' })
          try {
            const projected = observation.projections?.values?.userQuestions
            const active = Array.isArray(projected?.active) ? projected.active : []
            const continuedCallIds = new Set<string>()
            for (const question of active) {
              if (question.state === 'continued') continuedCallIds.add(String(question.callId))
              const questions = (question.questions ?? []).map((q: any) => ({
                id: String(q.id), question: String(q.question ?? ''),
                header: q.header ? String(q.header) : undefined,
                options: Array.isArray(q.options) ? q.options.map((o: any) => ({ label: String(o.label ?? ''), description: o.description ? String(o.description) : undefined })) : undefined,
                multiSelect: Boolean(q.multiSelect),
              }))
              if (questions.length > 0) await hub.upsertAuqItem(sessionId, String(question.callId), questions)
            }
            // 只有 continued 问题能由指挥中心代答；前台阻塞提问只读。
            hub.syncAuqAnswerable(sessionId, continuedCallIds)
            const settled = Array.isArray(projected?.settled) ? projected.settled : []
            for (const question of settled) {
              const item = hub.findAuqItem(sessionId, String(question.callId))
              if (item?.status === 'pending') {
                const summary = (question.answers ?? []).map((a: any) => [...(a.selected ?? []), ...(a.custom ? [a.custom] : [])].join('、')).filter(Boolean).join('；')
                hub.settleItem(item.id, 'answered', summary || '（已在会话内回答）')
              }
            }
            // 投影只跟踪 timed 工具；legacy 阻塞式提问改由事件折叠补齐。
            // 折叠要读完整事件，因此只对可能正在等回答的会话执行。
            const hasPending = hub.data.items.some(
              (it) => it.sessionId === sessionId && it.status === 'pending' && it.source === 'auq',
            )
            if (view.running || (!hasPending && now - view.updatedAt <= 15 * 60_000)) {
              for (const { callId, questions } of foldOpenAuqQuestions(observation.events ?? [])) {
                await hub.upsertAuqItem(sessionId, callId, questions)
              }
            }
            ok = true
          } finally {
            const release = (observation as any)[Symbol.dispose] ?? (observation as any).dispose
            release?.call(observation)
          }
        } catch {
          // Cold sessions can disappear during a concurrent archive or cleanup.
        } finally {
          // 只有完整成功才推进游标：中途失败保持旧游标，下一次轮询重试。
          if (ok) hub.markAuqSynced(sessionId, view.updatedAt)
        }
      }))
    }
  } finally {
    auqSyncRunning = false
  }
  hub.pruneAuqCursors(new Set(sessions.map((view) => view.id)))
}

// ── 会话中断告警：冷读回填 ───────────────────────────────────────────────────
//
// 实时 turn/end 事件覆盖进程存活期间的失败；会话进程崩溃、宿主重启、插件重载
// 期间发生的中断只在日志冷读时可见（session-query 会补记 interrupted 关闭事件），
// 因此启动后与面板轮询时按会话 updatedAt 增量回填。

/** 回填节流状态（模块级：热重载后重置一次，靠 alertScans 游标兜住重复扫描）。 */
interface AlertBackfillState {
  running: boolean
  lastAt: number
}

interface NormalizedSession {
  id: string
  updatedAt: number
  running: boolean
  origin?: string
  parentSessionId?: string
  blank?: boolean
}

/** 归一会话列表项：sessionController.list 用 sessionId，面板用 id。 */
function normalizeSession(raw: any): NormalizedSession | null {
  const id = String(raw?.sessionId ?? raw?.id ?? '')
  if (!id) return null
  return {
    id,
    updatedAt: Number(raw?.updatedAt) || 0,
    running: Boolean(raw?.running),
    origin: raw?.origin ? String(raw.origin) : undefined,
    parentSessionId: raw?.parentSessionId ? String(raw.parentSessionId) : undefined,
    blank: Boolean(raw?.blank),
  }
}

/** 告警范围：排除子代理、子会话、空白、回收站、归档会话。 */
function alertEligible(session: NormalizedSession, trashed: ReadonlySet<string>): boolean {
  if (session.origin === 'subagent' || session.parentSessionId) return false
  if (session.blank) return false
  return !trashed.has(session.id) && !archivedLive.has(session.id)
}

/** 冷读一个会话的日志，把窗口内的中断补进收件箱。 */
async function scanSessionAlerts(
  hub: Hub,
  ctx: AppContext,
  config: ConfigShape,
  sessionId: string,
  updatedAt: number,
): Promise<void> {
  const now = Date.now()
  const windowMs = Math.max(1, config.alertBackfillHours || 72) * 3600_000
  if (!hub.shouldScanSession(sessionId, updatedAt, now - windowMs)) return
  let observation: any
  try {
    observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
    const selection = selectAlertCandidates(foldTurnAlerts(observation?.events ?? [], config.alertKinds), {
      // live 观测的 interrupted 是持久化的补记事件（真中断）；冷读可能是合成事件
      source: observation?.source === 'live' ? 'live' : 'prepared',
      now,
      windowMs,
      interruptedGraceMs: Math.max(1, config.alertInterruptedGraceMinutes || 30) * 60_000,
    })
    if (selection.alerts.length > 0) await hub.recordTurnAlerts(sessionId, selection.alerts)
    // 有候选被推迟时不推进游标：等它静默够久，下一轮回填再判定
    if (!selection.deferred) hub.markSessionScanned(sessionId, updatedAt)
  } catch {
    /* 冷会话可能在并发归档或清理中消失；不推进游标，稍后重试 */
  } finally {
    try {
      const release = observation?.[Symbol.dispose] ?? observation?.dispose
      release?.call(observation)
    } catch { /* 释放失败不影响结果 */ }
  }
}

/** 增量回填：只扫描窗口内、上次扫描后更新的会话；3 路并发，面板构建与启动时触发。 */
async function backfillTurnAlerts(
  hub: Hub,
  ctx: AppContext,
  config: ConfigShape,
  state: AlertBackfillState,
  sessions: readonly any[],
  force: boolean,
): Promise<void> {
  if (state.running) return
  const now = Date.now()
  if (!force && now - state.lastAt < 5 * 60_000) return
  state.running = true
  state.lastAt = now
  try {
    const trashed = new Set(Object.keys(hub.data.trashed ?? {}))
    const windowMs = Math.max(1, config.alertBackfillHours || 72) * 3600_000
    const eligible = sessions
      .map(normalizeSession)
      .filter((session): session is NormalizedSession => Boolean(session) && Boolean(session && alertEligible(session, trashed)))
      .filter((session) => session.updatedAt >= now - windowMs)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 120)
    let cursor = 0
    const worker = async () => {
      while (cursor < eligible.length) {
        const session = eligible[cursor]
        cursor += 1
        await scanSessionAlerts(hub, ctx, config, session.id, session.updatedAt)
      }
    }
    const width = Math.min(3, eligible.length)
    if (width > 0) await Promise.all(Array.from({ length: width }, worker))
    hub.pruneScanCursors(new Set(eligible.map((session) => session.id)))
  } catch (error) {
    ctx.logger?.warn?.('[research-hub] 中断告警回填失败', error)
  } finally {
    state.running = false
  }
}

/** 程序化会话自动回收的节流状态。 */
interface ProgrammaticSweepState {
  running: boolean
  lastAt: number
}

/**
 * 程序化会话自动回收。
 *
 * headless 或脚本从 stdin 发起的一次性会话没有客户端标识，工作由注册任务的主会话承接，
 * 因此不计入指挥中心。判定只看首条用户消息的来源，判定一次后永久缓存。
 * 用户或 agent 显式绑定过项目的会话保留；人工从回收站恢复的会话长期豁免。
 */
async function sweepProgrammaticSessions(
  hub: Hub,
  ctx: AppContext,
  config: ConfigShape,
  state: ProgrammaticSweepState,
): Promise<void> {
  if (config.autoTrashProgrammatic === false || state.running) return
  const now = Date.now()
  if (now - state.lastAt < 30_000) return
  state.lastAt = now
  state.running = true
  try {
    const candidates = (await hub.listSessionsCached())
      .map(normalizeSession)
      .filter((session): session is NormalizedSession => Boolean(session))
      .filter((session) => session.origin !== 'subagent' && !session.parentSessionId && !session.blank)
      .filter((session) => !archivedLive.has(session.id))
      .filter((session) => !hub.isTrashed(session.id) && !hub.isTrashExempt(session.id))
      .filter((session) => !hub.hasExplicitBinding(session.id))
      .filter((session) => hub.programmaticVerdict(session.id) === undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 12)
    let cursor = 0
    const worker = async () => {
      while (cursor < candidates.length) {
        const session = candidates[cursor]
        cursor += 1
        try {
          const inspection = await ctx.sessionController.inspect(session.id)
          const first = firstUserMessageEvent(inspection?.events)
          // 首条用户消息还没落盘（新建会话）：下一轮再判
          if (first === undefined) continue
          const programmatic = isProgrammaticUserSource(first?.data?.source)
          hub.recordProgrammaticVerdict(session.id, programmatic)
          if (!programmatic || hub.hasExplicitBinding(session.id)) continue
          if (hub.trashSession(session.id)) {
            ctx.logger?.info?.(`[research-hub] 程序化会话已自动回收：${session.id}`)
          }
        } catch {
          /* 冷会话可能在并发归档或清理中消失：不写判定，下一轮重试 */
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, candidates.length) }, worker))
  } catch (error) {
    ctx.logger?.warn?.('[research-hub] 程序化会话自动回收失败', error)
  } finally {
    state.running = false
  }
}

/**
 * 后台补全深度归因：读首条用户消息，写持久化结论。
 * 单会话实测 1.1-1.7s，因此只并发 4 路，且绝不阻塞面板首帧。
 */
async function enrichSessions(hub: Hub, queue: SessionView[]): Promise<void> {
  if (queue.length === 0) return
  const pending = [...queue]
  const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
    for (let s = pending.shift(); s; s = pending.shift()) {
      try {
        const first = await hub.scanFirstUserMessage(s.id)
        const fullText = `${s.title}\n${first}`
        const projectId = hub.matchText(fullText)
        hub.commitInferred(s.id, s.title, projectId)
        hub.commitSuggest(s.id, s.title, hub.matchTextScored(fullText)?.id ?? null)
        if (!projectId) continue
        const current = hub.data.bindings[s.id]
        if (current && (current.locked || current.by !== 'auto')) continue
        hub.data.bindings[s.id] = { projectId, locked: false, by: 'auto', updatedAt: Date.now() }
        hub.syncPendingItems(s.id, projectId)
        hub.touch()
      } catch {
        // 冷会话可能在并发归档中消失；下一轮再处理。
      }
    }
  })
  await Promise.all(workers)
  hub.pruneInferred(new Set(hub.panelSessions().map((s) => s.id)))
}

/**
 * 组装面板载荷：纯内存计算，零 IO。
 *
 * 会话列表读持久化快照；标题、归因、建议全部读缓存。深度扫描、AUQ 镜像、
 * 中断回填与会话列表刷新在返回后后台执行，下一次轮询自然收敛。
 */
function buildPanel(hub: Hub, ctx: AppContext, config: ConfigShape, alertState: AlertBackfillState): unknown {
  // 项目发现走 60s 定时与 rescan，不在面板热路径上
  // 子 agent 会话不纳入（origin === 'subagent'）；其投递经 parentOf 归到父会话项目
  // 已归档会话不进入任何收件箱视图（会话列表与消息都不显示）
  // 空白会话（创建后从未发言）同样排除：它没有内容可归因，打开它只会显示新建页
  // 回收站会话同理隐藏（数据保留，恢复后回来）
  const archived = archivedLive
  const trashed = new Set(Object.keys(hub.data.trashed ?? {}))
  const sessions: SessionView[] = hub.panelSessions()
    .filter((s) => s.origin !== 'subagent' && !s.parentSessionId && !archived.has(s.id) && !s.blank && !trashed.has(s.id))
    .map((s) => ({
      id: s.id,
      title: '',
      running: s.running,
      updatedAt: s.updatedAt,
      projectId: null,
      bindBy: 'auto',
      bindLocked: false,
      suggested: null,
    }))
  const sessionIds = sessions.map((s) => s.id)

  // 标题读缓存；空标题由后台分批补齐，下一次轮询拿到。
  for (const s of sessions) s.title = hub.cachedTitle(s.id) ?? ''
  hub.refreshTitles(ctx.sessionQuery, sessionIds)

  // 归因：显式绑定 > 标题匹配 > 持久化的深度推断结论，全部零 IO。
  // 三者都没有结论的会话进后台深度扫描。
  const deepScan: SessionView[] = []
  const deepCutoff = Date.now() - 3 * 24 * 3600 * 1000
  let bindingsChanged = false
  for (const s of sessions) {
    const explicit = hub.data.bindings[s.id]
    if (explicit && (explicit.locked || explicit.by !== 'auto')) {
      s.projectId = explicit.projectId
      s.bindBy = explicit.by
      s.bindLocked = explicit.locked
      continue
    }
    const byTitle = hub.inferFromTitle(s.id, s.title)
    if (byTitle) {
      s.projectId = byTitle
      if (!explicit || explicit.projectId !== byTitle) {
        hub.data.bindings[s.id] = { projectId: byTitle, locked: false, by: 'auto', updatedAt: Date.now() }
        bindingsChanged = true
      }
      continue
    }
    const inferred = hub.cachedInference(s.id, s.title)
    if (inferred.known) {
      if (inferred.projectId) {
        s.projectId = inferred.projectId
        if (!explicit || explicit.projectId !== inferred.projectId) {
          hub.data.bindings[s.id] = { projectId: inferred.projectId, locked: false, by: 'auto', updatedAt: Date.now() }
          bindingsChanged = true
        }
      } else if (explicit?.projectId) {
        s.projectId = explicit.projectId
      }
      continue
    }
    if (explicit?.projectId) {
      s.projectId = explicit.projectId
      continue
    }
    if (s.updatedAt >= deepCutoff) deepScan.push(s)
  }
  if (bindingsChanged) hub.touch()

  // 未绑定会话的"建议项目"：只读标题的最佳候选（平局也给，采纳权在人）
  for (const s of sessions) {
    if (s.projectId === null) s.suggested = hub.suggestFor(s.id, s.title)
  }

  const visibleSessionIds = new Set(sessionIds)
  visibleSessionIdsCache = { at: Date.now(), ids: visibleSessionIds }

  // 后台任务：不阻塞首帧；下一次轮询（8 秒）收敛。
  void hub.syncSessions()
  void enrichSessions(hub, deepScan)
  void reconcileAuqMirrors(hub, ctx, sessions.map((s) => ({ id: s.id, running: s.running, updatedAt: s.updatedAt })))
  // 中断告警回填：5 分钟节流，只扫窗口内更新过的会话
  void backfillTurnAlerts(hub, ctx, config, alertState, sessions, false)

  const runningById = new Map(sessions.map((s) => [s.id, s.running]))
  const titleById = new Map(sessions.map((s) => [s.id, s.title]))
  const enrich = (it: HubItem) => ({
    ...it,
    sessionTitle: titleById.get(it.sessionId) || it.sessionTitle,
    sessionRunning: runningById.get(it.sessionId) ?? false,
    sessionVisible: runningById.has(it.sessionId),
    // 面板用它决定是否显示应答控件：false 表示只能去会话内回答。
    ...(it.source === 'auq' ? { answerable: it.auqAnswerable === true } : {}),
  })

  // 已归档/回收站会话的消息同样不进入任何收件箱视图（数据保留，恢复后回来）
  // 子代理产生的消息（无前缀 id 的会话）同样不进视图
  const items = hub.sortedItems().filter((it) => visibleSessionIds.has(it.sessionId) && !archived.has(it.sessionId) && !trashed.has(it.sessionId))
  const countsOf = (projectId: string | null) => {
    const scoped = items.filter((it) => it.projectId === projectId && it.status === 'pending')
    return {
      questions: scoped.filter((it) => it.type === 'question').length,
      deliverables: scoped.filter((it) => it.type === 'deliverable').length,
      alerts: scoped.filter((it) => it.type === 'alert').length,
      urgent: scoped.filter((it) => it.priority === 'urgent').length,
    }
  }

  const projects = hub.data.projects.map((p) => ({
    id: p.id,
    name: p.name,
    aliases: p.aliases,
    source: p.source,
    counts: countsOf(p.id),
    sessions: sessions.filter((s) => s.projectId === p.id),
  }))
  const pending = items.filter((it) => it.status === 'pending').length

  const trashedSessions = Object.entries(hub.data.trashed ?? {}).map(([id, at]) => ({
    id,
    title: hub.cachedTitle(id) ?? '',
    at,
  }))

  return {
    now: Date.now(),
    pending,
    projects,
    trashedSessions,
    unassignedSessions: sessions.filter((s) => s.projectId === null),
    unassignedCounts: countsOf(null),
    // 待处理项必须完整返回，只有历史记录限制数量，避免计数与可处理列表不一致。
    items: [...items.filter((it) => it.status === 'pending'), ...items.filter((it) => it.status !== 'pending').slice(0, 300)].map(enrich),
  }
}

/** 调用方是否子代理：根会话 id 带 session- 前缀且在 agents.roots() 里；子代理会话走 subagent routing，不在此列。 */
function isSubagentCaller(ctx: AppContext, sessionId: string): boolean {
  if (!sessionId.startsWith('session-')) return true
  try {
    const roots = ctx.agents.roots() as any[]
    return !roots.some((a) => String(a?.id) === sessionId)
  } catch {
    return false
  }
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

/** 跳转现场快照的环形缓冲（不持久化）。 */
const jumpReports: { at: number; payload: unknown }[] = []

export function apply(ctx: AppContext, config: ConfigShape): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profileDir = process.env.DSH_PROFILE_DIR || join(dshHome, 'profiles', 'web')
  const storeFile = config.storeFile || join(profileDir, 'research-hub.json')
  const store = new HubStore(storeFile)
  const services: HubServices = {
    sessionController: ctx.sessionController,
    sessionQuery: ctx.sessionQuery,
    userQuestions: ctx.userQuestions,
    agents: ctx.agents,
  }
  const hubRoots = config.projectsRoots?.length > 0 ? config.projectsRoots : [config.projectsRoot]
  const hub = new Hub(store, services, hubRoots)
  // 清理陈旧绑定：无前缀 id 属于子代理会话（subagent routing），不应占位
  let staleBindings = 0
  for (const key of Object.keys(store.data.bindings)) {
    if (!key.startsWith('session-')) {
      delete store.data.bindings[key]
      staleBindings += 1
    }
  }
  if (staleBindings > 0) store.touch()
  hub.discoverProjects()
  // 启动即在后台拉一次会话列表并落盘快照：面板首帧不必再等 list。
  void hub.syncSessions(true)

  // 归档集合的长驻订阅：baseline 与 archived 增量帧都是全量集合，直接替换
  ctx.effect(() => {
    const ac = new AbortController()
    void (async () => {
      try {
        for await (const frame of ctx.workspaceController.follow(ac.signal) as AsyncIterable<any>) {
          if (frame?.type === 'baseline') {
            archivedLive.clear()
            for (const id of frame.value?.archivedSessionIds ?? []) archivedLive.add(String(id))
          } else if (frame?.type === 'archived') {
            archivedLive.clear()
            for (const id of frame.archivedSessionIds ?? []) archivedLive.add(String(id))
          }
        }
      } catch { /* 流断开则保持现状，下轮面板仍可读旧集合 */ }
    })()
    return () => ac.abort()
  }, 'research-hub: workspace archived follow')

  // 周期性项目发现（新子项目自动出现）
  ctx.setInterval(() => hub.discoverProjects(), 60_000)

  // 中断告警回填的节流状态与启动回填：宿主重启/崩溃后，中断只在日志冷读里可见
  const alertState: AlertBackfillState = { running: false, lastAt: 0 }
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          await backfillTurnAlerts(hub, ctx, config, alertState, await hub.listSessionsCached(), true)
        } catch (error) {
          ctx.logger?.warn?.('[research-hub] 启动中断回填失败', error)
        }
      })()
    }, 8_000)
    return () => clearTimeout(timer)
  }, 'research-hub: startup interruption backfill')

  // 周期回填：没人打开面板时也要能补报被推迟的中断（推迟的扫描不推进游标）
  ctx.setInterval(() => {
    void (async () => {
      try {
        await backfillTurnAlerts(hub, ctx, config, alertState, await hub.listSessionsCached(), false)
      } catch (error) {
        ctx.logger?.warn?.('[research-hub] 周期中断回填失败', error)
      }
    })()
  }, 5 * 60_000)

  // 程序化会话自动回收：启动后补扫一次，之后每分钟增量扫描（判定结果持久缓存）
  const sweepState: ProgrammaticSweepState = { running: false, lastAt: 0 }
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void sweepProgrammaticSessions(hub, ctx, config, sweepState)
    }, 12_000)
    return () => clearTimeout(timer)
  }, 'research-hub: startup programmatic session sweep')
  ctx.setInterval(() => {
    void sweepProgrammaticSessions(hub, ctx, config, sweepState)
  }, 60_000)

  // 实时中断告警：turn/end 写入告警条目，turn/start 收掉该会话待处理告警
  ctx.effect(() => {
    const dispose = (ctx as any).on('session/event', async (session: any, event: any) => {
      const sessionId = String(session?.id ?? '')
      if (!sessionId) return
      const header = session?.header ?? {}
      // 子代理与子会话的中断由父会话承接，不进指挥中心
      if (header.origin === 'subagent' || header.parentSession) return
      try {
        if (event?.type === 'turn/start') {
          hub.settleAlertsForSession(sessionId)
          return
        }
        if (event?.type !== 'turn/end') return
        const candidates = foldTurnAlerts([event], config.alertKinds)
        if (candidates.length > 0) await hub.recordTurnAlerts(sessionId, candidates)
      } catch (error) {
        ctx.logger?.warn?.('[research-hub] 中断告警写入失败', sessionId, error)
      }
    }, { global: true })
    return typeof dispose === 'function' ? dispose : undefined
  }, 'research-hub: turn interruption alerts')

  const autoBinding = new Set<string>()
  ctx.effect(() => {
    const dispose = (ctx as any).on('session/event', async (session: any, event: any) => {
      if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') return
      if (session?.header?.origin === 'subagent') return
      const sessionId = String(session?.id ?? '')
      if (!sessionId || isSubagentCaller(ctx, sessionId) || autoBinding.has(sessionId)) return
      const existing = store.data.bindings[sessionId]
      if (existing && (existing.locked || existing.by !== 'auto')) return
      autoBinding.add(sessionId)
      try {
        const inferred = await hub.inferSession(sessionId)
        if (!inferred) return
        const project = store.data.projects.find((p) => p.id === inferred)
        if (!project) return
        const current = store.data.bindings[sessionId]
        if (current && (current.locked || current.by !== 'auto')) return
        store.data.bindings[sessionId] = { projectId: project.id, locked: false, by: 'auto', updatedAt: Date.now() }
        hub.syncPendingItems(sessionId, project.id)
        store.touch()
      } catch (error) {
        ctx.logger?.warn?.('[research-hub] 自动归属失败', sessionId, error)
      } finally {
        autoBinding.delete(sessionId)
      }
    })
    return typeof dispose === 'function' ? dispose : undefined
  }, 'research-hub: auto-bind main sessions')

  // ask_user_question 的实时镜像走会话事件，不依赖 user-questions 瀑布的 wait 字段。
  // legacy 阻塞式提问的瀑布请求不带 callId，只有会话日志能提供 callId 与问题批。
  ctx.effect(() => {
    const dispose = (ctx as any).on('session/event', async (session: any, event: any) => {
      if (!event) return
      if (session?.header?.origin === 'subagent') return
      const sessionId = String(session?.id ?? '')
      if (!sessionId) return
      try {
        await hub.mirrorAskUserQuestion(sessionId, event)
      } catch (error) {
        ctx.logger?.warn?.('[research-hub] 提问镜像失败', sessionId, error)
      }
    }, { global: true })
    return typeof dispose === 'function' ? dispose : undefined
  }, 'research-hub: mirror ask_user_question events')

  // ── Agent 工具 ──────────────────────────────────────────────────────────

  ctx.effect(() => ctx.tools.register({
    name: 'hub_register',
    description:
      '仅在自动归属错误或需要手动指定项目时调用。' +
      'project 传项目 id、名称或别名；传 "auto" 可重新按会话内容推断。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目 id / 名称 / 别名，或 "auto"' },
        note: { type: 'string', description: '可选备注：本会话在该项目下的具体任务' },
      },
      required: ['project'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: any, exec: any) {
      const sessionId = exec?.agent?.id ? String(exec.agent.id) : undefined
      if (!sessionId) return { ok: false, error: '无法确定调用方会话' }
      if (isSubagentCaller(ctx, sessionId)) {
        return { ok: false, error: '子代理会话不在指挥中心范围内，无需注册；结果请直接汇报给父会话' }
      }
      const input = String(args?.project ?? '').trim()
      let project = input.toLowerCase() === 'auto' ? undefined : hub.resolveProject(input)
      let by: 'agent' | 'auto' = 'agent'
      if (!project) {
        const inferred = await hub.inferSession(sessionId)
        if (inferred) {
          project = store.data.projects.find((p) => p.id === inferred)
          by = 'auto'
        }
      }
      if (!project) {
        return { ok: false, error: '未匹配到项目，请从已知项目中选择', projects: store.data.projects.map((p) => p.id) }
      }
      if (by === 'agent') hub.setBinding(sessionId, project.id, 'agent')
      else store.data.bindings[sessionId] = { projectId: project.id, locked: false, by: 'auto', updatedAt: Date.now() }
      store.touch()
      return {
        ok: true,
        projectId: project.id,
        projectName: project.name,
        attributedBy: by,
        note: args?.note ? String(args.note).slice(0, 200) : undefined,
      }
    },
  } as any), 'research-hub: hub_register')

  ctx.effect(() => ctx.tools.register({
    name: 'hub_post',
    description:
      '向跨会话指挥中心投递一条消息，按项目归入收件箱。' +
      'type="question"：需要人类决策或回答、但不阻塞你继续工作的问题（紧急结构化问题请直接用 ask_user_question，会被自动镜像，不要重复投递）；' +
      'type="deliverable"：已形成且可复用的结论、报告或产物；普通进度不投递。' +
      '人类的回复会以普通用户消息回到本会话。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['question', 'deliverable'], description: '消息类型' },
        title: { type: 'string', description: '一句话标题' },
        body: { type: 'string', description: '正文：背景、选项、结论、路径等' },
        priority: { type: 'string', enum: ['normal', 'urgent'], description: 'urgent 会在收件箱置顶' },
        project: { type: 'string', description: '可选：覆盖项目归属（默认用本会话的绑定）' },
      },
      required: ['type', 'title'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: any, exec: any) {
      const sessionId = exec?.agent?.id ? String(exec.agent.id) : undefined
      if (!sessionId) return { ok: false, error: '无法确定调用方会话' }
      if (isSubagentCaller(ctx, sessionId)) {
        return { ok: false, error: '子代理会话不在指挥中心范围内，产出请直接汇报给父会话（父会话会自行决定是否交付到指挥中心）' }
      }
      const type = args?.type === 'deliverable' ? 'deliverable' : args?.type === 'question' ? 'question' : undefined
      if (!type) return { ok: false, error: 'type 必须是 question 或 deliverable' }
      const title = String(args?.title ?? '').trim()
      if (!title) return { ok: false, error: 'title 不能为空' }
      let projectId: string | null | undefined
      if (typeof args?.project === 'string' && args.project.trim() !== '') {
        const p = hub.resolveProject(args.project)
        if (!p) return { ok: false, error: '未匹配到项目', projects: store.data.projects.map((pp) => pp.id) }
        projectId = p.id
      }
      const item = await hub.addItem({
        sessionId,
        type,
        title,
        body: typeof args?.body === 'string' ? args.body : '',
        priority: args?.priority === 'urgent' ? 'urgent' : 'normal',
        source: 'tool',
        projectId,
      })
      return { ok: true, itemId: item.id, projectId: item.projectId }
    },
  } as any), 'research-hub: hub_post')

  // ── 提示词注入 ───────────────────────────────────────────────────────────

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'research-hub',
    order: 950,
    text: () => [
      '## 跨会话指挥中心（research-hub）',
      '',
      '需要用户决策但不阻塞工作的事项，主动调用 hub_post(type="question")。',
      '形成可复用的结论、报告或产物时，主动调用 hub_post(type="deliverable")；普通进度不投递。',
    ].join('\n'),
  }), 'research-hub: prompt section')

  // ── ask_user_question 被动镜像 ───────────────────────────────────────────

  ctx.effect(() => {
    const dispose = (ctx as any).on('user-questions/request', async (request: any, next: any) => {
      const agent = request?.agent
      const callId = request?.wait?.callId
      if (!agent || !callId || !Array.isArray(request.questions)) return next()
      const sessionId = String(agent.id)
      const questions = request.questions.map((q: any) => ({
        id: String(q.id),
        question: String(q.question ?? ''),
        header: q.header ? String(q.header) : undefined,
        options: Array.isArray(q.options)
          ? q.options.map((o: any) => ({ label: String(o.label ?? ''), description: o.description ? String(o.description) : undefined }))
          : undefined,
        multiSelect: Boolean(q.multiSelect),
      }))
      // 镜像写入最多等待 5 秒，但超时不丢弃后台任务。完成后仍可由回填逻辑发现。
      const mirror = hub.upsertAuqItem(sessionId, String(callId), questions).catch(() => null)
      let itemId: string | null = null
      try {
        itemId = await Promise.race([mirror, new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))])
      } catch {
        /* 镜像失败不影响提问本身 */
      }
      try {
        const answer = await next()
        const finalId = itemId ?? await hub.upsertAuqItem(sessionId, String(callId), questions).catch(() => null)
        if (finalId) {
          const summary = (answer?.answers ?? [])
            .map((a: any) => [...(a.selected ?? []), ...(a.custom ? [a.custom] : [])].join('、'))
            .filter(Boolean)
            .join('；')
          hub.settleItem(finalId, 'answered', summary || '（已在会话内回答）')
        }
        return answer
      } catch (error) {
        const finalId = itemId ?? await hub.upsertAuqItem(sessionId, String(callId), questions).catch(() => null)
        if (finalId) hub.settleItem(finalId, 'dismissed', '问题在会话侧关闭')
        throw error
      }
    })
    return typeof dispose === 'function' ? dispose : undefined
  }, 'research-hub: mirror user questions')

  // 注意：不做 agent/disposed 或 api-session/removed 的孤儿清理。
  // DSH 的提问是可续答的（continued question 记录在会话日志里），Agent 空闲回收
  // 或宿主重启后仍可用 userQuestions.answer 应答；误标"已忽略"会杀掉合法问题。
  // 问题只在提问瀑布真正中止（上面的 catch，如 ASK_ABORTED）时才关闭。

  // ── 面板 API ─────────────────────────────────────────────────────────────

  const api: Record<string, (payload: any) => Promise<unknown> | unknown> = {
    async panel() {
      // 首帧读持久化快照，零 IO。只有首次安装还没有快照时才短暂等待列表刷新
      // （最多 300ms），保证首页冷启动也在 0.5s 内返回；下一次轮询拿到完整数据。
      if (!hub.hasSnapshot()) {
        await Promise.race([
          hub.syncSessions(true),
          new Promise<void>((resolve) => setTimeout(resolve, 300)),
        ])
      }
      return buildPanel(hub, ctx, config, alertState)
    },
    /** 轻量角标数据：只读内存 store，不触发归因与标题读取。 */
    badge() {
      const archived = archivedLive
      const trashedIds = store.data.trashed ?? {}
      const visible = visibleSessionIdsCache?.ids
      const pending = store.data.items.filter((it) => it.status === 'pending' && (!visible || visible.has(it.sessionId)) && !archived.has(it.sessionId) && !trashedIds[it.sessionId])
      return {
        pending: pending.length,
        questions: pending.filter((it) => it.type === 'question').length,
        alerts: pending.filter((it) => it.type === 'alert').length,
        urgent: pending.filter((it) => it.priority === 'urgent').length,
      }
    },
    /** 跳转报告的读取（排障用）。 */
    jumpReports() {
      return jumpReports
    },
    /** 客户端跳转后回传的现场快照（排障用，只留最近 10 条）。 */
    jumpReport(payload) {
      jumpReports.push({ at: Date.now(), payload })
      if (jumpReports.length > 10) jumpReports.shift()
      return { ok: true }
    },
    /** 打开会话前先预热：把冷会话的 Agent 拉活，模拟原生侧栏打开时的完整路径。失败时透出真实原因。 */
    async warm(payload) {
      const sessionId = requireString(payload, 'sessionId')
      try {
        const res = await ctx.sessionController.resolveAgent(sessionId)
        if ('agent' in res) return { ok: true }
        const detail = res.error?.message || res.error?.code || 'unknown'
        return { ok: false, error: String(detail).slice(0, 200) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    async reply(payload) {
      const text = requireString(payload, 'text')
      return hub.reply(requireString(payload, 'itemId'), text)
    },
    async answerStructured(payload) {
      const answers = payload?.answers
      if (!Array.isArray(answers)) throw new ApiError('bad-request', 'answers 必须是数组')
      return hub.answerStructured(requireString(payload, 'itemId'), answers)
    },
    dismiss(payload) {
      const item = hub.settleItem(requireString(payload, 'itemId'), 'dismissed', '在指挥中心忽略')
      if (!item) throw new ApiError('not-found', '消息不存在', 404)
      return { ok: true }
    },
    /** 交付类消息的一键确认：与"回答"同义，语义是"已查收"。 */
    ack(payload) {
      const item = hub.settleItem(requireString(payload, 'itemId'), 'answered', '已查收')
      if (!item) throw new ApiError('not-found', '消息不存在', 404)
      return { ok: true }
    },
    reopen(payload) {
      const item = store.data.items.find((it) => it.id === requireString(payload, 'itemId'))
      if (!item) throw new ApiError('not-found', '消息不存在', 404)
      item.status = 'pending'
      delete item.settledAt
      delete item.answerText
      store.touch()
      return { ok: true }
    },
    moveItem(payload) {
      const projectRaw = payload?.projectId
      const projectId = projectRaw === null ? null : requireString(payload, 'projectId')
      if (projectId !== null && !store.data.projects.some((p) => p.id === projectId)) {
        throw new ApiError('not-found', '项目不存在', 404)
      }
      const item = hub.moveItem(requireString(payload, 'itemId'), projectId)
      if (!item) throw new ApiError('not-found', '消息不存在', 404)
      return { ok: true }
    },
    trashSession(payload) {
      hub.trashSession(requireString(payload, 'sessionId'))
      return { ok: true }
    },
    restoreSession(payload) {
      // 人工恢复视为长期决定：该会话以后不再自动回收
      hub.restoreSession(requireString(payload, 'sessionId'))
      return { ok: true }
    },
    bind(payload) {
      const sessionId = requireString(payload, 'sessionId')
      const projectRaw = payload?.projectId
      const projectId = projectRaw === null || projectRaw === '' ? null : String(projectRaw)
      if (projectId !== null && !store.data.projects.some((p) => p.id === projectId)) {
        throw new ApiError('not-found', '项目不存在', 404)
      }
      hub.setBinding(sessionId, projectId, 'user')
      return { ok: true }
    },
    addProject(payload) {
      const project = hub.addProject(requireString(payload, 'name'), Array.isArray(payload?.aliases) ? payload.aliases.map(String) : [])
      return { ok: true, id: project.id }
    },
    async rescan() {
      hub.invalidateCaches()
      hub.discoverProjects()
      // 显式请求：先把会话列表拉到最新再返回（用户主动重新扫描，可接受这次等待）。
      await hub.syncSessions(true)
      // 手动重新扫描视为显式请求：强制补一次中断告警与程序化会话扫描
      void backfillTurnAlerts(hub, ctx, config, alertState, await hub.listSessionsCached(), true)
      void sweepProgrammaticSessions(hub, ctx, config, sweepState)
      return buildPanel(hub, ctx, config, alertState)
    },
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/rhub/api',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://rhub.internal').pathname
      const method = pathname.startsWith('/rhub/api/') ? pathname.slice('/rhub/api/'.length) : undefined
      if (!method || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
        return
      }
      const handler = api[method]
      if (!handler) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${method}"` } })
        return
      }
      try {
        const payload = await readJsonBody(req)
        writeJson(res, 200, { ok: true, value: await handler(payload) })
      } catch (error) {
        if (error instanceof ApiError) {
          writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
        } else {
          const message = error instanceof Error ? error.message : String(error)
          writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
        }
      }
    },
  } as any), 'research-hub: /rhub/api routes')

  ctx.logger?.info?.('[research-hub] 指挥中心已启动，存储：' + storeFile + '，项目根：' + hubRoots.join(', '))
}
