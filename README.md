# DSH Research Hub · 项目工作台

[English](README_EN.md) | 中文

[![Release](https://img.shields.io/github/v/release/Lingrui98/dsh-research-hub)](https://github.com/Lingrui98/dsh-research-hub/releases/latest)
[![CI](https://github.com/Lingrui98/dsh-research-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/Lingrui98/dsh-research-hub/actions/workflows/ci.yml)
[![dsh-xray: capability card](https://img.shields.io/endpoint?url=https://unstone.github.io/dsh-xray/badge/Lingrui98__dsh-research-hub.json)](https://unstone.github.io/dsh-xray/registry.html)
[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-blue)](LICENSE)

**把散落在几十个会话里的问题、结果和中断，收进一个能直接处理的项目工作台。**

DSH 擅长一次把一件事做好，但不擅长同时管很多件事。会话一多，问题卡在某个窗口里等你回答，结果散落在不同会话，任务失败了你也未必知道。Research Hub 在 DSH 之上加一层项目视图：自动把会话归到项目，把需要你处理的事集中到一个收件箱，并让你原地处理完，不必来回切换。

> 独立第三方插件，不是 DeepSeek 官方产品。当前版本 **v0.2.0**，已在 **DSH 0.2.0-rc.2 Web profile** 验证。

## 它解决什么问题

- **问题找不到你**：某个会话在等你回答提问，但你正在别的项目里干活，它就一直卡着。
- **结果散得到处都是**：A 会话的结论、B 会话的交付、C 会话的失败告警，没有任何地方汇总。
- **整理全靠手工**：会话一多，侧栏变成流水账，分不清哪个会话属于哪个项目、哪个还在推进。

## 核心能力

| 能力 | 你会得到什么 |
| --- | --- |
| **一个收件箱** | 待回答的问题、待查收的交付、会话中断告警，三类事情集中显示，紧急的排在前面。 |
| **自动分项目** | 扫描你的项目目录，由标题和首条消息推断会话归属；匹配不唯一时才需要你手动指定。 |
| **原地处理** | 在面板里直接作答、回复继续会话、一键查收或忽略，不用切回原会话。 |
| **中断不漏报** | 模型报错、宿主崩溃或重启导致回合中断时，自动进收件箱；重启前的历史中断也能补报。 |
| **打开就很快** | 首页读本地快照，常驻面板打开与轮询在毫秒级，不拖慢 DSH。 |
| **能被外部调用** | CI、脚本、另一台机器可以通过接口投递结果；收件箱事件也能推送到你自己的服务。 |
| **数据在本地** | 默认单文件存储，无遥测；可切换 SQLite，可随时导出备份、导入恢复。 |

## 和别的插件有什么不同

DSH 生态里已经有不少会话管理器和提醒插件，它们各自解决一小块。Research Hub 的定位是"项目级收件箱"：

| | 会话管理器类 | 通知类 | Research Hub |
| --- | --- | --- | --- |
| 主要用途 | 整理、归档、删除会话 | 把提醒推到屏幕/手机 | 收拢需要你处理的跨会话事项 |
| 是否汇总待办 | 否 | 只是弹一下 | 是，持久保存并可处理 |
| 能否原地回复 | 否 | 否 | 是 |
| 项目归属 | 手工分组 | 无 | 自动推断，可手动锁定 |
| 外部系统投递 | 否 | 否 | 支持（默认关闭） |

## 快速开始

### 1. 安装

从 [Releases](https://github.com/Lingrui98/dsh-research-hub/releases/latest) 下载安装包，在 DSH 的插件管理界面选择本地文件安装并启用；或者用 CLI：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-external-dsh-research-hub-0.2.0.tgz
```

安装包已包含编译产物，不需要自行构建。校验方式：

```bash
sha256sum -c SHA256SUMS
```

### 2. 告诉它你的项目在哪

最省事的方式是指定一个项目根目录，插件会把它下面的项目目录登记为项目：

```yaml
- id: dsh-research-hub
  name: '@dsh-external/dsh-research-hub'
  config:
    projectsRoots:
      - /path/to/projects
```

默认把含 `.git` 或 `paper.toml` 的子目录识别为项目。你的项目用别的标记文件（比如 `package.json`、`Cargo.toml`）时，加一行配置即可，不必改代码。

### 3. 打开面板

重启 `dsh web` 并刷新页面，侧栏图标区就是入口。之后你只需要正常干活：提问会在收件箱出现，交付物和中断也会自己进来。

## 工作方式

```text
项目目录 ──扫描──▶ 项目列表
   │
会话 ──自动归属──▶ 项目
   │
   ├─ 提问（含跨会话镜像）─┐
   ├─ agent 投递的交付物  ─┼─▶ 收件箱 ─▶ 面板处理 / 工具读取 / 事件推送
   ├─ 回合中断告警        ─┤
   └─ CI / 脚本投递       ─┘
```

不需要常驻进程，也不改动 DSH 核心：所有能力都在插件内完成。

## 常用配置

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `projectsRoots` | 空 | 固定项目发现范围；不配置时用启动目录 |
| `discovery.markers` | `["paper.toml", ".git"]` | 哪些文件/目录代表一个项目 |
| `discovery.maxDepth` | `1` | 从根目录往下扫几层 |
| `alertKinds` | `error` 等 | 哪些中断要进收件箱 |
| `kinds` | 内置三类 | 自定义消息类型与它的处理方式 |
| `view` | 默认布局 | 面板分区与分组方式 |
| `ingest.http.enabled` | `false` | 允许外部系统投递 |
| `webhooks` | 空 | 把收件箱事件推送到你的服务 |
| `storage.driver` | `json` | 存储后端，可切 `sqlite` |

完整字段与示例见 [docs/configuration.md](docs/configuration.md)。

## 外部集成

CI 或脚本投递结果（默认关闭，开启后需要 token）：

```bash
curl -fsS -X POST http://127.0.0.1:9999/rhub/api/post \
  -H "Authorization: Bearer $RHUB_INGEST_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"type":"deliverable","title":"构建完成","body":"产物在 …","project":"my-project","idempotencyKey":"ci-20261022-1"}'
```

收件箱事件推送到你的服务（签名校验、失败重试、默认拒绝内网地址）：

```yaml
    webhooks:
      - url: https://example.com/rhub
        events: [item.created, item.urgent, alert.created]
        secret: change-me
```

## 数据与隐私

- 数据默认保存在本机 profile 目录的 JSON 文件里，不上传，无遥测。
- 外部投递默认关闭；开启后只接受带 token 的请求，任何时刻都可以关掉。
- 导出/导入是本地接口，用于备份与迁移。
- 删除插件前建议先导出或备份 `research-hub.json`。

## 兼容性与边界

- 目前只验证 DSH 0.2.0-rc.2；DSH 预发布版本之间接口可能变化。
- 提问还在前台等待窗口内时，面板可能无法直接作答，此时在会话内回答即可。
- 自动归属可能判断错项目，手动绑定会锁定结果。
- 未发布到 npm 或官方插件目录，分发渠道是本仓库的 GitHub Releases。

## 源码开发

需要 Node.js 24、npm、bash 和已安装的 DSH：

```bash
git clone https://github.com/Lingrui98/dsh-research-hub.git
cd dsh-research-hub
npm ci --legacy-peer-deps --ignore-scripts
npm run build && npm run build:client
npm test
npm run test:package
```

社交预览图由真实客户端 bundle 加纯演示数据渲染生成（不读取真实收件箱）：

```bash
BROWSER_TEST_MODULE_ROOT=/path/to/package.json node scripts/social-preview.mjs
```

需要先执行 `npm run build:client`，并准备一个含 `react`、`react-dom`、`esbuild`、`playwright-core` 的环境。

## License

[BSD-3-Clause](LICENSE)。
