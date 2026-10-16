import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const roots = [process.env.DSH_CHECKOUT, process.env.DSH_ROOT].filter(Boolean).map((path) => resolve(path))
try {
  const env = { ...process.env }
  // npm --prefix exports its project prefix to lifecycle scripts; that is not the global installation.
  delete env.npm_config_prefix
  delete env.NPM_CONFIG_PREFIX
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', env }).trim()
  roots.push(resolve(globalRoot, '@deepseek-ai/dsh'))
} catch { /* A local DSH dependency or explicit path may still work. */ }
const requires = [createRequire(resolve(root, 'package.json'))]
for (const path of roots) requires.push(createRequire(resolve(path, 'package.json')))
const names = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-client-ui-slots']
for (const name of names) {
  const dest = resolve(root, 'node_modules', name)
  if (existsSync(dest)) continue
  let target
  for (const require of requires) {
    try { target = dirname(require.resolve(`${name}/package.json`)); break } catch { /* Try the next installation. */ }
  }
  if (!target) throw Error(`Cannot resolve ${name}. Install DSH, or set DSH_ROOT/DSH_CHECKOUT to its package root.`)
  // Never recursively delete a computed directory. Only replace a broken symlink at this exact dependency path.
  if (!dest.startsWith(resolve(root, 'node_modules') + '/')) throw Error('Invalid dependency destination')
  try {
    if (!lstatSync(dest).isSymbolicLink()) throw Error(`Refusing to replace an existing directory: ${dest}`)
    console.log(`Replacing broken dependency link: ${dest}`)
    unlinkSync(dest)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  mkdirSync(dirname(dest), { recursive: true })
  symlinkSync(realpathSync(target), dest, process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`Linked ${name}`)
}
