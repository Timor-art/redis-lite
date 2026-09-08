const $ = selector => document.querySelector(selector);
const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
let profiles;
try { profiles = JSON.parse(localStorage.getItem('redis-lite-profiles') || '[]'); if (!Array.isArray(profiles)) profiles = []; } catch { profiles = []; }
let config = null, keys = [], scanCursor = '0', scanPattern = '*', activeKey = null, detail = null, busy = false, formatted = true;
function notice(message, info = false) { $('#notice').textContent = message; $('#notice').hidden = !message; $('#notice').className = info ? 'info' : ''; }
async function api(path, input) {
  const response = await fetch(`/api/${path}`, input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
async function action(fn) {
  if (busy) return;
  busy = true; $('#active-db').disabled = true; if (!$('#notice').classList.contains('info')) notice(''); document.body.classList.add('busy'); $('#footer-status').textContent = '正在读取…';
  try { await fn(); } catch (error) { notice(error.message); }
  finally { busy = false; $('#active-db').disabled = false; document.body.classList.remove('busy'); $('#footer-status').textContent = config ? (config.demo ? '演示数据 · 未连接 Redis' : '本地连接 · 数据按需加载') : '尚未连接'; }
}
function saveProfiles() {
  try { localStorage.setItem('redis-lite-profiles', JSON.stringify(profiles)); } catch { notice('浏览器无法保存连接信息，本次连接仍可使用'); }
}
function renderProfiles() {
  const list = $('#connection-list'); list.replaceChildren();
  const items = config?.demo ? [{ ...config, id: 'demo' }, ...profiles] : profiles;
  for (const profile of items) {
    const active = config && (profile.demo ? config.demo : !config.demo && profile.host === config.host && profile.port === config.port && profile.username === config.username && profile.tls === config.tls);
    const row = el('div', `saved-connection${active ? ' active' : ''}`);
    const button = el('button', 'profile-button'); button.append(el('span', 'profile-dot'), document.createTextNode(profile.name || profile.host));
    button.title = profile.demo ? '演示数据' : `${profile.host}:${profile.port} / DB ${profile.db}`;
    button.onclick = () => profile.demo ? action(() => connect({ demo: true })) : openConnect(profile);
    row.append(button);
    if (!profile.demo) { const remove = el('button', 'icon-button remove-profile', '×'); remove.title = '移除保存的连接'; remove.setAttribute('aria-label', `移除连接 ${profile.name || profile.host}`); remove.onclick = () => { profiles = profiles.filter(p => p.id !== profile.id); saveProfiles(); renderProfiles(); }; row.append(remove); }
    list.append(row);
  }
}
function openConnect(profile) {
  const form = $('#connect-form'); form.reset();
  for (const name of ['name', 'host', 'port', 'db', 'username']) if (profile?.[name] !== undefined) form.elements[name].value = profile[name];
  form.elements.tls.checked = !!profile?.tls;
  $('#connect-error').hidden = true; $('#connect-dialog').showModal();
}
for (const id of ['add-connection', 'new-connection', 'welcome-connect', 'connection-settings']) $(`#${id}`).onclick = () => openConnect();
$('#browse-nav').onclick = () => config ? $('#pattern').focus() : openConnect();
$('#close-dialog').onclick = () => $('#connect-dialog').close();
$('#connect-dialog').addEventListener('close', () => { $('#connect-form').elements.password.value = ''; });
$('#connect-form').onsubmit = event => {
  event.preventDefault();
  action(async () => {
    const values = Object.fromEntries(new FormData(event.target)); values.tls = event.target.elements.tls.checked;
    $('#connect-submit').textContent = '连接中…'; $('#connect-error').hidden = true;
    try { await connect(values); }
    catch (error) { $('#connect-error').textContent = error.message; $('#connect-error').hidden = false; }
    finally { $('#connect-submit').textContent = '测试并连接 →'; }
  });
};
async function connect(input) {
  const result = await api('connect', input); config = result.config;
  if (!config.demo) {
    const id = `${config.host}:${config.port}/${config.db}/${config.username}/${config.tls}`;
    profiles = [{ ...config, id }, ...profiles.filter(p => p.id !== id)].slice(0, 20); saveProfiles();
  }
  $('#connect-dialog').close(); $('#connect-form').elements.password.value = '';
  applyConnection();
  try { await scan(true); } catch (error) { notice(error.message); }
}
function applyConnection() {
  $('#welcome').hidden = !!config; $('#workspace').hidden = !config;
  $('#connection-settings').textContent = '＋ 连接 Redis';
  keys = []; scanCursor = '0'; activeKey = null; detail = null;
  $('#pattern').value = '';
  if (config) {
    $('#active-name').textContent = config.name; $('#active-address').textContent = config.demo ? 'SAMPLE DATA' : `${config.host}:${config.port}`;
    renderDatabases();
  }
  notice(config?.demo ? '演示模式：以下为内置示例数据，未连接任何 Redis。搜索支持 * 和 ?；真实连接支持 Redis glob 规则。' : '', true);
  renderProfiles(); renderKeys(); renderDetail();
}
function renderDatabases() {
  const select = $('#active-db'); select.replaceChildren();
  const count = Math.min(config.databaseCount || 16, 1025);
  const options = new Set([...Array(count).keys(), config.db]);
  for (const db of [...options].sort((a, b) => a - b)) {
    const option = el('option', '', `DB ${db}`); option.value = String(db); select.append(option);
  }
  if (!config.databaseCount) {
    const other = el('option', '', '其他数据库…'); other.value = 'custom'; select.append(other);
  }
  select.value = String(config.db);
  select.title = config.databaseCount ? `当前实例共 ${config.databaseCount} 个数据库` : '无权限读取数据库总数，列出常用编号；切换时由 Redis 验证';
  $('#custom-db-form').hidden = true;
}
async function switchDatabase(db) {
  try {
    const result = await api('select-db', { db }); config = result.config;
    applyConnection();
    await scan(true);
  } finally { renderDatabases(); }
}
$('#active-db').onchange = event => {
  if (busy) { event.target.value = String(config.db); return; }
  if (event.target.value === 'custom') { $('#custom-db-form').hidden = false; $('#custom-db').focus(); return; }
  const db = Number(event.target.value);
  if (db !== config.db) action(() => switchDatabase(db));
};
$('#custom-db-form').onsubmit = event => {
  event.preventDefault(); action(() => switchDatabase(Number($('#custom-db').value)));
};
$('#demo').onclick = () => action(() => connect({ demo: true }));
$('#disconnect').onclick = () => action(async () => { await api('disconnect', {}); config = null; applyConnection(); });
async function scan(reset = false) {
  if (reset) { scanPattern = $('#pattern').value || '*'; keys = []; scanCursor = '0'; activeKey = null; detail = null; renderDetail(); renderKeys(); }
  const result = await api('scan', { cursor: scanCursor, pattern: scanPattern });
  keys = [...new Set([...keys, ...result.keys])].sort(); scanCursor = result.cursor;
  renderKeys();
}
function renderKeys() {
  const list = $('#key-list'); list.replaceChildren();
  for (const key of keys) {
    const button = el('button', `key-item${activeKey === key ? ' active' : ''}`); button.title = key;
    button.append(el('span', 'key-symbol', '⌑'), el('span', 'key-name', key || '(空 Key)'), el('span', 'key-chevron', '›'));
    button.onclick = () => action(async () => { activeKey = key; detail = null; renderKeys(); renderDetail(); await loadDetail(); });
    list.append(button);
  }
  if (!keys.length) list.append(el('div', 'inline-empty', scanCursor !== '0' ? '本批暂无匹配项\n可继续扫描' : '暂无匹配的 Key'));
  $('#key-count').textContent = keys.length;
  const capped = keys.length >= 5000 && scanCursor !== '0';
  $('#scan-status').textContent = capped ? '已达 5000 条，请缩小搜索范围' : scanCursor === '0' ? `扫描完成 · ${keys.length} 个 Key` : `已发现 ${keys.length} 个 Key`;
  $('#load-keys').hidden = scanCursor === '0' || capped;
}
$('#search-form').onsubmit = event => { event.preventDefault(); action(() => scan(true)); };
$('#refresh-keys').onclick = () => action(() => scan(true));
$('#load-keys').onclick = () => action(() => scan());
async function loadDetail(next = false) {
  const input = { key: activeKey };
  if (next && detail) { if (['list', 'zset'].includes(detail.type)) input.offset = Number(detail.cursor); else input.cursor = detail.cursor; }
  try { detail = await api('value', input); formatted = true; renderDetail(); }
  catch (error) { detail = null; renderDetail(error.message); throw error; }
}
function renderDetail(error) {
  const panel = $('#detail-panel'); panel.replaceChildren();
  if (!detail) {
    const empty = el('div', 'detail-empty'); empty.append(el('div', 'empty-icon', error ? '!' : '⌘'), el('h2', '', error ? '暂时无法读取' : activeKey !== null ? '正在读取内容…' : '从一个 Key 开始'), el('p', '', error || '选择左侧的 Key，查看它的内容和详细信息。'), el('span', 'shortcut', '只读浏览 · 安心探索'));
    if (error) { const retry = el('button', 'button', '重新读取'); retry.onclick = () => action(() => loadDetail()); empty.append(retry); }
    panel.append(empty); return;
  }
  const head = el('div', 'detail-header'), top = el('div', 'detail-top');
  const refresh = el('button', 'text-button', '↻ 刷新'); refresh.onclick = () => action(() => loadDetail());
  top.append(el('span', 'type-badge', detail.type), refresh); head.append(top, el('h2', '', detail.key || '(空 Key)'));
  const meta = el('div', 'metadata');
  const ttlText = detail.ttl === -1 ? '永不过期' : detail.ttl === -2 ? '已过期' : `${detail.ttl.toLocaleString()} 秒`;
  for (const [label, value] of [['TTL', ttlText], ['大小', detail.size === undefined ? '—' : `${detail.size.toLocaleString()} ${detail.type === 'string' ? 'bytes' : '项'}`], ['数据库', `DB ${config.db}`]]) { const item = el('span', '', label); item.append(el('b', '', value)); meta.append(item); }
  head.append(meta); panel.append(head);
  const toolbar = el('div', 'value-toolbar'); toolbar.append(el('span', '', detail.type === 'string' ? 'VALUE' : 'ENTRIES'));
  if (detail.value) {
    const controls = el('div', 'view-switch');
    for (const [label, mode] of [['格式化', true], ['原始', false]]) { const button = el('button', formatted === mode ? 'active' : '', label); button.onclick = () => { formatted = mode; renderDetail(); }; controls.append(button); }
    toolbar.append(controls);
  }
  const copy = el('button', 'text-button', '⧉ 复制当前页'); copy.onclick = async () => {
    try { await navigator.clipboard.writeText(detail.value ? detail.value.text : JSON.stringify(detail.rows.map(r => ({ ...(r.label === undefined ? {} : { label: r.label }), value: r.text })), null, 2)); copy.textContent = '✓ 已复制'; }
    catch { notice('无法访问剪贴板，请选中内容手动复制'); }
  };
  if (!detail.unsupported) toolbar.append(copy); panel.append(toolbar);
  const content = el('div', 'value-content');
  if (detail.unsupported) content.append(el('div', 'inline-empty', `当前暂不支持 ${detail.type} 类型的内容预览。`));
  else if (detail.value) {
    if (detail.value.truncated) content.append(el('div', 'data-warning', '大值预览：仅显示前 16 KiB，复制也只包含预览内容。'));
    let text = detail.value.text;
    if (formatted && !detail.value.truncated) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Non-JSON strings remain plain text. */ } }
    content.append(el('pre', 'code-block', text || '(空字符串)'));
  } else {
    if (detail.rows.some(row => row.truncated)) content.append(el('div', 'data-warning', '部分成员超过 16 KiB，已截断显示。'));
    const table = el('table', 'value-table'), thead = el('thead'), tr = el('tr');
    if (detail.type !== 'set') tr.append(el('th', '', { hash: 'FIELD', list: 'INDEX', zset: 'SCORE' }[detail.type]));
    tr.append(el('th', '', detail.type === 'zset' || detail.type === 'set' ? 'MEMBER' : 'VALUE')); thead.append(tr); table.append(thead);
    const tbody = el('tbody');
    for (const row of detail.rows) { const tr = el('tr'); if (row.label !== undefined) tr.append(el('td', '', row.label)); tr.append(el('td', '', row.text + (row.truncated ? '\n…（已截断）' : ''))); tbody.append(tr); }
    table.append(tbody); content.append(table);
    if (!detail.rows.length) content.append(el('div', 'inline-empty', detail.cursor !== '0' ? '本批为空，可继续读取。' : '当前没有成员。'));
    if (detail.cursor !== '0') { const next = el('button', 'button collection-next', '读取下一批 →'); next.onclick = () => action(() => loadDetail(true)); content.append(next); }
    content.append(el('p', 'shortcut', '按批读取 · 数据变化时可能出现重复或位置变化 · 刷新回到第一批'));
  }
  panel.append(content);
}
renderProfiles();
action(async () => { const status = await api('status'); if (status.connected) { config = status.config; applyConnection(); await scan(true); } });
