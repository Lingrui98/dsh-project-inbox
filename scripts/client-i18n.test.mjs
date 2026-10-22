import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// 与 client-home.test.mjs 相同的加载方式：transpile TS 后在 vm 里执行。
// 提供 console 桩以统计 warn 次数；不提供 document/navigator（模拟 Node 环境）。
function loadStrings(warnings, globals = {}) {
  const source = readFileSync(new URL('../src/client/strings.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
  })
  const exports = {}
  vm.runInNewContext(outputText, {
    exports,
    require: (name) => { throw new Error(`strings.ts 不应有依赖：${name}`) },
    console: { warn: (msg) => warnings.push(String(msg)), log() {}, error() {} },
    ...globals,
  })
  return exports
}

test('zh 与 en 字典的键集合完全一致', () => {
  const { zh, en } = loadStrings([])
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
})

test('en 字典每个键都有定义，且值类型与 zh 一致', () => {
  const { zh, en } = loadStrings([])
  for (const key of Object.keys(zh)) {
    assert.notEqual(en[key], undefined, `en 缺键 ${key}`)
    assert.equal(typeof en[key], typeof zh[key], `键 ${key} 类型不一致`)
  }
})

test('zh 抽样文案与 0.1.4 逐字一致', () => {
  const { zh } = loadStrings([])
  // 静态文案
  assert.equal(zh.loading, '正在加载收件箱…')
  assert.equal(zh.hubName, '项目收件箱')
  assert.equal(zh.retry, '重试')
  assert.equal(zh.back, '← 返回')
  assert.equal(zh.typeQuestionPending, '待回答')
  assert.equal(zh.typeAlertPending, '待处理')
  assert.equal(zh.typeDeliverablePending, '待查收')
  assert.equal(zh.pillSessionInterrupt, '会话中断')
  assert.equal(zh.dismiss, '忽略')
  assert.equal(zh.ack, '查收')
  assert.equal(zh.reopen, '重开')
  assert.equal(zh.placeholderAlert, '回复内容会继续该会话… · Ctrl/⌘ + Enter 发送')
  assert.equal(zh.placeholderWithOptions, '补充说明（可选） · Ctrl/⌘ + Enter 提交')
  assert.equal(zh.placeholderText, '写下回复… · Ctrl/⌘ + Enter 发送')
  assert.equal(zh.sessionOnlyHint, '该问题显示在前台会话的提问卡片上，需在会话内回答。回答后此处会自动关闭。')
  assert.equal(zh.newProjectPrompt, '新项目名称（例如 sway-paper）：')
  assert.equal(zh.noSessionsInProject, '尚无会话归入此项目')
  assert.equal(zh.inboxDesc, '集中回答问题、查收交付、处理会话中断。仅查看不会关闭消息。')
  assert.equal(zh.inboxEmptyTitle, '当前没有待处理消息')
  assert.equal(zh.noProjects, '暂无项目。可以新建项目，或重新扫描发现项目。')
  assert.equal(zh.trashEmpty, '回收站是空的。未分配区会话行上的垃圾桶按钮会把不重要的会话扫到这里。')
  assert.equal(zh.returnLabel, '← 收件箱')
  assert.equal(zh.returnTitle, '回到收件箱（保留你离开时的页面）')
  assert.equal(zh.newProjectOption, '＋ 新建项目并归入')
  // 插值文案
  assert.equal(zh.agoSeconds(5), '5 秒前')
  assert.equal(zh.agoMinutes(3), '3 分钟前')
  assert.equal(zh.agoHours(2), '2 小时前')
  assert.equal(zh.agoDays(4), '4 天前')
  assert.equal(zh.requestFailed(500), '请求失败（500）')
  assert.equal(zh.inboxHeadline(0), '收件箱 · 0 条待处理')
  assert.equal(zh.inboxMore(1), '还有 1 条待处理，打开收件箱继续处理')
  assert.equal(zh.expandAll(200), '展开全部（200 字）')
  assert.equal(zh.cardSessions(2, false), '2 个会话')
  assert.equal(zh.cardSessions(5, true), '5 个会话 · 显示最近 3 个')
  assert.equal(zh.overviewDesc(3, 7, 0), '3 个项目 · 7 个会话')
  assert.equal(zh.overviewDesc(3, 7, 2), '3 个项目 · 7 个会话 · 2 个运行中')
  assert.equal(zh.trashButton(2), ' 回收站（2）')
  assert.equal(zh.trashHeading(2), '回收站（2）')
  assert.equal(zh.historyToggle(9), '历史记录（9）')
  assert.equal(zh.trashedAt('3 分钟前'), '扫入于 3 分钟前')
  assert.equal(zh.openSessionTitle('会话 A', false), '打开会话：会话 A')
  assert.equal(zh.openSessionTitle('会话 A', true), '打开会话：会话 A（运行中）')
  assert.equal(zh.syncErrorBanner('上次成功数据', 'boom'), '自动更新失败，当前显示 上次成功数据：boom')
  assert.equal(zh.warmFailed('未知原因'), '会话预热失败：未知原因')
  assert.equal(zh.jumpNotInCatalog('abc123'), '提示：会话 abc123… 不在当前客户端目录中，已尝试打开')
  assert.equal(zh.answerPrefix('好的'), '答复：好的')
  assert.equal(zh.suggestChip('P'), '建议：P')
  assert.equal(zh.pillQuestionsCount(2), '2 待回答')
  assert.equal(zh.pillDeliverablesCount(3), '3 待查收')
  assert.equal(zh.cardPillQuestions(2), '2 问')
  assert.equal(zh.cardPillDeliverables(3), '3 交付')
})

test('resolveLocale：en* 归 en，其余与缺省归 zh', () => {
  const { resolveLocale } = loadStrings([])
  assert.equal(resolveLocale('en'), 'en')
  assert.equal(resolveLocale('en-US'), 'en')
  assert.equal(resolveLocale('EN-gb'), 'en')
  assert.equal(resolveLocale('zh-CN'), 'zh')
  assert.equal(resolveLocale('zh'), 'zh')
  assert.equal(resolveLocale('fr-FR'), 'zh')
  assert.equal(resolveLocale('ja'), 'zh')
  assert.equal(resolveLocale(''), 'zh')
  // 无 document/navigator 的 Node 环境：undefined/null 走默认，落到 zh
  assert.equal(resolveLocale(), 'zh')
  assert.equal(resolveLocale(null), 'zh')
  assert.equal(resolveLocale(undefined), 'zh')
})

test('resolveLocale：document.lang 优先于 navigator.language，缺省回退 zh', () => {
  const zhCtx = { document: { documentElement: { lang: 'zh-CN' } }, navigator: { language: 'en-US' } }
  const zhMod = loadStrings([], zhCtx)
  assert.equal(zhMod.resolveLocale(), 'zh')
  assert.equal(zhMod.pickStrings().hubName, '项目收件箱')

  const enCtx = { document: { documentElement: { lang: 'en-US' } }, navigator: { language: 'zh-CN' } }
  const enMod = loadStrings([], enCtx)
  assert.equal(enMod.resolveLocale(), 'en')
  assert.equal(enMod.pickStrings().hubName, 'Inbox')
})

test('pickStrings：zh 原样返回，en 覆盖全部键', () => {
  const { zh, en, pickStrings } = loadStrings([])
  assert.equal(pickStrings('zh'), zh)
  assert.equal(pickStrings('zh-CN'), zh)
  const picked = pickStrings('en-US')
  assert.equal(picked.loading, en.loading)
  assert.equal(picked.inboxHeadline(2), en.inboxHeadline(2))
  assert.notEqual(picked.loading, zh.loading)
  // 不传参（Node 环境）回退 zh
  assert.equal(pickStrings(), zh)
})

test('en 缺键时回退 zh 且每个键只 warn 一次', () => {
  const warnings = []
  const { zh, mergeWithFallback } = loadStrings(warnings)
  const total = Object.keys(zh).length
  // 空覆盖：全部键回退 zh
  const merged = mergeWithFallback({})
  assert.equal(merged.loading, zh.loading)
  assert.equal(merged.inboxHeadline(4), zh.inboxHeadline(4))
  assert.equal(warnings.length, total)
  // 再次合并同样的缺失：不再重复 warn
  mergeWithFallback({})
  assert.equal(warnings.length, total)
  // 部分覆盖：只为缺键 warn，已覆盖键用覆盖值
  const partial = mergeWithFallback({ loading: 'L', retry: 'R' })
  assert.equal(partial.loading, 'L')
  assert.equal(partial.retry, 'R')
  assert.equal(partial.hubName, zh.hubName)
  assert.equal(warnings.length, total)
})
