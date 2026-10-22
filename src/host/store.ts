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

export type ItemType = 'question' | 'deliverable' | 'alert'
export type ItemStatus = 'pending' | 'answered' | 'dismissed'
/** 条目来源：agent 工具投递、ask_user_question 镜像、宿主中断告警。 */
export type ItemSource = 'tool' | 'auq' | 'system'

/**
 * 中断告警原因，对应会话日志 `turn/end` 的 reason.kind。
 * `error`：回合执行失败（模型调用、工具或环境错误，含传输中断）；`interrupted`：崩溃或重启后补记的中断；
 * `max-tokens`：输出达到上限；`aborted`：宿主或上游主动取消，见 cause。
 */
export type TurnAlertKind = 'error' | 'interrupted' | 'max-tokens' | 'aborted'

/** 收件箱里与会话中断相关的最小事实集，面板按它渲染原因。 */
export interface TurnAlertView {
  /** 中断的轮次号（会话内 `turn/start` 的 turn）。 */
  turn: number
  kind: TurnAlertKind
  /** 取消原因，仅 aborted：user / parent / hook / disposed / legacy。 */
  cause?: string
  /** 模型失败码，仅 error，例如 PI_AI_ERROR。 */
  code?: string
  /** 一行原因说明（模型错误消息或人类可读描述）。 */
  detail?: string
}

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
  source: ItemSource
  createdAt: number
  settledAt?: number
  answerText?: string
  auq?: { callId: string; questions: AuqQuestionView[] }
  /** 中断告警条目（type 为 alert、source 为 system）的原因事实。 */
  alert?: TurnAlertView
  /**
   * AUQ 条目能否由指挥中心代答。
   * 只有会话投影里处于 continued 的问题可以：前台阻塞提问的应答权在会话卡片上。
   */
  auqAnswerable?: boolean
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
  /** 中断告警去重键：`${sessionId}#${turn}` → 已建条目 id。跨重启保留，避免重复告警。 */
  alertKeys?: Record<string, string>
  /** 中断告警扫描游标：sessionId → 该会话已扫描到的 updatedAt，避免重复冷读日志。 */
  alertScans?: Record<string, { at: number; updatedAt: number }>
  /**
   * 程序化会话判定：sessionId → 首条用户消息是否没有客户端标识（rpcId）。
   * 首条消息不可变，判定结果只写一次，后续扫描直接命中缓存。
   */
  programmatic?: Record<string, boolean>
  /** 人工从回收站恢复过的会话：sessionId → 恢复时间。恢复视为长期豁免，不再自动回收。 */
  trashExempt?: Record<string, number>
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
      if (!this.data.alertKeys) this.data.alertKeys = {}
      if (!this.data.alertScans) this.data.alertScans = {}
      if (!this.data.programmatic) this.data.programmatic = {}
      if (!this.data.trashExempt) this.data.trashExempt = {}
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
