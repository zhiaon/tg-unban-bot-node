# TG Unban Bot（Node.js 服务器版）

Telegram 群组自助解封 + 违禁词管理 + 自动回复机器人。

> **基于原创项目改造**
>
> 本项目基于 **[cmliu/CF-Workers-TGUnbanBot](https://github.com/cmliu/CF-Workers-TGUnbanBot)** 改造而成。
> 原作者：[cmliu](https://github.com/cmliu)
> 原项目是 Cloudflare Workers 单文件部署版本，本项目将其适配到普通服务器（Node.js）运行，
> 并新增了违禁词管理、自动回复、Web 管理面板等功能。
> 在此向原作者致敬，感谢其优秀的开源工作。

---

## 与原版的区别

| 特性 | 原版 (CF Workers) | 本项目 |
|------|------------------|--------|
| 部署 | 仅 Cloudflare Workers | **双版本：CF Workers + Node.js 服务器** |
| 存储 | CF KV / D1 | CF: KV/D1 · Node: SQLite |
| AI 评级 | Workers AI | CF: Workers AI · Node: DeepSeek API |
| 违禁词 | ❌ | ✅ 支持精确/包含匹配、单个词独立规则 |
| 自动回复 | ❌ | ✅ 关键词触发 |
| Web 管理面板 | ❌ | ✅ 移动端友好的网页面板 |
| 面板按钮 | ❌ | ✅ Telegram 内联按钮面板 |
| 群 ID 管理 | ❌ | ✅ 动态添加/删除群 |

## 两个版本

仓库提供两套部署方式，功能一致，按需选择：

### 🇨🇫 Cloudflare Workers 版 → [`cf-worker/`](cf-worker/)
- 单文件 `_worker.js` + `wrangler.toml`
- 免费、免服务器、全球加速
- 定时任务用 Cron Trigger
- 部署文档见 [cf-worker/README.md](cf-worker/README.md)

### 🖥 Node.js 服务器版 → 根目录
- `server.js` 适配层 + `_worker.js`
- 适合自有服务器（VPS/家宽）
- 定时任务用 `setTimeout`
- 部署文档见下文

## 功能

### 原版功能（保留）
- 用户自助解封（私聊 `/unban` + 确认口令）
- 联网黑名单（`/ban` `/unban` `/spam`）
- 封禁记录查询（`/check`）
- 举报投票 `/ad`（AI 威胁评级 + 群友投票）
- 新机器人进群风控

### 新增功能
- **违禁词管理**：`/addwords` `/delwords` `/listwords`
  - 双引号 = 精确匹配，无引号 = 包含匹配
  - 每个词可单独配置处罚方式、时长、警告次数
  - 全局配置：启用/关闭、警告上限、处罚方式（踢出/封禁）、处罚时长
- **警告管理**：`/warns` `/clearwarn`
- **自动回复**：`/autoreply 关键词=回复内容`
- **群 ID 管理**：`/addgroup` `/delgroup`
- **命令回复自动删除**：群内命令回复 20 秒后自动删除
- **管理面板**：`/panel`（Telegram 内联按钮）+ `/panel` 网页版

## 部署

### 环境要求
- Linux 服务器（Debian/Ubuntu）
- Node.js 22+
- Caddy 或 Nginx（用于 HTTPS 反代）

### 安装步骤

```bash
# 1. 安装 Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs

# 2. 创建目录并上传文件
sudo mkdir -p /opt/tg-unban-bot/data
# 上传 _worker.js / server.js / package.json / panel.html 到 /opt/tg-unban-bot/

# 3. 安装依赖
cd /opt/tg-unban-bot
npm install --production

# 4. 配置环境变量（systemd 方式见下）
```

### systemd 服务

```ini
[Unit]
Description=TG Unban Bot
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/tg-unban-bot
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=PORT=8787
Environment=DB_PATH=/opt/tg-unban-bot/data/tg-unban-bot.db
Environment=TOKEN=你的初始化密钥
Environment=BOT_TOKEN=你的BotToken
Environment=GROUP_ID=-1001234567890
# 可选：DeepSeek AI（用于 /ad 威胁评级）
# Environment=DEEPSEEK_API_KEY=sk-xxx

[Install]
WantedBy=multi-user.target
```

### Caddy 反代

```
unban.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

### 初始化 Webhook

部署后访问 `https://你的域名/你的TOKEN` 即可完成 Webhook 和命令菜单设置。

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `TOKEN` | ✅ | 初始化入口密钥（随机长字符串） |
| `BOT_TOKEN` | ✅ | Telegram Bot Token |
| `GROUP_ID` | ✅ | 群组 ID，多个用逗号分隔 |
| `PORT` | ❌ | 监听端口，默认 8787 |
| `DB_PATH` | ❌ | SQLite 数据库路径 |
| `DEEPSEEK_API_KEY` | ❌ | DeepSeek API Key（/ad AI 评级） |
| `DEEPSEEK_MODEL` | ❌ | DeepSeek 模型，默认 deepseek-chat |
| `AD_GROUP_RULES` | ❌ | /ad 评级群规 |
| `AD_AI_MODEL` | ❌ | /ad 模型列表 |

## 命令一览

| 命令 | 权限 | 说明 |
|------|------|------|
| `/unban` `/start` | 所有人 | 自助解封 |
| `/ban <ID>` | 管理员 | 封禁用户 |
| `/spam` | 管理员 | 回复消息，拉黑发送者 |
| `/check <ID>` | 管理员 | 查询封禁记录 |
| `/addwords 词1,词2` | 管理员 | 添加违禁词 |
| `/delwords 词` | 管理员 | 删除违禁词 |
| `/listwords` | 管理员 | 查看违禁词 |
| `/clearwarn [ID]` | 管理员 | 清除警告 |
| `/warns [ID]` | 管理员 | 查看警告次数 |
| `/autoreply 词=回复` | 管理员 | 添加自动回复 |
| `/addgroup <ID>` | 管理员 | 添加群到联ban范围 |
| `/delgroup <ID>` | 管理员 | 删除群 |
| `/panel` | 管理员 | 打开管理面板 |

## 网页面板

访问 `https://你的域名/panel`，输入 `TOKEN` 登录即可打开 Web 管理面板。

## 文件结构

```
.
├── _worker.js      # 业务主程序（Node.js 版）
├── server.js       # Node.js 适配层（KV/D1/AI 绑定 shim + HTTP 服务）
├── panel.html      # Web 管理面板
├── package.json    # 依赖配置
├── README.md       # 本文件
└── cf-worker/      # Cloudflare Workers 版
    ├── _worker.js      # 业务主程序（CF 版）
    ├── wrangler.toml   # CF 部署配置
    └── README.md       # CF 部署文档
```

## 许可

本项目基于 [cmliu/CF-Workers-TGUnbanBot](https://github.com/cmliu/CF-Workers-TGUnbanBot) 改造，
原项目采用 MIT 许可。改造部分同样适用 MIT 许可。
