# Changelog

## 0.3.3

- README 增加 LINUX DO 社区链接（开源推广披露要求）。
- 无代码变更。

## 0.3.2

- 修复客户端语言解析：文案改为首次渲染时读取 `<html lang>`，而不是模块求值阶段。
  DSH 的 locale 客户端会在启动时按 profile 的 `locale.preference` 写入 `<html lang>`，
  这时点晚于插件模块加载；此前偏好中文的用户会读到 `navigator.language` 而显示英文界面。
- 语言跟随 DSH 的语言设置（`zh*` → 中文，其余 → 英文），缺省仍回退中文；切换语言后下次渲染即更新。
- 新增回归测试：`document.lang` 优先于 `navigator.language`。

## 0.3.1

- 发布到 npm：包名改为无 scope 的 `dsh-project-inbox`，可用 `dsh plugin --profile web add dsh-project-inbox` 安装，并进入 DSH 插件中心候选。
- 修复：移除 package.json 的 `private` 字段；补 `publishConfig` 之外无需额外配置。
- GitHub Releases 继续提供离线 tgz，内容与 npm 包一致。

## 0.3.0

更名：`dsh-research-hub` → `dsh-project-inbox`（项目收件箱 / Project Inbox）。仓库与安装包名随之变化；工具名 `hub_register` / `hub_post`、路由 `/rhub/api`、配置字段与数据文件 `research-hub.json` 保持不变。升级时卸载旧包、安装新包即可，数据文件无需迁移。

- 存储后端可插拔：默认仍是 JSON（行为与 0.2.0 一致）；新增 `storage.driver = "sqlite"` 可选后端，懒加载 Node 24 内置 `node:sqlite`，失败自动降级 JSON；`storage.migrateFrom` 支持空库从旧 JSON 一次性导入。
- 插件卸载/热重载时关闭存储句柄，SQLite 后端不再占用句柄。
- 新增导出/导入：`POST /rhub/api/export` 与 `POST /rhub/api/import`（merge 按 id 去重、现有优先；replace 整体替换但保留本机会话快照）；`src/host/portability.ts` 为纯模块。
- 项目发现新增 `DSH_PROJECT_INBOX_PROJECTS_ROOT` 环境变量，兼容旧 `DSH_RESEARCH_HUB_PROJECTS_ROOT`。
- 多 hub 实例本轮不做：当前路由 `/rhub/api` 与工具名固定，需要 loader 级实例隔离，留待后续。
- 客户端品牌文案、README 与界面图同步改名。
- 新增测试：`sqlite-store`、`portability` 与 export/import API 接线用例。

## 0.2.0

- 项目发现规则配置化：新增 `discovery.markers` / `maxDepth` / `stopWords` / `excludeDirs`，不再硬编码单一项目标记文件（默认仍兼容 `paper.toml` 与 `.git`）。不配置时行为与 0.1.4 完全一致。
- 支持任意项目标记文件（如 `package.json`、`Cargo.toml`）与多层扫描；标记文件里的 `name`/`title` 作为项目显示名。
- 消息类型改为注册表：新增 `kinds` 配置，内置 `question`/`deliverable`/`alert`，可新增自定义类型并配置 `label`、`action`、`postable`。内置 `alert` 由宿主产生，默认不可经 `hub_post` 投递。
- store 升级到 v2：加载 v1 文件时先备份 `<store>.v1.bak`，补默认 kinds 后幂等迁移；v2 不重复迁移。
- 客户端文案抽取为中英双语（`src/client/strings.ts`），按 `document.lang` → `navigator.language` → 中文回退自动选择；中文界面与 0.1.4 逐字一致。
- 新增测试：`discovery.test.mjs`、`store-migration.test.mjs`、`client-i18n.test.mjs`；测试脚本纳入全部新用例。
- Phase 2：新增外部投递 `POST /rhub/api/post`（默认关闭、Bearer token、幂等键、限流、外部条目在面板可见）。
- Phase 2：面板布局可配（`view.sections` / `groupBy` / `defaultSection`），默认渲染与 0.1.4 一致。
- Phase 2：出站 webhook（HMAC-SHA256 签名、指数退避重试、SSRF 防护、默认拒绝私网目标）。
- Phase 2 测试：`ingest-api`、`webhook`、`client-layout`、`phase2-wiring`。

## 0.1.4

- 面板首页改为读持久化会话快照，热路径零 IO：重载/重启后首帧实测 15ms（改造前 2.6-7.8s），轮询实测 3-6ms（改造前 0.8-4.7s）。
- 深度归因结论（标题 + 首条用户消息匹配结果）持久化，宿主重启或插件重载后不再逐会话冷读会话日志。
- AUQ 镜像改为按会话 `updatedAt` 增量同步：日志没更新就跳过，运行中会话每 60 秒、仍有待答问题的会话每 120 秒兜底一次，替代每 30 秒全量 `observeSession`。
- 会话列表缓存改为 30 秒并单飞；启动时后台预热快照，回填与程序化扫描共享同一次拉取。
- 程序化会话扫描不再由每次面板刷新触发，只保留启动补扫与每分钟增量扫描。
- 首次安装还没有快照时，首帧最多等待 300ms 拉一次列表，保证首页 0.5 秒内返回，下一次轮询补全。
- 标题刷新节流从 5 分钟放宽到 10 分钟。
- 新增 `scripts/panel-perf.test.mjs` 覆盖快照、单飞、游标与持久化行为。
- 修复 `scripts/package.test.mjs` 写死版本号导致 0.1.3 起发布自检失败的问题，改为以 `package.json` 为准。

## 0.1.3

- 新增程序化会话自动回收：首条用户消息没有客户端标识（`rpcId`）的会话是 headless 或脚本的一次性运行，自动进入回收站，不计入项目、收件箱与角标。
- 判定只看首条用户消息，结果持久缓存；用户或 agent 显式绑定过项目的会话保留；人工从回收站恢复的会话长期豁免。
- 新增配置 `autoTrashProgrammatic`（默认 `true`）。
- 新增配置 `projectsRoots`：固定项目发现范围，项目不再随宿主启动目录变化。
- 修复从回收站恢复的会话缺少持久豁免、后续扫描再次回收的问题。

## 0.1.2

- 新增「会话中断告警」：宿主观测会话日志的回合结束事件，把模型调用失败、宿主崩溃/重启、输出超限等中断投递到收件箱。
- 实时事件与冷读回填双通道：进程存活期间即时投递；崩溃或重启后在启动约 8 秒回填，之后随面板刷新按 5 分钟节流增量回填。
- 同一会话同一轮只告警一次，去重记录跨重启保留；会话开新一轮或用户从收件箱回复后告警自动关闭；已被继续的旧中断不补报。
- 冷读补记的中断要等会话静默 `alertInterruptedGraceMinutes`（默认 30 分钟）才判定为真，避免把其他进程里正在运行的无人值守会话误报为崩溃；推迟的会话由周期回填补判。
- 新增配置 `alertKinds`（默认 `["error","interrupted","aborted:disposed"]`）与 `alertBackfillHours`（默认 72）。
- 面板新增「会话中断」分区、计数与侧栏角标，回复任意内容即可继续该会话。
- 修复浏览器回归测试里 AUQ 夹具缺 `answerable` 字段导致的既有失败。

## 0.1.1

- 修复从指挥中心打开会话后，临时主视图引用长期保留，导致侧栏切换会话或新建会话失败的问题。
- 跳转完成后自动释放临时引用。用户从侧栏切换时也会立即清理返回状态。

## 0.1.0

首个公开发布版本。

- 项目注册表、会话自动归属、手动锁定与未分配分拣。
- 跨会话收件箱、AUQ 镜像、紧急优先、快捷回复与交付查收。
- 首页常驻收件箱、等宽瀑布流项目总览、最近会话预览。
- 会话跳转与返回、指挥中心回收站、归档及子代理过滤。
- 亮暗主题、容器响应式分栏、键盘访问与减少动画支持。
- 移除机器专属路径，修复 bundle patch 漏包，提供预构建安装包。
- 新增组件、浏览器与分发包回归测试。

验证环境：DSH 0.2.0-rc.2 Web profile。其他 DSH 版本尚未验证。
