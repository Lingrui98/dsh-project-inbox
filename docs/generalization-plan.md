# research-hub 通用化计划（v1）

状态：Round 1 执行中
目标版本：0.2.0（本轮不发布，只落地代码与测试）
执行者：DSH Agent Team，模型 `kimi-code/k3`；Lead 负责集成、构建、回归与提交。

## 1. 背景与目标

插件当前把"研究项目"假设写进代码：项目=含 `paper.toml`/`.git` 的目录、停用词写死
`paper/papers/exp/doc`、提示词与研究口吻、消息类型固定三类。通用化目标：

1. 让任何有多个工作目录和会话的 DSH 用户都能用，而不只是论文项目。
2. 把"研究假设"移到配置与数据模型，行为默认值与现在完全一致（零迁移风险）。
3. 保留差异点：目录即项目的自动归属、deliverable 投递、中断告警、持久化收件箱。
4. 不改包名、不改工具名、不改 `/rhub/api` 路由、不改 store 目录结构。

## 2. 原则

- 向后兼容优先：现有 `projectsRoots`、`alertKinds` 等配置与已有 store 文件必须继续工作。
- 只做本轮声明的改动；不重构无关代码，不加新依赖。
- 写作用域严格隔离；跨作用域需求先报 Lead。
- 不做发布：不 bump 版本、不打 tgz、不推送、不建 Release。
- 每个任务自测：`npm run typecheck` + 相关 `node --test`；构建产物 `lib/` 不提交。

## 3. 本轮范围（Phase 0 + Phase 1 的一部分）

### 明确不做

- 不改客户端技术栈、不重做面板布局（只抽取文案 + 双语）。
- 不做外部投递 HTTP API（Phase 2）。
- 不做 SQLite 后端、多 hub 实例（Phase 3）。
- 不重命名工具 `hub_register` / `hub_post`，不改路由 `/rhub/api`。
- 不改 `deliverable` / `alert` / `question` 三个内置语义的默认行为。

### 配置目标（新增字段，全部有默认值）

```yaml
- id: dsh-research-hub
  config:
    # 已有：projectsRoot / projectsRoots / storeFile / alertKinds / ...
    discovery:
      markers: [paper.toml, .git]   # 目录含任一标记即算项目
      maxDepth: 1                   # 从 root 往下扫几层
      stopWords: [paper, papers, project, exp, doc, docs, the, and]
      excludeDirs: [.git, node_modules, .venv]   # 扫描排除项
    # Phase 1 新增
    kinds:
      question:    { label: 待回答, action: answer }
      deliverable: { label: 待查收, action: ack }
      alert:       { label: 中断,   action: inspect }
      note:        { label: 备忘,   action: read }     # 自定义示例
```

兼容规则：

- 未配置 `discovery` 时，行为与 0.1.4 完全一致（markers=`paper.toml`/`.git`，depth=1，
  停用词为现有集合）。
- `discovery` 与旧平铺字段同时存在时，以 `discovery` 为准；旧字段保留并标记 deprecated。
- 未配置 `kinds` 时，内置三类行为与现在一致；`type` 字段从联合类型放宽为 `string`，
  面板载荷形状不变（仍是 `type`），客户端继续按字符串渲染。

## 4. 任务分解

| ID | 任务 | 负责 | 写作用域 | 依赖 |
|---|---|---|---|---|
| T1 | 发现规则配置化 + `host/discovery.ts` | hub-discovery | `src/host/core.ts`, `src/host/discovery.ts`, `src/index.ts`(仅 Config/接线), `scripts/discovery.test.mjs` | 无 |
| T2 | 客户端文案抽取 + 中英双语 | hub-client-i18n | `src/client/index.ts`, `src/client/strings.ts`, `scripts/client-i18n.test.mjs` | 无 |
| T3 | kind registry + store v2 迁移 | hub-kindschema | `src/host/store.ts`, `src/host/core.ts`, `src/index.ts`, `scripts/store-migration.test.mjs` | T1 |

### T1 验收标准

- 新增 `src/host/discovery.ts`：导出 `DEFAULT_MARKERS`、`DEFAULT_STOP_WORDS`、
  `DiscoveryOptions`、`resolveDiscoveryOptions(config)`、`discoverProjects(roots, opts)`。
- `Hub.discoverProjects()` 改用它；`deriveAliases`/`paperTomlName`/`STOP_TOKENS` 的
  行为由 options 驱动；`matchText`/`matchTextScored` 使用配置后的停用词。
- `markers` 支持任意文件名（如 `package.json`、`Cargo.toml`），`maxDepth` 支持 0/1/2。
- `excludeDirs` 默认包含 `.git`、`node_modules`，扫描时跳过。
- 默认配置下 `scripts/auto-trash.test.mjs`、`scripts/panel-perf.test.mjs` 等既有测试全绿。
- 新增 `scripts/discovery.test.mjs`：markers、maxDepth、stopWords、excludeDirs、默认回退。
- `npm run typecheck` 通过。

### T2 验收标准

- 新增 `src/client/strings.ts`：`zh` / `en` 两套字典，`pickStrings(locale)`；
  locale 取值顺序：`document.documentElement.lang` → `navigator.language` → `zh`。
- `src/client/index.ts` 所有面向用户的文案（按钮、状态、空态、提示、错误）改读字典。
- 中文输出与 0.1.4 逐字一致（现有中文用户零感知）。
- 英文覆盖全部字典键；缺键回退 zh 并在开发模式下 `console.warn` 一次。
- 新增 `scripts/client-i18n.test.mjs`：字典键集合一致、无缺失、zh 抽样文案不变。
- `npm run build:client` + `node --test scripts/client-home.test.mjs scripts/client-i18n.test.mjs` 通过。
- 不改面板结构、不改样式 token、不改 host 侧代码。

### T3 验收标准

- `StoreData.version` 接受 1 与 2；加载 v1 文件时执行幂等迁移：
  迁移前把原文件备份为 `<store>.v1.bak`，迁移后写回 v2；重复加载不再迁移。
- `Item.type` 放宽为 `string`；新增 `kinds` 配置，校验投递与渲染时按注册表取
  label/action；未注册自定义类型时按 `read` 处理并告警一次（不崩溃）。
- `hub_post` 的参数 `type` 从固定枚举改为按配置的 kinds 校验；原有
  `question`/`deliverable` 行为不变。
- 新增 `scripts/store-migration.test.mjs`：v1→v2、幂等、备份存在、未知类型容错、
  内置三类行为不变。
- `npm run typecheck` + `npm test` 通过（需先 `npm run build`）。

## 5. 协作规则

- 每位成员只改自己写作用域内的文件；需要改别人的文件时先发消息给 Lead。
- 动手前先读 `docs/generalization-plan.md` 与相关源码；使用 read/edit/write 工具。
- 不要运行 `git commit`/`git push`/`npm pack`/`gh release`/版本号修改。
- 不要手工改 `lib/`、`node_modules/`；只用 `npm run build`（host）或
  `npm run build:client`（client）产出。
- 两位并行成员同时构建可能竞争 `lib/` 产物：host 侧成员只跑 `build` + `npm test`，
  client 侧成员只跑 `build:client` + `node --test scripts/client-home.test.mjs`；
  Lead 最后统一全量构建与回归。
- 完成后用 `send_message` 向 Lead 报告：任务 ID、改动文件、关键决策、测试命令与结果、
  遗留风险。不要只写"已完成"。

## 6. Lead 集成与验收

1. 等 T1、T2 完成后合并验证，再启动 T3（T3 依赖 T1 的文件）。
2. 全量执行：`npm run typecheck` → `npm test` → `npm run test:package` → `npm run build`。
3. 热重载插件并回归：`/rhub/api/panel` 冷/热延迟、会话数、收件箱计数、`rescan`、
   回收站恢复；确认首页仍 < 0.5s。
4. 检查 store：旧文件迁移后 rsync 备份存在，条目数量与类型不变。
5. 复查 diff 只含计划内文件；提交（不发布），更新 CHANGELOG 的 Unreleased 段落。

## 7. 后续阶段（不在本轮）

- Phase 2：外部投递 `POST /rhub/api/post`（显式开关 + token）、面板分区配置、
  出站 webhook。
- Phase 3：SQLite 后端、多 hub 实例、导出/导入。
- 文档与社区：README 定位改为"项目级跨会话收件箱"，向 awesome 列表提 PR 调整分类。
