/**
 * 生成 README 与仓库社交预览用的界面图：用真实 client bundle + 纯 demo 数据渲染，
 * 不读取真实收件箱，因此天然脱敏。
 *
 * 产出：
 *   docs/assets/social-preview.png  1280×640，深色，用作仓库 Social preview
 *   docs/assets/readme-detail.png   浅色，完整面板（收件箱 + 项目总览），嵌入 README
 *
 * 依赖一个已有浏览器测试环境（react / react-dom / esbuild / playwright-core 与 Chromium）：
 *   BROWSER_TEST_MODULE_ROOT=/path/to/package.json node scripts/social-preview.mjs
 * 可选：
 *   PREVIEW_OUT / DETAIL_OUT  覆盖输出路径
 *
 * 需要先构建 client bundle：npm run build:client
 */
import { readFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (!process.env.BROWSER_TEST_MODULE_ROOT) {
  console.error('Set BROWSER_TEST_MODULE_ROOT to a package.json with react, react-dom, esbuild and playwright-core')
  process.exit(1)
}
const require = createRequire(process.env.BROWSER_TEST_MODULE_ROOT)
const { chromium } = require('playwright-core')
const { build } = require('esbuild')

let client
try {
  client = readFileSync(resolve(root, 'lib/client.js'), 'utf8')
} catch {
  console.error('lib/client.js not found; run `npm run build:client` first')
  process.exit(1)
}

const { outputFiles } = await build({
  stdin: {
    contents: 'import React from "react"; import {createRoot} from "react-dom/client"; window.React=React; window.createRoot=createRoot',
    resolveDir: dirname(process.env.BROWSER_TEST_MODULE_ROOT),
    loader: 'js',
  },
  bundle: true, write: false, format: 'iife', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
})

// ── 纯虚构演示数据：项目、会话、消息都与真实用户数据无关 ───────────────────
const now = Date.now()
const zero = { questions: 0, deliverables: 0, alerts: 0, urgent: 0 }
const sessions = [
  { id: 'session-a', title: 'Recent session 1: check long-running experiment status', updatedAt: now - 60_000, running: false },
  { id: 'session-b', title: 'Recent session 2: review build artifacts', updatedAt: now - 120_000, running: true },
  { id: 'session-c', title: 'Recent session 3: pipeline rerun notes', updatedAt: now - 240_000, running: false },
  { id: 'session-d', title: 'Recent session 4: draft the API migration plan', updatedAt: now - 600_000, running: false },
]
const projects = [
  { id: 'web', name: 'Web app', sessions, counts: { questions: 2, deliverables: 1, alerts: 1, urgent: 1 } },
  { id: 'infra', name: 'Infrastructure', sessions: sessions.slice(0, 2), counts: zero },
  { id: 'docs', name: 'Documentation', sessions: sessions.slice(1, 3), counts: zero },
  { id: 'data', name: 'Data pipeline', sessions: [sessions[2]], counts: zero },
  { id: 'lab', name: 'Lab notes', sessions: [sessions[2]], counts: zero },
  { id: 'ops', name: 'Ops runbooks', sessions: [], counts: zero },
  { id: 'mobile', name: 'Mobile app', sessions: [sessions[3]], counts: zero },
  { id: 'design', name: 'Design system', sessions: [], counts: zero },
]
const items = [
  { id: 'item-q1', sessionId: 'session-a', sessionTitle: sessions[0].title, sessionVisible: true, sessionRunning: false, projectId: 'web', title: 'Which branch should we ship this week?', body: 'Two candidates are ready. Pick one and I will continue with the release checklist.', priority: 'urgent', type: 'question', status: 'pending', source: 'auq', answerable: true, createdAt: now - 30_000 },
  { id: 'item-q2', sessionId: 'session-c', sessionTitle: sessions[2].title, sessionVisible: true, sessionRunning: false, projectId: 'data', title: 'Should the rerun keep the old table names?', body: 'The schema changed; keeping names avoids breaking downstream jobs.', priority: 'normal', type: 'question', status: 'pending', source: 'tool', createdAt: now - 120_000 },
  { id: 'item-q3', sessionId: 'session-d', sessionTitle: sessions[3].title, sessionVisible: true, sessionRunning: false, projectId: 'mobile', title: 'Is the dark theme required for the first release?', body: 'It adds about a day of work. The alternative is to ship light-only and follow up.', priority: 'normal', type: 'question', status: 'pending', source: 'tool', createdAt: now - 900_000 },
  { id: 'item-d1', sessionId: 'session-b', sessionTitle: sessions[1].title, sessionVisible: true, sessionRunning: true, projectId: 'infra', title: 'Build artifacts are ready for review', body: 'Checksums and the comparison report are attached.', priority: 'normal', type: 'deliverable', status: 'pending', source: 'tool', createdAt: now - 300_000 },
  { id: 'item-d2', sessionId: 'session-a', sessionTitle: sessions[0].title, sessionVisible: true, sessionRunning: false, projectId: 'web', title: 'Pull request opened for the settings page', body: 'The changes are small; the preview deployment is up for a quick look.', priority: 'normal', type: 'deliverable', status: 'pending', source: 'tool', createdAt: now - 1_200_000 },
  { id: 'item-a1', sessionId: 'session-a', sessionTitle: sessions[0].title, sessionVisible: true, sessionRunning: false, projectId: 'web', title: 'Turn interrupted: model error', body: 'The previous turn stopped before finishing.', priority: 'normal', type: 'alert', status: 'pending', source: 'system', alert: { turn: 12, kind: 'error', code: 'PI_AI_ERROR', detail: 'upstream request failed' }, createdAt: now - 600_000 },
]
const panel = { now, pending: 6, projects, unassignedSessions: [], unassignedCounts: zero, trashedSessions: [], items, kinds: {}, layout: {} }

const themes = {
  dark: {
    '--dsw-alias-bg-base': '#171a20', '--dsw-alias-bg-layer-1': '#232832', '--dsw-alias-bg-layer-2': '#2c323f',
    '--dsw-alias-label-primary': '#edf0f7', '--dsw-alias-label-secondary': '#b2bdce', '--dsw-alias-brand-primary': '#8eacfa',
    '--dsw-alias-state-success-primary': '#76d7a3', '--dsw-alias-state-warn-primary': '#e6be77',
    '--dsw-alias-state-error-primary': '#fa8b9c', '--dsw-alias-border-l1': '#414957', '--dsw-alias-border-l2': '#5a6579',
  },
  light: {
    '--dsw-alias-bg-base': '#f7f8fb', '--dsw-alias-bg-layer-1': '#fff', '--dsw-alias-bg-layer-2': '#f2f4f8',
    '--dsw-alias-label-primary': '#202532', '--dsw-alias-label-secondary': '#596273', '--dsw-alias-brand-primary': '#4169bf',
    '--dsw-alias-state-success-primary': '#287a50', '--dsw-alias-state-warn-primary': '#936016',
    '--dsw-alias-state-error-primary': '#b63949', '--dsw-alias-border-l1': '#dce0e8', '--dsw-alias-border-l2': '#b7c0ce',
  },
}

const HTML = '<html lang="en"><body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif"><div id="root" style="min-height:100vh"></div></body></html>'

async function mount(browser, { width, height, theme }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.route('**/rhub/api/**', (route) => {
    const method = route.request().url().split('/').at(-1)
    return route.fulfill({ json: { ok: true, value: method === 'panel' ? panel : {} } })
  })
  await page.route('http://rhub-test.local/', (route) => route.fulfill({ contentType: 'text/html', body: HTML }))
  await page.goto('http://rhub-test.local/')
  await page.evaluate((vars) => Object.entries(vars).forEach(([name, value]) => document.documentElement.style.setProperty(name, value)), themes[theme])
  await page.evaluate((bg) => { document.body.style.background = bg }, themes[theme]['--dsw-alias-bg-base'])
  await page.addScriptTag({ content: outputFiles[0].text })
  await page.evaluate(() => {
    window.__hubSlots = []
    const snapshot = { ids: ['session-a', 'session-b', 'session-c', 'session-d'], byId: {
      'session-a': { id: 'session-a', updatedAt: 4, retainedBy: { mainView: 1 } },
      'session-b': { id: 'session-b', updatedAt: 3, retainedBy: { mainView: 1 } },
      'session-c': { id: 'session-c', updatedAt: 2, retainedBy: { mainView: 1 } },
      'session-d': { id: 'session-d', updatedAt: 1, retainedBy: { mainView: 1 } },
    } }
    const sessions = { list: { getSnapshot: () => snapshot, subscribe: () => () => {} }, retain: () => ({ release() {} }) }
    const ctx = {
      slots: { inject: (_name, fn) => fn(), register: (slot, component) => { window.__hubSlots.push({ slot, component }); return () => {} } },
      effect: (fn) => fn(),
      get: (name) => name === 'sessions' ? sessions
        : name === 'uiWorkspace' ? { openSession() {} }
        : name === 'layout' ? { selectPanel() {} } : null,
    }
    window.__ModuleLoader__ = { load: ({ factory }) => factory((name) => { if (name !== 'react') throw Error(name); return window.React }).apply(ctx) }
  })
  await page.addScriptTag({ content: client })
  await page.evaluate(() => {
    const panelSlot = window.__hubSlots.find((entry) => entry.slot.name === 'main')
    const rootEl = document.getElementById('root')
    window.createRoot(rootEl).render(window.React.createElement(panelSlot.component))
  })
  await page.waitForFunction(() => document.body.innerText.includes('Inbox'), null, { timeout: 15000 })
  await page.waitForTimeout(800)
  const text = await page.evaluate(() => document.body.innerText)
  if ((text.match(/[\u4e00-\u9fff]/g) || []).length > 0) {
    throw new Error('rendered text contains CJK; force English locale before capture')
  }
  return { page, errors }
}

const socialOut = resolve(root, process.env.PREVIEW_OUT ?? 'docs/assets/social-preview.png')
const detailOut = resolve(root, process.env.DETAIL_OUT ?? 'docs/assets/readme-detail.png')
mkdirSync(dirname(socialOut), { recursive: true })

const browser = await chromium.launch({ headless: true })
try {
  // 1) Social preview: 深色，1280×640 视口截图
  {
    const { page, errors } = await mount(browser, { width: 1280, height: 640, theme: 'dark' })
    await page.screenshot({ path: socialOut })
    console.log(`saved ${socialOut} (1280x640, dark); page errors: ${errors.length ? errors.join('; ') : 'none'}`)
    await page.close()
  }

  // 2) README detail: 浅色，1440 宽，完整面板
  {
    const { page, errors } = await mount(browser, { width: 1440, height: 1200, theme: 'light' })
    const box = await page.locator('#root').boundingBox()
    await page.locator('#root').screenshot({ path: detailOut })
    console.log(`saved ${detailOut} (1440x${Math.round(box?.height ?? 0)}, light); page errors: ${errors.length ? errors.join('; ') : 'none'}`)
    await page.close()
  }
} finally {
  await browser.close()
}
