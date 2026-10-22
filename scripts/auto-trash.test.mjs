/**
 * 程序化会话自动回收回归测试。
 *
 * 背景：headless 或脚本从 stdin 发起的一次性会话没有客户端标识，工作由注册任务的
 * 主会话承接，不应计入指挥中心。host 侧因此新增：
 * 1. `firstUserMessageEvent` / `isProgrammaticUserSource` 判定首条用户消息来源；
 * 2. Hub 的判定缓存、回收站写入与人工恢复豁免；
 * 3. apply() 的周期扫描（本测试覆盖判定与状态迁移，不启动宿主）。
 *
 * 依赖构建产物：先 `node_modules/.bin/tsc -p tsconfig.json`，
 * 再 `node --test scripts/auto-trash.test.mjs`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { Hub, firstUserMessageEvent, isProgrammaticUserSource } from '../lib/host/core.js'
import { HubStore } from '../lib/host/store.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temp = mkdtempSync(join(tmpdir(), 'rhub-auto-trash-'))
const storeFile = join(temp, 'research-hub.json')
process.on('exit', () => rmSync(temp, { recursive: true, force: true }))

/** 一个只满足这些用例的空服务面。 */
const services = {
  sessionController: {},
  sessionQuery: {},
  userQuestions: {},
  agents: {},
}

function freshHub() {
  const store = new HubStore(storeFile)
  return { hub: new Hub(store, services, [join(temp, 'projects')]), store }
}

test('isProgrammaticUserSource：无 rpcId 的用户输入是程序化运行', () => {
  assert.equal(isProgrammaticUserSource({ kind: 'user' }), true)
  assert.equal(isProgrammaticUserSource({ kind: 'user', rpcId: '' }), true)
  assert.equal(isProgrammaticUserSource({ kind: 'user', rpcId: 'rpc-1', clientTimeZone: 'Asia/Shanghai' }), false)
})

test('isProgrammaticUserSource：非用户来源一律不判定为程序化', () => {
  assert.equal(isProgrammaticUserSource({ kind: 'schedule' }), false)
  assert.equal(isProgrammaticUserSource({ kind: 'goal' }), false)
  assert.equal(isProgrammaticUserSource(undefined), false)
  assert.equal(isProgrammaticUserSource(null), false)
})

test('firstUserMessageEvent：取首条 user/message，缺省返回 undefined', () => {
  const events = [
    { type: 'permission/preset', data: {} },
    { type: 'user/message', data: { source: { kind: 'user', rpcId: 'rpc-1' } } },
    { type: 'user/message', data: { source: { kind: 'user' } } },
  ]
  assert.equal(firstUserMessageEvent(events)?.data?.source?.rpcId, 'rpc-1')
  assert.equal(firstUserMessageEvent([]), undefined)
  assert.equal(firstUserMessageEvent(undefined), undefined)
})

test('判定结果按会话缓存并持久化', () => {
  const { hub, store } = freshHub()
  assert.equal(hub.programmaticVerdict('session-a'), undefined)
  hub.recordProgrammaticVerdict('session-a', true)
  hub.recordProgrammaticVerdict('session-b', false)
  assert.equal(hub.programmaticVerdict('session-a'), true)
  assert.equal(hub.programmaticVerdict('session-b'), false)
  store.flush()
  const reopened = new HubStore(storeFile)
  assert.equal(reopened.data.programmatic?.['session-a'], true)
  assert.equal(reopened.data.programmatic?.['session-b'], false)
})

test('回收站写入幂等，恢复后写入长期豁免', () => {
  const { hub, store } = freshHub()
  assert.equal(hub.isTrashed('session-c'), false)
  assert.equal(hub.trashSession('session-c'), true)
  assert.equal(hub.trashSession('session-c'), false)
  assert.equal(hub.isTrashed('session-c'), true)
  hub.restoreSession('session-c')
  assert.equal(hub.isTrashed('session-c'), false)
  assert.equal(hub.isTrashExempt('session-c'), true)
  store.flush()
  const reopened = new HubStore(storeFile)
  assert.equal(reopened.data.trashed?.['session-c'], undefined)
  assert.equal(typeof reopened.data.trashExempt?.['session-c'], 'number')
})

test('显式绑定优先：用户与 agent 的绑定不被自动回收', () => {
  const { hub } = freshHub()
  hub.data.bindings['session-locked'] = { projectId: 'p', locked: true, by: 'user', updatedAt: 1 }
  hub.data.bindings['session-agent'] = { projectId: 'p', locked: false, by: 'agent', updatedAt: 1 }
  hub.data.bindings['session-auto'] = { projectId: 'p', locked: false, by: 'auto', updatedAt: 1 }
  assert.equal(hub.hasExplicitBinding('session-locked'), true)
  assert.equal(hub.hasExplicitBinding('session-agent'), true)
  assert.equal(hub.hasExplicitBinding('session-auto'), false)
  assert.equal(hub.hasExplicitBinding('session-unknown'), false)
})
