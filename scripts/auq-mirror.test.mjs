/**
 * ask_user_question 镜像回归测试。
 *
 * 背景：DSH 0.2.1-rc.2 的 legacy（默认）ask_user_question 走
 * `userQuestions.ask({questions, agent, signal})`，请求里没有 wait.callId；
 * timed 工具才带 callId。只靠 user-questions 瀑布无法镜像 legacy 提问，
 * 因此镜像改由会话事件驱动。本测试守护这条链路，并守护"前台阻塞提问
 * 不能在指挥中心代答"的边界。
 *
 * 依赖构建产物：先 `npm run build`，再 `npm test`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { Hub, foldOpenAuqQuestions } from '../lib/host/core.js'
import { HubStore } from '../lib/host/store.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const storeFile = join(root, 'node_modules', '.auq-mirror-test.json')

const questions = [{ id: 'q1', question: '选哪个？', header: '选择', options: [{ label: 'A' }, { label: 'B' }] }]
const callEvent = (callId, batch = questions) => ({
  type: 'tool/call',
  data: { turn: 1, step: 1, callId, name: 'ask_user_question', arguments: JSON.stringify({ questions: batch }) },
})
const resultEvent = (callId, payload) => ({
  type: 'tool/result',
  data: {
    turn: 1,
    step: 1,
    message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(payload) }] },
  },
})
const replyEvent = (callId, answers) => ({
  type: 'user/message',
  data: {
    source: { kind: 'user-question-reply', callId, outcome: 'answered' },
    content: [{ type: 'text', text: JSON.stringify({ answers }) }],
  },
})

/** 造一个独立 Hub，并暴露可观察的宿主调用记录。 */
function makeHub(options = {}) {
  rmSync(storeFile, { force: true })
  const store = new HubStore(storeFile)
  const calls = { prompt: [], answer: [] }
  const services = {
    sessionController: {
      inspect: async () => ({ meta: {} }),
      list: async () => ({ items: [] }),
      prompt: async (request) => { calls.prompt.push(request) },
      resolveAgent: async (sessionId) => ({ agent: { id: sessionId } }),
    },
    sessionQuery: { readTitle: async () => ({ title: '' }), filterEvents: async () => [] },
    userQuestions: {
      answer: (agent, callId, answer) => {
        calls.answer.push({ callId, answer })
        return options.answerResult ?? false
      },
    },
    agents: { roots: () => [] },
  }
  const hub = new Hub(store, services, [root])
  hub.data.projects.push({ id: 'proj', name: 'proj', aliases: ['proj'], source: 'manual', createdAt: 1 })
  hub.data.bindings['session-test-1'] = { projectId: 'proj', locked: true, by: 'user', updatedAt: 1 }
  return { hub, calls }
}

const SID = 'session-test-1'

test('legacy tool/call 建一条 pending 镜像，重复事件不重复建', async () => {
  const { hub } = makeHub()
  await hub.mirrorAskUserQuestion(SID, callEvent('c1'))
  await hub.mirrorAskUserQuestion(SID, callEvent('c1'))
  assert.equal(hub.data.items.length, 1)
  const item = hub.data.items[0]
  assert.equal(item.source, 'auq')
  assert.equal(item.status, 'pending')
  assert.equal(item.auq.callId, 'c1')
  assert.equal(item.projectId, 'proj')
  assert.equal(item.auq.questions[0].options.length, 2)
  assert.equal(item.auq.questions[0].multiSelect, false)
  assert.equal(item.auqAnswerable, false)
})

test('timed 的 pending 结果保持待处理', async () => {
  const { hub } = makeHub()
  await hub.mirrorAskUserQuestion(SID, callEvent('c1'))
  await hub.mirrorAskUserQuestion(SID, resultEvent('c1', { pending: true, callId: 'c1', message: 'pending' }))
  assert.equal(hub.data.items[0].status, 'pending')
})

test('会话内作答结果结算为 answered 并写入摘要', async () => {
  const { hub } = makeHub()
  await hub.mirrorAskUserQuestion(SID, callEvent('c1'))
  await hub.mirrorAskUserQuestion(SID, resultEvent('c1', { answers: [{ id: 'q1', selected: ['A'] }] }))
  assert.equal(hub.data.items[0].status, 'answered')
  assert.equal(hub.data.items[0].answerText, 'A')
})

test('迟到答复（user-question-reply）结算为 answered', async () => {
  const { hub } = makeHub()
  await hub.mirrorAskUserQuestion(SID, callEvent('c2'))
  await hub.mirrorAskUserQuestion(SID, replyEvent('c2', [{ id: 'q1', selected: [], custom: '自由文本' }]))
  assert.equal(hub.data.items[0].status, 'answered')
  assert.equal(hub.data.items[0].answerText, '自由文本')
})

test('失败结果关闭问题', async () => {
  const { hub } = makeHub()
  await hub.mirrorAskUserQuestion(SID, callEvent('c3'))
  await hub.mirrorAskUserQuestion(SID, resultEvent('c3', { error: 'boom' }))
  assert.equal(hub.data.items[0].status, 'dismissed')
})

test('事件折叠只保留仍可回答的调用', () => {
  const events = [
    callEvent('x1'),
    callEvent('x2'),
    resultEvent('x1', { answers: [{ id: 'q1', selected: ['B'] }] }),
    callEvent('x3'),
    resultEvent('x3', { pending: true }),
  ]
  assert.deepEqual(foldOpenAuqQuestions(events).map((o) => o.callId), ['x2', 'x3'])
  assert.deepEqual(
    foldOpenAuqQuestions([...events, replyEvent('x2', [{ id: 'q1', selected: ['A'] }])]).map((o) => o.callId),
    ['x3'],
  )
})

test('参数不可读的 tool/call 不产生镜像', async () => {
  const { hub } = makeHub()
  await hub.mirrorAskUserQuestion(SID, {
    type: 'tool/call',
    data: { callId: 'bad', name: 'ask_user_question', arguments: '{not json' },
  })
  assert.equal(hub.data.items.length, 0)
})

test('syncAuqAnswerable 只把 continued 的 callId 置为可代答', async () => {
  const { hub } = makeHub()
  await hub.mirrorAskUserQuestion(SID, callEvent('c1'))
  await hub.mirrorAskUserQuestion(SID, callEvent('c2'))
  hub.syncAuqAnswerable(SID, new Set(['c1']))
  const byCall = Object.fromEntries(hub.data.items.map((it) => [it.auq.callId, it.auqAnswerable]))
  assert.deepEqual(byCall, { c1: true, c2: false })
})

test('前台阻塞提问：reply 拒绝代答，不投递消息，也不结算', async () => {
  const { hub, calls } = makeHub()
  await hub.mirrorAskUserQuestion(SID, callEvent('c1'))
  const item = hub.data.items[0]
  await assert.rejects(() => hub.reply(item.id, '选 A'), /会话内回答/)
  assert.equal(calls.prompt.length, 0)
  assert.equal(calls.answer.length, 0)
  assert.equal(hub.data.items[0].status, 'pending')
})

test('前台阻塞提问：answerStructured 拒绝代答', async () => {
  const { hub, calls } = makeHub()
  await hub.mirrorAskUserQuestion(SID, callEvent('c1'))
  const item = hub.data.items[0]
  await assert.rejects(
    () => hub.answerStructured(item.id, [{ id: 'q1', selected: ['A'] }]),
    /会话内回答/,
  )
  assert.equal(calls.answer.length, 0)
  assert.equal(hub.data.items[0].status, 'pending')
})

test('可代答的 continued 提问：reply 走结构化应答并结算', async () => {
  const { hub, calls } = makeHub({ answerResult: true })
  await hub.mirrorAskUserQuestion(SID, callEvent('c1'))
  hub.syncAuqAnswerable(SID, new Set(['c1']))
  const item = hub.data.items[0]
  const result = await hub.reply(item.id, '选 A')
  assert.equal(result.via, 'answer')
  assert.equal(calls.answer.length, 1)
  assert.equal(calls.prompt.length, 0)
  assert.equal(hub.data.items[0].status, 'answered')
  assert.equal(hub.data.items[0].answerText, '选 A')
})

test('可代答但实际应答失败：报错并保持待处理，不伪造已答复', async () => {
  const { hub, calls } = makeHub({ answerResult: false })
  await hub.mirrorAskUserQuestion(SID, callEvent('c1'))
  hub.syncAuqAnswerable(SID, new Set(['c1']))
  const item = hub.data.items[0]
  await assert.rejects(() => hub.reply(item.id, '选 A'), /不可应答/)
  assert.equal(calls.prompt.length, 0)
  assert.equal(hub.data.items[0].status, 'pending')
})

test.after(() => rmSync(storeFile, { force: true }))
