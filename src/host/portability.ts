/**
 * research-hub 数据可移植：导出/导入纯模块。
 * 只处理可移植字段，不含 sessions 快照与本机缓存；不写盘、不修改入参。
 * 接线（HTTP API、flush）由调用方负责。
 */
import type { Binding, HubItem, KindSpec, Project, StoreData } from './store.js'

/** 导出包元信息。schema 固定 1，未来不兼容变更时升版本。 */
export interface BundleMeta {
  schema: 1
  exportedAt: number
  hubVersion?: string
  app?: string
}

/** 可移植字段清单：跨机器迁移需要的数据。sessions/inferred/auqScans/ingestKeys 是本机缓存，不导出。 */
export const PORTABLE_FIELDS = [
  'projects',
  'bindings',
  'items',
  'titles',
  'trashed',
  'alertKeys',
  'alertScans',
  'programmatic',
  'trashExempt',
  'kinds',
] as const

/** 导出包形态：元信息 + 可移植字段子集。 */
export interface HubBundle {
  meta: BundleMeta
  data: {
    projects: Project[]
    bindings: Record<string, Binding>
    items: HubItem[]
    titles?: Record<string, { title: string; at: number }>
    trashed?: Record<string, number>
    alertKeys?: Record<string, string>
    alertScans?: Record<string, { at: number; updatedAt: number }>
    programmatic?: Record<string, boolean>
    trashExempt?: Record<string, number>
    kinds?: Record<string, KindSpec>
  }
}

export interface ExportStats {
  projects: number
  bindings: number
  items: number
  pending: number
  settled: number
}

export type ImportMode = 'merge' | 'replace'

export interface ImportStats {
  mode: ImportMode
  /** 导入结果中的实体数量。 */
  projects: number
  bindings: number
  items: number
  /** 导入包里被并入的数量：merge 只计新增，replace 等于包内数量。 */
  addedProjects: number
  addedBindings: number
  addedItems: number
  /** merge 时因现有优先而跳过的数量；replace 恒为 0。 */
  skippedProjects: number
  skippedBindings: number
  skippedItems: number
}

/** 导入校验失败。code 供调用方按类别呈现错误。 */
export class PortabilityError extends Error {
  constructor(
    readonly code:
      | 'invalid-bundle'
      | 'invalid-schema'
      | 'invalid-meta'
      | 'invalid-data'
      | 'invalid-field'
      | 'invalid-project'
      | 'invalid-item',
    message: string,
  ) {
    super(message)
    this.name = 'PortabilityError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * 导出可移植字段。返回独立深拷贝，之后改 bundle 不影响 store。
 * meta 可覆盖 exportedAt / hubVersion / app；schema 固定为 1。
 */
export function exportBundle(data: StoreData, meta?: Partial<BundleMeta>): { bundle: HubBundle; stats: ExportStats } {
  const bundle: HubBundle = {
    meta: {
      schema: 1,
      exportedAt: meta?.exportedAt ?? Date.now(),
      ...(meta?.hubVersion !== undefined ? { hubVersion: meta.hubVersion } : {}),
      ...(meta?.app !== undefined ? { app: meta.app } : {}),
    },
    data: {
      projects: clone(data.projects ?? []),
      bindings: clone(data.bindings ?? {}),
      items: clone(data.items ?? []),
    },
  }
  if (data.titles) bundle.data.titles = clone(data.titles)
  if (data.trashed) bundle.data.trashed = clone(data.trashed)
  if (data.alertKeys) bundle.data.alertKeys = clone(data.alertKeys)
  if (data.alertScans) bundle.data.alertScans = clone(data.alertScans)
  if (data.programmatic) bundle.data.programmatic = clone(data.programmatic)
  if (data.trashExempt) bundle.data.trashExempt = clone(data.trashExempt)
  if (data.kinds) bundle.data.kinds = clone(data.kinds)
  const items = bundle.data.items
  return {
    bundle,
    stats: {
      projects: bundle.data.projects.length,
      bindings: Object.keys(bundle.data.bindings).length,
      items: items.length,
      pending: items.filter((item) => item.status === 'pending').length,
      settled: items.filter((item) => item.status !== 'pending').length,
    },
  }
}

/** 校验 bundle 形状；非法输入抛 PortabilityError。返回收窄后的 bundle。 */
function validateBundle(bundle: unknown): HubBundle {
  if (!isRecord(bundle)) {
    throw new PortabilityError('invalid-bundle', '导入内容不是对象，无法识别为导出包')
  }
  const meta = bundle.meta
  if (!isRecord(meta)) {
    throw new PortabilityError('invalid-meta', '导出包缺少 meta 字段')
  }
  if (meta.schema !== 1) {
    throw new PortabilityError('invalid-schema', `不支持的导出包 schema：${String(meta.schema)}（当前支持 1）`)
  }
  if (typeof meta.exportedAt !== 'number' || !Number.isFinite(meta.exportedAt)) {
    throw new PortabilityError('invalid-meta', '导出包 meta.exportedAt 必须是有限数字')
  }
  const data = bundle.data
  if (!isRecord(data)) {
    throw new PortabilityError('invalid-data', '导出包缺少 data 字段或 data 不是对象')
  }
  if (!Array.isArray(data.projects)) {
    throw new PortabilityError('invalid-field', '导出包 data.projects 必须是数组')
  }
  if (!Array.isArray(data.items)) {
    throw new PortabilityError('invalid-field', '导出包 data.items 必须是数组')
  }
  if (!isRecord(data.bindings)) {
    throw new PortabilityError('invalid-field', '导出包 data.bindings 必须是对象')
  }
  for (const project of data.projects) {
    if (!isRecord(project) || typeof project.id !== 'string' || project.id === '') {
      throw new PortabilityError('invalid-project', '导出包存在缺少 id 的项目条目')
    }
  }
  for (const item of data.items) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id === '' || typeof item.type !== 'string' || item.type === '') {
      throw new PortabilityError('invalid-item', '导出包存在缺少 id 或 type 的消息条目')
    }
  }
  return bundle as unknown as HubBundle
}

/** 可选记录字段的类型守卫：值必须是对象（数字/布尔/字符串记录也按对象处理），否则忽略并告警。 */
function readOptionalRecord(data: HubBundle['data'], field: keyof HubBundle['data'], warnings: string[]): Record<string, unknown> | undefined {
  const value = data[field]
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    warnings.push(`导出包 data.${String(field)} 类型非法，已忽略`)
    return undefined
  }
  return value as Record<string, unknown>
}

/** 与 HubStore 构造一致的缺省补齐，保证导入结果可直接接管。 */
function normalize(data: StoreData): StoreData {
  if (!data.titles) data.titles = {}
  if (!data.trashed) data.trashed = {}
  if (!data.alertKeys) data.alertKeys = {}
  if (!data.alertScans) data.alertScans = {}
  if (!data.programmatic) data.programmatic = {}
  if (!data.trashExempt) data.trashExempt = {}
  if (!data.sessions) data.sessions = { at: 0, items: [] }
  if (!data.inferred) data.inferred = {}
  if (!data.auqScans) data.auqScans = {}
  if (!data.ingestKeys) data.ingestKeys = {}
  return data
}

function mergeRecord<T>(current: Record<string, T> | undefined, incoming: Record<string, unknown> | undefined): { merged: Record<string, T>; added: number; skipped: number } {
  const merged: Record<string, T> = clone(current ?? {})
  let added = 0
  let skipped = 0
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (key in merged) skipped++
    else {
      merged[key] = clone(value) as T
      added++
    }
  }
  return { merged, added, skipped }
}

/**
 * 导入导出包。
 * merge：items 按 id 去重（现有优先）；projects 按 id 合并（现有字段优先，别名取并集）；
 *        bindings 与各记录字段按 key 合并（现有优先）。
 * replace：可移植字段整体替换为包内内容；当前 sessions 快照与 inferred/auqScans/ingestKeys
 *        等本机缓存保留，避免导入后首页空白、扫描游标丢失。
 * 返回新对象，不修改 current 与 bundle；不写盘，由调用方 flush。
 */
export function importBundle(
  current: StoreData,
  bundle: unknown,
  options?: { mode?: ImportMode },
): { data: StoreData; stats: ImportStats; warnings: string[] } {
  const mode: ImportMode = options?.mode ?? 'merge'
  if (mode !== 'merge' && mode !== 'replace') {
    throw new PortabilityError('invalid-field', `未知导入模式：${String(mode)}`)
  }
  const valid = validateBundle(bundle)
  const warnings: string[] = []
  const incoming = valid.data

  const incomingRecords = {
    titles: readOptionalRecord(incoming, 'titles', warnings),
    trashed: readOptionalRecord(incoming, 'trashed', warnings),
    alertKeys: readOptionalRecord(incoming, 'alertKeys', warnings),
    alertScans: readOptionalRecord(incoming, 'alertScans', warnings),
    programmatic: readOptionalRecord(incoming, 'programmatic', warnings),
    trashExempt: readOptionalRecord(incoming, 'trashExempt', warnings),
    kinds: readOptionalRecord(incoming, 'kinds', warnings),
  }
  for (const key of Object.keys(incoming)) {
    if (!(PORTABLE_FIELDS as readonly string[]).includes(key)) {
      warnings.push(`导出包 data.${key} 不是可移植字段，已忽略`)
    }
  }

  if (mode === 'replace') {
    const data = normalize({
      version: current.version,
      projects: clone(incoming.projects),
      bindings: clone(incoming.bindings),
      items: clone(incoming.items),
      ...(incomingRecords.titles ? { titles: clone(incomingRecords.titles) as StoreData['titles'] } : {}),
      ...(incomingRecords.trashed ? { trashed: clone(incomingRecords.trashed) as StoreData['trashed'] } : {}),
      ...(incomingRecords.alertKeys ? { alertKeys: clone(incomingRecords.alertKeys) as StoreData['alertKeys'] } : {}),
      ...(incomingRecords.alertScans ? { alertScans: clone(incomingRecords.alertScans) as StoreData['alertScans'] } : {}),
      ...(incomingRecords.programmatic ? { programmatic: clone(incomingRecords.programmatic) as StoreData['programmatic'] } : {}),
      ...(incomingRecords.trashExempt ? { trashExempt: clone(incomingRecords.trashExempt) as StoreData['trashExempt'] } : {}),
      ...(incomingRecords.kinds ? { kinds: clone(incomingRecords.kinds) as StoreData['kinds'] } : {}),
      // 本机状态保留：sessions 快照、归因缓存、扫描游标、幂等键。
      sessions: clone(current.sessions),
      inferred: clone(current.inferred),
      auqScans: clone(current.auqScans),
      ingestKeys: clone(current.ingestKeys),
    })
    if (current.sessions && current.sessions.items.length > 0) {
      warnings.push(`replace 模式保留当前 sessions 快照（${current.sessions.items.length} 条）`)
    }
    return {
      data,
      stats: {
        mode,
        projects: data.projects.length,
        bindings: Object.keys(data.bindings).length,
        items: data.items.length,
        addedProjects: incoming.projects.length,
        addedBindings: Object.keys(incoming.bindings).length,
        addedItems: incoming.items.length,
        skippedProjects: 0,
        skippedBindings: 0,
        skippedItems: 0,
      },
      warnings,
    }
  }

  // merge：现有优先。
  const items: HubItem[] = clone(current.items ?? [])
  const itemIds = new Set(items.map((item) => item.id))
  let addedItems = 0
  let skippedItems = 0
  for (const item of incoming.items) {
    if (itemIds.has(item.id)) skippedItems++
    else {
      items.push(clone(item))
      itemIds.add(item.id)
      addedItems++
    }
  }

  const projects: Project[] = clone(current.projects ?? [])
  const projectIndex = new Map(projects.map((project, index) => [project.id, index]))
  let addedProjects = 0
  let skippedProjects = 0
  for (const project of incoming.projects) {
    const existing = projectIndex.get(project.id)
    if (existing === undefined) {
      projectIndex.set(project.id, projects.length)
      projects.push(clone(project))
      addedProjects++
    } else {
      skippedProjects++
      // 现有字段优先，仅别名取并集。
      const aliases = Array.isArray(project.aliases) ? project.aliases.filter((a): a is string => typeof a === 'string') : []
      projects[existing].aliases = [...new Set([...projects[existing].aliases, ...aliases])]
    }
  }

  const bindings = mergeRecord(current.bindings, incoming.bindings)
  const titles = mergeRecord(current.titles, incomingRecords.titles)
  const trashed = mergeRecord(current.trashed, incomingRecords.trashed)
  const alertKeys = mergeRecord(current.alertKeys, incomingRecords.alertKeys)
  const alertScans = mergeRecord(current.alertScans, incomingRecords.alertScans)
  const programmatic = mergeRecord(current.programmatic, incomingRecords.programmatic)
  const trashExempt = mergeRecord(current.trashExempt, incomingRecords.trashExempt)
  const kinds = mergeRecord(current.kinds, incomingRecords.kinds)

  const data = normalize({
    ...clone(current),
    version: current.version,
    projects,
    bindings: bindings.merged,
    items,
    titles: titles.merged as StoreData['titles'],
    trashed: trashed.merged as StoreData['trashed'],
    alertKeys: alertKeys.merged as StoreData['alertKeys'],
    alertScans: alertScans.merged as StoreData['alertScans'],
    programmatic: programmatic.merged as StoreData['programmatic'],
    trashExempt: trashExempt.merged as StoreData['trashExempt'],
    kinds: Object.keys(kinds.merged).length > 0 || current.kinds ? (kinds.merged as StoreData['kinds']) : undefined,
  })

  return {
    data,
    stats: {
      mode,
      projects: projects.length,
      bindings: Object.keys(bindings.merged).length,
      items: items.length,
      addedProjects,
      addedBindings: bindings.added,
      addedItems,
      skippedProjects,
      skippedBindings: bindings.skipped,
      skippedItems,
    },
    warnings,
  }
}
