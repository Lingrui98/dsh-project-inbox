# DSH Research Hub · 研究指挥中心

[![Release](https://img.shields.io/github/v/release/Lingrui98/dsh-research-hub)](https://github.com/Lingrui98/dsh-research-hub/releases/latest)
[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-blue)](LICENSE)

把分散的 DSH 会话组织成项目工作台。集中处理问题与交付结果，直接回复，并在会话与指挥中心之间往返。

这是独立的第三方插件，不是 DeepSeek 官方产品。当前公开版本为 **v0.1.4**，已在 **DSH 0.2.0-rc.2 Web profile** 验证。DSH 的预发布接口可能变化，其他版本不作兼容承诺。

## 功能

- **常驻收件箱**：首页集中显示跨项目问题与交付。紧急优先，同级按入箱时间排序。空箱仍显示，查看不会自动关闭待处理状态。
- **项目总览**：等宽瀑布流减少空位，保持项目排序与键盘访问顺序。每张卡片显示最近更新的三个会话，以及两条待处理摘要。
- **原地处理**：文本回复、结构化选项作答、交付查收、忽略、重开。Ctrl/Cmd+Enter 提交回复。
- **中断告警**：会话因模型服务中断、宿主崩溃或重启而停在半途时，自动投递「会话中断」条目到收件箱。回复任意内容即可继续会话，会话恢复运行后告警自动关闭。
- **会话导航**：点击标题打开会话。会话头部的“指挥中心”按钮回到此前页面。
- **自动归属**：从项目根目录发现项目。主会话首条直接用户消息到达后，插件按标题和消息内容推断项目并自动绑定唯一匹配。无法唯一匹配时保持未分配。手动绑定优先于自动绑定。
- **高效分拣**：建议归属、就地创建项目、指挥中心专属回收站。回收站只隐藏会话，不删除 DSH 会话本身。
- **范围过滤**：排除子代理、空白会话、已归档会话、回收站会话和程序化会话（headless/脚本一次性运行）。归档状态跟随宿主推送。
- **主题适配**：亮暗主题、自然卡片高度、按面板实际宽度切换分栏、明确焦点和减少动画支持。
- **快速首页**：首页读持久化会话快照，打开面板与轮询在毫秒级；会话列表、归因与问题镜像在后台增量刷新。

## 安装

### 推荐：安装 GitHub Release 的预构建包

从 [Releases](https://github.com/Lingrui98/dsh-research-hub/releases/latest) 下载 `.tgz` 和 `SHA256SUMS`。安装包包含编译后的 host、client 与 bundle patch，不需要在用户机器编译。

```bash
curl -fL -O https://github.com/Lingrui98/dsh-research-hub/releases/download/v0.1.4/dsh-external-dsh-research-hub-0.1.4.tgz
curl -fL -O https://github.com/Lingrui98/dsh-research-hub/releases/download/v0.1.4/SHA256SUMS
sha256sum -c SHA256SUMS
```

在 DSH 的插件管理界面使用安装包的绝对路径或下列 tarball URL 安装并启用 bundle：

```text
https://github.com/Lingrui98/dsh-research-hub/releases/download/v0.1.4/dsh-external-dsh-research-hub-0.1.4.tgz
```

若界面没有插件安装入口，参见下方 CLI 方法。**只安装到可信的本机 DSH 环境。插件可读取会话标题、项目文件和消息，并可向会话发送回复。**

### CLI 方法

先停止目标 Web profile，再安装预构建包：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-external-dsh-research-hub-0.1.4.tgz
```

DSH 会自动将 bundle 追加到目标 profile 的 `package.json` 中的 `dsh.profile.bundles`。可以检查该数组是否包含 `@dsh-external/dsh-research-hub`。**不要额外把相同插件手动插入 profile patch**，避免重复装配。

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@dsh-external/dsh-research-hub"]
    }
  }
}
```

以上仅示意字段位置。保留原有 bundle 数组项，不要整段覆盖 profile。安装机制见 [DSH 官方打包与安装说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)。

重新启动 `dsh web` 并刷新页面。指挥中心入口位于侧栏图标区。实际 profile 名不同于 `web` 时，替换上述命令中的名称。

GitHub 源码快照不含 `lib/`，不能替代 Release 安装包。当前未发布 npm 包，不要使用 npm 包名安装。

## 配置

配置字段：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `projectsRoot` | `DSH_RESEARCH_HUB_PROJECTS_ROOT` 环境变量，否则为启动 DSH 的工作目录 | 自动发现项目的根目录 |
| `projectsRoots` | `[]` | 固定项目发现范围；非空时替代 `projectsRoot`，项目不随宿主启动目录变化 |
| `storeFile` | profile 目录内的 `research-hub.json` | 指挥中心持久化文件 |
| `alertKinds` | `["error","interrupted","aborted:disposed"]` | 需要投递收件箱的会话中断原因 |
| `alertBackfillHours` | `72` | 冷读回填回看最近多少小时的会话日志 |
| `alertInterruptedGraceMinutes` | `30` | 冷读观测的中断需要静默多少分钟才判定为真 |
| `autoTrashProgrammatic` | `true` | 程序化会话（headless/脚本一次性运行）自动进入回收站 |

推荐在 profile patch 里固定项目根目录，避免宿主从其他目录启动时丢失项目：

```yaml
- id: dsh-research-hub
  name: '@dsh-external/dsh-research-hub'
  config:
    projectsRoots:
      - /path/to/projects
```

插件会将每个根目录本身登记为项目，并扫描含 `paper.toml` 或 `.git` 的直接子目录。也可以在界面新建项目。插件不包含作者个人项目注册表、会话记录或机器路径。

### 程序化会话

headless 或脚本从标准输入发起的一次性会话，首条用户消息没有客户端标识（`rpcId`）。这类会话的工作由注册任务的主会话承接，因此插件会把它自动扫进回收站，不计入项目、收件箱或角标。

- 判定只看首条用户消息的来源，判定一次后缓存，不重复冷读日志。
- 用户或 agent 显式绑定过项目的会话保留，不自动回收。
- 从回收站恢复的会话视为长期豁免，不再自动回收。
- 关闭该行为：把 `autoTrashProgrammatic` 设为 `false`。


### 中断告警

会话停在半途时，agent 本身不会再投递消息。插件在宿主侧监听会话日志的回合结束事件，把中断补进收件箱。

触发来源有两个：

1. 实时事件：回合执行失败时立即投递。
2. 冷读回填：宿主崩溃或重启后，插件读取最近会话日志，把补记的中断投递。回填在启动后约 8 秒执行一次，之后每 5 分钟增量执行（打开面板时的刷新也走同一节流）。

`alertKinds` 的取值：

- `error`：回合执行失败，正文带失败码与错误消息。模型调用失败最常见，也可能是工具或环境错误。宿主对非模型错误只给出 `UNKNOWN` 码，此时标题不展示代码。
- `interrupted`：会话进程在回合运行中被打断（崩溃或重启）。
- `max-tokens`：输出达到 token 上限。
- `aborted`：所有主动取消；`aborted:user`、`aborted:parent`、`aborted:disposed`、`aborted:hook` 只匹配单种原因。

默认值只包含前两项与 `aborted:disposed`。用户主动取消（`aborted:user`）与父会话取消子代理（`aborted:parent`）默认不告警。

`interrupted` 需要额外判定。冷读观测会给末尾回合未闭合的日志补一条中断事件，而其他进程里正在运行的会话（例如无人值守的 headless 任务）在冷读里同样是未闭合日志。因此冷读得到的中断要等最后活动静默 `alertInterruptedGraceMinutes` 分钟才判定为真，未满时限就留到下一轮回填。进程内实时观测到的不受此限。

同一条会话的同一轮只告警一次，记录跨重启保留。会话开新一轮或用户从收件箱回复后，告警自动关闭。已被继续的旧中断不会补报。

## 会话工具

```text
hub_register(project, note?)
hub_post(type, title, body?, priority?, project?)
```

- `hub_register`：仅在自动归属错误或需要手动指定项目时调用。传 `project: "auto"` 可重新推断。
- `hub_post`：`type` 为 `question` 或 `deliverable`。`priority` 为 `normal` 或 `urgent`。
- `ask_user_question`：宿主自动镜像结构化问题。会话作答后同步关闭镜像，不必重复投递。
- 子代理不调用这些工具。子代理结果直接汇报给父会话。

## 数据与安全

- 数据只保存在当前 DSH profile 的本地 JSON 文件中。没有外部分析服务，不上传会话数据。
- 快捷回复通过宿主控制器执行，效果等同于用户在目标会话中输入。
- HTTP 路由位于 `/rhub/api`，只接受回环 Host 的 POST 请求。不是面向公网的 API。
- 建议仅通过 loopback 或 SSH 隧道访问 DSH。当前不支持远程自定义域名或反向代理 Host。
- API 和本地状态包含会话标题、问题与回复。不要把 profile 状态文件提交到仓库。
- 删除插件前先备份 `research-hub.json`。取消归档或从回收站恢复后，会话重新显示。

## 源码开发

需要 Node.js 24.11+、npm、bash 和已安装的 DSH。运行环境已验证 Node.js 24.4.1，但构建依赖声明要求 Node.js 24.11+。

```bash
git clone https://github.com/Lingrui98/dsh-research-hub.git
cd dsh-research-hub
npm ci --legacy-peer-deps --ignore-scripts
npm run build
npm run build:client
npm test
npm run test:package
npm pack --ignore-scripts
```

构建脚本会探测全局 DSH 安装。非全局安装时，用 `DSH_ROOT` 或 `DSH_CHECKOUT` 指向含依赖的 DSH 包根目录。脚本不含固定绝对路径，不覆盖既有依赖目录。宿主侧只依赖 DSH 提供的同名 `@deepseek-ai/*` 包，不装入另一个 Cordis 运行时。

`npm run test:package` 在临时目录解包、检查 gzip 完整性、bundle patch、入口文件和敏感路径，并验证 host/client 可加载。

浏览器回归需要已有的 `react`、`react-dom`、`esbuild`、`playwright-core` 和 Chromium：

```bash
BROWSER_TEST_MODULE_ROOT=/absolute/path/to/browser-test-project/package.json \
  node scripts/client-home.browser.mjs
```

测试使用真实 client bundle 与模拟宿主，不读写真实收件箱。覆盖亮暗主题、四种屏宽、瀑布流填空、动态高度、面板缩放、回复、查收、选项作答与跳转返回。

## 已知边界

- DSH 预发布版本之间接口可能变化。目前只验证 0.2.0-rc.2。
- AUQ 仍在前台工具等待窗口内时，结构化回答可能不可用。文本回复可作为备用。
- 新安装后标题缓存需要后台补齐。后续刷新使用持久化缓存。
- 自动推断可能归错项目。界面手动绑定会锁定归属。
- 当前未接入 npm 或官方公共插件目录。分发渠道是本仓库的 GitHub Releases。

## License

[BSD-3-Clause](LICENSE)。
