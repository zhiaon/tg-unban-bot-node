# TG Unban Bot（Node.js 服务器版）

Telegram 群组自助解封 + 违禁词管理 + AI 情绪监控 + 自动回复机器人。

> **基于原创项目改造**
>
> 本项目基于 **[cmliu/CF-Workers-TGUnbanBot](https://github.com/cmliu/CF-Workers-TGUnbanBot)** 改造而成。
> 原作者：[cmliu](https://github.com/cmliu)
> 原项目是 Cloudflare Workers 单文件部署版本，本项目将其适配到普通服务器（Node.js）运行，
> 并新增了违禁词管理、自动回复、AI 情绪监控、Web 管理面板等功能。
> 在此向原作者致敬，感谢其优秀的开源工作。

---

## 与原版的区别

| 特性 | 原版 (CF Workers) | 本项目 |
|------|------------------|--------|
| 部署 | 仅 Cloudflare Workers | **双版本：CF Workers + Node.js 服务器** |
| 存储 | CF KV / D1 | CF: KV/D1 · Node: SQLite |
| AI 评级 | Workers AI | CF: Workers AI · Node: OpenAI 兼容 API |
| 违禁词 | ❌ | ✅ 支持精确/包含匹配、单个词独立规则 |
| 自动回复 | ❌ | ✅ 关键词触发 |
| AI 情绪监控 | ❌ | ✅ 辱骂检测 + 累计警告 + 自动禁言/封禁 |
| Web 管理面板 | ❌ | ✅ 移动端友好的网页面板 |
| 面板按钮 | ❌ | ✅ Telegram 内联按钮面板 |
| 群 ID 管理 | ❌ | ✅ 动态添加/删除群 |

## 两个版本

仓库提供两套部署方式，功能一致，按需选择。

### CF Workers 版 → `cf-worker/`

- 单文件 `_worker.js` + `wrangler.toml`
- 免费、免服务器、全球加速
- 定时任务用 Cron Trigger
- 部署文档见 `cf-worker/README.md`

### Node.js 服务器版 → 根目录

- `server.js` 适配层 + `_worker.js`
- 适合自有服务器（VPS/家宽）
- 定时任务用 `setInterval`
- 存储为 SQLite，AI 走 OpenAI 兼容接口

## 功能

### 原版功能（保留）

- 用户自助解封（私聊 `/start` + 确认口令）
- 联网黑名单（`/ban` `/unban` `/check`）
- 封禁记录查询（`/check`）
- 举报投票 `/ad`（AI 威胁评级 + 群友投票）
- 新机器人进群风控

### 新增功能

- **违禁词管理** `/addwords` `/delwords` `/listwords`
  - 双引号 = 精确匹配，无引号 = 包含匹配
  - 每个词可单独配置处罚方式（禁言/踢出/封禁）和触发次数
- **AI 情绪监控**（智能辱骂检测）
  - 独立骂人检测：5 分钟内 3+ 条攻击性消息自动处理
  - 回复骂人检测：回复链 3+ 条敌意消息双向互怼自动处理
  - 累计警告制度：
    - 第 1-2 次：群里 @用户警告，显示次数和 AI 原因
    - 第 3 次：私聊通知管理员 + 群里 @所有管理员 + 禁言 5 分钟
    - 第 4 次+：踢出 + 封禁 + 拉黑
  - AI 攻击等级：0=正常, 1=语气不佳, 2=辱骂攻击, 3=严重威胁
- **警告管理** `/warns` `/clearwarn`
- **自动回复** `/autoreply`
- **群 ID 管理** `/addgroup` `/delgroup`
- **命令回复自动删除**：群内命令回复 20 秒后自动删除
- **管理面板**：`/panel`（Telegram 内联按钮）+ 网页版

### AI 配置（在线修改）

`/panel` → 🤖 AI 智能功能 → 🔑 配置 API

面板显示当前接入的 API Key、API 地址、模型，点击按钮后直接回复机器人发来的消息即可修改，**保存后立即生效，无需重启**。

也可用命令：

```
/setapikey <key>      修改 API Key
/setapiurl <url>      修改 API 地址
```

Node.js 版配置存放于 `data/ai-config.json`，`server.js` 每次请求重新读取（2 秒缓存）：

```json
{
  "apiKey": "你的 API Key",
  "baseUrl": "https://你的接口地址/v1",
  "model": "你的模型名"
}
```

未配置时读环境变量 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` 作为默认值。

## AI 情绪监控详解

### 触发条件

- 消息包含攻击性词汇（傻逼/垃圾/废物/操你妈/滚/闭嘴等）
- AI 判定 hostility ≥ 2（辱骂攻击或严重威胁）

### 处理流程

| 次数 | 群里行为 | 额外处理 |
|------|---------|---------|
| 第 1 次 | ⚠️ @用户 警告 1/3 + AI 原因 | 无 |
| 第 2 次 | ⚠️ @用户 警告 2/3 + AI 原因 | 无 |
| 第 3 次 | 🔇 @所有管理员 + 已禁言 5 分钟 | 私聊通知所有管理员（带消息链接） |
| 第 4 次+ | 🚫 已封禁踢出 + 拉黑 | 加入联网黑名单 |

## 每日摘要

- 管理员可发 `/summary` 手动生成当天摘要
- 到达设定时间（面板可选 22:00 / 23:00 / 00:00）自动生成
- 消息按 `Asia/Shanghai` 日期归档，保留 7 天

## 部署

### 环境要求

- Linux 服务器（Debian/Ubuntu）
- Node.js 22+
- Caddy 或 Nginx（用于 HTTPS 反代）

### 必需环境变量

| 变量 | 说明 |
|------|------|
| `BOT_TOKEN` | Telegram Bot API Token |
| `GROUP_ID` | 主群 ID（-100 开头） |
| `TOKEN` | Web 管理面板访问令牌 |

## 项目结构

```
_worker.js          # 主逻辑（CF Workers 格式，Node 版直接复用）
server.js           # Node.js 适配层（KV/DB/AI shim + Web 面板服务）
panel.html          # Web 管理面板
data/               # SQLite 数据库 + ai-config.json
cf-worker/          # Cloudflare Workers 部署版
```

## License

MIT License
