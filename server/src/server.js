// Officeline 云后端(MVP)— 零外部依赖:node:http + node:sqlite + node:crypto
// 功能:账号/订阅配额、文件云存档(带版本历史)、ONLYOFFICE 编辑集成、AI 代理(DeepSeek 兼容)
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.OFFICELINE_PORT || 9130);
// 浏览器访问 Document Server 的地址
const DS_PUBLIC = process.env.OFFICELINE_DS_PUBLIC || 'http://localhost:8080';
// Document Server(容器内)回访本服务的地址
const SELF_FOR_DS = process.env.OFFICELINE_SELF_FOR_DS || `http://host.docker.internal:${PORT}`;
// AI 配置:默认 DeepSeek(便宜),OpenAI 兼容协议,不设 key 时返回演示回复
const AI_BASE = process.env.OFFICELINE_AI_BASE || 'https://api.deepseek.com';
const AI_MODEL = process.env.OFFICELINE_AI_MODEL || 'deepseek-chat';
const AI_KEY = process.env.OFFICELINE_AI_KEY || '';

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const FILES_DIR = path.join(DATA, 'files');
const PUBLIC_DIR = path.join(ROOT, 'public');
const TPL_DIR = path.join(ROOT, 'templates');
fs.mkdirSync(FILES_DIR, { recursive: true });

// ---------- 密钥(首次启动生成,持久化) ----------
const secretFile = path.join(DATA, 'secret.key');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

// ---------- 数据库 ----------
const db = new DatabaseSync(path.join(DATA, 'officeline.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    pass TEXT NOT NULL, salt TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    current_version INTEGER NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS versions (
    file_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (file_id, version)
  );
`);

const PLANS = { free: { name: '免费版', quota: 2 * 1024 ** 3 }, pro: { name: '专业版', quota: 100 * 1024 ** 3 } };

// ---------- 工具 ----------
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const now = () => Date.now();

function makeToken(uid, email) {
  const payload = b64u(JSON.stringify({ uid, email, exp: now() + 30 * 86400e3 }));
  return `${payload}.${hmac(payload)}`;
}
function verifyToken(token) {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || hmac(payload) !== sig) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (p.exp < now()) return null;
    return p;
  } catch { return null; }
}
// 供 Document Server 免登录取文件/回调用的短签名
const dlToken = (fileId) => hmac(`dl:${fileId}`).slice(0, 24);

function hashPass(pass, salt) {
  return crypto.scryptSync(pass, salt, 32).toString('hex');
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function auth(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : new URL(req.url, 'http://x').searchParams.get('token');
  return verifyToken(token);
}

function usedBytes(uid) {
  const r = db.prepare(`SELECT COALESCE(SUM(v.size),0) AS s FROM versions v JOIN files f ON f.id=v.file_id WHERE f.owner_id=? AND f.deleted=0`).get(uid);
  return Number(r.s);
}

const EXT_TYPE = { docx: 'word', xlsx: 'cell', pptx: 'slide' };
const filePath = (id, v) => path.join(FILES_DIR, id, `v${v}${path.extname(db.prepare('SELECT name FROM files WHERE id=?').get(id).name)}`);

function saveVersion(fileId, buf) {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(fileId);
  const v = f.current_version + 1;
  fs.writeFileSync(path.join(FILES_DIR, fileId, `v${v}${path.extname(f.name)}`), buf);
  db.prepare('INSERT INTO versions (file_id, version, size, created_at) VALUES (?,?,?,?)').run(fileId, v, buf.length, now());
  db.prepare('UPDATE files SET current_version=?, updated_at=? WHERE id=?').run(v, now(), fileId);
  return v;
}

function createFile(uid, name, buf) {
  const id = crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(path.join(FILES_DIR, id), { recursive: true });
  db.prepare('INSERT INTO files (id, owner_id, name, current_version, updated_at) VALUES (?,?,?,1,?)').run(id, uid, name, now());
  fs.writeFileSync(path.join(FILES_DIR, id, `v1${path.extname(name)}`), buf);
  db.prepare('INSERT INTO versions (file_id, version, size, created_at) VALUES (?,1,?,?)').run(id, buf.length, now());
  return id;
}

// ---------- AI ----------
const AI_PROMPTS = {
  polish: '你是专业中文编辑。请润色下面的文字,保持原意,输出润色后的全文,不要解释:',
  summarize: '请用简洁的中文总结下面的内容,输出要点列表:',
  translate: '请将下面的内容翻译成英文(若已是英文则翻译成中文),只输出译文:',
  formula: '你是电子表格专家。用户描述一个计算需求,请给出可直接粘贴的公式(以=开头)并用一句话说明。需求:',
};
async function aiChat(action, text) {
  const sys = AI_PROMPTS[action] || '你是办公助手,请帮助用户处理以下内容:';
  if (!AI_KEY) {
    return `【演示模式】未配置 AI 密钥。设置环境变量 OFFICELINE_AI_KEY(DeepSeek API Key,约 ¥1/百万token)后即为真实 AI 输出。\n\n请求类型:${action}\n输入长度:${text.length} 字`;
  }
  const r = await fetch(`${AI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${AI_KEY}` },
    body: JSON.stringify({ model: AI_MODEL, messages: [{ role: 'user', content: `${sys}\n\n${text}` }], max_tokens: 2000 }),
  });
  if (!r.ok) throw new Error(`AI 服务返回 ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.choices[0].message.content;
}

// ---------- 编辑器页面 ----------
function editorHtml(f, user) {
  const ext = path.extname(f.name).slice(1);
  const cfg = {
    document: {
      fileType: ext,
      key: `${f.id}-v${f.current_version}`,
      title: f.name,
      url: `${SELF_FOR_DS}/api/files/${f.id}/raw?v=${f.current_version}&t=${dlToken(f.id)}`,
      permissions: { edit: true, download: true },
    },
    documentType: EXT_TYPE[ext] || 'word',
    editorConfig: {
      lang: 'zh-CN',
      callbackUrl: `${SELF_FOR_DS}/onlyoffice/callback/${f.id}?t=${dlToken(f.id)}`,
      user: { id: String(user.uid), name: user.email.split('@')[0] },
      customization: { autosave: true, forcesave: true, compactHeader: true },
    },
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>${f.name} — Officeline</title>
<style>html,body,#editor{margin:0;padding:0;height:100%;width:100%;overflow:hidden}</style></head>
<body><div id="editor"></div>
<script src="${DS_PUBLIC}/web-apps/apps/api/documents/api.js"></script>
<script>new DocsAPI.DocEditor("editor", Object.assign(${JSON.stringify(cfg)}, {width:"100%",height:"100%"}));</script>
</body></html>`;
}

// ---------- 路由 ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('POST', /^\/api\/auth\/(register|login)$/, async (req, res, m) => {
  const { email, password } = JSON.parse(await readBody(req, 1e4));
  if (!email || !password || password.length < 6) return json(res, 400, { error: '邮箱或密码不合法(密码至少6位)' });
  const existing = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (m[1] === 'register') {
    if (existing) return json(res, 409, { error: '该邮箱已注册' });
    const salt = crypto.randomBytes(16).toString('hex');
    const r = db.prepare('INSERT INTO users (email, pass, salt, created_at) VALUES (?,?,?,?)').run(email, hashPass(password, salt), salt, now());
    return json(res, 200, { token: makeToken(Number(r.lastInsertRowid), email), email });
  }
  if (!existing || hashPass(password, existing.salt) !== existing.pass) return json(res, 401, { error: '邮箱或密码错误' });
  json(res, 200, { token: makeToken(existing.id, email), email });
});

route('GET', /^\/api\/me$/, (req, res) => {
  const u = auth(req); if (!u) return json(res, 401, { error: '未登录' });
  const row = db.prepare('SELECT plan FROM users WHERE id=?').get(u.uid);
  const plan = PLANS[row.plan] ? row.plan : 'free';
  json(res, 200, { email: u.email, plan, planName: PLANS[plan].name, used: usedBytes(u.uid), quota: PLANS[plan].quota });
});

// 订阅升级(支付接入前的占位:真实上线接 Paddle/LemonSqueezy/微信支付)
route('POST', /^\/api\/billing\/upgrade$/, (req, res) => {
  const u = auth(req); if (!u) return json(res, 401, { error: '未登录' });
  db.prepare("UPDATE users SET plan='pro' WHERE id=?").run(u.uid);
  json(res, 200, { ok: true, note: '演示:已直接升级为专业版。上线前在此处接入支付回调。' });
});

route('GET', /^\/api\/files$/, (req, res) => {
  const u = auth(req); if (!u) return json(res, 401, { error: '未登录' });
  const rows = db.prepare(`SELECT f.id, f.name, f.current_version, f.updated_at, v.size
    FROM files f JOIN versions v ON v.file_id=f.id AND v.version=f.current_version
    WHERE f.owner_id=? AND f.deleted=0 ORDER BY f.updated_at DESC`).all(u.uid);
  json(res, 200, { files: rows });
});

// 新建空白文档
route('POST', /^\/api\/files\/new$/, async (req, res) => {
  const u = auth(req); if (!u) return json(res, 401, { error: '未登录' });
  const { name, type } = JSON.parse(await readBody(req, 1e4));
  if (!['docx', 'xlsx', 'pptx'].includes(type)) return json(res, 400, { error: '类型不支持' });
  const buf = fs.readFileSync(path.join(TPL_DIR, `blank.${type}`));
  const id = createFile(u.uid, `${(name || '未命名').replace(/[\/\\]/g, '')}.${type}`, buf);
  json(res, 200, { id });
});

// 上传(raw body,x-file-name 头传文件名)
route('POST', /^\/api\/files$/, async (req, res) => {
  const u = auth(req); if (!u) return json(res, 401, { error: '未登录' });
  const name = decodeURIComponent(req.headers['x-file-name'] || '').replace(/[\/\\]/g, '');
  if (!/\.(docx|xlsx|pptx)$/i.test(name)) return json(res, 400, { error: '仅支持 docx/xlsx/pptx' });
  const buf = await readBody(req);
  const plan = db.prepare('SELECT plan FROM users WHERE id=?').get(u.uid).plan;
  if (usedBytes(u.uid) + buf.length > (PLANS[plan] || PLANS.free).quota) {
    return json(res, 402, { error: '云空间已满,请升级订阅', code: 'QUOTA_EXCEEDED' });
  }
  json(res, 200, { id: createFile(u.uid, name, buf) });
});

// Document Server / 客户端下载文件内容
route('GET', /^\/api\/files\/([0-9a-f]+)\/raw$/, (req, res, m) => {
  const url = new URL(req.url, 'http://x');
  const f = db.prepare('SELECT * FROM files WHERE id=? AND deleted=0').get(m[1]);
  if (!f) return json(res, 404, { error: '文件不存在' });
  const ok = url.searchParams.get('t') === dlToken(f.id) || (auth(req) || {}).uid === f.owner_id;
  if (!ok) return json(res, 403, { error: '无权限' });
  const v = Number(url.searchParams.get('v')) || f.current_version;
  const p = filePath(f.id, v);
  if (!fs.existsSync(p)) return json(res, 404, { error: '版本不存在' });
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
  });
  fs.createReadStream(p).pipe(res);
});

route('GET', /^\/api\/files\/([0-9a-f]+)\/versions$/, (req, res, m) => {
  const u = auth(req); if (!u) return json(res, 401, { error: '未登录' });
  const f = db.prepare('SELECT * FROM files WHERE id=? AND owner_id=? AND deleted=0').get(m[1], u.uid);
  if (!f) return json(res, 404, { error: '文件不存在' });
  const rows = db.prepare('SELECT version, size, created_at FROM versions WHERE file_id=? ORDER BY version DESC').all(f.id);
  json(res, 200, { current: f.current_version, versions: rows });
});

// 恢复历史版本(复制为新版本,不破坏历史)
route('POST', /^\/api\/files\/([0-9a-f]+)\/restore$/, async (req, res, m) => {
  const u = auth(req); if (!u) return json(res, 401, { error: '未登录' });
  const { version } = JSON.parse(await readBody(req, 1e4));
  const f = db.prepare('SELECT * FROM files WHERE id=? AND owner_id=? AND deleted=0').get(m[1], u.uid);
  if (!f) return json(res, 404, { error: '文件不存在' });
  const p = filePath(f.id, Number(version));
  if (!fs.existsSync(p)) return json(res, 404, { error: '版本不存在' });
  const v = saveVersion(f.id, fs.readFileSync(p));
  json(res, 200, { ok: true, version: v });
});

route('DELETE', /^\/api\/files\/([0-9a-f]+)$/, (req, res, m) => {
  const u = auth(req); if (!u) return json(res, 401, { error: '未登录' });
  const r = db.prepare('UPDATE files SET deleted=1 WHERE id=? AND owner_id=?').run(m[1], u.uid);
  json(res, 200, { ok: r.changes > 0 });
});

// ONLYOFFICE 保存回调:status 2=编辑结束待保存 6=强制保存
route('POST', /^\/onlyoffice\/callback\/([0-9a-f]+)$/, async (req, res, m) => {
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('t') !== dlToken(m[1])) return json(res, 403, { error: 0 });
  const body = JSON.parse((await readBody(req, 1e6)).toString() || '{}');
  if ((body.status === 2 || body.status === 6) && body.url) {
    // DS 给的地址是容器可达地址;从宿主机取要换成映射端口
    const dlUrl = body.url.replace('http://localhost/', `${DS_PUBLIC}/`).replace(':80/', ':8080/');
    const r = await fetch(dlUrl);
    if (r.ok) {
      const v = saveVersion(m[1], Buffer.from(await r.arrayBuffer()));
      console.log(`[save] file=${m[1]} -> v${v} (status=${body.status})`);
    } else {
      console.error(`[save] 下载失败 ${r.status} ${dlUrl}`);
    }
  }
  json(res, 200, { error: 0 });
});

// 编辑器页面
route('GET', /^\/editor\/([0-9a-f]+)$/, (req, res, m) => {
  const u = auth(req); if (!u) { res.writeHead(302, { location: '/' }); return res.end(); }
  const f = db.prepare('SELECT * FROM files WHERE id=? AND owner_id=? AND deleted=0').get(m[1], u.uid);
  if (!f) return json(res, 404, { error: '文件不存在' });
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(editorHtml(f, u));
});

// AI 助手
route('POST', /^\/api\/ai$/, async (req, res) => {
  const u = auth(req); if (!u) return json(res, 401, { error: '未登录' });
  const { action, text } = JSON.parse(await readBody(req, 1e6));
  if (!text || !text.trim()) return json(res, 400, { error: '内容为空' });
  try {
    json(res, 200, { result: await aiChat(action, text.slice(0, 20000)) });
  } catch (e) {
    json(res, 502, { error: String(e.message) });
  }
});

// 静态文件
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveStatic(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  const file = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p.replace(/\.\./g, ''));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  try {
    for (const r of routes) {
      const m = r.method === req.method && pathname.match(r.pattern);
      if (m) return await r.handler(req, res, m);
    }
    if (req.method === 'GET') return serveStatic(req, res);
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(`[error] ${req.method} ${pathname}:`, e.message);
    if (!res.headersSent) json(res, 500, { error: '服务器内部错误' });
  }
}).listen(PORT, () => console.log(`Officeline server ready on http://localhost:${PORT}`));
