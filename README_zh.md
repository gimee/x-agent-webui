# X-Agent-Webui

[English](README.md) · [简体中文](README_zh.md) · [官网](https://x-agent.io)

为 **Hermes Agent、Claude 和 Pi** 超长对话打磨的自托管工作台。

![X-Agent-Webui](docs/images/x-agent-webui.png)

> **分支出处：** 本项目是 [EKKOLearnAI/hermes-studio](https://github.com/EKKOLearnAI/hermes-studio)（原 Hermes Web UI）的独立、非官方衍生版本，基于 **v0.7.18**，上游提交为 [`ee728bdc700d6409c81341003d623df9b811ee15`](https://github.com/EKKOLearnAI/hermes-studio/tree/ee728bdc700d6409c81341003d623df9b811ee15)，使用 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 作为底层引擎。本项目不代表上述项目，也未获其官方背书。公开仓库从脱敏后的源码快照开始，不包含内部开发历史；这里的“分支”指代码衍生关系，不表示已加入 GitHub 的 fork 网络。

## 为什么选择 X-Agent-Webui

**长对话，不失忆。** X-Agent-Webui 专为动辄几十万 token 的 Agent 长对话打磨。

| | 你得到什么 |
| --- | --- |
| **记忆优先压缩** | **Claude 对话：**约 40 万 token 触发压缩时，你说过的每一句原话都逐字跨代保留；摘要分节撰写，并附只读原文档案供模型回查。**Hermes 对话：**严格按你的压缩设置执行（目标比例、保护最近与开头消息），触发点按真实用量校准，超长历史分块总结。**两者都是：**摘要失败、超时或返回错误提示时一律保留原文，历史绝不会被一句错误替换，压缩进度在对话中实时可见。可由辅助模型写摘要（约 45 万 token 的对话从约 5 分钟降到约 2.5 分钟，增量压缩约 40 秒），发送前先脱敏。 |
| **消息零重复、零丢失** | 每条消息带稳定身份，贯穿发送、排队、多端广播、断线恢复与落库；刷新、重连、重启后不重复、不丢失，不会一直卡在「工作中」，中止或超时前已流出的输出也会保存。 |
| **历史再多也快** | 约 800 个会话时：会话列表出现约 3 秒 → 0.8 秒，页面内存 126MB → 14MB，最长卡顿约 2 秒 → 0.2 秒；长代码流式输出从 12–20 帧/秒提升到约 59 帧/秒；会话搜索从 1.3 秒降到 0.3–0.5 秒，且不占主线程。 |
| **三个 Agent，一个工作台** | Hermes Agent、Claude、Pi 共用同一界面；推理强度可按对话单独设置（低 → Max）并真实生效，上下文用量显示准确，对话自动起标题。 |
| **记忆由你掌控** | 开启记忆锁后，Agent 无法写入 MEMORY.md / USER.md；笔记可一键同步给 Claude。 |
| **稳定，不折腾** | 界面冻结，不随上游频繁改版；每次重建只更新 Hermes Agent、Claude Code、Pi 三个 Agent 层；群聊、工作流等冗余功能已移除，专注对话本身。 |

以上数字来自本发行版的真实使用环境实测，实际表现取决于硬件、模型与服务商。模型服务及 Agent CLI 各有独立的使用条件、费用与条款。

## 安装

一键脚本与手动 Docker 安装走的是**同一条 Docker Compose 源码构建路径**。当前不依赖、也不宣称提供预构建的 X-Agent 镜像。

前置条件：Bash、curl、Python 3、可用的 Docker Engine 与 Docker Compose v2；手动安装另需 Git。建议从 Linux x86-64 主机开始，预留足够内存和磁盘给 Hermes 基础镜像、Node 构建、Agent CLI 和浏览器。其他架构需要单独验证。

```bash
curl -fsSL https://raw.githubusercontent.com/gimee/x-agent-webui/main/install.sh | bash
```

更稳妥的方式是先下载、审阅脚本再执行：

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/gimee/x-agent-webui/main/install.sh
bash install.sh --help
bash install.sh
```

默认只绑定 **127.0.0.1:6060**。本机打开 <http://127.0.0.1:6060>；远程服务器先用 SSH 隧道访问，再按需配置 HTTPS 反向代理：

```bash
ssh -L 6060:127.0.0.1:6060 user@your-server
```

上游保留的首次登录账号密码为 **`admin` / `123456`**。先在本机登录，按提示立即修改用户名和密码，**改好之前不要开放公网访问**，然后填写自己的模型服务商凭据。项目不包含个人 API Key、聊天记录、个人 Skills 库或私人部署配置。

### 手动 Docker 安装

```bash
git clone https://github.com/gimee/x-agent-webui.git
cd x-agent-webui
docker compose -f compose.yaml up -d --build
docker compose -f compose.yaml ps
```

脚本参数、数据卷、更新与备份步骤见[安装指南](docs/installation.md)。

### 更新与停止

通过 Git clone 安装时，先备份数据，再执行：

```bash
git pull --ff-only
docker compose -f compose.yaml up -d --build
docker compose -f compose.yaml logs --tail=100
```

停止服务但保留数据卷：

```bash
docker compose -f compose.yaml down
```

**除非确定要永久删除安装数据，否则不要加 `-v`。** 一键脚本下载的归档不是 Git 仓库，不能直接 `git pull`；请按安装指南更新。

## 安全与隐私

- 这是 Agent 执行环境，**不是安全沙箱**。Agent 能运行命令并访问容器内可见文件；不要向不可信用户开放，也不要挂载敏感宿主目录。
- Docker 发行版在容器内包含较强的 Agent 执行权限，但不需要宿主 Docker socket。保留默认回环监听，启用认证；远程访问放在 HTTPS 和访问控制之后。
- 自托管存储不等于离线推理：提示词、附件或摘要可能发送给你配置的模型服务商；浏览器和外部集成也会联网。
- 各安装自行配置凭据。环境文件、数据卷、日志和备份不要进入 Git。公开仓库不包含私人部署状态及内部 Git 历史。
- 继承的可选集成可能连接上游或第三方服务，并有独立使用要求。本项目不授予原项目付费 App 或服务的使用权。

## 开发

使用 `package.json` 要求的 Node 版本，并使用隔离测试数据：

```bash
npm ci --include=dev --ignore-scripts
npm rebuild node-pty
npm run build
npm run test:claude-context
npm run test:claude-start
```

前后端位于 `packages/client` 与 `packages/server`，进程包装器位于 `bin/`，静态官网位于 `site/`。开发规则见 [DEVELOPMENT.md](DEVELOPMENT.md)、[AGENTS.md](AGENTS.md) 和[架构文档](ARCHITECTURE.md)。

`package.json` 的版本号是社区版本，`upstreamProvenance` 单独记录冻结的上游出处。更新 Hermes 基础镜像或可选 CLI，不等于更新冻结的 X-Agent-Webui 界面源码。

## 许可证与致谢

上游 Hermes Studio 代码及本衍生版本继续遵守上游 **Business Source License 1.1** 及其**非商业用途授权**。必须保留 [LICENSE](LICENSE) 与上游声明。出售、商业 SaaS 托管或嵌入商业产品等商业用途，需要原许可方单独授权。上游许可证规定 **2029-05-10** 转为 **Apache License 2.0**；因此当前准确表述为“源码公开”，**不是无商业限制的 MIT / Apache 开源版本**。

Hermes Agent 另行遵守 MIT 许可。依赖、字体、图片和第三方 CLI 保留各自许可证及条款；本项目不授予上游商标权。详见 [UPSTREAM.md](UPSTREAM.md) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

感谢 EKKOLearnAI、Nous Research 及上游贡献者。衍生版专属问题请提交至[本仓库 Issues](https://github.com/gimee/x-agent-webui/issues)，不要作为原项目问题提交。
