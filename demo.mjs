// Isolated sample data: demo mode never opens a Redis connection.
const data = new Map([
  ['app:config', ['string', JSON.stringify({ app: 'Redis Lite', environment: 'development', featureFlags: { darkMode: false, notifications: true }, updatedAt: '2026-09-08T09:30:00+08:00' })]],
  ['app:version', ['string', '1.4.2']],
  ['cache:home:banner', ['string', JSON.stringify({ title: 'Keep it simple.', subtitle: 'Small tools. Clear thinking.', enabled: true })]],
  ['cache:product:1001', ['string', JSON.stringify({ id: 1001, name: '机械键盘', price: 399, inventory: 128 })]],
  ['queue:notifications', ['list', ['欢迎使用 Redis Lite', '你的导出任务已完成', '今天也是高效的一天']]],
  ['queue:tasks', ['list', ['sync-products', 'refresh-cache', 'send-digest']]],
  ['session:demo-user', ['hash', { userId: '10001', name: 'Alex', role: 'developer', lastSeen: '2026-09-08 09:30:00' }]],
  ['stats:daily:visitors', ['string', '24809']],
  ['tags:popular', ['set', ['redis', 'database', 'development', 'lightweight', 'local-first']]],
  ['user:10001', ['hash', { name: 'Alex Chen', email: 'alex@example.com', language: 'zh-CN', theme: 'light' }]],
  ['user:10002', ['hash', { name: 'Sam', email: 'sam@example.com', language: 'en' }]],
  ['users:online', ['set', ['10001', '10002', '10008', '10016']]],
  ['leaderboard:weekly', ['zset', [['alex', '128'], ['sam', '256'], ['jordan', '512']]]],
]);
export function demoCommand([command, key, ...args], db = 0) {
  if (db !== 0) {
    if (command === 'SCAN') return ['0', []];
    if (command === 'TYPE') return 'none';
    throw new Error('演示数据库为空');
  }
  if (command === 'SCAN') {
    const pattern = args[1];
    const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.') + '$');
    return ['0', [...data.keys()].filter(k => regex.test(k))];
  }
  const entry = data.get(key);
  if (command === 'TYPE') return entry?.[0] || 'none';
  if (command === 'TTL') return key.startsWith('cache:') || key.startsWith('session:') ? 3580 : -1;
  const value = entry?.[1];
  if (command === 'STRLEN') return Buffer.byteLength(value);
  if (command === 'GETRANGE') return Buffer.from(value).subarray(Number(args[0]), Number(args[1]) + 1).toString();
  if (command === 'HLEN') return Object.keys(value).length;
  if (['SCARD', 'LLEN', 'ZCARD'].includes(command)) return value.length;
  if (command === 'HSCAN') return ['0', Object.entries(value).flat()];
  if (command === 'SSCAN') return ['0', value];
  if (command === 'LRANGE') return value.slice(Number(args[0]), Number(args[1]) + 1);
  if (command === 'ZRANGE') return value.slice(Number(args[0]), Number(args[1]) + 1).flat();
  throw new Error('Unsupported demo command');
}
