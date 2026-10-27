/**
 * dsh-project-inbox — client 侧文案字典（zh / en）。
 *
 * - zh 字典的每条文案与 0.1.4 逐字一致，现有中文用户零感知。
 * - en 字典覆盖全部键；插值文案用函数表达，两种语言的参数形状一致。
 * - resolveLocale()：document.documentElement.lang → navigator.language → 'zh'；
 *   en* 归 en，其余归 zh。
 * - pickStrings(locale)：按 locale 取字典；en 缺键时回退 zh，且每个键只 console.warn 一次。
 */

export type HubLocale = 'zh' | 'en'

export interface HubStrings {
  /** toLocaleTimeString 的 locale 参数。 */
  timeLocale: string
  agoSeconds(n: number): string
  agoMinutes(n: number): string
  agoHours(n: number): string
  agoDays(n: number): string
  requestFailed(status: number): string

  loading: string
  retry: string
  back: string
  hubName: string

  jumpToSessionTitle(sessionId: string): string
  jumpToSession: string

  typeQuestionPending: string
  typeQuestion: string
  typeAlertPending: string
  typeAlert: string
  typeDeliverablePending: string
  typeDeliverable: string
  /** 会话间通报等自定义 kind 的落款：直接用注册表 label，此处是缺省文案。 */
  typeNotice: string
  noticeHint: string
  pillUrgent: string
  pillSessionQuestion: string
  pillSessionInterrupt: string
  pillSessionOnly: string
  sessionNotInList: string
  collapse: string
  expandAll(chars: number): string
  sessionOnlyHint: string
  goAnswerInSession: string
  dismiss: string
  replyAriaLabel(title: string): string
  placeholderWithOptions: string
  placeholderAlert: string
  placeholderText: string
  submitting: string
  submitOptions: string
  sending: string
  reply: string
  processing: string
  ack: string
  statusAnswered: string
  statusDismissed: string
  reopen: string
  answerPrefix(text: string): string

  newProjectPromptBind: string
  trashTitle: string
  trashAriaLabel(sessionLabel: string): string
  suggestTitle: string
  suggestChip(projectName: string): string
  projectSelectAria(sessionLabel: string): string
  unassignedOption: string
  newProjectOption: string
  pillLocked: string
  pillSelfReported: string

  recentSessions: string
  openSessionTitle(sessionLabel: string, running: boolean): string
  runningAria: string
  idleAria: string
  noSessionsInProject: string

  inboxAriaLabel: string
  eyebrowAttention: string
  eyebrowAllClear: string
  inboxHeadline(total: number): string
  inboxDesc: string
  pillUrgentCount(n: number): string
  pillAlertsCount(n: number): string
  pillQuestionsCount(n: number): string
  pillDeliverablesCount(n: number): string
  pillNotesCount(n: number): string
  viewAll(total: number): string
  openInbox: string
  unassignedName: string
  inboxEmptyTitle: string
  inboxEmptyDesc: string
  inboxMore(remaining: number): string

  openProjectTitle: string
  cardPillQuestions(n: number): string
  cardPillDeliverables(n: number): string
  cardPillNotes(n: number): string
  cardSessions(count: number, capped: boolean): string
  cardRunning(n: number): string
  unassignedNote: string

  pageTitleAll: string
  pageTitleTrash: string
  eyebrowHome: string
  eyebrowDetail: string
  syncFailTitle: string
  syncOkTitle: string
  syncFailed: string
  updatedAt(time: string): string
  scanning: string
  rescan: string
  newProjectPrompt: string
  newProject: string
  newProjectCancel: string
  newProjectConfirm: string
  overviewTitle: string
  overviewDesc(projects: number, sessions: number, running: number): string
  /** 首字符是空格：原实现里图标与文字之间的间隔写在字符串内。 */
  trashButton(count: number): string
  noProjects: string
  trashHeading(count: number): string
  trashEmpty: string
  trashedAt(agoText: string): string
  restore: string

  sectionAlerts: string
  sectionPendingQuestions: string
  sectionPendingDeliverables: string
  sectionNotes: string
  sectionPending: string
  sectionHistory: string
  sectionUnassignedSessions: string
  sectionUnassignedItems: string
  sectionProjectSessions: string
  emptyAlerts: string
  emptyQuestions: string
  emptyDeliverables: string
  emptyNotes: string
  emptyUnassignedItems: string
  emptyPending: string
  historyToggle(count: number): string

  syncErrorBanner(which: string, message: string): string
  lastGoodData: string
  cachedData: string

  jumpNoWorkspace: string
  warmFailed(reason: string): string
  unknownReason: string
  jumpNotInCatalog(sessionIdPrefix: string): string
  jumpFailed(message: string): string

  returnTitle: string
  returnLabel: string
}

export const zh: HubStrings = {
  timeLocale: 'zh-CN',
  agoSeconds: (n) => `${n} 秒前`,
  agoMinutes: (n) => `${n} 分钟前`,
  agoHours: (n) => `${n} 小时前`,
  agoDays: (n) => `${n} 天前`,
  requestFailed: (status) => `请求失败（${status}）`,

  loading: '正在加载收件箱…',
  retry: '重试',
  back: '← 返回',
  hubName: '项目收件箱',

  jumpToSessionTitle: (sessionId) => `跳转会话 ${sessionId}`,
  jumpToSession: '跳转会话',

  typeQuestionPending: '待回答',
  typeQuestion: '问题',
  typeAlertPending: '待处理',
  typeAlert: '中断',
  typeDeliverablePending: '待查收',
  typeDeliverable: '交付',
  typeNotice: '通报',
  noticeHint: '该条为会话间通报，不需要你回答；需要跟进请到来源会话。',
  pillUrgent: '紧急',
  pillSessionQuestion: '会话提问',
  pillSessionInterrupt: '会话中断',
  pillSessionOnly: '会话内回答',
  sessionNotInList: '（会话不在列表）',
  collapse: '收起',
  expandAll: (chars) => `展开全部（${chars} 字）`,
  sessionOnlyHint: '该问题显示在前台会话的提问卡片上，需在会话内回答。回答后此处会自动关闭。',
  goAnswerInSession: '去会话回答',
  dismiss: '忽略',
  replyAriaLabel: (title) => `回复：${title}`,
  placeholderWithOptions: '补充说明（可选） · Ctrl/⌘ + Enter 提交',
  placeholderAlert: '回复内容会继续该会话… · Ctrl/⌘ + Enter 发送',
  placeholderText: '写下回复… · Ctrl/⌘ + Enter 发送',
  submitting: '提交中…',
  submitOptions: '提交选择',
  sending: '发送中…',
  reply: '回复',
  processing: '处理中…',
  ack: '查收',
  statusAnswered: '已回答',
  statusDismissed: '已忽略',
  reopen: '重开',
  answerPrefix: (text) => `答复：${text}`,

  newProjectPromptBind: '新项目名称（将创建并把该会话归入）：',
  trashTitle: '扫入回收站（收件箱内隐藏，可在回收站恢复）',
  trashAriaLabel: (sessionLabel) => `将会话移入回收站：${sessionLabel}`,
  suggestTitle: '按会话标题推断的建议项目，点击归入',
  suggestChip: (projectName) => `建议：${projectName}`,
  projectSelectAria: (sessionLabel) => `会话所属项目：${sessionLabel}`,
  unassignedOption: '未分配',
  newProjectOption: '＋ 新建项目并归入',
  pillLocked: '锁定',
  pillSelfReported: '自报',

  recentSessions: '最近会话',
  openSessionTitle: (sessionLabel, running) => `打开会话：${sessionLabel}${running ? '（运行中）' : ''}`,
  runningAria: '运行中',
  idleAria: '空闲',
  noSessionsInProject: '尚无会话归入此项目',

  inboxAriaLabel: '收件箱',
  eyebrowAttention: '需要你的关注',
  eyebrowAllClear: '一切就绪',
  inboxHeadline: (total) => `收件箱 · ${total} 条待处理`,
  inboxDesc: '集中回答问题、查收交付、处理会话中断。仅查看不会关闭消息。',
  pillUrgentCount: (n) => `${n} 紧急`,
  pillAlertsCount: (n) => `${n} 中断`,
  pillQuestionsCount: (n) => `${n} 待回答`,
  pillDeliverablesCount: (n) => `${n} 待查收`,
  pillNotesCount: (n) => `${n} 通报`,
  viewAll: (total) => `查看全部 ${total} 条`,
  openInbox: '打开收件箱',
  unassignedName: '未分配',
  inboxEmptyTitle: '当前没有待处理消息',
  inboxEmptyDesc: '新问题和交付结果会出现在这里。可以继续浏览项目。',
  inboxMore: (remaining) => `还有 ${remaining} 条待处理，打开收件箱继续处理`,

  openProjectTitle: '点击进入项目详情',
  cardPillQuestions: (n) => `${n} 问`,
  cardPillDeliverables: (n) => `${n} 交付`,
  cardPillNotes: (n) => `${n} 通报`,
  cardSessions: (count, capped) => `${count} 个会话${capped ? ' · 显示最近 3 个' : ''}`,
  cardRunning: (n) => `${n} 运行中`,
  unassignedNote: '会话归属可在详情页调整',

  pageTitleAll: '全部待处理',
  pageTitleTrash: '回收站',
  eyebrowHome: '项目收件箱',
  eyebrowDetail: '收件箱 / 项目与消息',
  syncFailTitle: '自动刷新失败，仍显示上次成功数据',
  syncOkTitle: '每 8 秒自动刷新',
  syncFailed: '更新失败',
  updatedAt: (time) => `更新于 ${time}`,
  scanning: '扫描中…',
  rescan: '重新扫描',
  newProjectPrompt: '新项目名称（例如 sway-paper）：',
  newProject: '新建项目',
  newProjectCancel: '取消',
  newProjectConfirm: '创建项目',
  overviewTitle: '项目总览',
  overviewDesc: (projects, sessions, running) => `${projects} 个项目 · ${sessions} 个会话${running > 0 ? ` · ${running} 个运行中` : ''}`,
  trashButton: (count) => ` 回收站（${count}）`,
  noProjects: '暂无项目。可以新建项目，或重新扫描发现项目。',
  trashHeading: (count) => `回收站（${count}）`,
  trashEmpty: '回收站是空的。未分配区会话行上的垃圾桶按钮会把不重要的会话扫到这里。',
  trashedAt: (agoText) => `扫入于 ${agoText}`,
  restore: '恢复',

  sectionAlerts: '会话中断',
  sectionPendingQuestions: '待回答问题',
  sectionPendingDeliverables: '待查看交付',
  sectionNotes: '会话间通报',
  sectionPending: '待处理',
  sectionHistory: '历史记录',
  sectionUnassignedSessions: '未分配会话',
  sectionUnassignedItems: '未分配消息',
  sectionProjectSessions: '项目会话',
  emptyAlerts: '没有会话中断',
  emptyQuestions: '没有待回答的问题',
  emptyDeliverables: '没有待查看的交付',
  emptyNotes: '没有通报',
  emptyUnassignedItems: '没有未分配的消息',
  emptyPending: '没有待处理的消息',
  historyToggle: (count) => `历史记录（${count}）`,

  syncErrorBanner: (which, message) => `自动更新失败，当前显示 ${which}：${message}`,
  lastGoodData: '上次成功数据',
  cachedData: '缓存数据',

  jumpNoWorkspace: '跳转失败：当前客户端没有 uiWorkspace 导航服务',
  warmFailed: (reason) => `会话预热失败：${reason}`,
  unknownReason: '未知原因',
  jumpNotInCatalog: (sessionIdPrefix) => `提示：会话 ${sessionIdPrefix}… 不在当前客户端目录中，已尝试打开`,
  jumpFailed: (message) => `跳转失败：${message}`,

  returnTitle: '回到收件箱（保留你离开时的页面）',
  returnLabel: '← 收件箱',
}

export const en: HubStrings = {
  timeLocale: 'en-US',
  agoSeconds: (n) => `${n}s ago`,
  agoMinutes: (n) => `${n}m ago`,
  agoHours: (n) => `${n}h ago`,
  agoDays: (n) => `${n}d ago`,
  requestFailed: (status) => `Request failed (${status})`,

  loading: 'Loading the inbox…',
  retry: 'Retry',
  back: '← Back',
  hubName: 'Inbox',

  jumpToSessionTitle: (sessionId) => `Go to session ${sessionId}`,
  jumpToSession: 'Go to session',

  typeQuestionPending: 'Needs answer',
  typeQuestion: 'Question',
  typeAlertPending: 'Needs attention',
  typeAlert: 'Interrupted',
  typeDeliverablePending: 'To review',
  typeDeliverable: 'Deliverable',
  typeNotice: 'Note',
  noticeHint: 'This is a cross-session note; no answer is needed. Follow up in the source session if required.',
  pillUrgent: 'Urgent',
  pillSessionQuestion: 'Session question',
  pillSessionInterrupt: 'Session interrupted',
  pillSessionOnly: 'Answer in session',
  sessionNotInList: '(session not in list)',
  collapse: 'Collapse',
  expandAll: (chars) => `Expand all (${chars} chars)`,
  sessionOnlyHint: 'This question is shown on the question card in the foreground session and must be answered there. It closes here automatically once answered.',
  goAnswerInSession: 'Answer in session',
  dismiss: 'Dismiss',
  replyAriaLabel: (title) => `Reply: ${title}`,
  placeholderWithOptions: 'Additional notes (optional) · Ctrl/⌘ + Enter to submit',
  placeholderAlert: 'Your reply resumes this session… · Ctrl/⌘ + Enter to send',
  placeholderText: 'Write a reply… · Ctrl/⌘ + Enter to send',
  submitting: 'Submitting…',
  submitOptions: 'Submit selection',
  sending: 'Sending…',
  reply: 'Reply',
  processing: 'Working…',
  ack: 'Acknowledge',
  statusAnswered: 'Answered',
  statusDismissed: 'Dismissed',
  reopen: 'Reopen',
  answerPrefix: (text) => `Answer: ${text}`,

  newProjectPromptBind: 'New project name (it will be created and this session assigned to it):',
  trashTitle: 'Sweep into trash (hidden in the inbox; restorable from the trash)',
  trashAriaLabel: (sessionLabel) => `Move session to trash: ${sessionLabel}`,
  suggestTitle: 'Suggested project inferred from the session title; click to assign',
  suggestChip: (projectName) => `Suggested: ${projectName}`,
  projectSelectAria: (sessionLabel) => `Project for session: ${sessionLabel}`,
  unassignedOption: 'Unassigned',
  newProjectOption: '+ New project and assign',
  pillLocked: 'Locked',
  pillSelfReported: 'Self-reported',

  recentSessions: 'Recent sessions',
  openSessionTitle: (sessionLabel, running) => `Open session: ${sessionLabel}${running ? ' (running)' : ''}`,
  runningAria: 'Running',
  idleAria: 'Idle',
  noSessionsInProject: 'No sessions assigned to this project yet',

  inboxAriaLabel: 'Inbox',
  eyebrowAttention: 'Needs your attention',
  eyebrowAllClear: 'All clear',
  inboxHeadline: (total) => `Inbox · ${total} pending`,
  inboxDesc: 'Answer questions, acknowledge deliveries, and handle session interruptions in one place. Viewing does not close messages.',
  pillUrgentCount: (n) => `${n} urgent`,
  pillAlertsCount: (n) => `${n} interrupted`,
  pillQuestionsCount: (n) => `${n} to answer`,
  pillDeliverablesCount: (n) => `${n} to review`,
  pillNotesCount: (n) => `${n} note${n === 1 ? '' : 's'}`,
  viewAll: (total) => `View all ${total}`,
  openInbox: 'Open inbox',
  unassignedName: 'Unassigned',
  inboxEmptyTitle: 'No pending messages',
  inboxEmptyDesc: 'New questions and deliveries will appear here. You can keep browsing projects.',
  inboxMore: (remaining) => `${remaining} more pending — open the inbox to continue`,

  openProjectTitle: 'Click to open project details',
  cardPillQuestions: (n) => `${n} question${n === 1 ? '' : 's'}`,
  cardPillDeliverables: (n) => `${n} deliverable${n === 1 ? '' : 's'}`,
  cardPillNotes: (n) => `${n} note${n === 1 ? '' : 's'}`,
  cardSessions: (count, capped) => `${count} session${count === 1 ? '' : 's'}${capped ? ' · showing latest 3' : ''}`,
  cardRunning: (n) => `${n} running`,
  unassignedNote: 'Session assignment can be adjusted on the detail page',

  pageTitleAll: 'All pending',
  pageTitleTrash: 'Trash',
  eyebrowHome: 'Project inbox',
  eyebrowDetail: 'Inbox / Projects & Messages',
  syncFailTitle: 'Auto-refresh failed; showing the last successful data',
  syncOkTitle: 'Auto-refreshes every 8 seconds',
  syncFailed: 'Update failed',
  updatedAt: (time) => `Updated at ${time}`,
  scanning: 'Scanning…',
  rescan: 'Rescan',
  newProjectPrompt: 'New project name (e.g. sway-paper):',
  newProject: 'New project',
  newProjectCancel: 'Cancel',
  newProjectConfirm: 'Create project',
  overviewTitle: 'Projects overview',
  overviewDesc: (projects, sessions, running) => `${projects} projects · ${sessions} sessions${running > 0 ? ` · ${running} running` : ''}`,
  trashButton: (count) => ` Trash (${count})`,
  noProjects: 'No projects yet. Create one, or rescan to discover projects.',
  trashHeading: (count) => `Trash (${count})`,
  trashEmpty: 'The trash is empty. The trash button on a session row in Unassigned sweeps unimportant sessions here.',
  trashedAt: (agoText) => `Swept in ${agoText}`,
  restore: 'Restore',

  sectionAlerts: 'Session interruptions',
  sectionPendingQuestions: 'Pending questions',
  sectionPendingDeliverables: 'Deliveries to review',
  sectionNotes: 'Cross-session notes',
  sectionPending: 'Pending',
  sectionHistory: 'History',
  sectionUnassignedSessions: 'Unassigned sessions',
  sectionUnassignedItems: 'Unassigned messages',
  sectionProjectSessions: 'Project sessions',
  emptyAlerts: 'No session interruptions',
  emptyQuestions: 'No pending questions',
  emptyDeliverables: 'No deliveries to review',
  emptyNotes: 'No notes',
  emptyUnassignedItems: 'No unassigned messages',
  emptyPending: 'No pending messages',
  historyToggle: (count) => `History (${count})`,

  syncErrorBanner: (which, message) => `Auto-update failed; showing ${which}: ${message}`,
  lastGoodData: 'the last successful data',
  cachedData: 'cached data',

  jumpNoWorkspace: 'Jump failed: this client has no uiWorkspace navigation service',
  warmFailed: (reason) => `Session warm-up failed: ${reason}`,
  unknownReason: 'unknown reason',
  jumpNotInCatalog: (sessionIdPrefix) => `Note: session ${sessionIdPrefix}… is not in this client's catalog; attempted to open it anyway`,
  jumpFailed: (message) => `Jump failed: ${message}`,

  returnTitle: 'Back to the inbox (your page is preserved)',
  returnLabel: '← Inbox',
}

/** 已告警过的缺键，保证每个键只 console.warn 一次。 */
const warnedKeys = new Set<string>()

/**
 * locale 归一化：en* → 'en'，其余 → 'zh'。
 * 不传参时依次读 document.documentElement.lang → navigator.language → 'zh'。
 */
export function resolveLocale(raw?: string | null): HubLocale {
  let value = raw ?? null
  if (value === null) {
    const docLang = typeof document !== 'undefined' ? document.documentElement?.lang ?? '' : ''
    const navLang = typeof navigator !== 'undefined' ? navigator.language ?? '' : ''
    value = docLang || navLang || 'zh'
  }
  return value.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/** 以 zh 为底合并覆盖字典；缺键回退 zh，每个键只 warn 一次。 */
export function mergeWithFallback(override: Partial<HubStrings>): HubStrings {
  const merged: Record<string, unknown> = { ...zh }
  for (const key of Object.keys(zh) as (keyof HubStrings)[]) {
    const value = override[key]
    if (value === undefined || value === null) {
      if (!warnedKeys.has(key)) {
        warnedKeys.add(key)
        console.warn(`[research-hub] i18n: 字典缺少键 "${key}"，回退中文文案`)
      }
    } else {
      merged[key] = value
    }
  }
  return merged as HubStrings
}

/** 按 locale 取字典。接受 'zh' / 'en' / BCP-47 语言标记 / null / undefined。 */
export function pickStrings(locale?: string | HubLocale | null): HubStrings {
  const resolved = locale === 'zh' || locale === 'en' ? locale : resolveLocale(locale)
  if (resolved === 'zh') return zh
  return mergeWithFallback(en)
}
