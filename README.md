# DSH Research Hub · 研究指挥中心

[![Release](https://img.shields.io/github/v/release/Lingrui98/dsh-research-hub)](https://github.com/Lingrui98/dsh-research-hub/releases/latest)
[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-blue)](LICENSE)

把分散的 DSH 会话组织成项目工作台。集中处理问题与交付结果，直接回复，并在会话与指挥中心之间往返。

这是独立的第三方插件，不是 DeepSeek 官方产品。当前公开版本为 **v0.1.1**，已在 **DSH 0.2.0-rc.2 Web profile** 验证。DSH 的预发布接口可能变化，其他版本不作兼容承诺。

## 功能

- **常驻收件箱**：首页集中显示跨项目问题与交付。紧急优先，同级按入箱时间排序。空箱仍显示，查看不会自动关闭待处理状态。
- **项目总览**：等宽瀑布流减少空位，保持项目排序与键盘访问顺序。每张卡片显示最近更新的三个会话，以及两条待处理摘要。
- **原地处理**：文本回复、结构化选项作答、交付查收、忽略、重开。Ctrl/Cmd+Enter 提交回复。
- **会话导航**：点击标题打开会话。会话头部的“指挥中心”按钮回到此前页面。
- **自动归属**：从项目根目录发现项目。手动锁定绑定优先于会话自报，再以标题及首条消息推断归属。无法判断的会话进入未分配区。
- **高效分拣**：建议归属、就地创建项目、指挥中心专属回收站。回收站只隐藏会话，不删除 DSH 会话本身。
- **范围过滤**：排除子代理、空白会话、已归档会话和回收站会话。归档状态跟随宿主推送。
- **主题适配**：亮暗主题、自然卡片高度、按面板实际宽度切换分栏、明确焦点和减少动画支持。

## 安装

### 推荐：安装 GitHub Release 的预构建包

从 [Releases](https://github.com/Lingrui98/dsh-research-hub/releases/latest) 下载 `.tgz` 和 `SHA256SUMS`。安装包包含编译后的 host、client 与 bundle patch，不需要在用户机器编译。

```bash
curl -fL -O https://github.com/Lingrui98/dsh-research-hub/releases/download/v0.1.1/dsh-external-dsh-research-hub-0.1.1.tgz
curl -fL -O https://github.com/Lingrui98/dsh-research-hub/releases/download/v0.1.1/SHA256SUMS
sha256sum -c SHA256SUMS
```

在 DSH 的插件管理界面使用安装包的绝对路径或下列 tarball URL 安装并启用 bundle：

```text
https://github.com/Lingrui98/dsh-research-hub/releases/download/v0.1.1/dsh-external-dsh-research-hub-0.1.1.tgz
```

若界面没有插件安装入口，参见下方 CLI 方法。**只安装到可信的本机 DSH 环境。插件可读取会话标题、项目文件和消息，并可向会话发送回复。**

### CLI 方法

先停止目标 Web profile，再安装预构建包：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-external-dsh-research-hub-0.1.1.tgz
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
| `storeFile` | profile 目录内的 `research-hub.json` | 指挥中心持久化文件 |

推荐启动时指定项目根目录：

```bash
DSH_RESEARCH_HUB_PROJECTS_ROOT="$HOME/projects" dsh web
```

插件会将根目录本身登记为项目，并扫描含 `paper.toml` 或 `.git` 的直接子目录。也可以在界面新建项目。插件不包含作者个人项目注册表、会话记录或机器路径。

## 会话工具

```text
hub_register(project, note?)
hub_post(type, title, body?, priority?, project?)
```

- `hub_register`：会话声明所属项目。`project: "auto"` 请求自动推断。
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
