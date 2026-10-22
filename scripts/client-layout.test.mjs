import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

// layout.ts 是纯模块（无 React / 文案依赖）：转译 CJS 后在同 realm 执行，
// 返回值与断言字面量共享原型，deepStrictEqual 才能直接比较。
function loadLayout() {
  const source = readFileSync(new URL('../src/client/layout.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
  })
  const exports = {}
  const run = new Function('exports', 'require', outputText)
  run(exports, (name) => { throw new Error(`layout.ts 不应有依赖：${name}`) })
  return exports
}

const layout = loadLayout()
const { DEFAULT_LAYOUT, normalizeLayout, assignItems, groupItems } = layout

function item(id, extra = {}) {
  return { id, type: 'question', priority: 'normal', status: 'pending', projectId: 'p1', ...extra }
}

test('default layout matches the fixed 0.1.4 rendering: alerts, questions, deliverables', () => {
  assert.deepEqual(DEFAULT_LAYOUT, {
    groupBy: 'none',
    sections: [
      { id: 'alerts', source: 'alerts', order: 0 },
      { id: 'questions', source: 'questions', order: 1 },
      { id: 'deliverables', source: 'deliverables', order: 2 },
    ],
  })
})

test('normalizeLayout falls back to the default for missing or non-object input', () => {
  for (const raw of [undefined, null, 42, 'x', [], true]) {
    assert.deepEqual(normalizeLayout(raw), DEFAULT_LAYOUT)
  }
  // 返回新对象：修改归一化结果不污染 DEFAULT_LAYOUT。
  const normalized = normalizeLayout(undefined)
  normalized.sections[0].id = 'mutated'
  assert.equal(DEFAULT_LAYOUT.sections[0].id, 'alerts')
})

test('normalizeLayout keeps explicit groupBy when sections fall back to default', () => {
  const normalized = normalizeLayout({ groupBy: 'kind', sections: 'oops' })
  assert.equal(normalized.groupBy, 'kind')
  assert.deepEqual(normalized.sections, DEFAULT_LAYOUT.sections)
})

test('section order follows order first, then array position', () => {
  const normalized = normalizeLayout({
    sections: [
      { id: 'q', source: 'questions' },
      { id: 'a', source: 'alerts', order: -1 },
      { id: 'd', source: 'deliverables' },
    ],
  })
  assert.deepEqual(normalized.sections.map((s) => s.id), ['a', 'q', 'd'])
})

test('sections not listed are hidden from the layout', () => {
  const normalized = normalizeLayout({
    sections: [{ id: 'q', source: 'questions' }],
  })
  assert.deepEqual(normalized.sections.map((s) => s.id), ['q'])
})

test('unknown sections and unknown fields are dropped, duplicate ids keep the first', () => {
  const normalized = normalizeLayout({
    sections: [
      { id: 'q', source: 'questions', bogus: 1, collapsed: true },
      { source: 'alerts' },
      { id: 'x', source: 'nope' },
      'garbage',
      { id: 'q', source: 'alerts' },
    ],
    groupBy: 'bogus',
    defaultSection: 'missing',
  })
  assert.deepEqual(normalized.sections, [{ id: 'q', source: 'questions', collapsed: true }])
  assert.equal(normalized.groupBy, 'none')
  assert.equal(normalized.defaultSection, undefined)
})

test('defaultSection survives only when it names a kept section', () => {
  const withFallback = normalizeLayout({
    sections: [{ id: 'q', source: 'questions' }, { id: 'rest', source: 'pending' }],
    defaultSection: 'rest',
  })
  assert.equal(withFallback.defaultSection, 'rest')
  const dropped = normalizeLayout({
    sections: [{ id: 'q', source: 'questions' }],
    defaultSection: 'rest',
  })
  assert.equal(dropped.defaultSection, undefined)
})

test('groupItems none keeps one group; kind uses fixed alert/question/deliverable order', () => {
  const items = [
    item('d1', { type: 'deliverable' }),
    item('q1', { type: 'question' }),
    item('a1', { type: 'alert' }),
    item('q2', { type: 'question' }),
  ]
  const none = groupItems(items, 'none')
  assert.deepEqual(none, [{ key: 'all', items }])
  const byKind = groupItems(items, 'kind')
  assert.deepEqual(byKind.map((g) => g.key), ['alert', 'question', 'deliverable'])
  assert.deepEqual(byKind[1].items.map((i) => i.id), ['q1', 'q2'])
  // 输入数组不被修改。
  assert.deepEqual(items.map((i) => i.id), ['d1', 'q1', 'a1', 'q2'])
})

test('groupItems priority puts urgent first; project groups follow first-seen order', () => {
  const items = [
    item('n1'),
    item('u1', { priority: 'urgent' }),
    item('n2'),
  ]
  const byPriority = groupItems(items, 'priority')
  assert.deepEqual(byPriority.map((g) => g.key), ['urgent', 'normal'])
  assert.deepEqual(byPriority[0].items.map((i) => i.id), ['u1'])

  const byProject = groupItems([
    item('a', { projectId: 'pb' }),
    item('b', { projectId: null }),
    item('c', { projectId: 'pa' }),
    item('d', { projectId: 'pb' }),
  ], 'project')
  assert.deepEqual(byProject.map((g) => g.key), ['pb', 'unassigned', 'pa'])
  assert.deepEqual(byProject[0].items.map((i) => i.id), ['a', 'd'])
})

test('assignItems applies kind, priority and project filters per section', () => {
  const items = [
    item('q-urgent', { priority: 'urgent' }),
    item('q-other-project', { projectId: 'p2' }),
    item('q-plain'),
    item('d1', { type: 'deliverable' }),
    item('a1', { type: 'alert' }),
    item('q-unassigned', { projectId: null }),
  ]
  const config = normalizeLayout({
    sections: [
      { id: 'hot', source: 'questions', filter: { priority: 'urgent' } },
      { id: 'mine', source: 'questions', filter: { project: 'p1' } },
      { id: 'inbox', source: 'questions', filter: { project: 'unassigned' } },
      { id: 'deliveries', source: 'deliverables', filter: { kind: 'deliverable' } },
      { id: 'rest', source: 'pending' },
    ],
    defaultSection: 'rest',
  })
  const assigned = assignItems(items, config)
  // 首个匹配分区生效：urgent 问题只进 hot，不重复进 mine/rest。
  assert.deepEqual(assigned.get('hot').map((i) => i.id), ['q-urgent'])
  assert.deepEqual(assigned.get('mine').map((i) => i.id), ['q-plain'])
  assert.deepEqual(assigned.get('inbox').map((i) => i.id), ['q-unassigned'])
  assert.deepEqual(assigned.get('deliveries').map((i) => i.id), ['d1'])
  // q-other-project（p2）与 alert 不落任何 filter 分区，进入 defaultSection。
  assert.deepEqual(assigned.get('rest').map((i) => i.id), ['q-other-project', 'a1'])
})

test('assignItems drops unmatched items when no defaultSection is configured', () => {
  const config = normalizeLayout({ sections: [{ id: 'q', source: 'questions' }] })
  const assigned = assignItems([item('q1'), item('d1', { type: 'deliverable' })], config)
  assert.deepEqual(assigned.get('q').map((i) => i.id), ['q1'])
  assert.equal([...assigned.values()].flat().length, 1)
})

test('default layout assigns the three pending kinds exactly like the fixed rendering', () => {
  const items = [
    item('q1'),
    item('a1', { type: 'alert' }),
    item('d1', { type: 'deliverable' }),
    item('old-q', { status: 'answered' }),
  ]
  const assigned = assignItems(items, normalizeLayout(undefined))
  assert.deepEqual(assigned.get('alerts').map((i) => i.id), ['a1'])
  assert.deepEqual(assigned.get('questions').map((i) => i.id), ['q1'])
  assert.deepEqual(assigned.get('deliverables').map((i) => i.id), ['d1'])
})
