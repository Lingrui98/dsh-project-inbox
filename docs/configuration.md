# 配置参考

插件通过 profile patch 配置。所有字段都有默认值，不写配置时行为与推荐用法一致：

```yaml
- id: dsh-project-inbox
  name: '@dsh-external/dsh-project-inbox'
  config: {}
```

## 项目发现

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `projectsRoot` | `DSH_RESEARCH_HUB_PROJECTS_ROOT` 环境变量，否则为启动 `dsh web` 的目录 | 自动发现项目的根目录 |
| `projectsRoots` | `[]` | 固定项目发现范围；非空时替代 `projectsRoot`，项目不再随启动目录变化 |
| `discovery.markers` | `["paper.toml", ".git"]` | 目录里出现任一标记即视为项目；标记是文件时读取其中的 `name`/`title` 作为显示名 |
| `discovery.maxDepth` | `1` | 从根目录往下扫描的层数；`0` 只登记根目录本身 |
| `discovery.stopWords` | `["paper","papers","project","exp","doc","docs","the","and"]` | 归属匹配时忽略的通用词 |
| `discovery.excludeDirs` | `[".git", "node_modules"]` | 扫描时跳过的目录名；以 `.` 开头的目录始终跳过 |

示例：按自己的目录约定发现项目。

```yaml
    discovery:
      markers: [package.json, Cargo.toml, go.mod, .git]
      maxDepth: 2
```

## 收件箱与中断

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `alertKinds` | `["error", "interrupted", "aborted:disposed"]` | 哪些回合结束原因要进收件箱；`aborted` 可匹配全部取消原因，`aborted:user` 等只匹配单种 |
| `alertBackfillHours` | `72` | 宿主重启后回看最近多少小时的会话日志补报中断 |
| `alertInterruptedGraceMinutes` | `30` | 冷读日志里的"回合未闭合"要静默多久才判定为真中断 |
| `autoTrashProgrammatic` | `true` | 把 headless/脚本发起的一次性会话自动收进回收站 |

## 消息类型

内置三类：`question`（待回答）、`deliverable`（待查收）、`alert`（中断）。可以覆盖文案与处理动作，也可以新增自定义类型：

```yaml
    kinds:
      question:
        label: 待回答
        action: answer
      deliverable:
        label: 待查收
        action: ack
      note:
        label: 备忘
        action: read
        postable: true
```

- `action`：`answer`（需要回答）、`ack`（一键确认）、`inspect`（跳转会话）、`read`（只读）。
- `postable`：是否允许 agent 通过 `hub_post` 主动投递。内置 `alert` 由宿主产生，默认不可投递。

## 面板布局

```yaml
    view:
      sections:
        - id: questions
          source: questions
        - id: alerts
          source: alerts
        - id: recent
          source: items
      groupBy: project   # project | kind | priority | none
```

不配置时使用内置默认布局，与未引入该配置前完全一致。

## 外部投递

允许 CI、脚本或其他机器把结果投递到收件箱。默认关闭；开启后必须带 token。

```yaml
    ingest:
      http:
        enabled: true
        tokenEnv: RHUB_INGEST_TOKEN   # 从这个环境变量读取 token
        loopbackOnly: true            # 只接受本机请求
        rateLimitPerMin: 30
        idempotencyTtlHours: 24
```

```bash
curl -fsS -X POST http://127.0.0.1:9999/rhub/api/post \
  -H "Authorization: Bearer $RHUB_INGEST_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"type":"deliverable","title":"CI 构建完成","body":"…","project":"my-project","idempotencyKey":"ci-1"}'
```

- 相同 `idempotencyKey` 在有效期内重复投递会返回第一次创建的条目，不会重复入箱。
- 带 `project` 时必须能匹配到项目，否则返回 400 并列出可选项目。
- 没有会话的外部条目可以查收、忽略，不能回复。

## 事件推送

把收件箱变化推送到自己的服务。默认不发送任何请求。

```yaml
    webhooks:
      - url: https://example.com/rhub
        events: [item.created, item.urgent, alert.created]
        secret: change-me
        timeoutMs: 5000
        retries: 3
    # 本地联调时才打开（默认拒绝内网地址）
    # webhookAllowPrivate: true
```

- 事件：`item.created`（新建）、`item.settled`（结算）、`item.urgent`（紧急）、`alert.created`（中断告警）。
- 请求头带事件名、时间戳与签名；签名由 `secret` 计算，便于接收端校验。
- 失败会退避重试；最终失败只记日志，不影响收件箱。

## 存储

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `storeFile` | profile 目录下的 `research-hub.json`（历史文件名，保持不变） | 数据文件位置 |
| `storage.driver` | `json` | `json` 或 `sqlite` |
| `storage.file` | 空 | 存储文件路径；空则沿用 `storeFile` |
| `storage.migrateFrom` | 空 | 空 SQLite 库首次启动时从这个 JSON 文件导入一次 |

```yaml
    storage:
      driver: sqlite
      file: /path/to/research-hub.sqlite
      migrateFrom: /path/to/research-hub.json
```

SQLite 后端需要 Node.js 24（内置 `node:sqlite`，实验特性，首次使用会有一条警告）。驱动无法创建时会自动退回 JSON。

## 备份、迁移与本地接口

`/rhub/api` 下的接口只接受本机回环请求：

| 接口 | 用途 |
| --- | --- |
| `panel` | 面板数据 |
| `badge` | 侧栏角标计数 |
| `rescan` | 重新扫描项目与会话 |
| `post` | 外部投递（需显式开启） |
| `export` | 导出可移植数据 |
| `import` | 导入数据，`mode` 为 `merge`（按 id 去重，现有优先）或 `replace`（整体替换，保留本机会话快照） |
| `reply` / `answerStructured` / `ack` / `dismiss` / `reopen` | 面板内的处理动作 |
| `bind` / `addProject` / `trashSession` / `restoreSession` | 项目与会话整理 |

升级时旧格式数据会在首次加载时自动迁移，并在同目录保留一份 `.v1.bak` 备份。

## 安全建议

- 仅通过本机回环或 SSH 隧道访问 DSH，不要把 DSH 暴露到公网。
- 外部投递与事件推送默认关闭；开启后妥善保管 token 与 secret。
- 数据文件包含会话标题、问题与回复，不要提交到代码仓库。
