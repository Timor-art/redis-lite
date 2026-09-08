import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@redis/client';
import { demoCommand } from './demo.mjs';

const PUBLIC = new URL('./public/', import.meta.url);
const sessions = new Map();
const TTL = 30 * 60_000;
const PREVIEW = 16 * 1024;
const PAGE = 100;
class AppError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const integer = (v, min, max, fallback) => {
  const n = v === undefined || v === '' ? fallback : Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new AppError('数字参数超出允许范围');
  return n;
};
function close(session) { if (session?.client?.isOpen) session.client.destroy(); }
async function deadline(promise, session) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => { close(session); reject(new AppError('Redis 请求超时，请重新连接', 504)); }, 5000);
  })]); } finally { clearTimeout(timer); }
}
function preview(value) {
  const bytes = Buffer.from(String(value ?? ''));
  return { text: bytes.subarray(0, PREVIEW).toString('utf8'), truncated: bytes.length > PREVIEW };
}
function cursor(value = '0') {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) throw new AppError('无效的扫描游标');
  return value;
}
async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > 65536) throw new AppError('请求过大', 413);
  }
  try { return JSON.parse(data || '{}'); } catch { throw new AppError('请求格式错误'); }
}
function json(res, value, status = 200) {
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > 2 * 1024 * 1024) throw new AppError('本批数据超过 2 MB，请缩小搜索范围或使用专用客户端读取', 413);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}
async function api(req, res, path) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=')));
  let id = cookies.redis_lite;
  let session = sessions.get(id);
  if (!session) {
    if (sessions.size >= 100) throw new AppError('会话数已达上限，请稍后重试', 503);
    id = randomBytes(24).toString('hex');
    session = { touched: Date.now(), client: null, demo: false, config: null, busy: false };
    sessions.set(id, session);
    res.setHeader('Set-Cookie', `redis_lite=${id}; HttpOnly; SameSite=Strict; Path=/`);
  }
  session.touched = Date.now();
  if (path === '/api/status' && req.method === 'GET') {
    return json(res, { connected: session.demo || !!session.client?.isReady, config: session.config });
  }
  if (req.method !== 'POST') throw new AppError('不支持此请求', 405);
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new AppError('需要 JSON 请求', 415);
  if (session.busy) throw new AppError('上一个请求尚未完成，请稍后再试', 409);
  session.busy = true;
  try {
    const input = await body(req);
    if (path === '/api/disconnect') {
      close(session); session.client = null; session.demo = false; session.config = null;
      return json(res, { ok: true });
    }
    if (path === '/api/connect') {
      const demo = input.demo === true;
      let next;
      const config = demo ? { name: '演示工作区', host: 'demo', port: 6379, db: 0, databaseCount: 16, demo: true } : {
        name: String(input.name || 'Redis').slice(0, 80), host: String(input.host || '127.0.0.1').trim(),
        port: integer(input.port, 1, 65535, 6379), db: integer(input.db, 0, 1024, 0), tls: input.tls === true,
        username: String(input.username || ''), demo: false
      };
      if (!demo) {
        if (!config.host || /[\s/@]/.test(config.host)) throw new AppError('请填写主机地址，不要包含协议或密码');
        // RESP2 keeps raw collection replies flat across client versions.
        next = createClient({ RESP: 2, socket: { host: config.host, port: config.port, tls: config.tls,
          connectTimeout: 4000, reconnectStrategy: false }, database: config.db,
          username: config.username || undefined, password: input.password ? String(input.password) : undefined,
          disableOfflineQueue: true });
        next.on('error', () => {});
        try {
          await deadline(next.connect(), { client: next });
          await deadline(next.ping(), { client: next });
          // Managed services and read-only ACLs may deny CONFIG; selection still works.
          try {
            const reply = await deadline(next.sendCommand(['CONFIG', 'GET', 'databases']), { client: next });
            const count = Number(reply[1]);
            config.databaseCount = Number.isSafeInteger(count) && count > 0 ? count : null;
          } catch (error) {
            if (!next.isReady) throw error;
            config.databaseCount = null;
          }
        }
        catch (error) { close({ client: next }); throw error; }
      }
      close(session); session.client = next || null; session.demo = demo; session.config = config;
      return json(res, { connected: true, config });
    }
    if (!session.demo && !session.client?.isReady) throw new AppError('连接已断开，请重新连接', 401);
    const cmd = async (...args) => session.demo ? demoCommand(args, session.config.db) : deadline(session.client.sendCommand(args), session);
    if (path === '/api/select-db') {
      const db = integer(input.db, 0, 1024);
      if (session.config.databaseCount && db >= session.config.databaseCount) throw new AppError('数据库编号超出当前实例范围');
      if (!session.demo) await cmd('SELECT', String(db));
      // Update state only after SELECT succeeds; errors preserve the previous DB.
      session.config = { ...session.config, db };
      return json(res, { config: session.config });
    }
    if (path === '/api/scan') {
      const pattern = String(input.pattern || '*');
      if (pattern.length > 1024) throw new AppError('搜索条件过长');
      const [next, keys] = await cmd('SCAN', cursor(input.cursor), 'MATCH', pattern, 'COUNT', '100');
      return json(res, { cursor: String(next), keys: [...new Set(keys)] });
    }
    if (path === '/api/value') {
      if (typeof input.key !== 'string') throw new AppError('缺少 Key');
      const key = input.key;
      const type = await cmd('TYPE', key);
      if (type === 'none') throw new AppError('这个 Key 已过期或被删除', 404);
      const ttl = await cmd('TTL', key);
      const offset = integer(input.offset, 0, Number.MAX_SAFE_INTEGER - PAGE, 0);
      let size = 0, rows = [], next = '0', value = null;
      if (type === 'string') {
        size = await cmd('STRLEN', key);
        value = preview(await cmd('GETRANGE', key, '0', String(PREVIEW - 1)));
        value.truncated ||= size > PREVIEW;
      } else if (type === 'hash' || type === 'set') {
        size = await cmd(type === 'hash' ? 'HLEN' : 'SCARD', key);
        const result = await cmd(type === 'hash' ? 'HSCAN' : 'SSCAN', key, cursor(input.cursor), 'COUNT', '100');
        next = String(result[0]);
        const items = result[1];
        rows = type === 'hash'
          ? Array.from({ length: items.length / 2 }, (_, i) => ({ label: items[i * 2], ...preview(items[i * 2 + 1]) }))
          : items.map(item => ({ ...preview(item) }));
      } else if (type === 'list' || type === 'zset') {
        size = await cmd(type === 'list' ? 'LLEN' : 'ZCARD', key);
        const args = [type === 'list' ? 'LRANGE' : 'ZRANGE', key, String(offset), String(offset + PAGE - 1)];
        if (type === 'zset') args.push('WITHSCORES');
        const items = await cmd(...args);
        rows = type === 'list' ? items.map((item, i) => ({ label: String(offset + i), ...preview(item) }))
          : Array.from({ length: items.length / 2 }, (_, i) => ({ label: items[i * 2 + 1], ...preview(items[i * 2]) }));
        next = offset + PAGE < size ? String(offset + PAGE) : '0';
      } else { return json(res, { key, type, ttl, unsupported: true }); }
      // A key can disappear between the metadata and value reads.
      if (await cmd('TYPE', key) === 'none') throw new AppError('这个 Key 已过期或被删除', 404);
      return json(res, { key, type, ttl, size, rows, value, cursor: next });
    }
    throw new AppError('接口不存在', 404);
  } finally { session.busy = false; }
}
export function createServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const expected = `127.0.0.1:${server.address().port}`;
      const allowed = [expected, `localhost:${server.address().port}`];
      if (!allowed.includes(req.headers.host)) throw new AppError('不允许的主机名', 403);
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new AppError('不允许跨站访问', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('不允许跨站访问', 403);
      const path = new URL(req.url, `http://${expected}`).pathname;
      if (path.startsWith('/api/')) return await api(req, res, path);
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (!files[path] || req.method !== 'GET') throw new AppError('页面不存在', 404);
      const [file, mime] = files[path];
      const data = await readFile(new URL(file, PUBLIC));
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); res.end(data);
    } catch (error) {
      let message = error.message;
      if (/WRONGPASS|AUTH/.test(message)) message = '认证失败，请检查用户名和密码';
      else if (/ECONNREFUSED/.test(message)) message = '连接被拒绝，请检查 Redis 地址、端口及运行状态';
      else if (/ENOTFOUND/.test(message)) message = '主机名无法解析，请检查地址';
      else if (/WRONGTYPE/.test(message)) message = 'Key 类型已发生变化，请刷新后重试';
      else if (/MOVED|ASK /.test(message)) message = '当前版本不支持 Redis Cluster，请使用单机连接';
      json(res, { error: String(message).slice(0, 400) }, error.status || 400);
    }
  });
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions) if (!session.busy && Date.now() - session.touched > TTL) { close(session); sessions.delete(id); }
  }, 60_000).unref();
  server.on('close', () => { clearInterval(cleanup); for (const s of sessions.values()) close(s); sessions.clear(); });
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = integer(process.env.PORT, 1, 65535, 6380);
  const server = createServer();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用，可用 PORT=6381 npm start 更换端口` : error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Redis Lite 已启动：http://127.0.0.1:${port}\n按 Ctrl+C 停止服务`));
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
