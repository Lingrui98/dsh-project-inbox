import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Test the actual components without adding browser/runtime dependencies.
// React elements remain inspectable, and event callbacks run against explicit mocks.
function harness() {
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity).filter((x) => x !== null && x !== false && x !== undefined) } }),
    useState: (value) => [value, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
    useReducer: (_reducer, initial) => [initial, () => {}],
  }
  const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
    + '\nexport const __test = { ItemCard, SessionPreview, HomeInbox, ProjectCard, HubPage, HubReturnBar, setReturnTarget };\n'
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
  })
  const exports = {}
  const localModules = {}
  const loadLocal = (name, relativePath) => {
    if (!localModules[name]) {
      const localSource = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
      const { outputText } = ts.transpileModule(localSource, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
      })
      const localExports = {}
      vm.runInNewContext(outputText, { exports: localExports, require: () => ({}) })
      localModules[name] = localExports
    }
    return localModules[name]
  }
  vm.runInNewContext(outputText, { exports, require: (name) => {
    if (name === './styles.js') return { HUB_CSS: readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8') }
    // i18n 字典单独成模块：测试替身按需转译一次，避免断言落到真实 bundle 上。
    if (name === './strings.js') return loadLocal(name, '../src/client/strings.ts')
    if (name === './layout.js') return loadLocal(name, '../src/client/layout.ts')
    assert.equal(name, 'react'); return React
  } })
  const components = exports.__test
  return {
    ...components,
    page(data) {
      let hook = 0
      const changes = []
      React.useState = (initial) => [hook++ === 0 ? data : initial, (v) => changes.push(v)]
      const page = components.HubPage({ ctx: {} })
      React.useState = (initial) => [initial, () => {}]
      return { page, changes }
    },
  }
}

function children(node) { return node?.props?.children ?? [] }
function nodes(node) { return typeof node === 'object' && node ? [node, ...children(node).flatMap(nodes)] : [] }
function text(node) { return typeof node === 'string' || typeof node === 'number' ? String(node) : children(node).map(text).join('') }
function session(id, updatedAt = 0) { return { id, title: `会话 ${id}`, updatedAt, running: false } }
function item(id, extra = {}) {
  return { id, title: id, status: 'pending', priority: 'normal', createdAt: 0, type: 'question', projectId: 'p', ...extra }
}
function data(extra = {}) {
  return { now: 10000, pending: 0, projects: [], unassignedSessions: [], unassignedCounts: { questions: 0, deliverables: 0, urgent: 0 }, trashedSessions: [], items: [], ...extra }
}
const noop = () => {}

// 首页/详情页的视图是模块级状态：前序用例可能把它留在详情页，先用头部「返回」回到首页。
function homePage(ui, extra = {}) {
  const first = ui.page(data(extra)).page
  const back = nodes(first).find((node) => node.type === 'button' && node.props.key === 'back')
  return back ? ui.page(data(extra)).page : first
}

function alertItem(extra = {}) {
  return item('alert-1', {
    type: 'alert', source: 'system',
    sessionId: 's1', sessionTitle: '会话 1', projectId: 'p',
    title: '会话中断：模型调用失败',
    body: '第 3 轮模型调用失败（PI_AI_ERROR）：连接被重置。',
    alert: { turn: 3, kind: 'error', code: 'PI_AI_ERROR', detail: '连接被重置' },
    ...extra,
  })
}

test('return button uses the displayed header session, never recency of retained sessions', () => {
  const ui = harness()
  ui.setReturnTarget({ sessionId: 'older-session' })
  const ctx = { get() { throw Error('Header identity must not be inferred from catalog or retain counts') } }
  assert.equal(ui.HubReturnBar({ ctx, sessionId: 'newer-session' }), null)
  assert.match(text(ui.HubReturnBar({ ctx, sessionId: 'older-session' })), /指挥中心/)
  ui.setReturnTarget({ sessionId: 'second-session' })
  assert.equal(ui.HubReturnBar({ ctx, sessionId: 'older-session' }), null)
  assert.match(text(ui.HubReturnBar({ ctx, sessionId: 'second-session' })), /指挥中心/)
})

test('return button selects the hub and clears the return target', () => {
  const ui = harness()
  const panels = []
  const ctx = { get(name) { assert.equal(name, 'layout'); return { selectPanel: (id) => panels.push(id) } } }
  assert.equal(ui.HubReturnBar({ ctx, sessionId: 'session-1' }), null)
  ui.setReturnTarget({ sessionId: 'session-1' })
  ui.HubReturnBar({ ctx, sessionId: 'session-1' }).props.onClick()
  assert.deepEqual(panels, ['research-hub'])
  assert.equal(ui.HubReturnBar({ ctx, sessionId: 'session-1' }), null)
})

test('homepage always places the inbox before the project grid, including empty state', () => {
  const ui = harness()
  const { page } = ui.page(data())
  const home = nodes(page).find((n) => n.props.key === 'home')
  assert.equal(children(home)[0].type, ui.HomeInbox)
  assert.match(text(ui.HomeInbox(children(home)[0].props)), /收件箱 · 0 条待处理/)
  assert.match(text(ui.HomeInbox(children(home)[0].props)), /当前没有待处理消息/)
  assert.match(text(home), /暂无项目/)
})

test('session previews select the three latest updates without mutating the input', () => {
  const ui = harness()
  const sessions = [session('a', 1), session('d', 4), session('b', 2), session('c', 3)]
  const preview = ui.SessionPreview({ sessions, now: 10000, onJump: noop })
  const buttons = nodes(preview).filter((n) => n.type === 'button')
  assert.deepEqual(buttons.map((n) => n.props.key), ['d', 'c', 'b'])
  assert.deepEqual(sessions.map((s) => s.id), ['a', 'd', 'b', 'c'])
  assert.equal(buttons[0].props.style.color, 'var(--dsw-alias-label-secondary, #626262)')
})

test('equal update timestamps use stable id ordering', () => {
  const ui = harness()
  const preview = ui.SessionPreview({ sessions: [session('b', 1), session('a', 1)], now: 10000, onJump: noop })
  assert.deepEqual(nodes(preview).filter((n) => n.type === 'button').map((n) => n.props.key), ['a', 'b'])
})

test('session buttons stop bubbling and open the exact session', () => {
  const ui = harness()
  const jumps = []
  let stopped = false
  const preview = ui.SessionPreview({ sessions: [session('target')], now: 10000, onJump: (id) => jumps.push(id) })
  const button = nodes(preview).find((n) => n.type === 'button')
  button.props.onClick({ stopPropagation() { stopped = true } })
  assert.equal(stopped, true)
  assert.deepEqual(jumps, ['target'])
})

test('empty session preview has explicit empty text', () => {
  const ui = harness()
  assert.match(text(ui.SessionPreview({ sessions: [], now: 0, onJump: noop })), /尚无会话/)
})

test('inbox filters terminal states, prioritizes urgent items and caps previews at three', () => {
  const ui = harness()
  const items = [item('normal', { createdAt: 1 }), item('urgent-new', { priority: 'urgent', createdAt: 4 }), item('urgent-old', { priority: 'urgent', createdAt: 2 }), item('delivery', { type: 'deliverable' }), item('history', { status: 'answered' })]
  const inbox = ui.HomeInbox({ items, projects: [{ id: 'p', name: '项目 P' }], now: 10000, onOpen: noop })
  const cards = nodes(inbox).filter((n) => typeof n.type === 'function' && n.type.name === 'ItemCard')
  assert.deepEqual(cards.map((n) => n.props.item.id), ['urgent-old', 'urgent-new', 'delivery'])
  assert.match(text(inbox), /4 条待处理/)
  assert.match(text(inbox), /还有 1 条待处理/)
  assert.match(text(inbox), /项目 P/)
  assert.deepEqual(items.map((i) => i.id), ['normal', 'urgent-new', 'urgent-old', 'delivery', 'history'])
})

test('inbox headline uses authoritative total even when only previews are supplied', () => {
  const ui = harness()
  const inbox = ui.HomeInbox({ items: [item('q')], total: 350, counts: { questions: 350, deliverables: 0, urgent: 0 }, projects: [], onOpen: noop })
  assert.match(text(inbox), /收件箱 · 350 条待处理/)
  assert.match(text(inbox), /还有 349 条待处理/)
})

test('both inbox entry buttons open the complete inbox', () => {
  const ui = harness()
  let opened = 0
  const inbox = ui.HomeInbox({ items: [1, 2, 3, 4].map((i) => item(String(i))), projects: [], onOpen: () => opened++ })
  const buttons = nodes(inbox).filter((n) => n.type === 'button')
  assert.equal(buttons.length, 2)
  buttons.forEach((n) => n.props.onClick())
  assert.equal(opened, 2)
})

test('project card keeps whole-card navigation and shows non-interactive message summaries', () => {
  const ui = harness()
  let opened = 0
  const card = ui.ProjectCard({ name: 'P', hue: '#4f7dd8', icon: 'folder', counts: { questions: 1 }, sessions: [session('s')], pendingItems: [item('q')], onOpen: () => opened++ })
  card.props.onClick()
  assert.equal(opened, 1)
  const messages = nodes(card).find((n) => n.props.key === 'items')
  assert.match(text(messages), /q/)
  assert.equal(nodes(messages).filter((n) => typeof n.type === 'function' && n.type.name === 'ItemCard').length, 0)
  assert.equal(opened, 1)
  assert.ok(nodes(card).some((n) => n.type === ui.SessionPreview))
})

test('project name is a native keyboard button without nesting buttons in another interactive role', () => {
  const ui = harness()
  let opened = 0
  const card = ui.ProjectCard({ name: 'P', hue: '#4f7dd8', icon: 'folder', counts: { questions: 0, deliverables: 0, urgent: 0 }, sessions: [], onOpen: () => opened++ })
  assert.equal(card.props.role, 'group')
  assert.equal(card.props.tabIndex, undefined)
  const title = nodes(card).find((node) => node.type === 'button' && node.props.key === 'name')
  assert.ok(title)
  title.props.onClick({ stopPropagation() {} })
  assert.equal(opened, 1)
})

test('home uses session-bearing project cards but not inbox or trash project cards', () => {
  const ui = harness()
  const project = { id: 'p', name: 'P', counts: { questions: 0, deliverables: 0, urgent: 0 }, sessions: [session('s')] }
  const { page, changes } = ui.page(data({ projects: [project], unassignedSessions: [session('u')], trashedSessions: [session('t')] }))
  const cards = nodes(page).filter((n) => n.type === ui.ProjectCard)
  assert.equal(cards.length, 2)
  assert.equal(cards[0].props.sessions, project.sessions)
  assert.deepEqual(cards.map((n) => n.props.name), ['P', '未分配'])
  const inbox = nodes(page).find((n) => n.type === ui.HomeInbox)
  inbox.props.onOpen()
  assert.deepEqual(changes, ['__all__'])
  const trash = nodes(page).find((n) => n.type === 'button' && text(n).includes('回收站'))
  trash.props.onClick()
  assert.deepEqual(changes, ['__all__', '__trash__'])
})

test('pending alert card renders interruption copy and a reply box instead of acknowledge', () => {
  const ui = harness()
  const card = ui.ItemCard({ item: alertItem(), now: 10000, onChanged: noop, onJump: noop })
  assert.match(text(card), /会话中断：模型调用失败/)
  assert.match(text(card), /待处理/)
  // 「会话中断」pill 由 source === 'system' 触发，不是标题文本碰巧命中。
  const pills = nodes(card).filter((node) => node.type === 'span' && children(node).includes('会话中断'))
  assert.equal(pills.length, 1)
  const area = nodes(card).find((node) => node.type === 'textarea')
  assert.ok(area)
  assert.match(area.props.placeholder, /继续该会话/)
  const buttons = nodes(card).filter((node) => node.type === 'button').map((node) => text(node))
  assert.ok(buttons.includes('回复'))
  assert.ok(buttons.includes('跳转会话'))
  assert.ok(buttons.includes('忽略'))
  assert.equal(buttons.includes('查收'), false)
})

test('home inbox counts interruption alerts', () => {
  const ui = harness()
  const inbox = ui.HomeInbox({
    items: [alertItem()], projects: [], now: 10000,
    counts: { questions: 0, deliverables: 0, urgent: 0, alerts: 1 }, onOpen: noop,
  })
  assert.match(text(inbox), /1 中断/)
  assert.match(text(inbox), /会话中断/)
})

test('all-pending view puts interruption alerts before questions and deliveries', () => {
  const ui = harness()
  const question = item('q-1', { sessionId: 's2', sessionTitle: '会话 2' })
  const delivery = item('d-1', { type: 'deliverable', sessionId: 's3', sessionTitle: '会话 3' })
  const items = [alertItem(), question, delivery]
  const home = homePage(ui, { items })
  nodes(home).find((node) => node.type === ui.HomeInbox).props.onOpen()
  const all = ui.page(data({ items })).page
  const labels = nodes(all).filter((node) => node.type === 'h2').map((node) => text(children(node)[1]))
  assert.deepEqual(labels, ['会话中断', '待回答问题', '待查看交付'])
  const cards = nodes(all).filter((node) => typeof node.type === 'function' && node.type.name === 'ItemCard')
  assert.deepEqual(cards.map((node) => node.props.item.id), ['alert-1', 'q-1', 'd-1'])
  // 复原模块级视图，避免影响后续用例。
  nodes(all).find((node) => node.type === 'button' && node.props.key === 'back').props.onClick()
})
