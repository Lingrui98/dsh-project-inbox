/**
 * SQLite 存储后端与适配器门面测试（P3-1）。
 *
 * 覆盖：
 * 1. sqlite driver：写入 → 关闭 → 重开数据一致；storage.file 为空时沿用 HubStore file。
 * 2. 损坏 payload：HubStore 从空开始，库内旧行保留不覆盖。
 * 3. 空库 + migrateFrom：从 JSON 一次性导入（含 v1→v2 迁移与 .v1.bak 备份）。
 * 4. sqlite 构造失败：降级 JSON，数据落在 HubStore file。
 * 5. driver=json 不加载 node:sqlite（子进程 moduleLoadList 断言 + sqlite 正向对照）。
 *
 * 依赖构建产物：先 `npm run build`，再 `node --test scripts/sqlite-store.test.mjs`。
 * node:sqlite 是 Node 24 实验特性：相关用例 stderr 会有 ExperimentalWarning，属预期。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { DEFAULT_KINDS, HubStore } from '../lib/host/store.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

const dirs = []
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'rhub-sqlite-'))
  dirs.push(dir)
  return dir
}

function sampleItem(id) {
  return {
    id, projectId: 'demo', sessionId: 'session-x', sessionTitle: '', type: 'question',
    title: 't', body: 'b', priority: 'normal', status: 'pending', source: 'tool', createdAt: 1,
  }
}

function readPayload(dbFile) {
  const db = new DatabaseSync(dbFile)
  try {
    return db.prepare('SELECT payload, version FROM hub_state WHERE id = 1').get()
  } finally {
    db.close()
  }
}

test.after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

// ── sqlite driver：基本读写 ─────────────────────────────────────────────────

test('sqlite：写入 → 关闭 → 重开数据一致；storage.file 为空沿用 HubStore file', () => {
  const dir = sandbox()
  const dbFile = join(dir, 'hub.db')
  // storage.file 缺省：sqlite 库直接落在 HubStore 的 file 上
  const store = new HubStore(dbFile, { storage: { driver: 'sqlite' } })
  assert.equal(store.data.version, 2)
  store.data.projects.push({ id: 'demo', name: 'demo', aliases: ['demo'], source: 'manual', createdAt: 1 })
  store.data.items.push(sampleItem('i1'))
  store.flush()
  store.close()

  const row = readPayload(dbFile)
  assert.equal(row.version, 2, 'version 列记录 StoreData.version')

  const again = new HubStore(dbFile, { storage: { driver: 'sqlite' } })
  assert.equal(again.data.projects.length, 1)
  assert.equal(again.data.projects[0].id, 'demo')
  assert.equal(again.data.items.length, 1)
  assert.equal(again.data.items[0].id, 'i1')
  // 默认字段补齐在门面层，sqlite 重开后同样生效
  assert.ok(again.data.sessions)
  again.close()
})

test('sqlite：storage.file 指定独立路径，覆盖写保持单行', () => {
  const dir = sandbox()
  const dbFile = join(dir, 'nested', 'hub.db')
  const store = new HubStore(join(dir, 'unused.json'), { storage: { driver: 'sqlite', file: dbFile } })
  store.data.items.push(sampleItem('i1'))
  store.flush()
  store.data.items.push(sampleItem('i2'))
  store.flush()
  store.close()

  assert.ok(!existsSync(join(dir, 'unused.json')), 'sqlite driver 不应写 JSON 文件')
  const db = new DatabaseSync(dbFile)
  try {
    const rows = db.prepare('SELECT id FROM hub_state').all()
    assert.equal(rows.length, 1, 'hub_state 始终单行')
  } finally {
    db.close()
  }
  const parsed = JSON.parse(readPayload(dbFile).payload)
  assert.equal(parsed.items.length, 2)
})

test('sqlite：空库且无 migrateFrom 时从空开始', () => {
  const dir = sandbox()
  const dbFile = join(dir, 'hub.db')
  const store = new HubStore(dbFile, { storage: { driver: 'sqlite' } })
  assert.equal(store.data.version, 2)
  assert.equal(store.data.items.length, 0)
  store.close()
})

// ── 损坏容错 ────────────────────────────────────────────────────────────────

test('sqlite：损坏 payload 从空开始，库内旧行保留不覆盖', () => {
  const dir = sandbox()
  const dbFile = join(dir, 'hub.db')
  const store = new HubStore(dbFile, { storage: { driver: 'sqlite' } })
  store.data.items.push(sampleItem('i1'))
  store.flush()
  store.close()

  const db = new DatabaseSync(dbFile)
  db.prepare('UPDATE hub_state SET payload = ? WHERE id = 1').run('{ broken')
  db.close()

  const corrupted = new HubStore(dbFile, { storage: { driver: 'sqlite' } })
  assert.equal(corrupted.data.version, 2)
  assert.equal(corrupted.data.items.length, 0, '损坏 payload 与 JSON 损坏语义一致：从空开始')
  corrupted.close()

  assert.equal(readPayload(dbFile).payload, '{ broken', '损坏行应保留，不被构造覆盖')
})

// ── migrateFrom 一次性导入 ──────────────────────────────────────────────────

test('sqlite：空库从 migrateFrom 的 v1 JSON 导入，含迁移与 .v1.bak 备份', () => {
  const dir = sandbox()
  const jsonFile = join(dir, 'legacy.json')
  const dbFile = join(dir, 'hub.db')
  writeFileSync(jsonFile, JSON.stringify({
    version: 1,
    projects: [{ id: 'demo', name: 'demo', aliases: ['demo'], source: 'manual', createdAt: 1 }],
    bindings: { 'session-x': { projectId: 'demo', locked: true, by: 'user', updatedAt: 1 } },
    items: [sampleItem('i1')],
  }))

  const store = new HubStore(join(dir, 'fallback.json'), {
    storage: { driver: 'sqlite', file: dbFile, migrateFrom: jsonFile },
  })
  assert.equal(store.data.version, 2)
  assert.deepEqual(store.data.kinds, DEFAULT_KINDS, 'v1 导入应补默认 kinds')
  assert.equal(store.data.items.length, 1)
  assert.equal(store.data.bindings['session-x'].projectId, 'demo')
  store.close()

  // 备份规则沿用 JSON 迁移：备份内容逐字节等于迁移前的 v1 文件
  assert.ok(existsSync(jsonFile + '.v1.bak'), '导入应生成 <file>.v1.bak 备份')
  assert.equal(JSON.parse(readFileSync(jsonFile + '.v1.bak', 'utf8')).version, 1)

  // 导入已写入 sqlite：不带 migrateFrom 重开仍有数据
  const again = new HubStore(dbFile, { storage: { driver: 'sqlite' } })
  assert.equal(again.data.items.length, 1)
  assert.equal(again.data.projects[0].id, 'demo')
  again.close()
})

test('sqlite：非空库忽略 migrateFrom', () => {
  const dir = sandbox()
  const jsonFile = join(dir, 'other.json')
  const dbFile = join(dir, 'hub.db')
  writeFileSync(jsonFile, JSON.stringify({ version: 2, projects: [], bindings: {}, items: [sampleItem('from-json')] }))

  const store = new HubStore(dbFile, { storage: { driver: 'sqlite' } })
  store.data.items.push(sampleItem('from-sqlite'))
  store.flush()
  store.close()

  const again = new HubStore(dbFile, { storage: { driver: 'sqlite', migrateFrom: jsonFile } })
  assert.equal(again.data.items.length, 1)
  assert.equal(again.data.items[0].id, 'from-sqlite', '非空库以 sqlite 为准，不再导入')
  again.close()
})

// ── 降级 ────────────────────────────────────────────────────────────────────

test('sqlite 构造失败（路径不可写）降级 JSON，数据落在 HubStore file', () => {
  const dir = sandbox()
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'not a directory')
  const jsonFile = join(dir, 'fallback.json')
  const store = new HubStore(jsonFile, {
    storage: { driver: 'sqlite', file: join(blocker, 'hub.db') },
  })
  store.data.items.push(sampleItem('i1'))
  store.flush()
  store.close()

  assert.ok(existsSync(jsonFile), '降级后应写 JSON 文件')
  const written = JSON.parse(readFileSync(jsonFile, 'utf8'))
  assert.equal(written.items.length, 1)
  assert.equal(written.items[0].id, 'i1')
})

// ── 懒加载：driver=json 不加载 node:sqlite ──────────────────────────────────

test('driver=json 不加载 node:sqlite（子进程断言），driver=sqlite 正向对照', () => {
  const dir = sandbox()
  const storeUrl = pathToFileURL(join(root, 'lib', 'host', 'store.js')).href
  const probe = (storage) => {
    const construct = storage === undefined
      ? `new HubStore(${JSON.stringify(join(dir, 'probe-store'))})`
      : `new HubStore(${JSON.stringify(join(dir, 'probe-store'))}, { storage: ${JSON.stringify(storage)} })`
    const script = [
      `import { HubStore } from ${JSON.stringify(storeUrl)}`,
      `const store = ${construct}`,
      'store.flush()',
      'store.close()',
      "console.log(JSON.stringify({ sqlite: process.moduleLoadList.some((e) => e.toLowerCase().includes('sqlite')) }))",
    ].join('\n')
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' })
    assert.equal(result.status, 0, `子进程应正常退出：${result.stderr}`)
    return JSON.parse(result.stdout.trim())
  }

  assert.equal(probe({ driver: 'json' }).sqlite, false, 'json driver 不应加载 node:sqlite')
  assert.equal(probe(undefined).sqlite, false, '缺省构造（new HubStore(file) 兼容形态）不应加载 node:sqlite')
  assert.equal(probe({ driver: 'sqlite', file: join(dir, 'probe.db') }).sqlite, true, 'sqlite driver 应加载 node:sqlite')
})
