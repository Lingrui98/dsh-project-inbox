/**
 * 导出/导入纯模块（portability）测试。
 *
 * 覆盖：导出字段完整、round-trip 等价、merge 去重（现有优先、项目别名并集）、
 * replace 保留 sessions 快照与本机缓存、非法输入错误码、统计数字、纯函数不修改入参。
 *
 * 依赖构建产物：先 `npm run build`，再 `node --test scripts/portability.test.mjs`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportBundle, importBundle, PortabilityError, PORTABLE_FIELDS } from '../lib/host/portability.js'

function makeStoreData() {
  return {
    version: 2,
    projects: [
      { id: 'p1', name: '项目一', aliases: ['p1', 'paper'], source: 'manual', createdAt: 1 },
      { id: 'p2', name: '项目二', aliases: ['p2'], source: 'discovered', createdAt: 2 },
    ],
    bindings: {
      'session-a': { projectId: 'p1', locked: true, by: 'user', updatedAt: 10 },
    },
    items: [
      { id: 'i1', projectId: 'p1', sessionId: 'session-a', sessionTitle: '会话A', type: 'question', title: '问题一', body: '正文', priority: 'normal', status: 'pending', source: 'tool', createdAt: 100 },
      { id: 'i2', projectId: null, sessionId: 'session-b', sessionTitle: '会话B', type: 'deliverable', title: '产物一', body: '', priority: 'urgent', status: 'answered', source: 'auq', createdAt: 200, settledAt: 300 },
    ],
    kinds: { note: { label: '备忘', action: 'read' } },
    titles: { 'session-a': { title: '会话A', at: 10 } },
    trashed: { 'session-x': 50 },
    alertKeys: { 'session-a#1': 'i1' },
    alertScans: { 'session-a': { at: 10, updatedAt: 20 } },
    programmatic: { 'session-a': false },
    trashExempt: { 'session-y': 60 },
    // 本机缓存：不应出现在导出包里
    sessions: { at: 999, items: [{ id: 'session-a', updatedAt: 20, running: true }] },
    inferred: { 'session-a': { title: '会话A', projectId: 'p1', at: 30 } },
    auqScans: { 'session-a': { at: 10, updatedAt: 20 } },
    ingestKeys: { 'key-1': { itemId: 'i1', at: 40 } },
  }
}

function makeBundleData() {
  return {
    projects: [
      { id: 'p1', name: '项目一（旧）', aliases: ['p1', 'legacy'], source: 'manual', createdAt: 1 },
      { id: 'p3', name: '项目三', aliases: ['p3'], source: 'manual', createdAt: 3 },
    ],
    bindings: {
      'session-a': { projectId: 'p2', locked: false, by: 'auto', updatedAt: 11 },
      'session-c': { projectId: 'p3', locked: false, by: 'agent', updatedAt: 12 },
    },
    items: [
      { id: 'i1', projectId: 'p2', sessionId: 'session-a', sessionTitle: '旧', type: 'question', title: '问题一（旧）', body: '旧正文', priority: 'urgent', status: 'answered', source: 'tool', createdAt: 100 },
      { id: 'i3', projectId: 'p3', sessionId: 'session-c', sessionTitle: '会话C', type: 'note', title: '备忘一', body: '', priority: 'normal', status: 'pending', source: 'tool', createdAt: 400 },
    ],
    titles: { 'session-a': { title: '旧标题', at: 11 }, 'session-c': { title: '会话C', at: 12 } },
    trashed: { 'session-x': 51, 'session-z': 52 },
    kinds: { note: { label: '备忘（旧）', action: 'ack' } },
  }
}

function makeBundle(data, meta) {
  return { meta: { schema: 1, exportedAt: 12345, ...meta }, data }
}

// ── 导出 ────────────────────────────────────────────────────────────────────

test('导出：只含可移植字段，不含 sessions 快照与本机缓存，meta 完整', () => {
  const data = makeStoreData()
  const { bundle, stats } = exportBundle(data, { hubVersion: '0.3.0', app: 'test', exportedAt: 777 })

  assert.equal(bundle.meta.schema, 1)
  assert.equal(bundle.meta.exportedAt, 777)
  assert.equal(bundle.meta.hubVersion, '0.3.0')
  assert.equal(bundle.meta.app, 'test')

  for (const field of ['projects', 'bindings', 'items', 'titles', 'trashed', 'alertKeys', 'alertScans', 'programmatic', 'trashExempt', 'kinds']) {
    assert.ok(field in bundle.data, `导出包应含 ${field}`)
  }
  for (const field of ['sessions', 'inferred', 'auqScans', 'ingestKeys', 'version']) {
    assert.ok(!(field in bundle.data), `导出包不应含本机字段 ${field}`)
  }

  assert.deepEqual(stats, { projects: 2, bindings: 1, items: 2, pending: 1, settled: 1 })

  // bundle 是独立深拷贝：改 bundle 不影响 store 数据
  bundle.data.items[0].title = '改写'
  assert.equal(data.items[0].title, '问题一')
})

test('导出：缺省 meta 自动补 exportedAt；缺省可选字段不出现在包里', () => {
  const { bundle } = exportBundle({ version: 2, projects: [], bindings: {}, items: [] })
  assert.equal(bundle.meta.schema, 1)
  assert.equal(typeof bundle.meta.exportedAt, 'number')
  assert.ok(!('titles' in bundle.data))
  assert.ok(!('kinds' in bundle.data))
})

// ── round-trip ──────────────────────────────────────────────────────────────

test('round-trip：导出后 replace 导入，可移植字段等价', () => {
  const data = makeStoreData()
  const { bundle } = exportBundle(data)
  const current = {
    version: 2,
    projects: [],
    bindings: {},
    items: [],
    sessions: { at: 1, items: [{ id: 'live', updatedAt: 2, running: true }] },
  }
  const { data: restored } = importBundle(current, bundle, { mode: 'replace' })
  assert.deepEqual(restored.projects, data.projects)
  assert.deepEqual(restored.bindings, data.bindings)
  assert.deepEqual(restored.items, data.items)
  assert.deepEqual(restored.titles, data.titles)
  assert.deepEqual(restored.trashed, data.trashed)
  assert.deepEqual(restored.alertKeys, data.alertKeys)
  assert.deepEqual(restored.alertScans, data.alertScans)
  assert.deepEqual(restored.programmatic, data.programmatic)
  assert.deepEqual(restored.trashExempt, data.trashExempt)
  assert.deepEqual(restored.kinds, data.kinds)
  // sessions 保留当前快照，不回填包外状态
  assert.deepEqual(restored.sessions, current.sessions)
})

// ── merge ───────────────────────────────────────────────────────────────────

test('merge：items 按 id 去重（现有优先），bindings/titles 按 key 现有优先，trashed 取并集', () => {
  const current = makeStoreData()
  const bundle = makeBundle(makeBundleData())
  const { data, stats } = importBundle(current, bundle, { mode: 'merge' })

  // i1 现有优先：标题仍是当前值；i3 新增
  const byId = Object.fromEntries(data.items.map((item) => [item.id, item]))
  assert.equal(data.items.length, 3)
  assert.equal(byId.i1.title, '问题一')
  assert.equal(byId.i1.priority, 'normal')
  assert.equal(byId.i3.title, '备忘一')

  // bindings：session-a 现有优先，session-c 新增
  assert.deepEqual(data.bindings['session-a'], current.bindings['session-a'])
  assert.deepEqual(data.bindings['session-c'], { projectId: 'p3', locked: false, by: 'agent', updatedAt: 12 })

  // titles：session-a 现有优先，session-c 新增
  assert.deepEqual(data.titles['session-a'], { title: '会话A', at: 10 })
  assert.deepEqual(data.titles['session-c'], { title: '会话C', at: 12 })

  // trashed：并集，冲突键现有优先
  assert.deepEqual(data.trashed, { 'session-x': 50, 'session-z': 52 })

  // kinds：现有优先
  assert.deepEqual(data.kinds.note, { label: '备忘', action: 'read' })

  // sessions 快照不动
  assert.deepEqual(data.sessions, current.sessions)

  assert.deepEqual(stats, {
    mode: 'merge',
    projects: 3,
    bindings: 2,
    items: 3,
    addedProjects: 1,
    addedBindings: 1,
    addedItems: 1,
    skippedProjects: 1,
    skippedBindings: 1,
    skippedItems: 1,
  })
})

test('merge：projects 按 id 合并，现有字段优先，别名取并集', () => {
  const current = makeStoreData()
  const { data } = importBundle(current, makeBundle(makeBundleData()), { mode: 'merge' })

  const byId = Object.fromEntries(data.projects.map((project) => [project.id, project]))
  assert.equal(data.projects.length, 3)
  // p1 保留现有 name/source/createdAt，别名 = 现有 ∪ 导入
  assert.equal(byId.p1.name, '项目一')
  assert.deepEqual(byId.p1.aliases, ['p1', 'paper', 'legacy'])
  // p3 原样新增
  assert.equal(byId.p3.name, '项目三')
  assert.deepEqual(byId.p3.aliases, ['p3'])
})

test('merge：默认 mode 是 merge', () => {
  const current = makeStoreData()
  const { stats } = importBundle(current, makeBundle(makeBundleData()))
  assert.equal(stats.mode, 'merge')
})

// ── replace ─────────────────────────────────────────────────────────────────

test('replace：可移植字段整体替换，保留当前 sessions 快照与本机缓存', () => {
  const current = makeStoreData()
  const bundleData = makeBundleData()
  const { data, stats, warnings } = importBundle(current, makeBundle(bundleData), { mode: 'replace' })

  assert.deepEqual(data.projects, bundleData.projects)
  assert.deepEqual(data.bindings, bundleData.bindings)
  assert.deepEqual(data.items, bundleData.items)
  assert.deepEqual(data.titles, bundleData.titles)
  assert.deepEqual(data.trashed, bundleData.trashed)
  assert.deepEqual(data.kinds, bundleData.kinds)
  // 包里没有的可选字段回落为空对象（与 HubStore 构造补齐一致）
  assert.deepEqual(data.alertKeys, {})
  assert.deepEqual(data.programmatic, {})

  // 本机状态保留
  assert.deepEqual(data.sessions, current.sessions)
  assert.deepEqual(data.inferred, current.inferred)
  assert.deepEqual(data.auqScans, current.auqScans)
  assert.deepEqual(data.ingestKeys, current.ingestKeys)
  assert.ok(warnings.some((line) => line.includes('sessions')))

  assert.deepEqual(stats, {
    mode: 'replace',
    projects: 2,
    bindings: 2,
    items: 2,
    addedProjects: 2,
    addedBindings: 2,
    addedItems: 2,
    skippedProjects: 0,
    skippedBindings: 0,
    skippedItems: 0,
  })
})

// ── 非法输入 ────────────────────────────────────────────────────────────────

function assertCode(bundle, code, options) {
  const current = makeStoreData()
  let thrown
  try {
    importBundle(current, bundle, options)
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof PortabilityError, `应抛 PortabilityError（${code}）`)
  assert.equal(thrown.code, code)
}

test('非法输入：按类别抛 PortabilityError code', () => {
  assertCode(null, 'invalid-bundle')
  assertCode('not a bundle', 'invalid-bundle')
  assertCode([], 'invalid-bundle')
  assertCode({ data: {} }, 'invalid-meta')
  assertCode(makeBundle({}, { schema: 2 }), 'invalid-schema')
  assertCode(makeBundle({}, { exportedAt: 'soon' }), 'invalid-meta')
  assertCode({ meta: { schema: 1, exportedAt: 1 } }, 'invalid-data')
  assertCode(makeBundle({ projects: {}, bindings: {}, items: [] }), 'invalid-field')
  assertCode(makeBundle({ projects: [], bindings: [], items: [] }), 'invalid-field')
  assertCode(makeBundle({ projects: [{ name: '无 id' }], bindings: {}, items: [] }), 'invalid-project')
  assertCode(makeBundle({ projects: [], bindings: {}, items: [{ type: 'note' }] }), 'invalid-item')
  assertCode(makeBundle({ projects: [], bindings: {}, items: [{ id: 'i1' }] }), 'invalid-item')
  // 未知导入模式
  assertCode(makeBundle({ projects: [], bindings: {}, items: [] }), 'invalid-field', { mode: 'sideways' })
})

test('宽松字段：可选记录类型非法时忽略并告警，未知字段告警', () => {
  const current = makeStoreData()
  const bundle = makeBundle({ ...makeBundleData(), titles: 'broken', mystery: 1 })
  const { data, warnings } = importBundle(current, bundle, { mode: 'merge' })
  // titles 非法被忽略：保留当前值
  assert.deepEqual(data.titles, current.titles)
  assert.ok(warnings.some((line) => line.includes('titles')))
  assert.ok(warnings.some((line) => line.includes('mystery')))
})

// ── 纯函数 ──────────────────────────────────────────────────────────────────

test('pure：exportBundle / importBundle 不修改入参', () => {
  const current = makeStoreData()
  const bundle = makeBundle(makeBundleData())
  const currentBefore = JSON.stringify(current)
  const bundleBefore = JSON.stringify(bundle)

  exportBundle(current)
  assert.equal(JSON.stringify(current), currentBefore, 'exportBundle 不应修改 data')

  for (const mode of ['merge', 'replace']) {
    const { data } = importBundle(current, bundle, { mode })
    assert.equal(JSON.stringify(current), currentBefore, `importBundle(${mode}) 不应修改 current`)
    assert.equal(JSON.stringify(bundle), bundleBefore, `importBundle(${mode}) 不应修改 bundle`)
    // 返回新对象：改返回值不影响入参
    data.items[0].title = '改写'
    assert.equal(JSON.stringify(current), currentBefore)
  }
})

test('PORTABLE_FIELDS 与导出结果一致', () => {
  const { bundle } = exportBundle(makeStoreData())
  assert.deepEqual(Object.keys(bundle.data).sort(), [...PORTABLE_FIELDS].sort())
})
