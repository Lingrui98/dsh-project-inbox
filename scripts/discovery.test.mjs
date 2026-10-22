/**
 * 项目发现规则配置化回归测试。
 *
 * 覆盖：
 * 1. resolveDiscoveryOptions 默认回退与部分配置；
 * 2. discoverProjects 默认 markers（paper.toml 名称提取、.git 目录标记）；
 * 3. 自定义 markers（package.json）与 maxDepth（0/1/2）；
 * 4. excludeDirs 与隐藏目录跳过；
 * 5. stopWords 经 Hub 注入后对 deriveAliases / matchText 生效；
 * 6. 旧调用（Hub 三参数构造）保持默认行为。
 *
 * 依赖构建产物：先 `npm run build`，再 `node --test scripts/discovery.test.mjs`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join, resolve } from 'node:path'
import {
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_MARKERS,
  DEFAULT_STOP_WORDS,
  deriveAliases,
  discoverProjects,
  markerDisplayName,
  resolveDiscoveryOptions,
} from '../lib/host/discovery.js'
import { Hub } from '../lib/host/core.js'
import { HubStore } from '../lib/host/store.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temp = mkdtempSync(join(tmpdir(), 'rhub-discovery-'))
process.on('exit', () => rmSync(temp, { recursive: true, force: true }))

let seq = 0
function freshDir() {
  seq += 1
  const dir = join(temp, `case-${seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const services = {
  sessionController: {},
  sessionQuery: {},
  userQuestions: {},
  agents: {},
}

const idsOf = (list) => list.map((p) => p.id).sort()

test('resolveDiscoveryOptions：缺省与空配置回落到默认值', () => {
  const fallback = {
    markers: [...DEFAULT_MARKERS],
    maxDepth: 1,
    stopWords: [...DEFAULT_STOP_WORDS],
    excludeDirs: [...DEFAULT_EXCLUDE_DIRS],
  }
  assert.deepEqual(resolveDiscoveryOptions(undefined), fallback)
  assert.deepEqual(resolveDiscoveryOptions(null), fallback)
  assert.deepEqual(resolveDiscoveryOptions({}), fallback)
  assert.deepEqual(resolveDiscoveryOptions({ maxDepth: Number.NaN }), fallback)
})

test('resolveDiscoveryOptions：部分配置生效，其余回落', () => {
  const opts = resolveDiscoveryOptions({ markers: ['package.json'], maxDepth: 2 })
  assert.deepEqual(opts.markers, ['package.json'])
  assert.equal(opts.maxDepth, 2)
  assert.deepEqual(opts.stopWords, DEFAULT_STOP_WORDS)
  assert.deepEqual(opts.excludeDirs, DEFAULT_EXCLUDE_DIRS)
})

test('默认 markers：paper.toml 提取显示名，.git 目录作标记，无标记目录跳过', () => {
  const dir = freshDir()
  mkdirSync(join(dir, 'alpha'))
  writeFileSync(join(dir, 'alpha', 'paper.toml'), 'name = "Alpha Paper"\n')
  mkdirSync(join(dir, 'beta', '.git'), { recursive: true })
  mkdirSync(join(dir, 'gamma'))

  const found = discoverProjects([dir])
  assert.deepEqual(idsOf(found), [basename(dir), 'alpha', 'beta'].sort())
  const alpha = found.find((p) => p.id === 'alpha')
  assert.equal(alpha.name, 'Alpha Paper')
  const beta = found.find((p) => p.id === 'beta')
  assert.equal(beta.name, 'beta', '.git 是目录，不可读时回退为目录名')
  // 根目录本身也算一个项目（0.1.4 行为）
  assert.ok(found.find((p) => p.id === basename(dir)))
})

test('自定义 markers：package.json 命中，paper.toml 不再算标记', () => {
  const dir = freshDir()
  mkdirSync(join(dir, 'alpha'))
  writeFileSync(join(dir, 'alpha', 'paper.toml'), 'name = "Alpha"\n')
  mkdirSync(join(dir, 'pkg-x'))
  writeFileSync(join(dir, 'pkg-x', 'package.json'), '{"name":"pkg-x"}\n')

  const found = discoverProjects([dir], { markers: ['package.json'] })
  assert.deepEqual(idsOf(found), [basename(dir), 'pkg-x'].sort())
  // JSON 不是 TOML 键值，显示名回退为目录名
  assert.equal(found.find((p) => p.id === 'pkg-x').name, 'pkg-x')
})

test('maxDepth：0 只登记根，1 只看一层，2 能看到孙目录', () => {
  const dir = freshDir()
  mkdirSync(join(dir, 'child'))
  writeFileSync(join(dir, 'child', 'paper.toml'), 'name = "Child"\n')
  mkdirSync(join(dir, 'grp', 'inner'), { recursive: true })
  writeFileSync(join(dir, 'grp', 'inner', 'paper.toml'), 'name = "Inner"\n')

  assert.deepEqual(idsOf(discoverProjects([dir], { maxDepth: 0 })), [basename(dir)])
  assert.deepEqual(idsOf(discoverProjects([dir], { maxDepth: 1 })), [basename(dir), 'child'].sort())
  // grp 本身没有 marker 不登记，但会向下遍历到 inner
  assert.deepEqual(idsOf(discoverProjects([dir], { maxDepth: 2 })), [basename(dir), 'child', 'inner'].sort())
})

test('excludeDirs：默认跳过 node_modules，隐藏目录始终跳过，自定义排除生效', () => {
  const dir = freshDir()
  mkdirSync(join(dir, 'node_modules'))
  writeFileSync(join(dir, 'node_modules', 'paper.toml'), 'name = "Nm"\n')
  mkdirSync(join(dir, '.hidden'))
  writeFileSync(join(dir, '.hidden', 'paper.toml'), 'name = "Hidden"\n')
  mkdirSync(join(dir, 'skipme'))
  writeFileSync(join(dir, 'skipme', 'paper.toml'), 'name = "Skip"\n')

  // 默认：node_modules 与隐藏目录不登记，skipme 正常登记
  const byDefault = discoverProjects([dir])
  assert.deepEqual(idsOf(byDefault), [basename(dir), 'skipme'].sort())
  // 自定义排除 skipme
  const custom = discoverProjects([dir], { excludeDirs: ['skipme'] })
  assert.deepEqual(idsOf(custom), [basename(dir), 'node_modules'].sort())
})

test('markerDisplayName：提取第一个 name/title 字段', () => {
  assert.equal(markerDisplayName('title = "My Paper"\n'), 'My Paper')
  assert.equal(markerDisplayName("name = 'single'\n"), 'single')
  assert.equal(markerDisplayName('{"name":"json"}\n'), undefined)
})

test('deriveAliases：停用词可配置，默认与 0.1.4 一致', () => {
  const aliases = deriveAliases('paper-reduction', 'paper-reduction')
  assert.ok(!aliases.includes('paper'), '默认停用词过滤 paper')
  assert.ok(aliases.includes('reduction'))
  const custom = deriveAliases('paper-reduction', 'paper-reduction', [])
  assert.ok(custom.includes('paper'), '清空停用词后 paper 参与别名')
})

test('stopWords 经 Hub 注入：matchText 使用配置后的停用词', () => {
  const byDefault = new Hub(new HubStore(join(temp, 'hub-stop-default.json')), services, [])
  byDefault.addProject('exp')
  assert.equal(byDefault.matchText('exp results'), null, '默认停用词下 exp 不参与匹配')

  const custom = new Hub(new HubStore(join(temp, 'hub-stop-custom.json')), services, [], { stopWords: [] })
  custom.addProject('exp')
  assert.equal(custom.matchText('exp results'), 'exp', '清空停用词后 exp 可匹配')
})

test('Hub.discoverProjects 默认配置与 0.1.4 行为一致（旧调用兼容）', () => {
  const dir = freshDir()
  mkdirSync(join(dir, 'alpha'))
  writeFileSync(join(dir, 'alpha', 'paper.toml'), 'name = "Alpha Paper"\n')
  mkdirSync(join(dir, 'gamma'))

  // 旧调用：三参数构造，不传发现配置
  const store = new HubStore(join(temp, 'hub-compat.json'))
  const hub = new Hub(store, services, [dir])
  hub.discoverProjects()
  const projects = store.data.projects
  assert.deepEqual(projects.map((p) => p.id).sort(), [basename(dir), 'alpha'].sort())
  assert.equal(projects.find((p) => p.id === 'alpha').name, 'Alpha Paper')

  // 重复扫描幂等：别名只增不删，不重复建项目
  hub.discoverProjects()
  assert.equal(store.data.projects.length, 2)
})
