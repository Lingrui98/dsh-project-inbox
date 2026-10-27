/**
 * store v1 → v2 迁移与 kinds 注册表回归测试。
 *
 * 背景：消息类型从固定三类放宽为可注册 kind，store 升到 v2：
 * 1. HubStore 加载 v1 文件时先备份 `<file>.v1.bak`，补默认 kinds，写回 v2；幂等。
 * 2. Hub.kindSpec 按注册表取 label/action；未注册类型按 read 处理并只告警一次。
 * 3. apply() 的 hub_post 按注册表校验 type；面板载荷保留 type 并附 kind 字段。
 *
 * 所有用例确定性：不依赖真实会话。依赖构建产物：先 `npm run build`，
 * 再 `node --test scripts/store-migration.test.mjs`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { Hub, resolveKinds } from '../lib/host/core.js'
import { DEFAULT_KINDS, HubStore } from '../lib/host/store.js'
import { apply } from '../lib/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeModules = join(root, 'node_modules')
const v1File = join(nodeModules, '.store-migration-v1.json')
const v2File = join(nodeModules, '.store-migration-v2.json')
const applyStoreFile = join(nodeModules, '.store-migration-apply.json')
const storeFiles = [v1File, v2File, applyStoreFile]
const bakFiles = storeFiles.map((f) => f + '.v1.bak')
const SID = 'session-kind-1'

const delay = (ms) => new Promise((settle) => setTimeout(settle, ms))

function makeHub(file) {
  const store = new HubStore(file)
  const services = {
    sessionController: {
      inspect: async () => ({ meta: {} }),
      list: async () => ({ items: [] }),
      prompt: async () => {},
      resolveAgent: async (sessionId) => ({ agent: { id: sessionId } }),
    },
    sessionQuery: {
      readTitle: async () => ({ title: '' }),
      readTitleSnapshots: async () => [],
      filterEvents: async () => [],
      observeSession: async () => ({ events: [] }),
    },
    userQuestions: { answer: () => false },
    agents: { roots: () => [] },
  }
  return { hub: new Hub(store, services, [root]), store }
}

function cleanup() {
  for (const file of [...storeFiles, ...bakFiles]) rmSync(file, { force: true })
}

// ── v1 → v2 迁移 ────────────────────────────────────────────────────────────

test('v1 store：加载时备份、补默认 kinds、写回 v2，条目原样保留', () => {
  cleanup()
  const v1 = {
    version: 1,
    projects: [{ id: 'demo', name: 'demo', aliases: ['demo'], source: 'manual', createdAt: 1 }],
    bindings: { 'session-x': { projectId: 'demo', locked: true, by: 'user', updatedAt: 1 } },
    items: [
      { id: 'i1', projectId: 'demo', sessionId: 'session-x', sessionTitle: '', type: 'question', title: 't', body: 'b', priority: 'normal', status: 'pending', source: 'tool', createdAt: 1 },
    ],
  }
  writeFileSync(v1File, JSON.stringify(v1))

  const store = new HubStore(v1File)
  assert.equal(store.data.version, 2)
  assert.deepEqual(store.data.kinds, DEFAULT_KINDS)
  assert.equal(store.data.items.length, 1)
  assert.equal(store.data.items[0].type, 'question')
  assert.equal(store.data.projects[0].id, 'demo')
  assert.deepEqual(store.data.bindings['session-x'].projectId, 'demo')

  // 备份存在且内容逐字节等于迁移前的 v1 文件
  assert.ok(existsSync(v1File + '.v1.bak'), '应生成 <file>.v1.bak 备份')
  const backup = JSON.parse(readFileSync(v1File + '.v1.bak', 'utf8'))
  assert.equal(backup.version, 1)
  assert.equal(backup.kinds, undefined)
  assert.equal(backup.items.length, 1)

  // 原文件已写回 v2（迁移是同步落盘的，不等防抖）
  const written = JSON.parse(readFileSync(v1File, 'utf8'))
  assert.equal(written.version, 2)
  assert.deepEqual(written.kinds, DEFAULT_KINDS)
})

test('幂等：已是 v2 不迁移、不建备份；重复加载不再改写备份', () => {
  cleanup()
  const v2 = {
    version: 2,
    projects: [],
    bindings: {},
    items: [],
    kinds: { note: { label: '备忘', action: 'read' } },
  }
  writeFileSync(v2File, JSON.stringify(v2))
  const store = new HubStore(v2File)
  assert.equal(store.data.version, 2)
  assert.deepEqual(store.data.kinds, { note: { label: '备忘', action: 'read' } })
  assert.ok(!existsSync(v2File + '.v1.bak'), 'v2 文件不应产生 v1 备份')

  // 场景二：v1 迁移一次后再加载，备份内容不被二次改写
  const v1 = { version: 1, projects: [], bindings: {}, items: [] }
  writeFileSync(v1File, JSON.stringify(v1))
  new HubStore(v1File)
  const firstBackup = readFileSync(v1File + '.v1.bak', 'utf8')
  const again = new HubStore(v1File)
  assert.equal(again.data.version, 2)
  assert.equal(readFileSync(v1File + '.v1.bak', 'utf8'), firstBackup, '重复加载不应重建备份')
})

test('损坏文件不迁移不备份，从空开始且原文件保留', () => {
  cleanup()
  writeFileSync(v2File, '{ not json')
  const store = new HubStore(v2File)
  assert.equal(store.data.version, 2)
  assert.equal(store.data.items.length, 0)
  assert.ok(!existsSync(v2File + '.v1.bak'))
  assert.equal(readFileSync(v2File, 'utf8'), '{ not json', '损坏文件不应被覆盖')
})

// ── kinds 注册表 ────────────────────────────────────────────────────────────

test('内置四类：默认注册表与原语义一致，并新增只读通报', () => {
  assert.deepEqual(DEFAULT_KINDS, {
    question: { label: '待回答', action: 'answer', postable: true },
    deliverable: { label: '待查收', action: 'ack', postable: true },
    note: { label: '通报', action: 'read', postable: true },
    alert: { label: '中断', action: 'inspect', postable: false },
  })
  // 中断由宿主产生：默认不允许 agent 伪造；配置可显式放开
  assert.equal(resolveKinds().alert.postable, false)
  assert.equal(resolveKinds({ alert: { postable: true } }).alert.postable, true)
  assert.deepEqual(resolveKinds({}), DEFAULT_KINDS)
  assert.deepEqual(resolveKinds(null), DEFAULT_KINDS)
  assert.deepEqual(resolveKinds(undefined), DEFAULT_KINDS)
})

test('resolveKinds：配置覆盖内置条目、新增自定义类型、非法值回落', () => {
  const resolved = resolveKinds({
    question: { label: '问题', action: '' },
    note: { label: '备忘', action: 'read' },
    broken: { label: '坏条目', action: 'explode' },
    '': { label: '空键', action: 'read' },
  })
  assert.deepEqual(resolved.question, { label: '问题', action: 'answer', postable: true }, '空 action 回落到内置值并保留 postable')
  assert.deepEqual(resolved.note, { label: '备忘', action: 'read', postable: true }, '覆盖内置 note 时沿用可投递标记')
  assert.deepEqual(resolved.broken, { label: '坏条目', action: 'read' }, '未知 action 回落为 read')
  assert.equal(resolved[''], undefined, '空键被跳过')
  assert.deepEqual(resolved.deliverable, DEFAULT_KINDS.deliverable)
  assert.deepEqual(resolved.alert, DEFAULT_KINDS.alert)
})

test('未知 kind 容错：kindSpec 回落 read 且每种类型只告警一次', () => {
  cleanup()
  const { hub } = makeHub(v2File)
  const warnings = []
  hub.onWarn = (message) => warnings.push(message)

  const spec = hub.kindSpec('memo')
  assert.deepEqual(spec, { label: 'memo', action: 'read' })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /memo/)

  hub.kindSpec('memo')
  hub.kindSpec('memo')
  assert.equal(warnings.length, 1, '同一未知类型只告警一次')

  hub.kindSpec('ghost')
  assert.equal(warnings.length, 2, '另一种未知类型再告警一次')

  // 已注册类型不告警；内置四类原样返回
  assert.deepEqual(hub.kindSpec('question'), DEFAULT_KINDS.question)
  assert.deepEqual(hub.kindSpec('deliverable'), DEFAULT_KINDS.deliverable)
  assert.deepEqual(hub.kindSpec('note'), DEFAULT_KINDS.note)
  assert.deepEqual(hub.kindSpec('alert'), DEFAULT_KINDS.alert)
  assert.equal(warnings.length, 2)
})

test('store 原样加载未知类型的历史条目', () => {
  cleanup()
  writeFileSync(v2File, JSON.stringify({
    version: 2,
    projects: [],
    bindings: {},
    items: [
      { id: 'i1', projectId: null, sessionId: SID, sessionTitle: '', type: 'note', title: '备忘', body: '', priority: 'normal', status: 'pending', source: 'tool', createdAt: 1 },
    ],
    kinds: { note: { label: '备忘', action: 'read' } },
  }))
  const store = new HubStore(v2File)
  assert.equal(store.data.items[0].type, 'note')
})

// ── apply() 接线：hub_post 注册表校验 + 面板载荷 ────────────────────────────

/** 最小 fake ctx，对齐 turn-alert.test.mjs 的模式。 */
function makeFakeCtx(sessions) {
  const effects = []
  const webServers = []
  const tools = []
  const warnings = []
  const ctx = {
    effect(fn) {
      const result = fn()
      if (typeof result === 'function') effects.push(result)
      else if (result && typeof result.dispose === 'function') effects.push(() => result.dispose())
      return result
    },
    on() {
      return () => {}
    },
    setInterval() {
      return () => {}
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    systemPrompt: { section: () => () => {} },
    webServer: {
      register(registration) {
        webServers.push(registration)
        return () => {}
      },
    },
    logger: { warn: (message) => warnings.push(String(message)), info() {} },
    sessionController: {
      list: async () => ({ items: sessions }),
      inspect: async () => ({ meta: {} }),
      resolveAgent: async (sessionId) => ({ agent: { id: sessionId } }),
      prompt: async () => {},
    },
    sessionQuery: {
      readTitle: async () => ({ title: '' }),
      readTitleSnapshots: async (ids) => ids.map((sessionId) => ({ status: 'fulfilled', sessionId, value: { title: { title: '类型会话' } } })),
      filterEvents: async () => [],
      observeSession: async () => ({
        events: [],
        projections: { values: { userQuestions: { active: [], settled: [] } } },
      }),
    },
    userQuestions: { answer: () => false },
    agents: { roots: () => [{ id: SID }] },
    workspaceController: {
      follow: () => ({
        [Symbol.asyncIterator]() {
          return { next: async () => ({ done: true, value: undefined }) }
        },
      }),
    },
    sessionProjections: {},
  }
  return { ctx, effects, webServers, tools, warnings }
}

function fakeReq(url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  let index = 0
  return {
    headers: { host: '127.0.0.1:9999' },
    method: 'POST',
    url,
    [Symbol.asyncIterator]() {
      return {
        next: async () => (index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }),
      }
    },
  }
}

function fakeRes() {
  const out = { status: 0, body: '' }
  return {
    out,
    writeHead(status) {
      out.status = status
    },
    end(text) {
      out.body = text
    },
  }
}

async function callApi(handler, method, payload) {
  const res = fakeRes()
  await handler(fakeReq(`/rhub/api/${method}`, payload), res)
  return { status: res.out.status, json: JSON.parse(res.out.body) }
}

test('apply()：hub_post 按注册表校验，面板保留 type 并附 kind，未知类型回落 read', async () => {
  cleanup()
  const projectsRoot = mkdtempSync(join(tmpdir(), 'rhub-kind-'))
  // 预置一条未注册类型的历史条目：面板应按 read 展示并告警一次
  writeFileSync(applyStoreFile, JSON.stringify({
    version: 2,
    projects: [],
    bindings: {},
    items: [
      { id: 'ghost-1', projectId: null, sessionId: SID, sessionTitle: '', type: 'ghost', title: '旧类型', body: '', priority: 'normal', status: 'pending', source: 'tool', createdAt: 1 },
    ],
  }))
  const fake = makeFakeCtx([{ sessionId: SID, title: '类型会话', running: false, updatedAt: Date.now() }])
  try {
    apply(fake.ctx, {
      projectsRoot,
      projectsRoots: [projectsRoot],
      storeFile: applyStoreFile,
      alertKinds: ['error', 'interrupted', 'aborted:disposed'],
      alertBackfillHours: 72,
      alertInterruptedGraceMinutes: 30,
      autoTrashProgrammatic: false,
      discovery: {},
      kinds: { note: { label: '备忘', action: 'read' } },
    })
    const hubPost = fake.tools.find((tool) => tool.name === 'hub_post')
    assert.ok(hubPost, '应注册 hub_post 工具')
    const exec = { agent: { id: SID } }

    // 注册表内的类型可投递：内置两类与自定义 note
    for (const type of ['question', 'deliverable', 'note']) {
      const result = await hubPost.execute({ type, title: `${type} 标题` }, exec)
      assert.equal(result.ok, true, `已注册类型 ${type} 应可投递`)
    }
    // 未注册类型被拒绝，错误信息列出已注册类型
    const rejected = await hubPost.execute({ type: 'bogus', title: 'x' }, exec)
    assert.equal(rejected.ok, false)
    assert.match(rejected.error, /question/)
    assert.match(rejected.error, /note/)
    // 内置 alert 由宿主产生，hub_post 默认拒绝伪造
    const forged = await hubPost.execute({ type: 'alert', title: '伪造中断' }, exec)
    assert.equal(forged.ok, false)
    assert.match(forged.error, /宿主/)

    const handler = fake.webServers[0]?.handler
    const panel = await callApi(handler, 'panel')
    assert.equal(panel.json.ok, true)
    // 面板携带注册表；note 已注册，ghost 未注册
    assert.deepEqual(panel.json.value.kinds.note, { label: '备忘', action: 'read', postable: true })
    assert.deepEqual(panel.json.value.kinds.question, DEFAULT_KINDS.question)
    const items = panel.json.value.items
    const byType = Object.fromEntries(items.map((it) => [it.type, it]))
    // type 字段保留原值，kind 按注册表解析
    assert.equal(byType.question.type, 'question')
    assert.deepEqual(byType.question.kind, DEFAULT_KINDS.question)
    assert.deepEqual(byType.deliverable.kind, DEFAULT_KINDS.deliverable)
    assert.deepEqual(byType.note.kind, { label: '备忘', action: 'read', postable: true })
    assert.deepEqual(byType.ghost.kind, { label: 'ghost', action: 'read' }, '未注册类型按 read 展示')

    // 未注册类型只在首次显示时告警一次
    const ghostWarns = () => fake.warnings.filter((w) => w.includes('ghost')).length
    assert.equal(ghostWarns(), 1)
    await callApi(handler, 'panel')
    assert.equal(ghostWarns(), 1, '重复渲染不再告警')

    // kinds 快照已落盘（防抖 150ms，等待后读文件）
    await delay(250)
    const written = JSON.parse(readFileSync(applyStoreFile, 'utf8'))
    assert.deepEqual(written.kinds.note, { label: '备忘', action: 'read', postable: true })
    assert.equal(written.version, 2)
  } finally {
    for (const dispose of [...fake.effects].reverse()) {
      try {
        dispose()
      } catch {
        /* 单条清理失败不影响其余 */
      }
    }
    rmSync(projectsRoot, { recursive: true, force: true })
  }
})

test.after(async () => {
  // HubStore 的 150ms 防抖 flush 可能仍在队列里：先清文件，等抖动结束再清一次
  cleanup()
  await delay(250)
  cleanup()
})
