/**
 * 项目发现规则：markers / maxDepth / stopWords / excludeDirs 全部可配置。
 * 未配置时 resolveDiscoveryOptions 回落到默认值，行为与 0.1.4 的硬编码完全一致。
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { basename, join } from 'node:path'

/** 默认项目标记：目录含 paper.toml 或 .git 即算项目。 */
export const DEFAULT_MARKERS = ['paper.toml', '.git']

/** 默认归因停用词：无区分度的通用词，不参与别名派生与匹配。 */
export const DEFAULT_STOP_WORDS = ['paper', 'papers', 'project', 'exp', 'doc', 'docs', 'the', 'and']

/** 默认扫描排除目录。 */
export const DEFAULT_EXCLUDE_DIRS = ['.git', 'node_modules']

/** 发现规则的完整形态（resolveDiscoveryOptions 的输出）。 */
export interface DiscoveryOptions {
  /** 目录含任一标记文件即登记为项目；按数组顺序取第一个命中的标记提取显示名。 */
  markers: string[]
  /** 从项目根往下扫描的层数：0 只登记根本身，1 是 0.1.4 的行为。 */
  maxDepth: number
  /** 归因停用词：别名派生与文本匹配都跳过这些词（小写比较）。 */
  stopWords: string[]
  /** 扫描时跳过的目录名；隐藏目录（. 开头）始终跳过。 */
  excludeDirs: string[]
}

/** 配置入参：所有字段可选，缺省回落到默认值。 */
export interface DiscoveryConfig {
  markers?: string[]
  maxDepth?: number
  stopWords?: string[]
  excludeDirs?: string[]
}

function uniq(list: string[]): string[] {
  return [...new Set(list.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()))]
}

/** 字符串数组配置：非数组回退默认值；显式数组（含空数组）按用户配置生效。 */
function cleanList(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  return uniq(value as string[])
}

/** 解析发现配置：缺省字段回落到默认值；maxDepth 取非负整数，否则回退 1。 */
export function resolveDiscoveryOptions(config?: DiscoveryConfig | null): DiscoveryOptions {
  const maxDepth = Number(config?.maxDepth)
  return {
    markers: cleanList(config?.markers, DEFAULT_MARKERS),
    maxDepth: Number.isFinite(maxDepth) && maxDepth >= 0 ? Math.floor(maxDepth) : 1,
    stopWords: cleanList(config?.stopWords, DEFAULT_STOP_WORDS),
    excludeDirs: cleanList(config?.excludeDirs, DEFAULT_EXCLUDE_DIRS),
  }
}

/** 从目录名派生别名：全名、去分隔符、逐 token（≥3 字符且非停用词）、token 前缀链。 */
export function deriveAliases(dirName: string, displayName: string, stopWords: readonly string[] = DEFAULT_STOP_WORDS): string[] {
  const stops = new Set(stopWords.map((s) => s.toLowerCase()))
  const aliases = [dirName, displayName, dirName.replace(/[-_]+/g, '')]
  const tokens = dirName.split(/[-_]+/).filter((t) => t.length >= 3 && !stops.has(t.toLowerCase()))
  aliases.push(...tokens)
  for (let i = 2; i < tokens.length; i += 1) aliases.push(tokens.slice(0, i).join(' '))
  return uniq(aliases)
}

/** 从 marker 文件文本里朴素提取第一个 name/title 字段（TOML 风格键值）。 */
export function markerDisplayName(text: string): string | undefined {
  const m = text.match(/^(?:name|title)\s*=\s*["']([^"']+)["']/m)
  return m?.[1]
}

/** 一次扫描发现的项目。 */
export interface DiscoveredProject {
  id: string
  name: string
  aliases: string[]
}

/**
 * 扫描项目根：根目录本身登记为一个项目；再向下扫描 maxDepth 层，
 * 含任一 marker 的子目录登记为项目。单个根失败不影响其他根。
 *
 * 显示名取自第一个命中的 marker 文件里的 name/title 字段；
 * marker 是目录（如 .git）或不可读时回退为目录名。
 */
export function discoverProjects(roots: readonly string[], options?: DiscoveryConfig | null): DiscoveredProject[] {
  const opts = resolveDiscoveryOptions(options)
  const found = new Map<string, { name: string; aliases: string[] }>()
  const addDir = (dir: string, display: string) => {
    const previous = found.get(dir)
    found.set(dir, {
      name: display,
      aliases: uniq([...(previous?.aliases ?? []), ...deriveAliases(dir, display, opts.stopWords)]),
    })
  }
  const excluded = new Set(opts.excludeDirs)
  for (const root of roots) {
    try {
      if (!existsSync(root)) continue
      const rootName = basename(root) || 'projects'
      addDir(rootName, rootName)
      let level: string[] = [root]
      for (let depth = 1; depth <= opts.maxDepth; depth += 1) {
        const next: string[] = []
        for (const dir of level) {
          let entries: Dirent[]
          try {
            entries = readdirSync(dir, { withFileTypes: true })
          } catch {
            continue
          }
          for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.') || excluded.has(entry.name)) continue
            const child = join(dir, entry.name)
            next.push(child)
            const marker = opts.markers.find((name) => existsSync(join(child, name)))
            if (!marker) continue
            let display = entry.name
            try {
              display = markerDisplayName(readFileSync(join(child, marker), 'utf8')) ?? entry.name
            } catch { /* marker 是目录（如 .git）或不可读时用目录名 */ }
            addDir(entry.name, display)
          }
        }
        level = next
      }
    } catch { /* 单个根扫描失败不影响其他根 */ }
  }
  return [...found.entries()].map(([id, info]) => ({ id, name: info.name, aliases: info.aliases }))
}
