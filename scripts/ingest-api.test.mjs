/**
 * 外部投递 API（POST /rhub/api/post）测试。
 *
 * 覆盖：默认关闭不暴露、token 缺失拒绝启用、无/错 token 401、正确 token 建条、
 * 幂等键 TTL 内去重、project 匹配失败 400 并列出可用项目、限流 429、
 * loopbackOnly 行为、外部条目在面板可见（无会话、不参与会话过滤）。
 *
 * 所有用例确定性：不依赖真实会话。依赖构建产物：先 `npm run build`，
 * 再 `node --test scripts/ingest-api.test.mjs`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const TOKEN_ENV = 'RHUB_INGEST_TEST_TOKEN'
const TOKEN = 'test-token-3f8a2c'

const delay = (ms) => new Promise((settle) => setTimeout(settle, ms))

/** 最小 fake ctx，对齐 store-migration.test.mjs 的模式。 */
function makeFakeCtx(sessions = []) {
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
      readTitleSnapshots: async () => [],
      filterEvents: async () => [],
      observeSession: async () => ({
        events: [],
        projections: { values: { userQuestions: { active: [], settled: [] } } },
      }),
    },
    userQuestions: { answer: () => false },
    agents: { roots: () => [] },
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

function fakeReq(url, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  let index = 0
  return {
    headers: { host: '127.0.0.1:9999', ...headers },
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

async function callApi(handler, method, payload, headers) {
  const res = fakeRes()
  await handler(fakeReq(`/rhub/api/${method}`, payload, headers), res)
  return { status: res.out.status, json: JSON.parse(res.out.body) }
}

/** 起一套独立的插件实例：独立 store 文件与空项目根，测试间互不影响。 */
function setup(configOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rhub-ingest-'))
  const fake = makeFakeCtx()
  apply(fake.ctx, {
    projectsRoot: dir,
    projectsRoots: [dir],
    storeFile: join(dir, 'store.json'),
    alertKinds: ['error', 'interrupted', 'aborted:disposed'],
    alertBackfillHours: 72,
    alertInterruptedGraceMinutes: 30,
    autoTrashProgrammatic: false,
    discovery: {},
    kinds: {},
    ...configOverrides,
  })
  const handler = fake.webServers[0]?.handler
  assert.ok(handler, '应注册 /rhub/api 路由')
  const teardown = async () => {
    for (const dispose of [...fake.effects].reverse()) {
      try {
        dispose()
      } catch {
        /* 单条清理失败不影响其余 */
      }
    }
    await delay(250)
    rmSync(dir, { recursive: true, force: true })
  }
  return { fake, handler, teardown, dir }
}

const ingestOn = (overrides = {}) => ({
  ingest: {
    http: {
      enabled: true,
      tokenEnv: TOKEN_ENV,
      loopbackOnly: true,
      rateLimitPerMin: 30,
      idempotencyTtlHours: 24,
      ...overrides,
    },
  },
})

const auth = { authorization: `Bearer ${TOKEN}` }

test('默认关闭：post 与未知方法一样 404，不暴露能力', async () => {
  const { handler, teardown } = setup()
  try {
    const res = await callApi(handler, 'post', { type: 'deliverable', title: 'x' }, auth)
    assert.equal(res.status, 404)
    assert.equal(res.json.ok, false)
    assert.equal(res.json.error.code, 'not-found')
    const unknown = await callApi(handler, 'bogus-method', {})
    assert.equal(unknown.status, 404)
    assert.equal(unknown.json.error.code, 'not-found', 'post 的拒绝方式应与未知方法一致')
    // 面板仍然可用：默认配置行为不变
    const panel = await callApi(handler, 'panel')
    assert.equal(panel.status, 200)
    assert.equal(panel.json.ok, true)
  } finally {
    await teardown()
  }
})

test('enabled 但环境变量无 token：拒绝启用并告警，post 仍 404', async () => {
  delete process.env[TOKEN_ENV]
  const { fake, handler, teardown } = setup(ingestOn())
  try {
    const res = await callApi(handler, 'post', { type: 'deliverable', title: 'x' }, auth)
    assert.equal(res.status, 404)
    assert.ok(fake.warnings.some((w) => w.includes(TOKEN_ENV)), '应告警 token 环境变量为空')
  } finally {
    await teardown()
  }
})

test('鉴权：无 token 与错 token 401，正确 token 建条且 source=external', async () => {
  process.env[TOKEN_ENV] = TOKEN
  const { handler, teardown } = setup(ingestOn())
  try {
    const noAuth = await callApi(handler, 'post', { type: 'deliverable', title: '无 token' })
    assert.equal(noAuth.status, 401)
    const wrong = await callApi(handler, 'post', { type: 'deliverable', title: '错 token' }, { authorization: 'Bearer wrong' })
    assert.equal(wrong.status, 401)
    // 非 Bearer 形式同样拒绝
    const basic = await callApi(handler, 'post', { type: 'deliverable', title: '错 scheme' }, { authorization: `Basic ${TOKEN}` })
    assert.equal(basic.status, 401)

    const ok = await callApi(handler, 'post', { type: 'deliverable', title: 'CI 构建完成', body: 'commit abc' }, auth)
    assert.equal(ok.status, 200)
    assert.equal(ok.json.ok, true)
    assert.ok(ok.json.value.itemId, '应返回 itemId')
    assert.equal(ok.json.value.projectId, null, '未指定项目时进未分配收件箱')

    // 外部条目在面板可见：它没有会话，不参与可见会话过滤
    const panel = await callApi(handler, 'panel')
    const item = panel.json.value.items.find((it) => it.id === ok.json.value.itemId)
    assert.ok(item, '外部条目应出现在面板载荷里')
    assert.equal(item.source, 'external')
    assert.equal(item.sessionId, '')
    assert.equal(item.title, 'CI 构建完成')
    assert.equal(item.sessionVisible, false)
    // 角标计数同样包含外部条目
    const badge = await callApi(handler, 'badge')
    assert.equal(badge.json.value.pending, 1)
  } finally {
    await teardown()
  }
})

test('幂等：同一 idempotencyKey 在 TTL 内返回首次 itemId，不重复建条', async () => {
  process.env[TOKEN_ENV] = TOKEN
  const { handler, teardown } = setup(ingestOn())
  try {
    const body = { type: 'deliverable', title: 'nightly 报告', idempotencyKey: 'ci-20261022-1' }
    const first = await callApi(handler, 'post', body, auth)
    assert.equal(first.status, 200)
    const second = await callApi(handler, 'post', { ...body, title: '内容不同也算重复' }, auth)
    assert.equal(second.status, 200)
    assert.equal(second.json.value.itemId, first.json.value.itemId)
    assert.equal(second.json.value.idempotent, true)

    const panel = await callApi(handler, 'panel')
    const items = panel.json.value.items.filter((it) => it.source === 'external')
    assert.equal(items.length, 1, '重复投递不应重复建条')
    assert.equal(items[0].title, 'nightly 报告')
  } finally {
    await teardown()
  }
})

test('项目归属：未知 project 返回 400 并列出可用项目，别名可匹配', async () => {
  process.env[TOKEN_ENV] = TOKEN
  const { handler, teardown } = setup(ingestOn())
  try {
    await callApi(handler, 'addProject', { name: 'papers', aliases: ['论文'] })
    const bad = await callApi(handler, 'post', { type: 'deliverable', title: 'x', project: 'no-such-project' }, auth)
    assert.equal(bad.status, 400)
    assert.match(bad.json.error.message, /papers/, '错误信息应列出可用项目')

    const ok = await callApi(handler, 'post', { type: 'deliverable', title: 'x', project: '论文' }, auth)
    assert.equal(ok.status, 200)
    assert.equal(ok.json.value.projectId, 'papers')
  } finally {
    await teardown()
  }
})

test('限流：超过每 token 每分钟上限返回 429', async () => {
  process.env[TOKEN_ENV] = TOKEN
  const { handler, teardown } = setup(ingestOn({ rateLimitPerMin: 2 }))
  try {
    const first = await callApi(handler, 'post', { type: 'deliverable', title: '1' }, auth)
    const second = await callApi(handler, 'post', { type: 'deliverable', title: '2' }, auth)
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    const third = await callApi(handler, 'post', { type: 'deliverable', title: '3' }, auth)
    assert.equal(third.status, 429)
    assert.equal(third.json.error.code, 'rate-limited')
    // 鉴权失败不计入限流
    const unauth = await callApi(handler, 'post', { type: 'deliverable', title: 'x' })
    assert.equal(unauth.status, 401)
  } finally {
    await teardown()
  }
})

test('loopbackOnly：默认拒绝非回环；显式关闭后凭 token 可非回环投递', async () => {
  process.env[TOKEN_ENV] = TOKEN
  const remote = { host: 'hub.internal:9999', ...auth }
  // 默认 loopbackOnly=true：非回环 Host 被围栏拒绝（与其他方法一致）
  {
    const { handler, teardown } = setup(ingestOn())
    try {
      const res = await callApi(handler, 'post', { type: 'deliverable', title: 'x' }, remote)
      assert.equal(res.status, 403)
    } finally {
      await teardown()
    }
  }
  // loopbackOnly=false：非回环请求凭正确 token 通过
  {
    const { handler, teardown } = setup(ingestOn({ loopbackOnly: false }))
    try {
      const ok = await callApi(handler, 'post', { type: 'deliverable', title: '远程投递' }, remote)
      assert.equal(ok.status, 200)
      assert.equal(ok.json.ok, true)
      // 但 token 错误仍 401
      const wrong = await callApi(handler, 'post', { type: 'deliverable', title: 'x' }, { host: 'hub.internal:9999', authorization: 'Bearer nope' })
      assert.equal(wrong.status, 401)
      // 其他方法不受放行影响：非回环依旧 403
      const panel = await callApi(handler, 'panel', undefined, { host: 'hub.internal:9999' })
      assert.equal(panel.status, 403)
    } finally {
      await teardown()
    }
  }
})

test('类型校验：未注册类型 400，postable=false 的类型 403', async () => {
  process.env[TOKEN_ENV] = TOKEN
  const { handler, teardown } = setup(ingestOn())
  try {
    const unknown = await callApi(handler, 'post', { type: 'bogus', title: 'x' }, auth)
    assert.equal(unknown.status, 400)
    assert.match(unknown.json.error.message, /question/)
    const forged = await callApi(handler, 'post', { type: 'alert', title: '伪造中断' }, auth)
    assert.equal(forged.status, 403)
  } finally {
    await teardown()
  }
})
