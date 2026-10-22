/**
 * Phase 2 接线回归测试：hub_post → 条目事件钩子 → webhook 真发送；panel 透传布局。
 *
 * 覆盖 Lead 侧接线（agent 模块本身各有单测）：
 * 1. apply() 读取 webhooks 配置并创建 dispatcher，条目创建时真的发出带签名的 HTTP 请求；
 * 2. panel 载荷把 config.view 原样透传为 layout；
 * 3. 默认配置（无 webhooks / 空 view）不产生副作用。
 *
 * 依赖构建产物：先 `npm run build`，再 `node --test scripts/phase2-wiring.test.mjs`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { signWebhookPayload } from '../lib/host/webhook.js'

const SID = 'session-wiring'

function makeFakeCtx(sessions, warnings = []) {
  const effects = []
  const webServers = []
  const tools = []
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
    tools: { register(tool) { tools.push(tool); return () => {} } },
    systemPrompt: { section: () => () => {} },
    webServer: { register(registration) { webServers.push(registration); return () => {} } },
    logger: { warn: (message) => warnings.push(String(message)), info() {} },
    sessionController: {
      list: async () => ({ items: sessions }),
      inspect: async () => ({ meta: {}, events: [] }),
      resolveAgent: async (sessionId) => ({ agent: { id: sessionId } }),
      prompt: async () => {},
    },
    sessionQuery: {
      readTitle: async () => ({ title: '' }),
      readTitleSnapshots: async (ids) => ids.map((sessionId) => ({ status: 'fulfilled', sessionId, value: { title: { title: '接线会话' } } })),
      filterEvents: async () => [],
      observeSession: async () => ({ events: [], projections: { values: { userQuestions: { active: [], settled: [] } } } }),
    },
    userQuestions: { answer: () => false },
    agents: { roots: () => [{ id: SID }] },
    workspaceController: {
      follow: () => ({ [Symbol.asyncIterator]() { return { next: async () => ({ done: true, value: undefined }) } } }),
    },
    sessionProjections: {},
  }
  return { ctx, effects, webServers, tools, warnings }
}

function baseConfig(storeFile, projectsRoot, extra = {}) {
  return {
    projectsRoot,
    projectsRoots: [projectsRoot],
    storeFile,
    alertKinds: ['error', 'interrupted', 'aborted:disposed'],
    alertBackfillHours: 72,
    alertInterruptedGraceMinutes: 30,
    autoTrashProgrammatic: false,
    discovery: {},
    kinds: {},
    ...extra,
  }
}

function fakeReq(url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  let index = 0
  return {
    headers: { host: '127.0.0.1:9999' },
    method: 'POST',
    url,
    [Symbol.asyncIterator]() {
      return { next: async () => (index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }) }
    },
  }
}

async function callApi(handler, method, payload) {
  const out = { status: 0, body: '' }
  await handler(fakeReq(`/rhub/api/${method}`, payload), { writeHead: (status) => { out.status = status }, end: (text) => { out.body = text } })
  return { status: out.status, json: JSON.parse(out.body) }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('webhook 接线：hub_post 建条后发出签名事件，panel 透传 layout', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'rhub-wiring-'))
  const received = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      received.push({ headers: req.headers, body, url: req.url })
      res.writeHead(200)
      res.end('ok')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const secret = 'phase2-secret'
  const view = { sections: [{ id: 'inbox', source: 'items' }], groupBy: 'kind', defaultSection: 'inbox' }
  const fake = makeFakeCtx([{ sessionId: SID, title: '接线会话', running: false, updatedAt: Date.now() }])
  try {
    apply(fake.ctx, baseConfig(join(temp, 'store.json'), temp, {
      view,
      webhooks: [{ url: `http://127.0.0.1:${port}/hook`, events: ['item.created'], secret, headers: {}, timeoutMs: 2000, retries: 0 }],
      webhookAllowPrivate: true,
    }))

    const hubPost = fake.tools.find((tool) => tool.name === 'hub_post')
    assert.ok(hubPost, '应注册 hub_post 工具')
    const created = await hubPost.execute({ type: 'deliverable', title: '接线测试条目' }, { agent: { id: SID } })
    assert.equal(created.ok, true, JSON.stringify(created))

    for (let i = 0; i < 40 && received.length === 0; i += 1) await delay(50)
    assert.equal(received.length, 1, '应收到一条 webhook')
    const hit = received[0]
    assert.equal(hit.headers['x-rhub-event'], 'item.created')
    assert.equal(hit.headers['x-rhub-signature'], signWebhookPayload(secret, hit.headers['x-rhub-timestamp'], hit.body))
    const payload = JSON.parse(hit.body)
    assert.equal(payload.version, 1)
    assert.equal(payload.event, 'item.created')
    assert.equal(payload.item.title, '接线测试条目')
    assert.equal(payload.item.type, 'deliverable')

    // panel 透传布局，且新条目可见
    const handler = fake.webServers[0]?.handler
    assert.ok(handler, '应注册 /rhub/api 路由')
    const panel = await callApi(handler, 'panel', {})
    assert.equal(panel.json.ok, true)
    assert.deepEqual(panel.json.value.layout, view)
    assert.ok(panel.json.value.items.some((item) => item.title === '接线测试条目'))
  } finally {
    await new Promise((resolve) => server.close(resolve))
    for (const dispose of [...fake.effects].reverse()) {
      try {
        dispose()
      } catch {
        /* 单条清理失败不影响其余 */
      }
    }
    rmSync(temp, { recursive: true, force: true })
  }
})

test('默认配置：无 webhook 目标时不发请求，layout 为空对象', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'rhub-wiring-default-'))
  const fake = makeFakeCtx([{ sessionId: SID, title: '接线会话', running: false, updatedAt: Date.now() }])
  try {
    apply(fake.ctx, baseConfig(join(temp, 'store.json'), temp))
    const hubPost = fake.tools.find((tool) => tool.name === 'hub_post')
    const created = await hubPost.execute({ type: 'question', title: '无 webhook 条目' }, { agent: { id: SID } })
    assert.equal(created.ok, true)
    const handler = fake.webServers[0]?.handler
    const panel = await callApi(handler, 'panel', {})
    assert.deepEqual(panel.json.value.layout, {})
  } finally {
    for (const dispose of [...fake.effects].reverse()) {
      try {
        dispose()
      } catch {
        /* 忽略 */
      }
    }
    rmSync(temp, { recursive: true, force: true })
  }
})
