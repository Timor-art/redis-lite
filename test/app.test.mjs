import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createServer } from '../server.mjs';
import { createClient } from '@redis/client';

let server, base, cookie = '', redisProcess, redis, redisPort;
async function request(path, input, headers = {}, useCookie = true) {
  const response = await fetch(`${base}/api/${path}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { ...(useCookie && cookie ? { Cookie: cookie } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: input === undefined ? undefined : JSON.stringify(input)
  });
  if (useCookie && response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return { status: response.status, body: await response.json() };
}
before(async () => {
  server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (redis?.isOpen) redis.destroy();
  if (redisProcess?.pid && redisProcess.exitCode === null && redisProcess.signalCode === null) { const exited = once(redisProcess, 'exit'); redisProcess.kill('SIGTERM'); await exited; }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
});
test('static page, local host and cross-origin boundary', async () => {
  const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /Redis Lite/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const rejectedHost = await new Promise((resolve, reject) => {
    http.get(`${base}/api/status`, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(rejectedHost, 403);
  assert.equal((await request('connect', { demo: true }, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await request('connect', { demo: true }, { 'Content-Type': 'text/plain' })).status, 415);
});
test('demo mode, filtering, five data types, missing keys and session isolation', async () => {
  assert.equal((await request('connect', { demo: true })).status, 200);
  const result = await request('scan', { pattern: 'user:*' }); assert.deepEqual(result.body.keys, ['user:10001', 'user:10002']);
  for (const [key, type] of [['app:config', 'string'], ['user:10001', 'hash'], ['queue:tasks', 'list'], ['users:online', 'set'], ['leaderboard:weekly', 'zset']]) {
    const value = await request('value', { key }); assert.equal(value.status, 200); assert.equal(value.body.type, type); assert.ok(value.body.size > 0);
  }
  assert.equal((await request('value', { key: 'missing' })).status, 404);
  assert.equal((await request('scan', { cursor: '-1' })).status, 400);
  assert.equal((await request('scan', {}, {}, false)).status, 401);
  assert.equal((await request('select-db', { db: 1 })).body.config.db, 1);
  assert.deepEqual((await request('scan', {})).body.keys, []);
  assert.equal((await request('value', { key: 'app:config' })).status, 404);
  assert.equal((await request('select-db', { db: 0 })).body.config.db, 0);
  assert.equal((await request('select-db', { db: -1 })).status, 400);
  assert.equal((await request('select-db', {})).status, 400);
});
test('failed replacement preserves current connection; disconnect releases it', async () => {
  assert.equal((await request('connect', { port: -1 })).status, 400);
  assert.equal((await request('status')).body.connected, true);
  assert.equal((await request('disconnect', {})).status, 200);
  assert.equal((await request('status')).body.connected, false);
});
test('real Redis: authentication, DB selection, cursors, previews, pagination and expiry', { skip: !process.env.REDIS_SERVER, timeout: 30000 }, async () => {
  // Starts an isolated process with persistence disabled. Never uses a user's Redis.
  const net = await import('node:net');
  const portProbe = net.createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening'); redisPort = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  redisProcess = spawn(process.env.REDIS_SERVER, ['--bind', '127.0.0.1', '--port', String(redisPort), '--save', '', '--appendonly', 'no', '--requirepass', 'redis-lite-test-only'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Redis startup timeout')), 10000);
    redisProcess.once('error', error => { clearTimeout(timer); reject(error); });
    redisProcess.once('exit', code => { clearTimeout(timer); reject(new Error(`Redis exited: ${code}`)); });
    redisProcess.stdout.on('data', chunk => { if (chunk.toString().includes('Ready to accept connections')) { clearTimeout(timer); resolve(); } });
  });
  redis = createClient({ socket: { host: '127.0.0.1', port: redisPort, reconnectStrategy: false }, password: 'redis-lite-test-only', database: 2 });
  redis.on('error', () => {}); await redis.connect();
  const write = (...args) => redis.sendCommand(args);
  await write('SET', 'test:string', JSON.stringify({ hello: '你好', count: 1 }));
  await write('SET', 'test:large', 'x'.repeat(40000));
  await write('SET', 'test:ttl', 'expires', 'EX', '60');
  await write('SET', '', 'empty-key');
  await write('HSET', 'test:hash', 'name', 'Alex', 'value', '<script>alert(1)</script>');
  await write('RPUSH', 'test:list', ...Array.from({ length: 205 }, (_, i) => `item-${i}`));
  await write('SADD', 'test:set', 'alpha', 'beta');
  await write('ZADD', 'test:zset', '1', 'a', '2', 'b');
  await write('XADD', 'test:stream', '*', 'name', 'unsupported');
  await Promise.all(Array.from({ length: 250 }, (_, i) => write('SET', `page:${i}`, String(i))));
  assert.equal((await request('connect', { port: redisPort, password: 'incorrect', db: 2 })).status, 400);
  const connection = await request('connect', { name: 'Test', port: redisPort, password: 'redis-lite-test-only', db: 2 });
  assert.equal(connection.status, 200); assert.equal(connection.body.config.db, 2); assert.equal('password' in connection.body.config, false);
  assert.equal(connection.body.config.databaseCount, 16);
  await write('SELECT', '7'); await write('SET', 'only:db7', 'separate database'); await write('SELECT', '2');
  assert.equal((await request('select-db', { db: 7 })).body.config.db, 7);
  assert.equal((await request('value', { key: 'test:string' })).status, 404);
  assert.equal((await request('value', { key: 'only:db7' })).body.value.text, 'separate database');
  assert.equal((await request('select-db', { db: 99 })).status, 400);
  assert.equal((await request('status')).body.config.db, 7);
  assert.equal((await request('select-db', { db: 2 })).body.config.db, 2);
  let cursor = '0', seen = new Set(), calls = 0;
  do { const result = await request('scan', { cursor, pattern: 'page:*' }); assert.equal(result.status, 200); cursor = result.body.cursor; result.body.keys.forEach(key => seen.add(key)); calls++; assert.ok(calls < 30); } while (cursor !== '0');
  assert.equal(seen.size, 250); assert.ok(calls > 1);
  const large = await request('value', { key: 'test:large' }); assert.equal(large.body.size, 40000); assert.equal(large.body.value.text.length, 16384); assert.equal(large.body.value.truncated, true);
  assert.equal((await request('value', { key: '' })).body.value.text, 'empty-key');
  const first = await request('value', { key: 'test:list' }); assert.equal(first.body.rows.length, 100); assert.equal(first.body.cursor, '100');
  const last = await request('value', { key: 'test:list', offset: 200 }); assert.equal(last.body.rows.length, 5); assert.equal(last.body.cursor, '0'); assert.equal(last.body.rows[0].label, '200');
  assert.equal((await request('value', { key: 'test:hash' })).body.rows.length, 2);
  assert.equal((await request('value', { key: 'test:set' })).body.rows.length, 2);
  assert.equal((await request('value', { key: 'test:zset' })).body.rows[1].label, '2');
  assert.equal((await request('value', { key: 'test:stream' })).body.unsupported, true);
  assert.ok((await request('value', { key: 'test:ttl' })).body.ttl > 0);
  await write('PEXPIRE', 'test:ttl', '1'); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await request('value', { key: 'test:ttl' })).status, 404);
  // CONFIG is optional: a restricted user can still switch DBs with SELECT.
  await write('ACL', 'SETUSER', 'viewer', 'on', '>redis-lite-viewer-test', '~*', '+@read', '+ping', '+select', '+hello', '+client');
  const restricted = await request('connect', { port: redisPort, username: 'viewer', password: 'redis-lite-viewer-test', db: 2 });
  assert.equal(restricted.status, 200); assert.equal(restricted.body.config.databaseCount, null);
  assert.equal((await request('select-db', { db: 7 })).status, 200);
  assert.equal((await request('select-db', { db: 99 })).status, 400);
  assert.equal((await request('status')).body.config.db, 7);
  assert.equal((await request('value', { key: 'only:db7' })).body.value.text, 'separate database');
  await request('disconnect', {});
});
