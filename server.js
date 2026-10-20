/**
 * TG Unban Bot — Node.js 适配层
 * 在普通服务器上运行 Cloudflare Workers 代码 (_worker.js)
 *
 * 适配三类 Workers 绑定:
 *  - KV  → SQLite key-value 表 (支持 TTL)
 *  - DB  → SQLite D1 兼容 shim (prepare/bind/first/all/run/exec/batch)
 *  - AI  → DeepSeek API (可选; 未配置时 env.AI=null, /ad 回退 C 级)
 */

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─── 配置 ───────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8787');
const DB_PATH = process.env.DB_PATH || join(dirname(fileURLToPath(import.meta.url)), 'data', 'tg-unban-bot.db');

// 从 package.json 同目录加载 _worker.js
const __dirname = dirname(fileURLToPath(import.meta.url));
const workerModule = await import(join(__dirname, '_worker.js'));
const worker = workerModule.default;

// 加载面板 HTML
const PANEL_PATH = join(__dirname, 'panel.html');
let panelHtml = '';
if (existsSync(PANEL_PATH)) {
  panelHtml = readFileSync(PANEL_PATH, 'utf-8');
  console.log('[panel] 面板 HTML 已加载');
} else {
  console.log('[panel] panel.html 未找到, /panel 路由不可用');
}

// ─── SQLite 初始化 ──────────────────────────────────────
const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 5000');

// KV 表 (用于 env.KV shim)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER
  )
`);

// ─── KV Shim ────────────────────────────────────────────
function cleanExpiredKv() {
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare('DELETE FROM kv_store WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
}

const KV = {
  async get(key, options) {
    cleanExpiredKv();
    const row = sqlite.prepare('SELECT value FROM kv_store WHERE key = ?').get(key);
    if (!row) return null;
    if (options && options.type === 'json') {
      try { return JSON.parse(row.value); } catch { return null; }
    }
    return row.value;
  },
  async put(key, value, options) {
    const ttl = options && options.expiration_ttl;
    const expiresAt = ttl ? Math.floor(Date.now() / 1000) + ttl : null;
    sqlite.prepare('INSERT OR REPLACE INTO kv_store (key, value, expires_at) VALUES (?, ?, ?)')
      .run(String(key), String(value), expiresAt);
  },
  async delete(key) {
    sqlite.prepare('DELETE FROM kv_store WHERE key = ?').run(String(key));
  }
};

// ─── D1 Shim ───────────────────────────────────────────
class D1PreparedStatement {
  constructor(db, sql) {
    this._db = db;
    this._sql = sql;
    this._bindArgs = [];
  }
  bind(...args) {
    this._bindArgs = args;
    return this;
  }
  async first() {
    const stmt = this._db.prepare(this._sql);
    const row = stmt.get(...this._bindArgs);
    return row || null;
  }
  async all() {
    const stmt = this._db.prepare(this._sql);
    const rows = stmt.all(...this._bindArgs);
    return { results: rows };
  }
  async run() {
    const stmt = this._db.prepare(this._sql);
    const info = stmt.run(...this._bindArgs);
    return { meta: { changes: info.changes, last_row_id: String(info.lastInsertRowid), changed: info.changes } };
  }
}

const DB = {
  prepare(sql) {
    return new D1PreparedStatement(sqlite, sql);
  },
  async exec(sql) {
    sqlite.exec(sql);
  },
  async batch(statements) {
    const results = [];
    for (const stmt of statements) {
      results.push(await stmt.run());
    }
    return results;
  }
};

// ─── AI Shim (可选, DeepSeek API; 支持运行时改配置) ─────
const AI_CONFIG_FILE = join(__dirname, 'data', 'ai-config.json');
const AI_TIMEOUT_MS = parseInt(process.env.AD_AI_TIMEOUT_MS || '12000');

const AI_DEFAULT_CFG = {
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  baseUrl: process.env.DEEPSEEK_BASE_URL || '',
  model: process.env.DEEPSEEK_MODEL || ''
};

let _aiCfgCache = null;
let _aiCfgCacheAt = 0;

// 读取当前 AI 接入配置（文件优先，2 秒缓存；改完立即生效）
function getAiEndpointConfig() {
  const now = Date.now();
  if (_aiCfgCache && now - _aiCfgCacheAt < 2000) return _aiCfgCache;
  const cfg = { ...AI_DEFAULT_CFG };
  try {
    if (existsSync(AI_CONFIG_FILE)) {
      const raw = JSON.parse(readFileSync(AI_CONFIG_FILE, 'utf8')) || {};
      if (typeof raw.apiKey === 'string') cfg.apiKey = raw.apiKey;
      if (typeof raw.baseUrl === 'string' && raw.baseUrl) cfg.baseUrl = raw.baseUrl;
      if (typeof raw.model === 'string' && raw.model) cfg.model = raw.model;
    }
  } catch (e) {
    console.error('[AI] 读取 ai-config.json 失败:', e.message);
  }
  _aiCfgCache = cfg;
  _aiCfgCacheAt = now;
  return cfg;
}

// 保存部分配置字段（apiKey / baseUrl / model），立即生效，无需重启
function saveAiEndpointConfig(patch) {
  const cur = getAiEndpointConfig();
  const cfg = { apiKey: cur.apiKey, baseUrl: cur.baseUrl, model: cur.model, ...(patch || {}) };
  try {
    writeFileSync(AI_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('[AI] 写入 ai-config.json 失败:', e.message);
    throw e;
  }
  _aiCfgCache = cfg;
  _aiCfgCacheAt = Date.now();
  console.log('[AI] 配置已更新: model=' + cfg.model + ', baseUrl=' + cfg.baseUrl +
    ', key=' + (cfg.apiKey ? cfg.apiKey.slice(0, 8) + '...' : '(空)'));
  return cfg;
}

// 每次 buildEnv 时重建 AI 对象 → 配置改动后下一条消息即使用新 Key
function makeAIShim() {
  const cfg = getAiEndpointConfig();
  if (!cfg.apiKey || !cfg.baseUrl) return null;
  return {
    async run(model, options) {
      const live = getAiEndpointConfig();
      if (!live.apiKey || !live.baseUrl) throw new Error('AI 未配置：请先在管理面板填写 API Key 和地址');
      let messages;
      if (options.messages) {
        messages = options.messages;
      } else if (options.instructions) {
        messages = [{ role: 'system', content: options.instructions }];
        if (options.input && Array.isArray(options.input)) {
          for (const item of options.input) {
            messages.push({ role: item.role || 'user', content: item.content });
          }
        }
      } else {
        messages = [{ role: 'user', content: String(options) }];
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
      try {
        const resp = await fetch(`${String(live.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${live.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: live.model,
            messages,
            max_tokens: 1000,
            temperature: 0.3,
            stream: false
          }),
          signal: controller.signal
        });
        clearTimeout(timer);
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          throw new Error(`AI API ${resp.status}: ${text.slice(0, 200)}`);
        }
        return await resp.json();
      } catch (err) {
        clearTimeout(timer);
        throw err;
      }
    }
  };
}

const _bootCfg = getAiEndpointConfig();
if (_bootCfg.apiKey && _bootCfg.baseUrl) {
  console.log('[AI] AI shim 已启用, model=' + _bootCfg.model + ', baseUrl=' + _bootCfg.baseUrl);
} else {
  console.log('[AI] 未配置 API Key/地址, 请用 /panel → AI 智能功能 → 配置 API 设置');
}

// ─── env 对象 ──────────────────────────────────────────
function buildEnv() {
  return {
    TOKEN: process.env.TOKEN,
    BOT_TOKEN: process.env.BOT_TOKEN,
    GROUP_ID: process.env.GROUP_ID,
    AD_VOTE_THRESHOLD: process.env.AD_VOTE_THRESHOLD,
    AD_GROUP_RULES: process.env.AD_GROUP_RULES,
    AD_AI_MODEL: process.env.AD_AI_MODEL,
    AD_AI_TIMEOUT_MS: process.env.AD_AI_TIMEOUT_MS,
    KV,
    DB,
    AI: makeAIShim(),
    GET_AI_ENDPOINT: getAiEndpointConfig,
    SAVE_AI_ENDPOINT: saveAiEndpointConfig
  };
}

// ─── Web 面板 API ───────────────────────────────────────
const ADMIN_TOKEN = process.env.TOKEN || '';

function checkToken(url) {
  return url.searchParams.get('token') === ADMIN_TOKEN;
}

function jsonReply(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function handleApi(req, res, fullUrl, body) {
  const path = fullUrl.pathname;
  const tokenOk = checkToken(fullUrl);

  // /panel — 返回 HTML 面板
  if (path === '/panel') {
    if (!panelHtml) { res.writeHead(404); res.end('panel.html not found'); return true; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(panelHtml);
    return true;
  }

  // /api/* 需要 token 鉴权
  if (!path.startsWith('/api/')) return false;
  if (!tokenOk) { jsonReply(res, { error: '未授权' }, 401); return true; }

  // GET /api/overview — 概览统计
  if (path === '/api/overview' && req.method === 'GET') {
    const userCount = sqlite.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const messageCount = sqlite.prepare('SELECT COALESCE(SUM(message_count),0) as c FROM users').get().c;
    const warningCount = sqlite.prepare('SELECT COUNT(*) as c FROM users WHERE word_warnings > 0').get().c;
    const blacklistedCount = sqlite.prepare('SELECT COUNT(*) as c FROM users WHERE is_blacklisted = 1').get().c;
    jsonReply(res, { userCount, messageCount, warningCount, blacklistedCount });
    return true;
  }

  // GET /api/banned-words — 违禁词列表
  if (path === '/api/banned-words' && req.method === 'GET') {
    const row = sqlite.prepare("SELECT value FROM schema_meta WHERE key = 'banned_words_v1'").get();
    const words = row ? JSON.parse(row.value) : [];
    jsonReply(res, words);
    return true;
  }

  // POST /api/banned-words — 添加/删除违禁词
  if (path === '/api/banned-words' && req.method === 'POST') {
    const data = JSON.parse(body.toString());
    const row = sqlite.prepare("SELECT value FROM schema_meta WHERE key = 'banned_words_v1'").get();
    let words = row ? JSON.parse(row.value) : [];
    if (data.action === 'add') {
      if (!words.some(w => w.toLowerCase() === data.word.toLowerCase())) words.push(data.word);
    } else if (data.action === 'delete') {
      words = words.filter(w => w.toLowerCase() !== data.word.toLowerCase());
    }
    sqlite.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run('banned_words_v1', JSON.stringify(words));
    jsonReply(res, { success: true, words });
    return true;
  }

  // GET /api/warnings — 警告记录
  if (path === '/api/warnings' && req.method === 'GET') {
    const rows = sqlite.prepare('SELECT tgid, first_name, username, word_warnings, last_active_at FROM users WHERE word_warnings > 0 ORDER BY word_warnings DESC').all();
    jsonReply(res, rows);
    return true;
  }

  // POST /api/warnings — 清除警告
  if (path === '/api/warnings' && req.method === 'POST') {
    const data = JSON.parse(body.toString());
    if (data.action === 'clearAll') {
      sqlite.prepare('UPDATE users SET word_warnings = 0').run();
    } else if (data.action === 'clearUser' && data.tgid) {
      sqlite.prepare('UPDATE users SET word_warnings = 0 WHERE tgid = ?').run(data.tgid);
    }
    jsonReply(res, { success: true });
    return true;
  }

  // GET /api/blacklist — 联网黑名单
  if (path === '/api/blacklist' && req.method === 'GET') {
    const rows = sqlite.prepare('SELECT tgid, first_name, username, ban_reason, banned_at, banned_by FROM users WHERE is_blacklisted = 1 ORDER BY banned_at DESC').all();
    jsonReply(res, rows);
    return true;
  }

  // POST /api/blacklist — 移出黑名单
  if (path === '/api/blacklist' && req.method === 'POST') {
    const data = JSON.parse(body.toString());
    if (data.action === 'remove' && data.tgid) {
      sqlite.prepare('UPDATE users SET is_blacklisted = 0, ban_reason = ?, banned_at = 0, banned_by = ? WHERE tgid = ?').run('', '', data.tgid);
    }
    jsonReply(res, { success: true });
    return true;
  }

  // GET /api/settings — 读取设置
  if (path === '/api/settings' && req.method === 'GET') {
    jsonReply(res, {
      warningLimit: 3,
      autoDeleteDelay: 20,
      groupId: process.env.GROUP_ID || '',
      botToken: process.env.BOT_TOKEN ? '已配置' : '未配置',
      webhookUrl: 'https://unban.zhiaon.top/',
      aiEnabled: !!process.env.DEEPSEEK_API_KEY
    });
    return true;
  }

  jsonReply(res, { error: '未知接口' }, 404);
  return true;
}

// ─── HTTP 服务器 ────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  try {
    // 构造完整 URL (考虑 X-Forwarded-Proto)
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host || `localhost:${PORT}`;
    const fullUrl = new URL(req.url, `${protocol}://${host}`);

    // 读取请求体
    let body = null;
    if (req.method === 'POST' || req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks);
    }

    // Web 面板 / API 路由拦截
    const handled = await handleApi(req, res, fullUrl, body);
    if (handled) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} → API (${Date.now() - startTime}ms)`);
      return;
    }

    // 构造 Web Request
    const init = { method: req.method, headers: req.headers };
    if (body && body.length > 0) init.body = body;
    const request = new Request(fullUrl, init);

    // 调用 Worker
    const env = buildEnv();
    const ctx = { waitUntil(p) { p.catch(() => {}); }, passThroughOnException() {} };
    const response = await worker.fetch(request, env, ctx);

    // 提取响应
    const respBody = await response.text();
    const respHeaders = {};
    response.headers.forEach((v, k) => { respHeaders[k] = v; });

    res.writeHead(response.status, respHeaders);
    res.end(respBody);

    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} → ${response.status} (${Date.now() - startTime}ms)`);
  } catch (error) {
    console.error('[server] Error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, error: 'Internal Server Error', message: error.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[server] TG Unban Bot 已启动, 监听 http://127.0.0.1:${PORT}`);
  console.log(`[server] 数据库: ${DB_PATH}`);
  console.log(`[server] BOT_TOKEN: ${process.env.BOT_TOKEN ? '已配置' : '未配置'}`);
  console.log(`[server] GROUP_ID: ${process.env.GROUP_ID || '未配置'}`);
  console.log(`[server] TOKEN (init): ${process.env.TOKEN ? '已配置' : '未配置'}`);
});

// 优雅退出
process.on('SIGTERM', () => { console.log('[server] SIGTERM, 关闭中...'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { console.log('[server] SIGINT, 关闭中...'); server.close(() => process.exit(0)); });
