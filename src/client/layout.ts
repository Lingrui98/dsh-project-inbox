/**
 * @dsh-external/dsh-project-inbox — client 侧：面板布局配置（纯模块）。
 *
 * 职责：
 * - 描述"全部待处理"视图的分区（LayoutSection）与整体布局（LayoutConfig）。
 * - DEFAULT_LAYOUT 与 0.1.4 的固定渲染等价：alerts → questions → deliverables。
 * - normalizeLayout(raw) 容错：未知 source 的分区丢弃、未知字段剥离、
 *   sections 全部无效或缺失时回退默认布局、groupBy/defaultSection 非法时回退。
 * - assignItems 把条目按"首个匹配分区"归入分区，不落任何分区的条目进入
 *   defaultSection（若配置）；都不存在则丢弃。
 * - groupItems 在分区内部按 project / kind / priority 分组；none 不分组。
 *
 * 本模块不依赖 React 与文案字典，标题回退由调用方（index.ts）完成。
 */

export type LayoutGroupBy = 'project' | 'kind' | 'priority' | 'none'

/** 分区的条目来源。alerts/questions/deliverables 只取待处理条目。 */
export type LayoutSectionSource =
  | 'alerts'
  | 'questions'
  | 'deliverables'
  | 'pending'
  | 'history'
  | 'all'

/** 分区过滤条件；project 取 'unassigned' 时匹配 projectId 为 null 的条目。 */
export interface LayoutFilter {
  kind?: 'question' | 'deliverable' | 'alert'
  priority?: 'normal' | 'urgent'
  project?: string
}

export interface LayoutSection {
  id: string
  /** 自定义标题；缺省时由调用方按 source 取内置文案。 */
  title?: string
  source: LayoutSectionSource
  filter?: LayoutFilter
  /** 排序键；缺省时用数组位置，保持书写顺序。 */
  order?: number
  /** 折叠分区只渲染标题行，不渲染条目。 */
  collapsed?: boolean
}

export interface LayoutConfig {
  sections?: LayoutSection[]
  groupBy?: LayoutGroupBy
  /** 不落任何分区的条目归入该 id 的分区；id 不存在则忽略。 */
  defaultSection?: string
}

/** 参与布局的条目最小结构（HubItemView 兼容）。 */
export interface LayoutItem {
  id: string
  type: string
  priority: string
  status: string
  projectId: string | null
}

export interface ItemGroup<T> {
  key: string
  items: T[]
}

const KNOWN_SOURCES: readonly LayoutSectionSource[] = [
  'alerts',
  'questions',
  'deliverables',
  'pending',
  'history',
  'all',
]

const KNOWN_GROUP_BY: readonly LayoutGroupBy[] = ['project', 'kind', 'priority', 'none']

const KNOWN_KINDS = ['question', 'deliverable', 'alert'] as const
const KNOWN_PRIORITIES = ['normal', 'urgent'] as const

/** 与 0.1.4 固定渲染等价：中断 → 待回答问题 → 待查看交付，不分组。 */
export const DEFAULT_LAYOUT: LayoutConfig = {
  groupBy: 'none',
  sections: [
    { id: 'alerts', source: 'alerts', order: 0 },
    { id: 'questions', source: 'questions', order: 1 },
    { id: 'deliverables', source: 'deliverables', order: 2 },
  ],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneDefault(): LayoutConfig {
  return {
    groupBy: DEFAULT_LAYOUT.groupBy,
    sections: DEFAULT_LAYOUT.sections!.map((section) => ({ ...section })),
  }
}

function normalizeFilter(raw: unknown): LayoutFilter | undefined {
  if (!isRecord(raw)) return undefined
  const filter: LayoutFilter = {}
  if (typeof raw.kind === 'string' && (KNOWN_KINDS as readonly string[]).includes(raw.kind)) {
    filter.kind = raw.kind as LayoutFilter['kind']
  }
  if (typeof raw.priority === 'string' && (KNOWN_PRIORITIES as readonly string[]).includes(raw.priority)) {
    filter.priority = raw.priority as LayoutFilter['priority']
  }
  if (typeof raw.project === 'string' && raw.project.length > 0) {
    filter.project = raw.project
  }
  return Object.keys(filter).length > 0 ? filter : undefined
}

function normalizeSection(raw: unknown): LayoutSection | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null
  if (typeof raw.source !== 'string' || !KNOWN_SOURCES.includes(raw.source as LayoutSectionSource)) return null
  const section: LayoutSection = { id: raw.id, source: raw.source as LayoutSectionSource }
  if (typeof raw.title === 'string' && raw.title.length > 0) section.title = raw.title
  const filter = normalizeFilter(raw.filter)
  if (filter) section.filter = filter
  if (typeof raw.order === 'number' && Number.isFinite(raw.order)) section.order = raw.order
  if (raw.collapsed === true) section.collapsed = true
  return section
}

/**
 * 容错归一化：任何非对象输入回退默认布局；sections 里未知 source、缺 id 的
 * 条目丢弃；未知字段剥离；同 id 分区保留首个；按 order（缺省取数组位置）
 * 稳定排序；归一化后无有效分区时回退默认布局。
 * 返回值总是新对象，调用方修改不会污染 DEFAULT_LAYOUT。
 */
export function normalizeLayout(raw: unknown): LayoutConfig {
  if (!isRecord(raw)) return cloneDefault()
  const config: LayoutConfig = {}
  config.groupBy = typeof raw.groupBy === 'string' && KNOWN_GROUP_BY.includes(raw.groupBy as LayoutGroupBy)
    ? raw.groupBy as LayoutGroupBy
    : 'none'

  let sections: LayoutSection[] = []
  if (Array.isArray(raw.sections)) {
    const seen = new Set<string>()
    const normalized = raw.sections
      .map((entry, index) => ({ section: normalizeSection(entry), index }))
      .filter((entry): entry is { section: LayoutSection; index: number } => entry.section !== null)
      .filter((entry) => {
        if (seen.has(entry.section.id)) return false
        seen.add(entry.section.id)
        return true
      })
    // order 缺省时用数组位置做排序键；并列时保持数组先后。
    normalized.sort((a, b) =>
      (a.section.order ?? a.index) - (b.section.order ?? b.index) || a.index - b.index)
    sections = normalized.map((entry) => entry.section)
  }
  // sections 缺失或全部无效时回退默认分区，但保留已归一化的 groupBy。
  if (sections.length === 0) sections = cloneDefault().sections!
  config.sections = sections

  if (typeof raw.defaultSection === 'string' && sections.some((section) => section.id === raw.defaultSection)) {
    config.defaultSection = raw.defaultSection
  }
  return config
}

function sourceMatches(source: LayoutSectionSource, item: LayoutItem): boolean {
  const pending = item.status === 'pending'
  switch (source) {
    case 'alerts': return pending && item.type === 'alert'
    case 'questions': return pending && item.type === 'question'
    case 'deliverables': return pending && item.type === 'deliverable'
    case 'pending': return pending
    case 'history': return !pending
    case 'all': return true
  }
}

function filterMatches(filter: LayoutFilter | undefined, item: LayoutItem): boolean {
  if (!filter) return true
  if (filter.kind !== undefined && item.type !== filter.kind) return false
  if (filter.priority !== undefined && item.priority !== filter.priority) return false
  if (filter.project !== undefined) {
    const projectId = filter.project === 'unassigned' ? null : filter.project
    if (item.projectId !== projectId) return false
  }
  return true
}

/**
 * 把条目归入分区：每条目进入归一化顺序下首个 source 与 filter 都匹配的分区；
 * 无匹配时进入 defaultSection（若配置且存在）；否则不显示。
 * 分区内的条目顺序与输入数组一致。返回 Map 覆盖全部分区 id（含空数组）。
 */
export function assignItems<T extends LayoutItem>(items: T[], layout: LayoutConfig): Map<string, T[]> {
  const sections = layout.sections ?? []
  const result = new Map<string, T[]>()
  for (const section of sections) result.set(section.id, [])
  const fallback = layout.defaultSection && result.has(layout.defaultSection) ? layout.defaultSection : null
  for (const item of items) {
    const target = sections.find((section) => sourceMatches(section.source, item) && filterMatches(section.filter, item))
    const id = target?.id ?? fallback
    if (id) result.get(id)!.push(item)
  }
  return result
}

function orderedGroups<T>(items: T[], keyOf: (item: T) => string, preferred: readonly string[]): ItemGroup<T>[] {
  const buckets = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(item)
    else buckets.set(key, [item])
  }
  const keys: string[] = []
  for (const key of preferred) if (buckets.has(key)) keys.push(key)
  for (const key of buckets.keys()) if (!preferred.includes(key)) keys.push(key)
  return keys.map((key) => ({ key, items: buckets.get(key)! }))
}

/**
 * 分区内分组：
 * - none：恒为单组 { key: 'all' }，调用方按未分组渲染。
 * - kind：alert → question → deliverable 固定序，其余类型按首现顺序追加。
 * - priority：urgent → normal，其余按首现顺序追加。
 * - project：按 projectId 分组（null 归 'unassigned'），组序按首现顺序。
 * kind / priority / project 只返回非空组。
 */
export function groupItems<T extends LayoutItem>(items: T[], groupBy: LayoutGroupBy = 'none'): ItemGroup<T>[] {
  if (groupBy === 'kind') {
    return orderedGroups(items, (item) => item.type, ['alert', 'question', 'deliverable'])
  }
  if (groupBy === 'priority') {
    return orderedGroups(items, (item) => item.priority, ['urgent', 'normal'])
  }
  if (groupBy === 'project') {
    return orderedGroups(items, (item) => item.projectId ?? 'unassigned', [])
  }
  return [{ key: 'all', items }]
}
