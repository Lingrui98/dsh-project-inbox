/**
 * 面板首页性能回归测试。
 *
 * 背景：首页原来在每次请求里做 list、深度扫描、AUQ 全量 observeSession 和
 * 标题刷新，冷启动 2.6-7.8s、轮询 0.8-4.7s。改为：
 * 1. `syncSessions` 后台拉列表并落盘快照，面板首页只读快照（零 IO）；
 * 2. 快照只存首页可见会话（排除子代理、子会话、空白会话）；
 * 3. 深度推断结论持久化，重启后标题不变就直接复用；
 * 4. AUQ 镜像同步游标持久化，日志没更新就跳过；
 * 5. `listSessionsCached` 在内存无缓存时强制回源，不依赖快照节流。
 *
 * 依赖构建产物：先 `node scripts/build.sh` 或 `npm run build`，
 * 再 `node --test scripts/panel-perf.test.mjs`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { Hub } from '../lib/host/core.js'
import { HubStore } from '../lib/host/store.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temp = mkdtempSync(join(tmpdir(), 'rhub-panel-perf-'))
process.on('exit', () => rmSync(temp, { recursive: true, force: true }))

let seq = 0
function freshFile() {
  seq += 1
  return join(temp, `research-hub-${seq}.json`)
}

const roots = [join(temp, 'projects')]

/** 会话列表行：首页只应展示前两条。 */
const rows = [
  { sessionId: 'session-main', updatedAt: 10, running: false },
  { sessionId: 'session-running', updatedAt: 20, running: true },
  { sessionId: 'session-sub', updatedAt: 30, origin: 'subagent' },
  { sessionId: 'session-child', updatedAt: 40, parentSessionId: 'session-main' },
  { sessionId: 'session-blank', updatedAt: 50, blank: true },
]

function makeServices(items = rows) {
  const calls = { list: 0 }
  return {
    calls,
    services: {
      sessionController: {
        list: async () => {
          calls.list += 1
          return { items }
        },
      },
      sessionQuery: {},
      userQuestions: {},
      agents: {},
    },
  }
}

test('syncSessions 只把首页可见会话写进快照（排除子代理、子会话、空白）', async () => {
  const { services, calls } = makeServices()
  const hub = new Hub(new HubStore(freshFile()), services, roots)
  assert.equal(hub.hasSnapshot(), false)
  await hub.syncSessions(true)
  assert.deepEqual(hub.panelSessions().map((s) => s.id), ['session-main', 'session-running'])
  assert.equal(calls.list, 1)
})

test('syncSessions 15 秒内不重复拉列表，force 例外', async () => {
  const { services, calls } = makeServices()
  const hub = new Hub(new HubStore(freshFile()), services, roots)
  await hub.syncSessions(true)
  assert.equal(calls.list, 1)
  await hub.syncSessions()
  assert.equal(calls.list, 1, '节流窗口内不应重复拉取')
  await hub.syncSessions(true)
  assert.equal(calls.list, 2, '显式刷新必须回源')
})

test('syncSessions 并发调用共享同一次拉取（单飞）', async () => {
  const { services, calls } = makeServices()
  const hub = new Hub(new HubStore(freshFile()), services, roots)
  await Promise.all([hub.syncSessions(true), hub.syncSessions(true), hub.syncSessions(true)])
  assert.equal(calls.list, 1)
})

test('快照持久化：新实例（模拟宿主重启）直接可渲染', async () => {
  const file = freshFile()
  const first = makeServices()
  const store = new HubStore(file)
  const hub = new Hub(store, first.services, roots)
  await hub.syncSessions(true)
  store.flush()

  const restarted = makeServices()
  const rebuilt = new Hub(new HubStore(file), restarted.services, roots)
  assert.equal(rebuilt.hasSnapshot(), true)
  assert.deepEqual(rebuilt.panelSessions().map((s) => s.id), ['session-main', 'session-running'])
  assert.equal(restarted.calls.list, 0, '重启后读快照不应再拉列表')
})

test('深度推断结论持久化，标题不变就复用（标题变了才重扫）', () => {
  const file = freshFile()
  const store = new HubStore(file)
  const hub = new Hub(store, makeServices().services, roots)
  hub.commitInferred('session-a', 'Title A', 'proj-a')
  store.flush()

  const rebuilt = new Hub(new HubStore(file), makeServices().services, roots)
  assert.deepEqual(rebuilt.cachedInference('session-a', 'Title A'), { known: true, projectId: 'proj-a' })
  assert.deepEqual(rebuilt.cachedInference('session-a', 'Title B'), { known: false, projectId: null })
})

test('AUQ 同步游标持久化，并按可见集合裁剪', () => {
  const file = freshFile()
  const store = new HubStore(file)
  const hub = new Hub(store, makeServices().services, roots)
  assert.equal(hub.auqCursor('session-a'), undefined)
  hub.markAuqSynced('session-a', 123)
  store.flush()

  const rebuilt = new Hub(new HubStore(file), makeServices().services, roots)
  assert.equal(rebuilt.auqCursor('session-a')?.updatedAt, 123)
  rebuilt.pruneAuqCursors(new Set(['session-b']))
  assert.equal(rebuilt.auqCursor('session-a'), undefined)
})

test('listSessionsCached 在内存无缓存时强制回源（快照新也不行）', async () => {
  const file = freshFile()
  const first = makeServices()
  const store = new HubStore(file)
  const hub = new Hub(store, first.services, roots)
  await hub.syncSessions(true)
  store.flush()

  const restarted = makeServices()
  const rebuilt = new Hub(new HubStore(file), restarted.services, roots)
  const list = await rebuilt.listSessionsCached()
  assert.equal(restarted.calls.list, 1)
  assert.equal(list.length, rows.length)
})
