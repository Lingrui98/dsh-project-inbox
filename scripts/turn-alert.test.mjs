/**
 * 会话中断告警回归测试。
 *
 * 背景：会话因模型服务中断、宿主崩溃或主动取消而停在半途时，agent 本身不会
 * 再调用 hub_post，用户离开会话后无从得知。host 侧因此新增：
 * 1. `foldTurnAlerts` 从会话日志尾部折叠出中断回合；
 * 2. Hub 的 recordTurnAlerts / settleAlertsForSession 写入/结算告警条目；
 * 3. apply() 的实时 session/event 订阅与面板、角标的 alerts 计数。
 *
 * 本测试守护折叠语义（tailOnly 尾部恢复、原因白名单）、Hub 去重与结算，
 * 以及 apply() 接线后的面板/角标载荷。所有用例确定性：不依赖真实会话。
 *
 * 依赖构建产物：先 `node_modules/.bin/tsc -p tsconfig.json`，
 * 再 `node --test scripts/turn-alert.test.mjs`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  Hub,
  DEFAULT_ALERT_KINDS,
  foldTurnAlerts,
  alertTitle,
  alertBody,
  alertKeyOf,
  selectAlertCandidates,
} from '../lib/host/core.js'
import { HubStore } from '../lib/host/store.js'
import { apply } from '../lib/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeModules = join(root, 'node_modules')
const storeFile = join(nodeModules, '.turn-alert-test.json')
const restartStoreFile = join(nodeModules, '.turn-alert-test-restart.json')
const applyStoreFile = join(nodeModules, '.turn-alert-test-apply.json')
const storeFiles = [storeFile, restartStoreFile, applyStoreFile]
const SID = 'session-alert-1'
const OTHER_SID = 'session-alert-2'

const delay = (ms) => new Promise((settle) => setTimeout(settle, ms))

/** 与真实会话日志同形：turn/end 事件的 data.reason 决定告警类别。 */
const turnEnd = (turn, reason, time = Date.now()) => ({ type: 'turn/end', time, data: { turn, reason } })
const turnStart = (turn, time = Date.now()) => ({ type: 'turn/start', time, data: { turn } })

function errorReason(overrides = {}) {
  return {
    kind: 'error',
    error: { code: 'PI_AI_ERROR', message: 'upstream connect timeout', status: 502, ...overrides },
  }
}
const interruptedReason = () => ({ kind: 'interrupted' })
const maxTokensReason = () => ({ kind: 'max-tokens' })
const abortedReason = (cause) => ({ kind: 'aborted', ...(cause === undefined ? {} : { reason: { kind: cause } }) })
const candidate = (overrides = {}) => ({ turn: 1, kind: 'error', time: Date.now() - 2000, ...overrides })

/** 独立 Hub（不落盘共享状态）；调用前清掉同名临时 store。 */
function makeHub(file = storeFile) {
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

// ── 折叠：原因白名单 ────────────────────────────────────────────────────────

test('DEFAULT_ALERT_KINDS 默认值固定为 error/interrupted/aborted:disposed', () => {
  assert.deepEqual(DEFAULT_ALERT_KINDS, ['error', 'interrupted', 'aborted:disposed'])
})

test('error 折叠出 code 与含 message 的 detail', () => {
  const [found] = foldTurnAlerts([turnEnd(7, errorReason(), 1000)])
  assert.equal(found.turn, 7)
  assert.equal(found.kind, 'error')
  assert.equal(found.code, 'PI_AI_ERROR')
  assert.equal(found.time, 1000)
  assert.match(found.detail, /upstream connect timeout/)
  assert.match(found.detail, /HTTP 502/)
  assert.deepEqual(foldTurnAlerts([turnEnd(7, { kind: 'error', error: { message: 'boom' } }, 1000)]), [
    { turn: 7, kind: 'error', code: undefined, detail: 'boom', time: 1000 },
  ])
})

test('interrupted 折叠出中断说明', () => {
  const [found] = foldTurnAlerts([turnEnd(2, interruptedReason(), 5)])
  assert.equal(found.kind, 'interrupted')
  assert.equal(found.turn, 2)
  assert.match(found.detail, /中断/)
})

test('默认只命中 aborted:disposed，不命中 aborted:parent / aborted:user', () => {
  const disposed = foldTurnAlerts([turnEnd(3, abortedReason('disposed'), 1)])
  assert.equal(disposed.length, 1)
  assert.equal(disposed[0].kind, 'aborted')
  assert.equal(disposed[0].cause, 'disposed')
  assert.match(disposed[0].detail, /宿主关闭/)
  assert.deepEqual(foldTurnAlerts([turnEnd(3, abortedReason('parent'), 1)]), [])
  assert.deepEqual(foldTurnAlerts([turnEnd(3, abortedReason('user'), 1)]), [])
  // 缺 reason.reason 的历史取消按 legacy 处理，默认不命中
  assert.deepEqual(foldTurnAlerts([turnEnd(3, abortedReason(undefined), 1)]), [])
})

test('max-tokens 默认不命中，配置后命中', () => {
  assert.deepEqual(foldTurnAlerts([turnEnd(4, maxTokensReason(), 1)]), [])
  const [found] = foldTurnAlerts([turnEnd(4, maxTokensReason(), 1)], ['max-tokens'])
  assert.equal(found.kind, 'max-tokens')
  assert.match(found.detail, /token/)
})

test('completed / blocked / forked 永不命中（即使配置 all）', () => {
  const anyKinds = ['error', 'interrupted', 'max-tokens', 'aborted', 'aborted:user', 'all']
  for (const kind of ['completed', 'blocked', 'forked']) {
    assert.deepEqual(foldTurnAlerts([turnEnd(1, { kind }, 1)], anyKinds), [], kind)
  }
})

test('自定义 kinds：aborted 命中全部取消原因，aborted:user 只命中 user', () => {
  assert.equal(foldTurnAlerts([turnEnd(1, abortedReason('parent'), 1)], ['aborted'])[0].cause, 'parent')
  assert.equal(foldTurnAlerts([turnEnd(1, abortedReason('hook'), 1)], ['aborted'])[0].cause, 'hook')
  assert.equal(foldTurnAlerts([turnEnd(1, abortedReason('user'), 1)], ['aborted:user']).length, 1)
  assert.deepEqual(foldTurnAlerts([turnEnd(1, abortedReason('parent'), 1)], ['aborted:user']), [])
})

// ── 折叠：尾部语义与文案 ────────────────────────────────────────────────────

test('尾部语义：之后出现 turn/start 视为已恢复，空结果', () => {
  assert.deepEqual(foldTurnAlerts([turnEnd(7, errorReason(), 1000), turnStart(8, 1100)]), [])
  assert.deepEqual(
    foldTurnAlerts([turnEnd(7, errorReason(), 1000), turnStart(8, 1100), turnEnd(8, { kind: 'completed' }, 1200)]),
    [],
  )
})

test('尾部语义：中断之后只有非 turn/start 事件时仍命中', () => {
  const events = [turnEnd(7, errorReason(), 1000), { type: 'session/title', time: 1100, data: { title: '新标题' } }]
  const found = foldTurnAlerts(events)
  assert.equal(found.length, 1)
  assert.equal(found[0].turn, 7)
})

test('tailOnly:false 返回窗口内全部中断历史，默认只返回尾部一条', () => {
  const events = [
    turnEnd(1, errorReason(), 1000),
    turnStart(2, 1100),
    turnEnd(2, interruptedReason(), 1200),
    { type: 'session/title', time: 1300, data: { title: 'x' } },
  ]
  assert.deepEqual(foldTurnAlerts(events).map((c) => c.kind), ['interrupted'])
  assert.deepEqual(foldTurnAlerts(events, DEFAULT_ALERT_KINDS, { tailOnly: false }).map((c) => c.kind), [
    'error',
    'interrupted',
  ])
})

test('alertTitle/alertBody 文案含「回合执行失败」「轮次」「原因」，UNKNOWN 码不展示', () => {
  const [errorCandidate] = foldTurnAlerts([turnEnd(5, errorReason(), 1000)])
  assert.match(alertTitle(errorCandidate), /回合执行失败/)
  assert.match(alertTitle({ ...errorCandidate, code: 'UNKNOWN' }), /回合执行失败$/)
  assert.doesNotMatch(alertTitle({ ...errorCandidate, code: 'UNKNOWN' }), /UNKNOWN/)
  assert.doesNotMatch(alertBody({ ...errorCandidate, code: 'UNKNOWN' }), /UNKNOWN/)
  assert.match(alertTitle(errorCandidate), /PI_AI_ERROR/)
  const errorBody = alertBody(errorCandidate)
  assert.match(errorBody, /轮次/)
  assert.match(errorBody, /原因/)
  assert.match(errorBody, /upstream connect timeout/)

  const [abortedCandidate] = foldTurnAlerts([turnEnd(6, abortedReason('user'), 1000)], ['aborted'])
  assert.match(alertTitle(abortedCandidate), /取消/)
  const abortedBody = alertBody(abortedCandidate)
  assert.match(abortedBody, /轮次/)
  assert.match(abortedBody, /原因/)
  assert.match(abortedBody, /用户取消/)
})

test('selectAlertCandidates：冷读的 interrupted 需要静默够久才判定为真', () => {
  const now = 1_000_000_000
  const grace = 30 * 60_000
  const window = 72 * 3600_000
  const opts = { now, windowMs: window, interruptedGraceMs: grace }
  const interrupted = { turn: 1, kind: 'interrupted', time: now - 60_000 }
  const stale = { ...interrupted, time: now - grace - 60_000 }
  const errorRecent = { turn: 2, kind: 'error', code: 'PI_AI_ERROR', time: now - 60_000 }

  // 冷读 + 最近还在活动：别的进程里的会话，推迟判定，不推进游标
  const preparedRecent = selectAlertCandidates([interrupted], { ...opts, source: 'prepared' })
  assert.deepEqual(preparedRecent.alerts, [])
  assert.equal(preparedRecent.deferred, true)

  // 冷读 + 静默超过宽限：判定为真中断
  const preparedStale = selectAlertCandidates([stale], { ...opts, source: 'prepared' })
  assert.deepEqual(preparedStale.alerts.map((c) => c.kind), ['interrupted'])
  assert.equal(preparedStale.deferred, false)

  // live 观测的 interrupted 是持久化补记事件，立刻投递
  const live = selectAlertCandidates([interrupted], { ...opts, source: 'live' })
  assert.deepEqual(live.alerts.map((c) => c.kind), ['interrupted'])
  assert.equal(live.deferred, false)

  // error 不受宽限影响：失败事件本身就是真实记录
  const errorPrepared = selectAlertCandidates([errorRecent], { ...opts, source: 'prepared' })
  assert.deepEqual(errorPrepared.alerts.map((c) => c.kind), ['error'])
  assert.equal(errorPrepared.deferred, false)

  // 窗口外的候选直接丢弃，且不算推迟
  const outOfWindow = selectAlertCandidates([{ ...errorRecent, time: now - window - 1000 }], { ...opts, source: 'prepared' })
  assert.deepEqual(outOfWindow.alerts, [])
  assert.equal(outOfWindow.deferred, false)
})

test('alertKeyOf 是会话内按轮次去重的稳定键', () => {
  assert.equal(alertKeyOf(SID, 3), `${SID}#3`)
  assert.notEqual(alertKeyOf(SID, 3), alertKeyOf(OTHER_SID, 3))
})

// ── Hub 方法：写入、去重、结算、扫描游标 ─────────────────────────────────────

test('recordTurnAlerts 建出 pending 的系统告警条目，alert 事实齐全', async () => {
  rmSync(storeFile, { force: true })
  const { hub } = makeHub()
  const created = await hub.recordTurnAlerts(SID, foldTurnAlerts([turnEnd(3, errorReason(), Date.now())]))
  assert.equal(created.length, 1)
  const item = created[0]
  assert.equal(item.type, 'alert')
  assert.equal(item.source, 'system')
  assert.equal(item.status, 'pending')
  assert.equal(item.sessionId, SID)
  assert.match(item.title, /回合执行失败/)
  assert.match(item.body, /轮次/)
  assert.deepEqual(item.alert, {
    turn: 3,
    kind: 'error',
    code: 'PI_AI_ERROR',
    detail: 'upstream connect timeout，HTTP 502',
  })
  assert.equal(hub.data.alertKeys[alertKeyOf(SID, 3)], item.id)
})

test('同会话同轮重复写入只建一条（含跨重启去重与 alertKeys 丢失兜底）', async () => {
  rmSync(restartStoreFile, { force: true })
  const first = makeHub(restartStoreFile)
  const candidates = [candidate({ turn: 4 })]
  const created = await first.hub.recordTurnAlerts(SID, candidates)
  assert.equal(created.length, 1)
  const again = await first.hub.recordTurnAlerts(SID, candidates)
  assert.equal(again.length, 0)
  assert.equal(first.hub.data.items.length, 1)
  first.store.flush()

  // 模拟宿主重启：同一 store 文件新建 Hub，去重键随文件保留
  const second = makeHub(restartStoreFile)
  assert.equal(second.hub.data.items.length, 1)
  const createdAfterRestart = await second.hub.recordTurnAlerts(SID, candidates)
  assert.equal(createdAfterRestart.length, 0)
  assert.equal(second.hub.data.items.length, 1)
  assert.equal(second.hub.data.alertKeys[alertKeyOf(SID, 4)], created[0].id)

  // 去重键丢失时按已有条目兜底
  delete second.hub.data.alertKeys[alertKeyOf(SID, 4)]
  assert.equal((await second.hub.recordTurnAlerts(SID, candidates)).length, 0)
  assert.equal(second.hub.data.alertKeys[alertKeyOf(SID, 4)], 'existing')
  assert.equal(second.hub.data.items.length, 1)
})

test('settleAlertsForSession 只结算该会话的 pending 告警', async () => {
  rmSync(storeFile, { force: true })
  const { hub } = makeHub()
  await hub.recordTurnAlerts(SID, [candidate({ turn: 1 })])
  await hub.recordTurnAlerts(OTHER_SID, [candidate({ turn: 1 })])
  assert.equal(hub.settleAlertsForSession(SID), 1)
  const mine = hub.data.items.find((it) => it.sessionId === SID)
  const other = hub.data.items.find((it) => it.sessionId === OTHER_SID)
  assert.equal(mine.status, 'answered')
  assert.equal(mine.answerText, '会话已恢复运行')
  assert.ok(mine.settledAt > 0)
  assert.equal(other.status, 'pending')
  assert.equal(hub.settleAlertsForSession(SID), 0)
})

test('会话已恢复后再补写更早时间的告警，直接为 answered（竞态保护）', async () => {
  rmSync(storeFile, { force: true })
  const { hub } = makeHub()
  hub.settleAlertsForSession(SID)
  const [late] = await hub.recordTurnAlerts(SID, [candidate({ turn: 9, time: Date.now() - 5000 })])
  assert.equal(late.status, 'answered')
  assert.equal(late.answerText, '会话已恢复运行')
})

test('shouldScanSession / markSessionScanned / pruneScanCursors 游标行为', () => {
  rmSync(storeFile, { force: true })
  const { hub } = makeHub()
  assert.equal(hub.shouldScanSession(SID, 1000, 0), true)
  assert.equal(hub.shouldScanSession(SID, 500, 1000), false, '早于可见时间窗不扫')
  hub.markSessionScanned(SID, 1000)
  assert.equal(hub.shouldScanSession(SID, 1000, 0), false, '同一 updatedAt 不重复扫')
  assert.equal(hub.shouldScanSession(SID, 2000, 0), true, '日志更新后要再扫')
  hub.markSessionScanned(OTHER_SID, 3000)
  assert.ok(hub.data.alertScans[OTHER_SID])
  hub.pruneScanCursors(new Set([SID]))
  assert.ok(hub.data.alertScans[SID], '保留可见会话的游标')
  assert.equal(hub.data.alertScans[OTHER_SID], undefined, '丢弃不可见会话的游标')
})

// ── apply() 接线：实时订阅 + 面板/角标载荷 ──────────────────────────────────

/** 构造 apply() 需要的 fake ctx；effect disposer 全部收集，测试末尾统一调用。 */
function makeFakeCtx(sessions) {
  const listeners = new Map()
  const effects = []
  const webServers = []
  const tools = []
  const sections = []
  let currentEffect

  const ctx = {
    effect(fn, label) {
      const previous = currentEffect
      currentEffect = label
      let result
      try {
        result = fn()
      } finally {
        currentEffect = previous
      }
      if (typeof result === 'function') effects.push({ label, dispose: result })
      else if (result && typeof result.dispose === 'function') effects.push({ label, dispose: () => result.dispose() })
      return result
    },
    on(name, fn) {
      const entry = { fn, effect: currentEffect }
      const list = listeners.get(name) ?? []
      list.push(entry)
      listeners.set(name, list)
      return () => {
        const index = list.indexOf(entry)
        if (index >= 0) list.splice(index, 1)
      }
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
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    webServer: {
      register(registration) {
        webServers.push(registration)
        return () => {}
      },
    },
    logger: { warn() {}, info() {} },
    sessionController: {
      list: async () => ({ items: sessions }),
      inspect: async () => ({ meta: {} }),
      resolveAgent: async (sessionId) => ({ agent: { id: sessionId } }),
      prompt: async () => {},
    },
    sessionQuery: {
      readTitle: async () => ({ title: '' }),
      readTitleSnapshots: async (ids) => ids.map((sessionId) => ({ status: 'fulfilled', sessionId, value: { title: { title: '告警会话' } } })),
      filterEvents: async () => [],
      observeSession: async () => ({
        events: [],
        projections: { values: { userQuestions: { active: [], settled: [] } } },
      }),
    },
    userQuestions: { answer: () => false },
    agents: { roots: () => [] },
    workspaceController: {
      // 空帧流：apply 的归档订阅立刻正常结束
      follow: () => ({
        [Symbol.asyncIterator]() {
          return { next: async () => ({ done: true, value: undefined }) }
        },
      }),
    },
    sessionProjections: {},
  }
  return { ctx, listeners, effects, webServers, tools, sections }
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
  const out = { status: 0, headers: null, body: '' }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
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

test('apply() 接线：实时 turn/end 建告警，面板与角标计数，turn/start 结算', async () => {
  const projectsRoot = mkdtempSync(join(tmpdir(), 'rhub-alert-'))
  rmSync(applyStoreFile, { force: true })
  const sessions = [{ sessionId: SID, title: '告警会话', running: false, updatedAt: Date.now() }]
  const fake = makeFakeCtx(sessions)
  try {
    apply(fake.ctx, {
      projectsRoot,
      projectsRoots: [projectsRoot],
      storeFile: applyStoreFile,
      alertKinds: [...DEFAULT_ALERT_KINDS],
      alertBackfillHours: 72,
      alertInterruptedGraceMinutes: 30,
      autoTrashProgrammatic: false,
    })
    const handler = fake.webServers[0]?.handler
    assert.equal(typeof handler, 'function', '应注册 /rhub/api 处理器')
    const alertEntry = fake.listeners
      .get('session/event')
      ?.find((entry) => entry.effect === 'research-hub: turn interruption alerts')
    assert.ok(alertEntry, '应注册中断告警的 session/event 订阅')
    const emit = (session, event) => alertEntry.fn(session, event)
    const alertSession = { id: SID, header: {} }

    const initial = await callApi(handler, 'panel')
    assert.equal(initial.json.ok, true)
    assert.equal(initial.json.value.items.filter((it) => it.type === 'alert').length, 0)

    // 同一 turn/end 事件重复 emit 两次：只建一条
    const errorEvent = turnEnd(4, errorReason(), Date.now())
    await emit(alertSession, errorEvent)
    await emit(alertSession, errorEvent)
    const panel = await callApi(handler, 'panel')
    const alerts = panel.json.value.items.filter((it) => it.type === 'alert')
    assert.equal(alerts.length, 1)
    const item = alerts[0]
    assert.equal(item.type, 'alert')
    assert.equal(item.source, 'system')
    assert.equal(item.status, 'pending')
    assert.equal(item.sessionId, SID)
    assert.equal(item.alert.kind, 'error')
    assert.equal(item.alert.turn, 4)
    assert.equal(item.alert.code, 'PI_AI_ERROR')
    assert.match(item.alert.detail, /upstream connect timeout/)
    assert.match(item.alert.detail, /HTTP 502/)
    assert.match(item.title, /回合执行失败/)
    assert.match(item.body, /轮次/)
    assert.equal(panel.json.value.unassignedCounts.alerts, 1)
    const badge = await callApi(handler, 'badge')
    assert.equal(badge.json.value.alerts, 1)

    // 子代理 / 子会话的中断不进指挥中心
    await emit({ id: SID, header: { origin: 'subagent' } }, turnEnd(9, errorReason(), Date.now()))
    await emit({ id: SID, header: { parentSession: 'session-parent' } }, turnEnd(10, errorReason(), Date.now()))
    const panelIgnored = await callApi(handler, 'panel')
    assert.equal(panelIgnored.json.value.items.filter((it) => it.type === 'alert').length, 1)
    assert.equal(panelIgnored.json.value.unassignedCounts.alerts, 1)

    // 会话继续运行：该条告警结算为 answered，角标清零
    await emit(alertSession, turnStart(5, Date.now()))
    const badgeSettled = await callApi(handler, 'badge')
    assert.equal(badgeSettled.json.value.alerts, 0)
    const panelSettled = await callApi(handler, 'panel')
    const settled = panelSettled.json.value.items.filter((it) => it.type === 'alert')
    assert.equal(settled.length, 1)
    assert.equal(settled[0].status, 'answered')
    assert.equal(settled[0].answerText, '会话已恢复运行')
    assert.equal(panelSettled.json.value.unassignedCounts.alerts, 0)

    // 恢复后重放同一历史事件：不产生第二条
    await emit(alertSession, errorEvent)
    const panelReplay = await callApi(handler, 'panel')
    assert.equal(panelReplay.json.value.items.filter((it) => it.type === 'alert').length, 1)
  } finally {
    for (const effect of [...fake.effects].reverse()) {
      try {
        effect.dispose()
      } catch {
        /* 单条清理失败不影响其余 */
      }
    }
    rmSync(projectsRoot, { recursive: true, force: true })
  }
})

test.after(async () => {
  // HubStore 的 150ms 防抖 flush 可能仍在队列里：先清文件，等抖动结束再清一次
  for (const file of storeFiles) rmSync(file, { force: true })
  await delay(250)
  for (const file of storeFiles) rmSync(file, { force: true })
})
