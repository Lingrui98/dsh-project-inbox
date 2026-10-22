# research-hub Phase 3 计划：存储抽象与数据可移植

状态：执行中（Round 3，0.2.0 发布之后）
目标版本：0.3.0（本轮不发布）
执行者：DSH Agent Team，`kimi-code/k3`；Lead 负责 API 接线、构建、回归、提交。

前置：0.2.0 已发布（tag `v0.2.0`，commit `6a2caa9`）。基线：118 项测试全绿，面板毫秒级，store v2，默认 JSON。

## 1. 目标

1. **存储后端可插拔**：默认仍是 JSON 单文件（零行为变化）；可选 SQLite 后端，适合大收件箱与更稳的写入。
2. **数据可移植**：提供导出/导入的纯模块，支持备份、跨机器迁移与合并恢复。
3. 迁移路径明确：JSON → SQLite 一次性导入；SQLite → JSON 导出再导入。

## 2. 明确不做（本轮）

- **多 hub 实例**：插件当前固定路由 `/rhub/api`、固定工具名和单 store。多实例需要 loader 级实例隔离与路由前缀，属于独立架构改动。本轮不做，理由写进文档。
- 云同步、端到端加密、多用户权限。
- 不改 kind/discovery/ingest/webhook 语义。
- 不发布、不 bump 版本、不推送。

## 3. 任务分解（文件作用域不重叠）

| ID | 任务 | 负责 | 写作用域 | 依赖 |
|---|---|---|---|---|
| P3-1 | 存储适配器 + SQLite 后端 | storage agent | `src/host/storage.ts`（新）, `src/host/store.ts`, `src/index.ts`, `scripts/sqlite-store.test.mjs` | 无 |
| P3-2 | 导出/导入纯模块 | portability agent | `src/host/portability.ts`（新）, `scripts/portability.test.mjs` | 无 |

Lead 在两人完成后接线：`export` / `import` API、`storage` 配置透传、README/CHANGELOG、全量回归。

### P3-1 存储适配器 + SQLite 规格

配置：

```yaml
storage:
  driver: json          # json（默认）| sqlite
  file: ""              # 空则沿用 storeFile / profile 默认路径
  migrateFrom: ""       # 可选：空 SQLite 库从该 JSON 文件一次性导入
```

实现要求：

- 新增 `src/host/storage.ts`：
  - `StoreData` 的读写接口 `StorageAdapter { load(): StoreData | undefined; save(data: StoreData): void; close(): void }`。
  - `JsonStorageAdapter`：行为与当前 `HubStore` 完全一致（原子写 tmp+rename、损坏时原文件保留、v1→v2 迁移逻辑保持）。
  - `SqliteStorageAdapter`：**懒加载** `node:sqlite`（只在 driver=sqlite 时 import，避免默认用户看到实验性警告）；
    表结构 `hub_state(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)`；
    `load()` 读 payload 并 JSON.parse；`save()` 用 `INSERT ... ON CONFLICT(id) DO UPDATE` 单行覆盖。
    空库且 `migrateFrom` 存在时：读取 JSON（含 v1 迁移与备份规则）→ 写入 sqlite。
  - SQLite 打开失败、写入失败：抛错由 HubStore 捕获并降级（与当前 JSON 写失败静默一致：记日志、保留内存态）。
- `src/host/store.ts`：`HubStore` 改为适配器门面，保留现有公开 API（`data`、`touch`、`flush`、`file`、构造签名兼容）；
  构造签名扩展为 `(file, options?)`，`options.storage` 透传；现有调用（含测试直接 `new HubStore(file)`）不得破坏。
- `src/index.ts`：Config 增加 `storage` 分组；apply() 解析后传给 HubStore；默认值下行为逐字节不变。
- 新增 `scripts/sqlite-store.test.mjs`：
  - JSON 默认行为回归（含 v1 迁移备份）仍走既有测试；
  - sqlite driver：写入 → 关闭 → 重开数据一致；损坏 payload 保持旧数据/报错行为；空库从 `migrateFrom` 导入；
  - driver=json 时不加载 node:sqlite（可用注入/计数断言或子进程环境变量验证）。

验收：`npm run typecheck`；`npm run build && npm test` 全绿（既有 118 项不得回归）。

### P3-2 导出/导入纯模块规格

新增 `src/host/portability.ts`，不接线、不改其他文件：

- 导出：
  - `BundleMeta { schema: 1; exportedAt: number; hubVersion?: string; app?: string }`
  - `exportBundle(data: StoreData, meta?: Partial<BundleMeta>): { bundle: HubBundle; stats: ExportStats }`
    `HubBundle = { meta, data: { projects, bindings, items, titles?, trashed?, alertKeys?, alertScans?, programmatic?, trashExempt?, kinds? } }`
  - `ExportStats { projects, bindings, items, pending, settled }`
- 导入：
  - `importBundle(current: StoreData, bundle: unknown, options?: { mode?: 'merge' | 'replace' }): { data: StoreData; stats: ImportStats; warnings: string[] }`
  - 校验：schema 版本、字段类型、条目 id/type 必填；非法文件抛 `PortabilityError`（带 code）。
  - `merge`：按 item id 去重（已存在保留现有条目）；projects 按 id 合并（现有优先，别名取并集）；bindings 按 sessionId 合并（现有优先）；titles/alertKeys 等按 key 合并（现有优先）。
  - `replace`：整体替换，但仍保留当前 `sessions`（会话快照）与 `sessions.at`，避免导入后首页空白。
  - 导入不写盘（返回新对象），由调用方 flush；不修改入参。
- `scripts/portability.test.mjs`：导出字段完整、round-trip 等价、merge 去重、replace 保留 sessions、非法输入 code、统计数字正确、pure 不修改入参。

验收：`npm run typecheck`；`npm run build && node --test scripts/portability.test.mjs` 全绿。

## 4. 协作规则

- worktree：`/nfs/home/goulingrui/project/dsh-infra/.rhub-generalize`，只在该目录读写。
- 只改各自写作用域；跨作用域先报 Lead。
- 不 commit/push、不改版本号、不手工改 lib/、不热重载。
- 构建可能互撞：构建失败可重跑一次，报告注明。
- 完成后 send_message 给 Lead：任务 ID、改动文件、关键决策、测试命令与结果、遗留风险。

## 5. Lead 集成清单

1. 审 diff + `npm run typecheck`。
2. 接线：`/rhub/api` 增加 `export` / `import` 方法（export 返回 bundle；import 接受 bundle+mode，校验后写盘并返回统计）；
   需要 loopback 围栏保持；import 视为显式请求，写盘后 invalidate 缓存。
3. 全量：`npm test`（含新测试）→ `npm run build` → `npm run build:client` → `test:package`。
4. 运行时：热重载；SQLite 用临时 store 实测（不改 profile 默认配置）；export/import 用临时文件实测。
5. 文档：README 补 `storage` 配置与导出/导入说明；CHANGELOG 追加 0.3.0 方向；说明多 hub 延后原因。
6. 提交（不发布）。

## 6. 验收口径

- 默认配置（JSON）下行为与 0.2.0 完全一致，118 项既有测试 + 新测试全绿。
- SQLite driver 可读写、可从 JSON 一次性迁移、失败可降级。
- 导出/导入 round-trip 与两种合并模式正确，非法输入有明确错误码。
