import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = fileURLToPath(new URL('..', import.meta.url))

test('release tarball contains a complete, portable, loadable DSH bundle', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'rhub-package-test-'))
  const packs = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], { cwd: root, encoding: 'utf8' }))
  const pack = packs[0]
  const names = pack.files.map((entry) => entry.path)
  for (const name of ['package.json', 'cordis.patch.yml', 'LICENSE', 'README.md', 'lib/index.js', 'lib/host/core.js', 'lib/client.js']) assert.ok(names.includes(name), `Missing package file: ${name}`)
  for (const name of names) {
    assert.ok(!/(^|\/)(node_modules|\.env|\.git|\.screenshots|research-hub\.json)(\/|$)/.test(name), `Unexpected private file: ${name}`)
  }
  execFileSync('gzip', ['-t', join(temp, pack.filename)])
  execFileSync('tar', ['-xzf', join(temp, pack.filename), '-C', temp])
  const dir = join(temp, 'package')
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  // 版本号以仓库 package.json 为唯一来源，避免发版自检随版本漂移失效。
  const expectedVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  assert.equal(manifest.version, expectedVersion)
  assert.ok(existsSync(join(dir, manifest.dsh.bundle.patch)))
  assert.ok(existsSync(join(dir, manifest.exports['./client'])))
  for (const name of names.filter((name) => /\.(js|json|map|md|yml)$/.test(name))) {
    const text = readFileSync(join(dir, name), 'utf8')
    assert.ok(!text.includes('/nfs/home/'), `Non-portable private path in ${name}`)
    assert.ok(!/gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/.test(text), `Possible credential in ${name}`)
  }
  // Host peers belong to DSH; emulate that dependency environment without copying user profile data.
  symlinkSync(resolve(root, 'node_modules'), join(dir, 'node_modules'), 'dir')
  const host = await import(pathToFileURL(join(dir, 'lib/index.js')))
  assert.equal(host.name, manifest.name)
  assert.equal(typeof host.apply, 'function')
  const config = host.Config({})
  assert.equal(config.projectsRoot, process.env.DSH_RESEARCH_HUB_PROJECTS_ROOT || process.cwd())
  const { Hub } = await import(pathToFileURL(join(dir, 'lib/host/core.js')))
  const { HubStore } = await import(pathToFileURL(join(dir, 'lib/host/store.js')))
  const store = new HubStore(join(temp, 'state', 'research-hub.json'))
  const hub = new Hub(store, {}, [join(temp, 'projects')])
  const project = hub.addProject('Example Project')
  assert.equal(project.id, 'Example-Project')
  let firstMessage = ''
  const inferHub = new Hub(store, {
    sessionQuery: {
      readTitle: async () => ({ title: 'Unrelated session' }),
      filterEvents: async () => firstMessage ? [{ text: firstMessage }] : [],
    },
  }, [join(temp, 'projects')])
  assert.equal(await inferHub.inferSession('session-infer'), null)
  firstMessage = 'Working on Example Project results'
  assert.equal(await inferHub.inferSession('session-infer'), project.id)
  hub.setBinding('session-test', project.id, 'user')
  store.flush()
  assert.equal(new HubStore(store.file).data.bindings['session-test'].projectId, project.id)
  let client
  vm.runInNewContext(readFileSync(join(dir, 'lib/client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load: (entry) => { client = entry.factory((name) => { assert.equal(name, 'react'); return { createElement() {} } }) } } },
  })
  assert.equal(typeof client.apply, 'function')
  console.log(`Verified ${pack.filename}: ${names.length} files; isolated host and client imports; no profile data`)
})
