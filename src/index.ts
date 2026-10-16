/**
 * @dsh-external/dsh-research-hub — host 侧：跨会话项目指挥中心。
 *
 * 职责：
 * 1. 项目注册表：扫描 projectsRoot（含 paper.toml/.git 的子目录）+ 手动添加。
 * 2. 会话归因：显式绑定（用户/agent 自报）> 内容推断（标题+首条消息匹配别名）。
 * 3. 消息通道：hub_register / hub_post 两个工具；ask_user_question 瀑布事件被动镜像。
 * 4. 回复路由：AUQ 走 userQuestions.answer 结构化应答，其余走 sessionController.prompt。
 * 5. 面板 API：POST /rhub/api/<method>（loopback Host 头围栏）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import { Hub, type HubServices } from './host/core.js'
import { HubStore, type HubItem } from './host/store.js'

export const name = '@dsh-external/dsh-research-hub'
export const inject = ['tools', 'systemPrompt', 'webServer', 'sessionController', 'userQuestions', 'agents', 'sessionQuery', 'timer', 'workspaceController']

export const Config = z.object({
  projectsRoot: z.string().default(process.env.DSH_RESEARCH_HUB_PROJECTS_ROOT || process.cwd()),
  storeFile: z.string().default(''),
})

interface ConfigShape {
  projectsRoot: string
  storeFile: string
}

type AppContext = Context & {
  tools: any
  systemPrompt: any
  webServer: any
  sessionController: any
  userQuestions: any
  agents: any
  sessionQuery: any
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

async function buildPanel(hub: Hub, ctx: AppContext): Promise<unknown> {
  // 项目发现走 60s 定时与 rescan，不在面板热路径上
  // 子 agent 会话不纳入（origin === 'subagent'）；其投递经 parentOf 归到父会话项目
  // 已归档会话不进入任何收件箱视图（会话列表与消息都不显示）
  // 空白会话（创建后从未发言）同样排除：它没有内容可归因，打开它只会显示新建页
  // 回收站会话同理隐藏（数据保留，恢复后回来）
  const archived = archivedLive
  const trashed = new Set(Object.keys(hub.data.trashed ?? {}))
  const summaries = (await hub.listSessionsCached()).filter(
    (s: any) => s?.origin !== 'subagent' && !s?.parentSessionId && !archived.has(String(s.sessionId))
      && !s?.blank && !trashed.has(String(s.sessionId)),
  )

  const sessions: SessionView[] = summaries.map((s) => ({
    id: String(s.sessionId),
    title: '',
    running: Boolean(s.running),
    updatedAt: Number(s.updatedAt) || 0,
    projectId: null,
    bindBy: 'auto',
    bindLocked: false,
    suggested: null,
  }))

  // 标题走缓存（空标题后台分批刷新，下一轮轮询拿到），不阻塞面板
  for (const s of sessions) s.title = hub.cachedTitle(s.id) ?? ''
  hub.refreshTitles(ctx.sessionQuery, sessions.map((s) => s.id))

  // 归因两阶段：① 显式绑定 + 标题匹配（零 IO）；② 近 3 天未命中的做深度扫描（限并发）
  const deepScan: SessionView[] = []
  const deepCutoff = Date.now() - 3 * 24 * 3600 * 1000
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
      hub.data.bindings[s.id] = { projectId: byTitle, locked: false, by: 'auto', updatedAt: Date.now() }
      hub.touch()
      continue
    }
    if (explicit?.projectId) {
      s.projectId = explicit.projectId
      continue
    }
    // 已扫描过且标题未变（含"不匹配"结论）的会话不重复深度扫描
    if (s.updatedAt >= deepCutoff && !hub.hasFreshInference(s.id, s.title)) deepScan.push(s)
  }
  // 深度扫描：6 路并发读首条用户消息
  const workers = Array.from({ length: Math.min(6, deepScan.length) }, async () => {
    for (let s = deepScan.shift(); s; s = deepScan.shift()) {
      const first = await hub.scanFirstUserMessage(s.id)
      const fullText = `${s.title}\n${first}`
      const projectId = hub.matchText(fullText)
      hub.commitInferred(s.id, s.title, projectId)
      hub.commitSuggest(s.id, s.title, hub.matchTextScored(fullText)?.id ?? null)
      if (projectId) {
        s.projectId = projectId
        hub.data.bindings[s.id] = { projectId, locked: false, by: 'auto', updatedAt: Date.now() }
      }
    }
  })
  await Promise.all(workers)
  if (sessions.some((s) => s.projectId)) hub.touch()

  // 未绑定会话的"建议项目"：只读标题的最佳候选（平局也给，采纳权在人）
  for (const s of sessions) {
    if (s.projectId === null) s.suggested = hub.suggestFor(s.id, s.title)
  }

  const runningById = new Map(sessions.map((s) => [s.id, s.running]))
  const titleById = new Map(sessions.map((s) => [s.id, s.title]))
  const enrich = (it: HubItem) => ({
    ...it,
    sessionTitle: titleById.get(it.sessionId) || it.sessionTitle,
    sessionRunning: runningById.get(it.sessionId) ?? false,
    sessionVisible: runningById.has(it.sessionId),
  })

  // 已归档/回收站会话的消息同样不进入任何收件箱视图（数据保留，恢复后回来）
  // 子代理产生的消息（无前缀 id 的会话）同样不进视图
  const items = hub.sortedItems().filter((it) => !archived.has(it.sessionId) && !trashed.has(it.sessionId) && it.sessionId.startsWith('session-'))
  const countsOf = (projectId: string | null) => {
    const scoped = items.filter((it) => it.projectId === projectId && it.status === 'pending')
    return {
      questions: scoped.filter((it) => it.type === 'question').length,
      deliverables: scoped.filter((it) => it.type === 'deliverable').length,
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
  const hub = new Hub(store, services, config.projectsRoot)
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

  // ── Agent 工具 ──────────────────────────────────────────────────────────

  const projectListText = () =>
    store.data.projects.map((p) => `${p.id}（${p.name}）`).join('、') || '（暂无项目）'

  ctx.effect(() => ctx.tools.register({
    name: 'hub_register',
    description:
      '向跨会话指挥中心声明本会话所属的研究项目。开始工作时调用一次即可。' +
      'project 传项目 id、名称或别名；不确定时传 "auto"，由指挥中心按会话内容推断。',
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
      'type="deliverable"：交付结果，如实验结论、分析结果、报告或产物路径。' +
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
      '本环境装有指挥中心插件，把多个会话的待办消息汇聚到统一收件箱。规则：',
      `1. 开始工作时调用一次 hub_register 声明本会话所属的研究项目。当前已知项目：${projectListText()}。不确定时传 "auto"。`,
      '2. 需要人类决策或回答、但不必打断当前流程的问题，调用 hub_post(type="question") 投递，然后继续工作。',
      '3. 产出可交付结果（实验结论、分析结果、报告、产物路径）时，调用 hub_post(type="deliverable") 交付。',
      '4. 紧急且需要立即回答的结构化问题仍用 ask_user_question；它会被自动镜像到指挥中心，不要再用 hub_post 重复投递。',
      '5. 人类的回复以普通用户消息进入本会话，按正常输入处理即可。',
      '6. 子代理（subagent）会话不属于指挥中心范围：被委派执行的子会话禁止调用 hub_register / hub_post，结果直接汇报给父会话。',
    ].join('\n'),
  }), 'research-hub: prompt section')

  // ── ask_user_question 被动镜像 ───────────────────────────────────────────

  ;(ctx as any).on('user-questions/request', async (request: any, next: any) => {
    const agent = request?.agent
    const callId = request?.wait?.callId
    if (!agent || !callId || !Array.isArray(request.questions)) return next()
    let itemId: string | null = null
    try {
      const questions = request.questions.map((q: any) => ({
        id: String(q.id),
        question: String(q.question ?? ''),
        header: q.header ? String(q.header) : undefined,
        options: Array.isArray(q.options)
          ? q.options.map((o: any) => ({ label: String(o.label ?? ''), description: o.description ? String(o.description) : undefined }))
          : undefined,
        multiSelect: Boolean(q.multiSelect),
      }))
      // 镜像有 5s 兜底：指挥中心自身的存储/查询异常绝不能阻塞用户的提问
      itemId = await Promise.race([
        hub.upsertAuqItem(String(agent.id), String(callId), questions),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ])
    } catch {
      /* 镜像失败不影响提问本身 */
    }
    try {
      const answer = await next()
      if (itemId) {
        const summary = (answer?.answers ?? [])
          .map((a: any) => [...(a.selected ?? []), ...(a.custom ? [a.custom] : [])].join('、'))
          .filter(Boolean)
          .join('；')
        hub.settleItem(itemId, 'answered', summary || '（已在会话内回答）')
      }
      return answer
    } catch (error) {
      if (itemId) hub.settleItem(itemId, 'dismissed', '问题在会话侧关闭')
      throw error
    }
  })

  // 注意：不做 agent/disposed 或 api-session/removed 的孤儿清理。
  // DSH 的提问是可续答的（continued question 记录在会话日志里），Agent 空闲回收
  // 或宿主重启后仍可用 userQuestions.answer 应答；误标"已忽略"会杀掉合法问题。
  // 问题只在提问瀑布真正中止（上面的 catch，如 ASK_ABORTED）时才关闭。

  // ── 面板 API ─────────────────────────────────────────────────────────────

  const api: Record<string, (payload: any) => Promise<unknown> | unknown> = {
    async panel() {
      return buildPanel(hub, ctx)
    },
    /** 轻量角标数据：只读内存 store，不触发归因与标题读取。 */
    badge() {
      const archived = archivedLive
      const trashedIds = store.data.trashed ?? {}
      const pending = store.data.items.filter((it) => it.status === 'pending' && !archived.has(it.sessionId) && !trashedIds[it.sessionId] && it.sessionId.startsWith('session-'))
      return {
        pending: pending.length,
        questions: pending.filter((it) => it.type === 'question').length,
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
      const sessionId = requireString(payload, 'sessionId')
      if (!store.data.trashed) store.data.trashed = {}
      store.data.trashed[sessionId] = Date.now()
      store.touch()
      return { ok: true }
    },
    restoreSession(payload) {
      const sessionId = requireString(payload, 'sessionId')
      if (store.data.trashed) delete store.data.trashed[sessionId]
      store.touch()
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
      return buildPanel(hub, ctx)
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

  ctx.logger?.info?.('[research-hub] 指挥中心已启动，存储：' + storeFile + '，项目根：' + config.projectsRoot)
}
