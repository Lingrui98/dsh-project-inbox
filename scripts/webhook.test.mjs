/**
 * webhook 投递模块回归测试。
 *
 * 覆盖：
 * 1. 本地 http server 收到事件，HMAC 签名可验证，payload 字段完整；
 * 2. 500 后重试成功（指数退避经注入 sleep 跳过等待）；
 * 3. 超时视为失败并重试（注入永不返回的 fetchImpl）；
 * 4. 回环/私网默认拒绝，allowPrivate 放行；
 * 5. 不匹配的事件不发送；
 * 6. buildWebhookPayload / signWebhookPayload 纯函数行为。
 *
 * 依赖构建产物：先 `npm run build`，再 `node --test scripts/webhook.test.mjs`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import {
  buildWebhookPayload,
  createWebhookDispatcher,
  isPrivateHost,
  signWebhookPayload,
} from '../lib/host/webhook.js'

function makeItem(overrides = {}) {
  return {
    id: 'item-1',
    projectId: 'papers',
    sessionId: 'session-1',
    sessionTitle: 'demo',
    type: 'deliverable',
    title: '报告完成',
    body: '正文',
    priority: 'normal',
    status: 'pending',
    source: 'tool',
    createdAt: 1729000000000,
    ...overrides,
  }
}

function makeLogger() {
  const warnings = []
  return { warnings, logger: { warn: (msg) => warnings.push(String(msg)) } }
}

const immediateSleep = () => Promise.resolve()

/** 启动本地接收 server；handler 返回 [status, recorded]。 */
async function startReceiver(handler) {
  const received = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      received.push({ headers: req.headers, body })
      const status = handler(received.length, { headers: req.headers, body })
      res.writeHead(status).end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    received,
    url: `http://127.0.0.1:${port}/hook`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('本地 server 收到事件，HMAC 可验证，payload 字段完整', async () => {
  const receiver = await startReceiver(() => 200)
  try {
    const { logger } = makeLogger()
    const dispatcher = createWebhookDispatcher({
      targets: [{ url: receiver.url, secret: 'top-secret' }],
      logger,
      sleep: immediateSleep,
      allowPrivate: true,
      now: () => 1729000000123,
    })
    await dispatcher.dispatch('item.created', makeItem(), { project: 'papers' })

    assert.equal(receiver.received.length, 1)
    const hit = receiver.received[0]
    assert.equal(hit.headers['x-rhub-event'], 'item.created')
    assert.equal(hit.headers['x-rhub-timestamp'], '1729000000123')
    assert.equal(hit.headers['content-type'], 'application/json')

    // 用相同算法独立重算签名
    const expect = 'sha256=' + createHmac('sha256', 'top-secret').update(`1729000000123.${hit.body}`).digest('hex')
    assert.equal(hit.headers['x-rhub-signature'], expect)

    const payload = JSON.parse(hit.body)
    assert.equal(payload.version, 1)
    assert.equal(payload.event, 'item.created')
    assert.equal(payload.deliveredAt, 1729000000123)
    assert.equal(payload.project, 'papers')
    assert.deepEqual(payload.item, makeItem())
  } finally {
    await receiver.close()
  }
})

test('500 后按退避重试并成功；重试间隔走注入的 sleep', async () => {
  const receiver = await startReceiver((count) => (count === 1 ? 500 : 200))
  try {
    const { logger, warnings } = makeLogger()
    const delays = []
    const dispatcher = createWebhookDispatcher({
      targets: [{ url: receiver.url, retries: 3 }],
      logger,
      sleep: async (ms) => void delays.push(ms),
      allowPrivate: true,
    })
    await dispatcher.dispatch('item.created', makeItem())

    assert.equal(receiver.received.length, 2, '第一次 500，重试后第二次 200')
    assert.deepEqual(delays, [500], '只重试一次，首次退避 500ms')
    assert.equal(warnings.length, 0, '最终成功不记失败日志')
  } finally {
    await receiver.close()
  }
})

test('重试耗尽后放弃，只记日志不抛出', async () => {
  const receiver = await startReceiver(() => 500)
  try {
    const { logger, warnings } = makeLogger()
    const delays = []
    const dispatcher = createWebhookDispatcher({
      targets: [{ url: receiver.url, retries: 2 }],
      logger,
      sleep: async (ms) => void delays.push(ms),
      allowPrivate: true,
    })
    await dispatcher.dispatch('item.created', makeItem())

    assert.equal(receiver.received.length, 3, '1 次首发 + 2 次重试')
    assert.deepEqual(delays, [500, 1000], '指数退避 500/1000')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /放弃/)
  } finally {
    await receiver.close()
  }
})

test('超时视为失败并重试', async () => {
  const { logger, warnings } = makeLogger()
  let calls = 0
  const dispatcher = createWebhookDispatcher({
    targets: [{ url: 'https://example.com/hook', timeoutMs: 50, retries: 1 }],
    logger,
    // 永不 resolve，也不响应 abort signal，验证超时由 race 兜底
    fetchImpl: () => {
      calls += 1
      return new Promise(() => {})
    },
    sleep: immediateSleep,
  })
  await dispatcher.dispatch('item.created', makeItem())

  assert.equal(calls, 2, '1 次首发 + 1 次重试，两次都超时')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /超时|放弃/)
})

test('超时重试后成功', async () => {
  const { logger } = makeLogger()
  let calls = 0
  const dispatcher = createWebhookDispatcher({
    targets: [{ url: 'https://example.com/hook', timeoutMs: 50, retries: 2 }],
    logger,
    fetchImpl: () => {
      calls += 1
      if (calls === 1) return new Promise(() => {}) // 第一次挂起触发超时
      return Promise.resolve(new Response('ok', { status: 200 }))
    },
    sleep: immediateSleep,
  })
  await dispatcher.dispatch('item.created', makeItem())
  assert.equal(calls, 2)
})

test('回环/私网默认拒绝，allowPrivate 放行', async () => {
  for (const url of [
    'http://127.0.0.1:9999/hook',
    'http://localhost/hook',
    'http://10.0.0.8/hook',
    'http://172.16.3.4/hook',
    'http://192.168.1.1/hook',
    'http://169.254.1.1/hook',
    'http://100.64.0.1/hook',
    'http://[::1]/hook',
    'http://[fd00::1]/hook',
    'http://[fe80::1]/hook',
    'http://[::ffff:127.0.0.1]/hook',
    'http://0.0.0.0/hook',
  ]) {
    const { logger, warnings } = makeLogger()
    let calls = 0
    const dispatcher = createWebhookDispatcher({
      targets: [{ url }],
      logger,
      fetchImpl: () => {
        calls += 1
        return Promise.resolve(new Response('ok', { status: 200 }))
      },
      sleep: immediateSleep,
    })
    await dispatcher.dispatch('item.created', makeItem())
    assert.equal(calls, 0, `${url} 默认必须被拒绝`)
    assert.ok(warnings.some((w) => w.includes('拒绝')), `${url} 拒绝必须记日志`)
  }

  // allowPrivate 放行回环
  const { logger } = makeLogger()
  let calls = 0
  const dispatcher = createWebhookDispatcher({
    targets: [{ url: 'http://127.0.0.1:9999/hook' }],
    logger,
    fetchImpl: () => {
      calls += 1
      return Promise.resolve(new Response('ok', { status: 200 }))
    },
    sleep: immediateSleep,
    allowPrivate: true,
  })
  await dispatcher.dispatch('item.created', makeItem())
  assert.equal(calls, 1, 'allowPrivate 后回环地址允许投递')
})

test('不匹配的事件不发送；空 events 订阅全部', async () => {
  const { logger } = makeLogger()
  let calls = 0
  const fetchImpl = () => {
    calls += 1
    return Promise.resolve(new Response('ok', { status: 200 }))
  }
  const dispatcher = createWebhookDispatcher({
    targets: [
      { url: 'https://a.example.com/hook', events: ['item.settled'] },
      { url: 'https://b.example.com/hook' },
    ],
    logger,
    fetchImpl,
    sleep: immediateSleep,
  })
  await dispatcher.dispatch('item.created', makeItem())
  assert.equal(calls, 1, '只有订阅全部事件的 b 收到 item.created')

  await dispatcher.dispatch('item.settled', makeItem())
  assert.equal(calls, 3, 'item.settled 两个目标都收到')
})

test('4xx 不重试，直接记日志放弃', async () => {
  const { logger, warnings } = makeLogger()
  let calls = 0
  const dispatcher = createWebhookDispatcher({
    targets: [{ url: 'https://example.com/hook', retries: 3 }],
    logger,
    fetchImpl: () => {
      calls += 1
      return Promise.resolve(new Response('bad', { status: 400 }))
    },
    sleep: immediateSleep,
  })
  await dispatcher.dispatch('item.created', makeItem())
  assert.equal(calls, 1, '4xx 不重试')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /不重试/)
})

test('buildWebhookPayload：字段完整，无 project 时不带该字段', () => {
  const item = makeItem()
  const payload = buildWebhookPayload('item.urgent', item, undefined, 1234)
  assert.deepEqual(payload, { version: 1, event: 'item.urgent', item, deliveredAt: 1234 })
  const withProject = buildWebhookPayload('alert.created', item, { project: 'papers' }, 1234)
  assert.equal(withProject.project, 'papers')
})

test('signWebhookPayload：sha256= 前缀 + HMAC-SHA256 hex，与独立计算一致', () => {
  const got = signWebhookPayload('s3cret', '1729000000123', '{"a":1}')
  const expect = 'sha256=' + createHmac('sha256', 's3cret').update('1729000000123.{"a":1}').digest('hex')
  assert.equal(got, expect)
  assert.match(got, /^sha256=[0-9a-f]{64}$/)
})

test('isPrivateHost：公网地址放行，私网/回环拒绝', () => {
  assert.equal(isPrivateHost('example.com'), false)
  assert.equal(isPrivateHost('8.8.8.8'), false)
  assert.equal(isPrivateHost('223.5.5.5'), false)
  for (const host of [
    'localhost',
    'foo.localhost',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.0.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
  ]) {
    assert.equal(isPrivateHost(host), true, `${host} 必须判为私网/回环`)
  }
  // 172.15 与 172.32 不在 172.16/12 内
  assert.equal(isPrivateHost('172.15.0.1'), false)
  assert.equal(isPrivateHost('172.32.0.1'), false)
})

test('非 http/https 协议与非法 URL 只记日志', async () => {
  const { logger, warnings } = makeLogger()
  let calls = 0
  const dispatcher = createWebhookDispatcher({
    targets: [{ url: 'file:///etc/passwd' }, { url: 'not a url' }],
    logger,
    fetchImpl: () => {
      calls += 1
      return Promise.resolve(new Response('ok', { status: 200 }))
    },
    sleep: immediateSleep,
  })
  await dispatcher.dispatch('item.created', makeItem())
  assert.equal(calls, 0)
  assert.equal(warnings.length, 2)
})
