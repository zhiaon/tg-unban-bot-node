# Cloudflare Workers 部署说明

> 本项目基于 [cmliu/CF-Workers-TGUnbanBot](https://github.com/cmliu/CF-Workers-TGUnbanBot) 改造
> 原作者：[cmliu](https://github.com/cmliu)

本目录是**适配 Cloudflare Workers** 的版本（`_worker.js` 单文件 + `wrangler.toml`）。

如果要在普通 Linux 服务器（Node.js）部署，请用上级目录的 `server.js` 版本。

---

## 与 Node.js 版的差异

| 特性 | CF Workers 版 | Node.js 版 |
|------|--------------|-----------|
| 存储 | CF KV / D1 | 本地 SQLite |
| AI | Workers AI 绑定 | DeepSeek API |
| 20 秒延迟删消息 | `ctx.waitUntil()` + `scheduler.wait()` | `setTimeout` |
| 临时封禁自动解封 | Cron Trigger + `unmute_queue` 表 | `setTimeout` |
| 部署 | `wrangler deploy` | systemd 服务 |

---

## 部署步骤

### 1. 安装 Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. 创建 D1 数据库

```bash
wrangler d1 create tg-unban-bot
```

把输出的 `database_id` 填到 `wrangler.toml` 的 `[[d1_databases]]` 段。

### 3. 配置 Workers AI

`wrangler.toml` 中已保留 `[ai] binding = "AI"`，直接重新 `wrangler deploy` 即可；
或在 Cloudflare Dashboard 给该 Worker 绑定名为 `AI` 的 Workers AI 资源。

### 4. 设置环境变量

```bash
wrangler secret put TOKEN        # 初始化入口密钥（随机长字符串）
wrangler secret put BOT_TOKEN    # Telegram Bot Token
wrangler secret put GROUP_ID     # 群组 ID（多个用逗号分隔）
```

### 5. 部署

```bash
wrangler deploy
```

### 6. 初始化 Webhook

访问 `https://你的Worker域名/你的TOKEN`，返回 `"成功": true` 即完成。

---

## Cron 定时任务

`wrangler.toml` 已配置：

```toml
[triggers]
crons = ["*/5 * * * *"]
```

每 5 分钟触发一次 `scheduled` 事件，扫描 `unmute_queue` 表，
对到期的临时封禁用户执行自动解封。

**注意**：如果不用 Cron，临时封禁（5分钟/30分钟/1天）到期后不会自动解封，
用户需等管理员手动 `/unban`。

---

## 兼容性说明

- 需要 `compatibility_flags = ["nodejs_compat"]`（`wrangler.toml` 已配置）
- 依赖 `scheduler.wait()`，需要 `compatibility_date >= 2024-09-23`

---

## 新增功能（与 Node.js 版一致）

- 违禁词管理：`/addwords` `/delwords` `/listwords`
  - 双引号 = 精确匹配，无引号 = 包含匹配
  - 每个词可单独配置处罚方式、时长、警告次数
- 警告管理：`/warns` `/clearwarn`
- 自动回复：`/autoreply 关键词=回复内容`
- 群 ID 管理：`/addgroup` `/delgroup`
- 管理面板：`/panel`
- 命令回复 20 秒后自动删除
