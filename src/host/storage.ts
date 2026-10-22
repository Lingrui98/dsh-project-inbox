/**
 * research-hub 存储适配器：StoreData 读写后端的抽象与两个实现。
 *
 * - JsonStorageAdapter：与 0.2.0 HubStore 的内置行为逐点对应
 *   （原子写 tmp+rename、损坏时返回 undefined 且原文件保留、v1→v2 迁移与 .v1.bak 备份）。
 * - SqliteStorageAdapter：node:sqlite（Node 24 内置实验特性）懒加载，单行 payload 表；
 *   空库且配置 migrateFrom 时从 JSON 一次性导入（含 v1 迁移与备份规则）。
 *
 * 适配器只做整份 StoreData 的同步读写；默认字段补齐、防抖与失败静默都在 HubStore 门面。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'
// 与 store.ts 存在运行时循环引用（store → storage → store）：DEFAULT_KINDS 只在
// 方法体内延迟访问，两个模块顶层都不取值，ESM 任意加载顺序下均安全。
import { DEFAULT_KINDS, type StoreData } from './store.js'

/** 存储后端：整份 StoreData 的同步读写。 */
export interface StorageAdapter {
  /** 读出持久化数据；没有可读数据（文件不存在、结构非法、损坏、空库）时返回 undefined。 */
  load(): StoreData | undefined
  /** 覆盖写入整份数据；失败可抛错，由调用方（HubStore.flush）捕获静默。 */
  save(data: StoreData): void
  /** 释放底层资源（如数据库句柄）；JSON 实现为空操作。 */
  close(): void
}

/** 存储配置：driver 缺省 json；file / migrateFrom 空串表示未设置。 */
export interface StorageConfig {
  /** json（默认）| sqlite；未知值由上层按 json 处理。 */
  driver?: string
  /** sqlite 库文件路径；空则沿用 HubStore 的 file。 */
  file?: string
  /** 空 SQLite 库从该 JSON 文件一次性导入；仅 driver=sqlite 时生效。 */
  migrateFrom?: string
}

/** 校验已解析数据是合法的 store（v1 或 v2）；非法结构按"没有可读数据"处理。 */
function isStoreShape(parsed: unknown): parsed is StoreData {
  const data = parsed as StoreData | null | undefined
  return Boolean(
    data
    && typeof data === 'object'
    && (data.version === 1 || data.version === 2)
    && Array.isArray(data.projects)
    && Array.isArray(data.items),
  )
}

/**
 * v1 → v2 幂等迁移：version 置 2、缺 kinds 时补默认注册表，其余原样。
 * 调用方负责备份与写回。返回是否发生了迁移。
 */
function migrateV1toV2(parsed: StoreData): boolean {
  if (parsed.version !== 1) return false
  parsed.version = 2
  if (!parsed.kinds || typeof parsed.kinds !== 'object') {
    parsed.kinds = Object.fromEntries(Object.entries(DEFAULT_KINDS).map(([k, v]) => [k, { ...v }]))
  }
  return true
}

/** JSON 单文件后端：行为与 0.2.0 HubStore 内置实现逐点对应。 */
export class JsonStorageAdapter implements StorageAdapter {
  constructor(readonly file: string) {}

  load(): StoreData | undefined {
    if (!existsSync(this.file)) return undefined
    const raw = readFileSync(this.file, 'utf8')
    // JSON 解析失败抛错，由 HubStore 捕获：从空开始、原文件保留。
    const parsed = JSON.parse(raw) as StoreData
    if (!isStoreShape(parsed)) return undefined
    if (parsed.version === 1) {
      // 先备份原始字节再迁移写回；备份失败抛错，HubStore 从空开始、原文件保持 v1，下次加载重试。
      writeFileSync(this.file + '.v1.bak', raw)
      migrateV1toV2(parsed)
      // 迁移立即写回（不等防抖）；写回失败静默：备份已在，原文件仍是 v1，下次加载重试。
      try {
        this.save(parsed)
      } catch {
        /* 下次 load 重试迁移 */
      }
    }
    return parsed
  }

  save(data: StoreData): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, this.file)
  }

  close(): void {
    /* 无底层资源 */
  }
}

/** node:sqlite 的最小结构类型；避免依赖 @types/node 的实验模块声明。 */
interface SqliteStatement {
  get(...args: unknown[]): Record<string, unknown> | undefined
  run(...args: unknown[]): unknown
}
interface SqliteDatabase {
  exec(sql: string): unknown
  prepare(sql: string): SqliteStatement
  close(): void
}

/**
 * SQLite 后端：单行 payload 表 hub_state，整份 StoreData 作为 JSON 文本存取。
 *
 * node:sqlite 只在构造时经 createRequire 懒加载：默认 JSON 用户不会触发实验警告，
 * 也不需要宿主预置该模块。构造失败（无模块、路径不可写）抛错，由 HubStore 降级 JSON。
 */
export class SqliteStorageAdapter implements StorageAdapter {
  private readonly db: SqliteDatabase
  private readonly migrateFrom: string

  constructor(readonly file: string, options?: { migrateFrom?: string }) {
    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDatabase }
    mkdirSync(dirname(this.file), { recursive: true })
    this.db = new DatabaseSync(this.file)
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS hub_state ('
      + 'id INTEGER PRIMARY KEY CHECK(id = 1), '
      + 'payload TEXT NOT NULL, '
      + 'version INTEGER NOT NULL, '
      + 'updated_at INTEGER NOT NULL)',
    )
    this.migrateFrom = options?.migrateFrom || ''
  }

  load(): StoreData | undefined {
    const row = this.db.prepare('SELECT payload FROM hub_state WHERE id = 1').get()
    if (row && typeof row.payload === 'string') {
      try {
        const parsed = JSON.parse(row.payload) as StoreData
        if (isStoreShape(parsed)) {
          // payload 正常由 save() 写入 v2；防御历史 v1 残留，迁移在内存完成，下次 save 落盘。
          migrateV1toV2(parsed)
          return parsed
        }
      } catch {
        /* payload 损坏：按没有可读数据处理 */
      }
      // 损坏或结构非法：返回 undefined，行保留不覆盖（与 JSON 损坏语义一致），下次 save 才替换。
      return undefined
    }
    // 空库：配置 migrateFrom 时从 JSON 一次性导入（含 v1 迁移与 .v1.bak 备份规则）。
    if (this.migrateFrom) {
      const imported = new JsonStorageAdapter(this.migrateFrom).load()
      if (imported) this.save(imported)
      return imported
    }
    return undefined
  }

  save(data: StoreData): void {
    this.db.prepare(
      'INSERT INTO hub_state (id, payload, version, updated_at) VALUES (1, ?, ?, ?) '
      + 'ON CONFLICT(id) DO UPDATE SET '
      + 'payload = excluded.payload, version = excluded.version, updated_at = excluded.updated_at',
    ).run(JSON.stringify(data), data.version, Date.now())
  }

  close(): void {
    this.db.close()
  }
}

/**
 * 按配置创建适配器。
 * driver=sqlite 时构造失败（无 node:sqlite、路径不可写等）降级为 JSON 后端，
 * 数据落在 HubStore 的 file 上；其余情况（含缺省与未知值）一律 JSON。
 */
export function createStorageAdapter(file: string, storage?: StorageConfig): StorageAdapter {
  if (storage?.driver === 'sqlite') {
    try {
      return new SqliteStorageAdapter(storage.file || file, { migrateFrom: storage.migrateFrom })
    } catch {
      return new JsonStorageAdapter(file)
    }
  }
  return new JsonStorageAdapter(file)
}
