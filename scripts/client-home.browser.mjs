import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// Reuse an existing installation; do not install a second browser or server.
// Example: BROWSER_TEST_MODULE_ROOT=/path/to/package.json node scripts/client-home.browser.mjs
assert.ok(process.env.BROWSER_TEST_MODULE_ROOT, 'Set BROWSER_TEST_MODULE_ROOT to a package.json with react, react-dom, esbuild and playwright-core')
const require = createRequire(process.env.BROWSER_TEST_MODULE_ROOT)
const { chromium } = require('playwright-core')
const { build } = require('esbuild')
const { outputFiles } = await build({
  stdin: { contents: 'import React from "react"; import {createRoot} from "react-dom/client"; window.React=React; window.createRoot=createRoot', resolveDir: new URL('.', 'file://' + process.env.BROWSER_TEST_MODULE_ROOT).pathname, loader: 'js' },
  bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' },
})
const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const now = Date.now()
const counts = { questions: 0, deliverables: 0, urgent: 0 }
const sessions = [1, 2, 3, 4].map((n) => ({ id: `session-${n}`, title: `最近会话 ${n}：长期实验状态与结果核查，这是一个较长的会话标题`, updatedAt: now - n * 60000, running: n === 2 }))
const projects = [
  { id: 'p', name: '示例研究项目 LongName', sessions, counts },
  { id: 'q', name: '空项目', sessions: [], counts },
  { id: 'r', name: '另一个项目', sessions: sessions.slice(1), counts },
  ...Array.from({ length: 7 }, (_, i) => ({ id: `extra-${i}`, name: `项目 ${i}`, sessions: sessions.slice(0, i % 4), counts })),
]
const empty = { now, pending: 0, projects, unassignedSessions: [], unassignedCounts: counts, trashedSessions: [], items: [] }
const items = [1, 2, 3, 4].map((n) => ({ id: `item-${n}`, sessionId: 'session-1', sessionTitle: sessions[0].title, sessionVisible: true, sessionRunning: false, projectId: 'p', title: n === 2 ? '紧急：确认下一步实验范围' : `待处理消息 ${n}`, body: '此处是消息正文，用于验证首页能够直接阅读和回复。'.repeat(n === 1 ? 15 : 2), priority: n === 2 ? 'urgent' : 'normal', type: n === 3 ? 'deliverable' : 'question', status: 'pending', source: 'tool', createdAt: now - n * 10000 }))
items[3] = { ...items[3], source: 'auq', answerable: true, auq: { callId: 'test-call', questions: [{ id: 'decision', question: '选择验证方式', options: [{ label: '先小规模验证' }, { label: '完整回归' }] }] } }
const populated = { ...empty, pending: 4, items, projects: [{ ...projects[0], counts: { questions: 3, deliverables: 1, urgent: 1 } }, ...projects.slice(1)] }
const themes = {
  light: { '--dsw-alias-bg-base': '#f7f8fb', '--dsw-alias-bg-layer-1': '#fff', '--dsw-alias-bg-layer-2': '#f2f4f8', '--dsw-alias-label-primary': '#202532', '--dsw-alias-label-secondary': '#596273', '--dsw-alias-brand-primary': '#4169bf', '--dsw-alias-state-success-primary': '#287a50', '--dsw-alias-state-warn-primary': '#936016', '--dsw-alias-state-error-primary': '#b63949', '--dsw-alias-border-l1': '#dce0e8', '--dsw-alias-border-l2': '#b7c0ce' },
  dark: { '--dsw-alias-bg-base': '#171a20', '--dsw-alias-bg-layer-1': '#232832', '--dsw-alias-bg-layer-2': '#2c323f', '--dsw-alias-label-primary': '#edf0f7', '--dsw-alias-label-secondary': '#b2bdce', '--dsw-alias-brand-primary': '#8eacfa', '--dsw-alias-state-success-primary': '#76d7a3', '--dsw-alias-state-warn-primary': '#e6be77', '--dsw-alias-state-error-primary': '#fa8b9c', '--dsw-alias-border-l1': '#414957', '--dsw-alias-border-l2': '#5a6579' },
}
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ['light', 'dark']) {
    for (const width of [1920, 1440, 768, 390]) {
      for (const [state, panel] of [['empty', empty], ['pending', populated]]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } })
        const errors = []
        const requests = []
        page.on('pageerror', (error) => errors.push(String(error)))
        const payloads = []
        await page.route('**/rhub/api/**', (route) => {
          const method = route.request().url().split('/').at(-1)
          requests.push(method)
          payloads.push({ method, value: route.request().postDataJSON() })
          return route.fulfill({ json: { ok: true, value: method === 'panel' ? panel : method === 'warm' ? { ok: true } : {} } })
        })
        // Use a route-backed document, not a second application server.
        await page.route('http://rhub-test.local/', (route) => route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0;font-family:Arial,sans-serif"><div id="root" style="height:100vh"></div></body></html>' }))
        await page.goto('http://rhub-test.local/')
        await page.evaluate((vars) => Object.entries(vars).forEach(([name, value]) => document.documentElement.style.setProperty(name, value)), themes[theme])
        await page.addScriptTag({ content: outputFiles[0].text })
        await page.evaluate(() => {
          window.__hubSlots = []
          window.__events = []
          // A newer retained session must not hide the return button for an older destination.
          const snapshot = { ids: ['session-other', 'session-1', 'session-2'], byId: {
            'session-other': { id: 'session-other', updatedAt: 99999, retainedBy: { mainView: 1 } },
            'session-1': { id: 'session-1', updatedAt: 1, retainedBy: { mainView: 1 } },
            'session-2': { id: 'session-2', updatedAt: 2, retainedBy: { mainView: 1 } },
          } }
          const sessions = { list: { getSnapshot: () => snapshot, subscribe: () => () => {} }, retain: (id) => { window.__events.push(['retain', id]); return { release() { window.__events.push(['release', id]) } } } }
          const ctx = {
            slots: { inject: (_name, fn) => fn(), register: (slot, component) => { window.__hubSlots.push({ slot, component }); return () => {} } },
            effect: (fn) => fn(),
            get: (name) => name === 'sessions' ? sessions
              : name === 'uiWorkspace' ? { openSession: (id) => window.__events.push(['open', id]) }
              : name === 'layout' ? { selectPanel: (id) => { window.__events.push(['panel', id]); window.__renderHub() } } : null,
          }
          window.__ModuleLoader__ = { load: ({ factory }) => factory((name) => { if (name !== 'react') throw Error(name); return window.React }).apply(ctx) }
        })
        await page.addScriptTag({ content: client })
        await page.evaluate(() => {
          const panel = window.__hubSlots.find((entry) => entry.slot.name === 'main')
          const header = window.__hubSlots.find((entry) => entry.slot.name === 'conversation.session.header.utilities')
          const root = window.createRoot(document.getElementById('root'))
          window.__renderHub = () => root.render(window.React.createElement(panel.component))
          window.__renderHeader = (sessionId) => root.render(window.React.createElement(header.component, { ...header.slot.inject(sessionId), sessionId }))
          window.__renderHub()
        })
        await page.getByRole('region', { name: '收件箱', exact: true }).waitFor()
        const inbox = page.getByRole('region', { name: '收件箱', exact: true })
        assert.match(await inbox.innerText(), state === 'empty' ? /当前没有待处理消息/ : /4 条待处理/)
        assert.equal(await page.getByRole('group', { name: '示例研究项目 LongName', exact: true }).locator('button[title^="打开会话："]').count(), 3)
        await page.locator('.rh-project-grid[data-masonry="ready"]').waitFor()
        const geometry = await page.evaluate(() => {
          const inbox = document.querySelector('section[aria-label="收件箱"]').getBoundingClientRect()
          const cardElements = [...document.querySelectorAll('[role="group"]')]
          const cards = cardElements.map((n) => n.getBoundingClientRect())
          const internalGaps = cardElements.flatMap((card) => [...card.children].slice(1).map((child, i) => child.getBoundingClientRect().top - card.children[i].getBoundingClientRect().bottom))
          const emptyHeight = document.querySelector('[role="group"][aria-label="空项目"]').getBoundingClientRect().height
          const fullHeight = document.querySelector('[role="group"][aria-label="示例研究项目 LongName"]').getBoundingClientRect().height
          const overflow = [...document.querySelectorAll('*')].filter((n) => {
            const box = n.getBoundingClientRect()
            return box.width > 0 && (box.right > innerWidth + 1 || box.left < -1)
          }).map((n) => n.tagName + ':' + n.className)
          const columns = getComputedStyle(document.querySelector('.rh-project-grid')).gridTemplateColumns.split(' ').length
          const compact = cards.slice(columns).every((card) => {
            const above = cards.filter((other) => Math.abs(other.left - card.left) < 1 && other.top < card.top)
            const gap = card.top - Math.max(...above.map((other) => other.bottom))
            return gap >= 15 && gap <= 18
          })
          const overlap = cards.some((a, i) => cards.slice(i + 1).some((b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1))
          let regularHeight = 0
          for (let i = 0; i < cards.length; i += columns) regularHeight += Math.max(...cards.slice(i, i + columns).map((r) => r.height)) + 16
          const packedHeight = Math.max(...cards.map((r) => r.bottom)) - Math.min(...cards.map((r) => r.top)) + 16
          return { inboxBottom: inbox.bottom, cardTops: cards.map((r) => r.top), internalGaps, emptyHeight, fullHeight, overflow, columns, compact, overlap, widths: cards.map((r) => r.width), regularHeight, packedHeight }
        })
        assert.ok(geometry.cardTops.every((top) => top >= geometry.inboxBottom), 'Inbox must precede projects')
        assert.deepEqual(geometry.overflow, [], 'No horizontal layout overflow')
        assert.ok(geometry.cardTops.slice(0, geometry.columns).every((top) => top === geometry.cardTops[0]), 'First cards align across columns')
        assert.ok(geometry.compact, 'Cards fill the next available position with a consistent gap')
        assert.equal(geometry.overlap, false, 'Masonry cards must not overlap')
        assert.ok(Math.max(...geometry.widths) - Math.min(...geometry.widths) < 1, 'Columns remain equal width')
        if (geometry.columns > 1) assert.ok(geometry.packedHeight < geometry.regularHeight - 10, 'Masonry reduces total height compared with regular equal-height rows')
        assert.ok(geometry.emptyHeight < geometry.fullHeight - 30, 'Sparse cards must not stretch to match the tallest card')
        assert.ok(geometry.internalGaps.every((gap) => gap <= 13), 'Card sections must not use expanding blank space')
        // Simulate content growth and shrinking without remounting or changing DOM order.
        const emptyCard = page.getByRole('group', { name: '空项目', exact: true })
        const originalSpan = await emptyCard.evaluate((node) => node.style.gridRowEnd)
        await emptyCard.evaluate((node) => { node.style.paddingBottom = '140px' })
        await page.waitForFunction((oldSpan) => document.querySelector('[aria-label="空项目"]').style.gridRowEnd !== oldSpan, originalSpan)
        assert.equal(await page.evaluate(() => {
          const cards = [...document.querySelectorAll('.rh-project')].map((node) => node.getBoundingClientRect())
          return cards.some((a, i) => cards.slice(i + 1).some((b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1))
        }), false, 'Content growth must trigger repacking without overlap')
        await emptyCard.evaluate((node) => { node.style.padding = '18px' })
        await page.waitForFunction((span) => document.querySelector('[aria-label="空项目"]').style.gridRowEnd === span, originalSpan)
        if (width === 1440) {
          await page.locator('#root').evaluate((node) => { node.style.width = '600px' })
          await page.waitForFunction(() => {
            const cards = [...document.querySelectorAll('.rh-project')].map((node) => node.getBoundingClientRect())
            return cards.every((r) => r.width > 500 && Math.abs(r.left - cards[0].left) < 1) && cards.slice(1).every((r, i) => r.top - cards[i].bottom >= 15)
          })
          await page.locator('#root').evaluate((node) => { node.style.width = '' })
          await page.waitForFunction(() => {
            const cards = [...document.querySelectorAll('.rh-project')].map((node) => node.getBoundingClientRect())
            return Math.abs(cards[0].top - cards[1].top) < 1 && !cards.some((a, i) => cards.slice(i + 1).some((b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1))
          })
        }
        await page.screenshot({ path: `/tmp/rhub-home-${theme}-${width}-${state}.png`, fullPage: true })
        const firstSession = page.getByRole('group', { name: '示例研究项目 LongName', exact: true }).locator('button[title^="打开会话："]').first()
        await firstSession.focus()
        assert.equal(await firstSession.evaluate((node) => getComputedStyle(node).outlineStyle), 'solid', 'Keyboard focus must be visible')
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.getByRole('group', { name: '示例研究项目 LongName', exact: true }).hover()
        assert.equal(await page.getByRole('group', { name: '示例研究项目 LongName', exact: true }).evaluate((node) => getComputedStyle(node).transform), 'none', 'Reduced motion disables card lift')
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        // Real DOM clicks must not trigger project navigation when opening a session.
        const project = page.getByRole('group', { name: '示例研究项目 LongName', exact: true })
        await project.locator('button[title^="打开会话："]').first().click()
        await page.waitForFunction(() => window.__events.some(([event]) => event === 'open'))
        assert.deepEqual(await page.evaluate(() => window.__events), [['retain', 'session-1'], ['open', 'session-1']])
        await page.waitForFunction(() => window.__events.some(([event, id]) => event === 'release' && id === 'session-1'), null, { timeout: 3000 })
        assert.equal(await inbox.count(), 1)
        // Mount the registered session-scoped header after unmounting the hub.
        await page.evaluate(() => window.__renderHeader('session-1'))
        await page.getByRole('button', { name: '← 指挥中心', exact: true }).waitFor()
        // Another session's header must not inherit this destination's return button.
        await page.evaluate(() => window.__renderHeader('session-other'))
        await page.waitForFunction(() => !document.querySelector('button[title="回到指挥中心（保留你离开时的页面）"]'))
        await page.evaluate(() => window.__renderHeader('session-1'))
        await page.getByRole('button', { name: '← 指挥中心', exact: true }).click()
        await inbox.waitFor()
        assert.deepEqual(await page.evaluate(() => window.__events.slice(-2)), [['release', 'session-1'], ['panel', 'research-hub']])
        // Jump to a second session after returning; reused header props must update.
        await project.locator('button[title^="打开会话："]').nth(1).click()
        await page.waitForFunction(() => window.__events.some(([event, id]) => event === 'open' && id === 'session-2'))
        await page.evaluate(() => window.__renderHeader('session-2'))
        await page.getByRole('button', { name: '← 指挥中心', exact: true }).click()
        await inbox.waitFor()
        assert.deepEqual(await page.evaluate(() => window.__events.slice(-2)), [['release', 'session-2'], ['panel', 'research-hub']])
        // Whitespace in the project card still opens the project.
        await project.click({ position: { x: 5, y: 5 } })
        assert.equal(await inbox.count(), 0)
        const detailGeometry = await page.evaluate(() => {
          const detail = document.querySelector('.rh-detail-grid')
          const columns = getComputedStyle(detail).gridTemplateColumns.split(' ').length
          const overflow = [...document.querySelectorAll('*')].filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1) }).map((n) => n.tagName)
          return { columns, overflow }
        })
        assert.equal(detailGeometry.columns, width > 1050 ? 2 : 1)
        assert.deepEqual(detailGeometry.overflow, [], 'Detail view must not overflow')
        if (width === 1440) {
          await page.locator('#root').evaluate((node) => { node.style.width = '600px' })
          assert.equal(await page.locator('.rh-detail-grid').evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length), 1, 'Narrow host panels collapse columns even in wide viewports')
          await page.locator('#root').evaluate((node) => { node.style.width = '' })
        }
        await page.screenshot({ path: `/tmp/rhub-detail-${theme}-${width}-${state}.png`, fullPage: true })
        await page.getByRole('button', { name: '← 返回', exact: true }).click()
        await page.getByRole('region', { name: '收件箱', exact: true }).waitFor()
        await page.getByRole('button', { name: state === 'empty' ? '打开收件箱' : '查看全部 4 条', exact: true }).click()
        assert.match(await page.locator('#root').innerText(), /待回答问题/)
        if (state === 'pending') {
          const message = page.locator('.rh-message').filter({ hasText: '紧急：确认下一步实验范围' })
          await message.getByRole('textbox').fill('已确认，执行这项方案。')
          await Promise.all([
            page.waitForResponse((r) => r.url().endsWith('/reply')),
            message.getByRole('textbox').press('Control+Enter'),
          ])
          assert.ok(payloads.some((p) => p.method === 'reply' && p.value.itemId === 'item-2' && p.value.text === '已确认，执行这项方案。'))
          await page.getByRole('button', { name: '查收', exact: true }).click()
          assert.ok(payloads.some((p) => p.method === 'ack' && p.value.itemId === 'item-3'))
          const structured = page.locator('.rh-message').filter({ hasText: '待处理消息 4' })
          await structured.getByRole('button', { name: '先小规模验证', exact: true }).click()
          assert.equal(await structured.getByRole('button', { name: '先小规模验证', exact: true }).getAttribute('aria-pressed'), 'true')
          await structured.getByRole('button', { name: '提交选择', exact: true }).click()
          assert.ok(payloads.some((p) => p.method === 'answerStructured' && p.value.itemId === 'item-4' && p.value.answers[0].selected[0] === '先小规模验证'))
        }
        assert.equal(errors.length, 0, errors.join('\n'))
        assert.ok(requests.includes('panel'))
        console.log(`PASS ${theme} ${width}px ${state}: layout, previews, jump isolation, session header return cycle, project and inbox navigation`)
        await page.close()
      }
    }
  }
} finally { await browser.close() }
