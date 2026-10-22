# research-hub Phase 2 计划：外部投递、面板布局、出站 webhook

状态：执行中（Round 2）
目标版本：0.2.0（本轮仍不发布）
执行者：DSH Agent Team，`kimi-code/k3`；Lead 负责集成、接线、构建、回归、提交。

前置：Phase 1 已合并（commit `ed248ec`，main）。现有基线：84 项测试全绿，面板 23ms，store v2。

## 1. 目标

把插件从"只有 DSH 内 agent 能投递、只有本机能看固定面板"扩展为：

1. **外部投递**：CI、脚本、定时任务、另一台机器可经 HTTP 投递，默认关闭、token 鉴权、幂等。
2. **面板布局可配**：分区、顺序、分组方式可配，默认渲染不变。
3. **出站事件**：收件箱事件以 webhook 推出（HMAC 签名、重试、SSRF 防护），不做通知中心。

## 2. 明确不做

- 不做 SQLite 后端、多 hub 实例、导出/导入（Phase 3）。
- 不改内置三类语义，不改 `/rhub/api` 已有方法的行为。
- 不做消息模板/通道适配（飞书、Slack 适配留给通知插件）。
- 不发布、不 bump 版本、不推送 GitHub。

## 3. 任务分解（文件作用域互不重叠）

| ID | 任务 | 负责 | 写作用域 | 依赖 |
|---|---|---|---|---|
| P2-1 | 外部投递 API + 外部来源可见性 | ingest agent | `src/index.ts`, `src/host/store.ts`, `src/host/core.ts`, `scripts/ingest-api.test.mjs` | 无 |
| P2-2 | webhook 投递模块（纯模块，不接线） | webhook agent | `src/host/webhook.ts`, `scripts/webhook.test.mjs` | 无 |
| P2-3 | 客户端布局模块与渲染 | layout agent | `src/client/layout.ts`, `src/client/index.ts`, `scripts/client-layout.test.mjs` | 无 |

Lead 在三人完成后做接线（`view`/`webhooks` 配置、panel payload 的 `layout`、事件钩子），再统一构建回归。

### P2-1 外部投递 API 规格

配置（默认关闭，全部有默认值）：

```yaml
ingest:
  http:
    enabled: false
    tokenEnv: RHUB_INGEST_TOKEN   # 从环境变量读 token；enabled 时必须非空
    loopbackOnly: true            # 默认只接受回环请求
    rateLimitPerMin: 30
    idempotencyTtlHours: 24
```

API：`POST /rhub/api/post`

```json
{ "type": "deliverable", "title": "...", "body": "...", "priority": "normal",
  "project": "papers", "idempotencyKey": "ci-20261022-1" }
```

行为：

- `enabled=false`：返回 404/403（与未知方法一致，不暴露能力）。
- `enabled=true`：要求 `Authorization: Bearer <token>`，用 `crypto.timingSafeEqual` 比较；
  `loopbackOnly` 为真时非回环请求拒绝。
- 幂等：同一 `idempotencyKey` 在 TTL 内返回首次创建的 itemId，不重复建条。
- 限流：每 token 每分钟次数上限，超限 429。
- 归属：显式 `project`（id/名称/别名）优先；无法匹配返回 400 并在错误里列出可用项目。
- 条目：`source: 'external'`，`sessionId` 可为空；无会话条目不参与会话过滤。
- 面板：`buildPanel` 过滤改为"有会话的按可见会话过滤，`source === 'external'` 始终可见"，
  并在载荷里带 `externalItems`（或 items 中 `source` 字段 + 客户端按 source 分组，二选一，
  以不破坏现有客户端断言为准；默认渲染必须保持现状）。
- store：`ItemSource` 增加 `'external'`；`StoreData.ingestKeys?: Record<string, { itemId: string; at: number }>`；
  加载时补默认 `{}`；不升 version（v2 加可选字段）。

验收：

- 新增 `scripts/ingest-api.test.mjs`：默认关闭拒绝、无 token 拒绝、错误 token 拒绝、
  正确 token 建条、幂等、项目匹配与 400、限流 429、外部条目在面板可见。
- `npm run typecheck` 通过；`npm run build && npm test` 全绿（既有 84 项不得回归）。

### P2-2 webhook 模块规格

新增 `src/host/webhook.ts`，只做纯模块（不碰 index.ts/core.ts/store.ts）：

- 导出：`WebhookTarget { url, events?, secret?, headers?, timeoutMs?, retries? }`、
  `WebhookEvent = 'item.created' | 'item.settled' | 'item.urgent' | 'alert.created'`、
  `buildWebhookPayload(event, item, context)`、`signWebhookPayload(secret, timestamp, body)`（HMAC-SHA256）、
  `createWebhookDispatcher(options)`。
- dispatcher 依赖注入：`{ targets, logger, fetchImpl?, now?, sleep?, allowPrivate? }`，便于测试。
- 行为：只投匹配事件；5s 超时；失败指数退避重试（默认 3 次）；不抛异常、不阻塞调用方；
  私网/回环目标默认拒绝（`allowPrivate` 显式放开）；payload 带 `version: 1`、`event`、`item`、`deliveredAt`。
- 验收 `scripts/webhook.test.mjs`：本地 http server 收到事件并校验 HMAC；500 后重试成功；
  超时视为失败；私网默认拒绝、allowPrivate 放行；未匹配事件不发送。

### P2-3 客户端布局规格

新增 `src/client/layout.ts` + 改 `src/client/index.ts`：

- 导出 `LayoutSection { id, title?, source, filter?, order?, collapsed? }`、
  `LayoutConfig { sections?, groupBy?: 'project' | 'kind' | 'priority' | 'none', defaultSection? }`、
  `DEFAULT_LAYOUT`（与当前渲染等价）、`normalizeLayout(raw)`（未知字段/section 容错）、
  `groupItems(items, groupBy)`。
- `index.ts`：从 panel payload 读可选 `layout`，缺省用 `DEFAULT_LAYOUT`；按 sections 顺序渲染；
  默认输出的 DOM 结构与文案与现在一致（client-home 既有断言必须全绿）。
- 验收 `scripts/client-layout.test.mjs`：默认归一化、顺序/隐藏/未知 section、三种 groupBy、
  filter 按 kind/priority/project 生效。
- 不碰 host 文件、不碰 `styles.ts`。

## 4. 协作规则

- 只改写作用域内文件；跨作用域先报 Lead。
- 在 worktree `/nfs/home/goulingrui/project/dsh-infra/.rhub-generalize` 内工作。
- 不 commit/push、不改版本号、不手工改 lib/、不热重载插件。
- 构建所有权：ingest agent 跑 `npm run build` + `npm test`；webhook agent 只跑自己的测试（可先 build）；
  layout agent 跑 `npm run build:client` + `node --test scripts/client-home.test.mjs scripts/client-layout.test.mjs`。
- 完成后 send_message 给 Lead：任务 ID、改动文件、关键决策、测试命令与结果、遗留风险。

## 5. Lead 集成清单

1. 三份报告齐后：审 diff，`npm run typecheck`。
2. 接线：Config 增加 `view`、`webhooks`；panel payload 增加 `layout`；Hub 增加事件钩子并在
   `addItem`/`settleItem`/`recordTurnAlerts` 处触发 webhook dispatcher（失败只记日志）。
3. 全量：`npm test`（含新测试）→ `npm run build` → `npm run build:client` → `test:package`。
4. 运行时回归：热重载、面板延迟、外部投递 curl 实测（临时 token）、webhook 本地 server 实测、
   面板布局默认渲染不变。
5. 提交（不发布），CHANGELOG 更新 Phase 2 条目。

## 6. 验收口径

- 默认配置下：84 项既有测试 + 新测试全绿，面板结构与文案不变，性能仍 < 100ms。
- 开启后：外部投递、幂等、鉴权、限流、webhook 签名与重试按规格工作。
- 关闭时：不暴露新能力（API 与 webhook 都不生效）。
