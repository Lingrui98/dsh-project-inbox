/**
 * research-hub 持久化存储：项目注册表、会话绑定、收件箱消息。
 * JSON 单文件，防抖原子写（tmp + rename）。损坏时从空开始，原文件保留。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Project {
  id: string
  name: string
  aliases: string[]
  source: 'discovered' | 'manual'
  createdAt: number
}

export type ItemType = 'question' | 'deliverable'
export type ItemStatus = 'pending' | 'answered' | 'dismissed'

export interface AuqOptionView {
  label: string
  description?: string
}

export interface AuqQuestionView {
  id: string
  question: string
  header?: string
  options?: AuqOptionView[]
  multiSelect?: boolean
}

export interface HubItem {
  id: string
  projectId: string | null
  sessionId: string
  sessionTitle: string
  type: ItemType
  title: string
  body: string
  priority: 'normal' | 'urgent'
  status: ItemStatus
  source: 'tool' | 'auq'
  createdAt: number
  settledAt?: number
  answerText?: string
  auq?: { callId: string; questions: AuqQuestionView[] }
}

export interface Binding {
  projectId: string | null
  locked: boolean
  by: 'user' | 'agent' | 'auto'
  updatedAt: number
}

export interface StoreData {
  version: 1
  projects: Project[]
  bindings: Record<string, Binding>
  items: HubItem[]
  /** 会话标题缓存（持久化，热重载/重启后面板秒开）。 */
  titles?: Record<string, { title: string; at: number }>
  /** 回收站：sessionId → 扫入时间。回收站会话不进任何收件箱视图。 */
  trashed?: Record<string, number>
}

export class HubStore {
  data: StoreData = { version: 1, projects: [], bindings: {}, items: [] }
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(readonly file: string) {
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoreData
        if (parsed && parsed.version === 1 && Array.isArray(parsed.projects) && Array.isArray(parsed.items)) {
          this.data = parsed
        }
      }
      if (!this.data.titles) this.data.titles = {}
      if (!this.data.trashed) this.data.trashed = {}
    } catch {
      /* 读取失败从空开始；原文件不覆盖，下次 flush 才替换 */
    }
  }

  /** 标脏，150ms 防抖后落盘。 */
  touch(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, 150)
  }

  flush(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.data))
      renameSync(tmp, this.file)
    } catch {
      /* 写盘失败静默，下一次 touch 再试 */
    }
  }
}
