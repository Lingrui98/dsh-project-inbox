/**
 * research-hub 核心：项目发现、会话归因、收件箱操作、回复路由。
 * 所有方法只操作内存 store + 宿主服务，落盘由 store.touch 防抖完成。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AuqQuestionView, Binding, HubItem, HubStore, Project } from './store.js'

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

export class Hub {
  /** 归因缓存：title 变化时重算。 */
  private inferCache = new Map<string, { title: string; projectId: string | null }>()

  constructor(
    private store: HubStore,
    private services: HubServices,
    private projectsRoot: string,
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

  // ── 项目 ────────────────────────────────────────────────────────────────

  /** 扫描 projectsRoot：含 paper.toml 或 .git 的子目录登记为项目；根目录本身也算一个项目。 */
  discoverProjects(): void {
    const found = new Map<string, { name: string; aliases: string[] }>()
    const addDir = (dir: string, display: string) => {
      found.set(dir, { name: display, aliases: deriveAliases(dir, display) })
    }
    try {
      if (existsSync(this.projectsRoot)) {
        const rootName = basename(this.projectsRoot) || 'projects'
        addDir(rootName, rootName)
        for (const entry of readdirSync(this.projectsRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue
          const dir = join(this.projectsRoot, entry.name)
          const toml = join(dir, 'paper.toml')
          const isProject = existsSync(toml) || existsSync(join(dir, '.git'))
          if (!isProject) continue
          let display = entry.name
          try {
            if (existsSync(toml)) display = paperTomlName(readFileSync(toml, 'utf8')) ?? entry.name
          } catch { /* 读不到就用目录名 */ }
          addDir(entry.name, display)
        }
      }
    } catch { /* 扫描失败保留现状 */ }

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
        this.store.touch()
      }
      return binding
    }
    return explicit ?? { projectId: null, locked: false, by: 'auto', updatedAt: Date.now() }
  }

  setBinding(sessionId: string, projectId: string | null, by: 'user' | 'agent'): Binding {
    const binding: Binding = { projectId, locked: by === 'user', by, updatedAt: Date.now() }
    if (projectId === null) delete this.store.data.bindings[sessionId]
    else this.store.data.bindings[sessionId] = binding
    this.store.touch()
    return binding
  }

  /** 标题缓存：readTitleSnapshots 全量约 126ms/会话，面板轮询必须走缓存。持久化到 store。 */
  private titleCache = new Map<string, { title: string; at: number }>()
  private titleRefreshRunning = false
  /** 会话列表缓存（sessionController.list 约 0.5s，轮询不重复拉）。 */
  private listCache: { at: number; items: any[] } | null = null
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

  /** 会话列表（10 秒缓存）。 */
  async listSessionsCached(): Promise<any[]> {
    if (this.listCache && Date.now() - this.listCache.at < 10_000) return this.listCache.items
    try {
      const listed = await this.services.sessionController.list({})
      this.listCache = { at: Date.now(), items: listed?.items ?? [] }
    } catch {
      this.listCache = this.listCache ?? { at: Date.now(), items: [] }
    }
    return this.listCache.items
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
      return !c || Date.now() - c.at > 300_000
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
    const cached = this.inferCache.get(sessionId)
    if (cached && cached.title === title) return cached.projectId
    const first = await this.scanFirstUserMessage(sessionId)
    const projectId = this.matchText(title + '\n' + first)
    this.inferCache.set(sessionId, { title, projectId })
    return projectId
  }

  /** 轻量推断：只用给定标题。面板批量路径用。 */
  inferFromTitle(sessionId: string, title: string): string | null {
    const cached = this.inferCache.get(sessionId)
    if (cached && cached.title === title) return cached.projectId
    const projectId = this.matchText(title)
    if (projectId) this.inferCache.set(sessionId, { title, projectId })
    return projectId
  }

  /** 深度推断结果写缓存（面板批量路径在扫描后调用）。 */
  commitInferred(sessionId: string, title: string, projectId: string | null): void {
    this.inferCache.set(sessionId, { title, projectId })
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
    source: 'tool' | 'auq'
    projectId?: string | null
    auq?: HubItem['auq']
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
    }
    this.store.data.items.push(item)
    this.store.touch()
    return item
  }

  /** AUQ 镜像：同一 callId 只建一条。返回消息 id，重复时返回已有 id。 */
  async upsertAuqItem(sessionId: string, callId: string, questions: AuqQuestionView[]): Promise<string> {
    const existing = this.store.data.items.find((it) => it.source === 'auq' && it.auq?.callId === callId)
    if (existing) return existing.id
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

  /** 快捷回复：AUQ 问题优先走结构化应答，失败退化为普通消息投递。 */
  async reply(itemId: string, text: string): Promise<{ via: 'answer' | 'prompt' }> {
    const item = this.store.data.items.find((it) => it.id === itemId)
    if (!item) throw new Error('消息不存在')
    if (item.status !== 'pending') throw new Error('消息已处理')
    if (item.source === 'auq') {
      const questions = item.auq?.questions ?? []
      const answers = questions.map((q) => ({ id: q.id, selected: [] as string[], custom: text }))
      if (await this.tryAnswerAuq(item, answers)) {
        this.settleItem(itemId, 'answered', text)
        return { via: 'answer' }
      }
    }
    await this.promptSession(item.sessionId, text)
    this.settleItem(itemId, 'answered', text)
    return { via: 'prompt' }
  }

  /** AUQ 选项应答：每个问题给出 selected 标签或 custom 文本。 */
  async answerStructured(itemId: string, answers: { id: string; selected: string[]; custom?: string }[]): Promise<{ via: 'answer' | 'prompt' }> {
    const item = this.store.data.items.find((it) => it.id === itemId)
    if (!item) throw new Error('消息不存在')
    if (item.status !== 'pending') throw new Error('消息已处理')
    if (item.source !== 'auq' || !item.auq) throw new Error('该消息不支持选项应答')
    if (await this.tryAnswerAuq(item, answers)) {
      const summary = answers
        .map((a) => [...a.selected, ...(a.custom ? [a.custom] : [])].join('、'))
        .filter(Boolean)
        .join('；')
      this.settleItem(itemId, 'answered', summary)
      return { via: 'answer' }
    }
    // 退化：把选项结果拼成文本投递
    const lines = answers.map((a) => {
      const q = item.auq!.questions.find((qq) => qq.id === a.id)
      const picked = [...a.selected, ...(a.custom ? [a.custom] : [])].join('、')
      return q ? `${q.question}\n→ ${picked}` : picked
    })
    await this.promptSession(item.sessionId, lines.join('\n\n'))
    this.settleItem(itemId, 'answered', lines.join('；'))
    return { via: 'prompt' }
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
