'use strict';
// 前端畫面測試：以 Playwright 開啟 docs/，攔截所有送往 Supabase 的請求並以記憶體中的模擬資料回應
// （模擬資料套用與 RLS 相同的可見範圍規則）。資料庫端的權限另見 schema.test.js。
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

let chromium;
try { ({ chromium } = require('playwright')); } catch { /* 未安裝 Playwright */ }
if (!chromium) {
  test('前端畫面測試（未安裝 Playwright，略過）', { skip: true }, () => {});
  return;
}

const DOCS = path.join(__dirname, '..', 'docs');
const cfgSrc = fs.readFileSync(path.join(DOCS, 'config.js'), 'utf8');
const SUPABASE = cfgSrc.match(/supabaseUrl:\s*'([^']+)'/)[1];
const DOMAIN = cfgSrc.match(/emailDomain:\s*'([^']+)'/)[1];

/* ---------- 日期 ---------- */
function weekStart(d = new Date()) {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(d);
  const x = new Date(s + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}
const THIS_WEEK = weekStart();
const addDaysStr = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const NEXT_WEEK = addDaysStr(THIS_WEEK, 7);
const LAST_WEEK = (() => { const x = new Date(THIS_WEEK + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - 7); return x.toISOString().slice(0, 10); })();

/* ---------- 模擬資料 ---------- */
const U = {
  admin: '00000000-0000-4000-8000-00000000000a',
  boss: '00000000-0000-4000-8000-00000000000b',
  amy: '00000000-0000-4000-8000-00000000000c',
  bob: '00000000-0000-4000-8000-00000000000d',
};
const db = {
  departments: [{ id: 1, name: '北區業務部' }, { id: 2, name: '南區業務部' }],
  profiles: [
    { id: U.admin, username: 'admin', name: '系統管理員', role: 'admin', department_id: null, active: true, must_change_password: false, created_at: '2026-01-01T00:00:00Z' },
    { id: U.boss, username: 'boss', name: '王經理', role: 'manager', department_id: 1, active: true, must_change_password: false, created_at: '2026-01-01T00:00:00Z' },
    { id: U.amy, username: 'amy', name: '陳小明', role: 'staff', department_id: 1, active: true, must_change_password: false, created_at: '2026-01-01T00:00:00Z' },
    { id: U.bob, username: 'bob', name: '黃大偉', role: 'staff', department_id: 2, active: true, must_change_password: true, created_at: new Date().toISOString() },
  ],
  manager_departments: [{ user_id: U.boss, department_id: 1 }],
  reports: [
    {
      id: 1, user_id: U.amy, week_start: LAST_WEEK, work_summary: '', customer_visits: '採購王課長',
      daily_work: ['拜訪大成科技<script>alert(1)</script>', '', '完成長興報價', '', '', '週六展覽', ''],
      sales_progress: '報價 35 萬', next_week_plan: '追蹤簽約', issues: '', status: 'submitted',
      submitted_at: new Date().toISOString(), updated_at: new Date().toISOString(), reviewed_at: null, reviewed_by: null, reviewer_name: '', review_comment: '',
    },
  ],
  review_logs: [],
  customers: [
    { id: 1, department_id: 1, name: '大成科技', aliases: ['大成'], active: true },
    { id: 2, department_id: 2, name: '南方企業', aliases: [], active: true },
  ],
};
const rpcCalls = [];

const profileOf = (id) => db.profiles.find((p) => p.id === id);
const deptOf = (id) => db.departments.find((d) => d.id === id) || null;
function canReviewDept(uid, dept) {
  const me = profileOf(uid);
  if (!me || !me.active) return false;
  if (me.role === 'admin') return true;
  return me.role === 'manager' && db.manager_departments.some((m) => m.user_id === uid && m.department_id === dept);
}
// 與 schema.sql 的 RLS 政策相同的可見範圍
function visible(table, uid) {
  const me = profileOf(uid);
  const ok = me && me.active;
  switch (table) {
    case 'departments': return ok ? db.departments : [];
    case 'profiles': return db.profiles.filter((p) => p.id === uid || canReviewDept(uid, p.department_id))
      .map((p) => ({ ...p, department: deptOf(p.department_id) }));
    case 'manager_departments': return db.manager_departments.filter((m) => (m.user_id === uid && ok) || (ok && me.role === 'admin'));
    case 'reports': return db.reports.filter((r) => (r.user_id === uid && ok) || (r.status === 'submitted' && canReviewDept(uid, profileOf(r.user_id).department_id)))
      .map((r) => { const a = profileOf(r.user_id); return { ...r, author: { name: a.name, role: a.role, department_id: a.department_id, department: deptOf(a.department_id) } }; });
    case 'review_logs': return db.review_logs.filter((l) => visible('reports', uid).some((r) => r.id === l.report_id));
    // 與 schema.sql 相同：自己部門；主管另含負責部門；管理員全部
    case 'customers': return ok ? db.customers.filter((c) => me.role === 'admin' || c.department_id === me.department_id
      || (me.role === 'manager' && db.manager_departments.some((m) => m.user_id === uid && m.department_id === c.department_id))) : [];
    default: return [];
  }
}
function applyQuery(rows, params) {
  let out = rows;
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    if (k === 'and' || k === 'or') throw new Error('mock 不支援的條件：' + k);
    const get = (r) => k.split('.').reduce((o, p) => (o == null ? o : o[p]), r);
    const vals = (s) => s.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''));
    let f;
    if (v.startsWith('eq.')) f = (r) => String(get(r)) === v.slice(3);
    else if (v.startsWith('neq.')) f = (r) => String(get(r)) !== v.slice(4);
    else if (v.startsWith('lt.')) f = (r) => String(get(r)) < v.slice(3);
    else if (v.startsWith('gte.')) f = (r) => String(get(r)) >= v.slice(4);
    else if (v.startsWith('lte.')) f = (r) => String(get(r)) <= v.slice(4);
    else if (v.startsWith('in.')) f = (r) => vals(v.slice(3)).includes(String(get(r)));
    else if (v === 'is.null') f = (r) => get(r) == null;
    else if (v === 'not.is.null') f = (r) => get(r) != null;
    else throw new Error('mock 不支援的條件：' + k + '=' + v);
    out = out.filter(f);
  }
  const order = params.get('order');
  if (order) {
    const [col, dir] = order.split('.');
    out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (dir === 'desc' ? -1 : 1));
  }
  if (params.get('offset')) out = out.slice(Number(params.get('offset')));
  if (params.get('limit')) out = out.slice(0, Number(params.get('limit')));
  return out;
}

// 與 schema.sql 的 customer_mentions 相同的比對規則
function mentions(ids, uid) {
  const out = [];
  for (const c of visible('customers', uid).filter((x) => ids.includes(x.id))) {
    const terms = [c.name, ...c.aliases].map((t) => t.toLowerCase());
    const has = (t) => terms.some((x) => String(t || '').toLowerCase().includes(x));
    for (const r of visible('reports', uid).filter((x) => x.status === 'submitted')) {
      const a = profileOf(r.user_id);
      if (a.department_id !== c.department_id) continue;
      const base = { customer_id: c.id, report_id: r.id, week_start: r.week_start, author_id: a.id, author_name: a.name };
      const days = (r.daily_work || []).map((t, i) => ({ t, i })).filter((d) => d.t && has(d.t));
      if (days.length) days.forEach((d) => out.push({ ...base, day_index: d.i, record_date: addDaysStr(r.week_start, d.i), field: 'daily', content: d.t }));
      else if (has(r.customer_visits)) out.push({ ...base, day_index: null, record_date: r.week_start, field: 'customer_visits', content: r.customer_visits });
      else if (has(r.work_summary)) out.push({ ...base, day_index: null, record_date: r.week_start, field: 'work_summary', content: r.work_summary });
    }
  }
  return out;
}
class RpcError extends Error {}
function rpc(fn, args, uid) {
  rpcCalls.push({ fn, args, uid });
  const me = profileOf(uid);
  const now = new Date().toISOString();
  switch (fn) {
    case 'save_report': {
      if (args.p_id) {
        const r = db.reports.find((x) => x.id === args.p_id);
        Object.assign(r, { work_summary: args.p_work_summary, daily_work: args.p_daily_work, status: args.p_submit ? 'submitted' : 'draft', submitted_at: args.p_submit ? (r.submitted_at || now) : null, updated_at: now });
        return r.id;
      }
      const id = Math.max(...db.reports.map((x) => x.id)) + 1;
      db.reports.push({ id, user_id: uid, week_start: args.p_week, work_summary: args.p_work_summary, daily_work: args.p_daily_work, customer_visits: args.p_customer_visits, sales_progress: args.p_sales_progress, next_week_plan: args.p_next_week_plan, issues: args.p_issues, status: args.p_submit ? 'submitted' : 'draft', submitted_at: args.p_submit ? now : null, updated_at: now, reviewed_at: null, reviewed_by: null, reviewer_name: '', review_comment: '' });
      return id;
    }
    case 'review_report': {
      const r = db.reports.find((x) => x.id === args.p_id);
      if (args.p_action === 'review') Object.assign(r, { reviewed_at: now, reviewed_by: uid, reviewer_name: me.name, review_comment: args.p_comment });
      if (args.p_action === 'unreview') Object.assign(r, { reviewed_at: null, reviewed_by: null, reviewer_name: '', review_comment: '' });
      db.review_logs.push({ id: db.review_logs.length + 1, report_id: r.id, user_name: me.name, action: args.p_action === 'review' ? 'reviewed' : 'unreviewed', comment: args.p_comment, created_at: now });
      return null;
    }
    case 'change_my_password': me.must_change_password = false; return null;
    case 'admin_save_user': return args.p_id || '00000000-0000-4000-8000-0000000000ff';
    case 'admin_save_department': return 9;
    case 'review_reports': return 0;
    case 'save_customer': {
      const name = args.p_name.trim();
      const terms = [name, ...args.p_aliases].map((t) => t.toLowerCase());
      const clash = db.customers.find((c) => c.id !== args.p_id && c.department_id === args.p_department_id
        && [c.name, ...c.aliases].some((t) => terms.includes(t.toLowerCase())));
      if (clash) throw new RpcError(`「${terms.find((t) => [clash.name, ...clash.aliases].map((x) => x.toLowerCase()).includes(t))}」已經是客戶「${clash.name}」的名稱或別名。`);
      if (args.p_id) {
        Object.assign(db.customers.find((c) => c.id === args.p_id), { name, aliases: args.p_aliases, active: args.p_active, department_id: args.p_department_id });
        return args.p_id;
      }
      const id = Math.max(...db.customers.map((c) => c.id)) + 1;
      db.customers.push({ id, department_id: args.p_department_id, name, aliases: args.p_aliases, active: true });
      return id;
    }
    case 'admin_delete_customer':
      if (me.role !== 'admin') throw new RpcError('只有系統管理員可以刪除客戶。');
      db.customers = db.customers.filter((c) => c.id !== args.p_id);
      return null;
    case 'customer_records':
      return mentions([args.p_customer_id], uid)
        .sort((a, b) => (a.record_date < b.record_date ? 1 : a.record_date > b.record_date ? -1 : b.report_id - a.report_id))
        .slice(args.p_offset, args.p_offset + args.p_limit);
    case 'customer_stats': {
      const g = {};
      for (const m of mentions(args.p_customer_ids, uid)) {
        const k = m.customer_id + '|' + m.author_id;
        g[k] = g[k] || { customer_id: m.customer_id, author_id: m.author_id, author_name: m.author_name, records: 0, last_date: '' };
        g[k].records += 1;
        if (m.record_date > g[k].last_date) g[k].last_date = m.record_date;
      }
      return Object.values(g);
    }
    default: return null;
  }
}

/* ---------- Supabase 模擬路由 ---------- */
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const tokenFor = (uid) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: uid, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
function uidFrom(req) {
  const a = req.headers()['authorization'] || '';
  try { return JSON.parse(Buffer.from(a.replace(/^Bearer /, '').split('.')[1], 'base64url')).sub; } catch { return null; }
}
async function handleSupabase(route) {
  const req = route.request();
  const url = new URL(req.url());
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': req.headers()['access-control-request-headers'] || '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,HEAD,OPTIONS',
    'access-control-expose-headers': 'content-range',
  };
  const json = (status, body, extra = {}) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json', ...extra }, body: body === undefined ? '' : JSON.stringify(body) });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });

  if (url.pathname === '/auth/v1/token') {
    const { email, password } = JSON.parse(req.postData() || '{}');
    const p = db.profiles.find((x) => `${x.username}@${DOMAIN}` === email);
    if (!p || password !== 'pass1234') return json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
    const user = { id: p.id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
    return json(200, { access_token: tokenFor(p.id), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh-' + p.id, user });
  }
  if (url.pathname === '/auth/v1/user') {
    const uid = uidFrom(req);
    return json(200, { id: uid, aud: 'authenticated', role: 'authenticated', email: '', app_metadata: {}, user_metadata: {} });
  }
  if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers: cors });

  const uid = uidFrom(req);
  const m = url.pathname.match(/^\/rest\/v1\/(rpc\/)?(\w+)$/);
  if (!m) return json(404, { message: 'not found' });
  if (m[1]) {
    try {
      return json(200, rpc(m[2], JSON.parse(req.postData() || '{}'), uid));
    } catch (e) {
      if (e instanceof RpcError) return json(400, { code: 'P0001', message: e.message });
      throw e;
    }
  }
  // 與 PostgREST 相同：profiles↔departments、reports↔profiles 都有兩條關聯，嵌入時必須指定外鍵
  const select = url.searchParams.get('select') || '';
  if (/(^|[^!\w])(departments|profiles)\(/.test(select)) {
    return json(300, { code: 'PGRST201', message: 'Could not embed because more than one relationship was found' });
  }
  const rows = applyQuery(visible(m[2], uid), url.searchParams);
  if (req.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...cors, 'content-range': `*/${rows.length}` } });
  if ((req.headers()['accept'] || '').includes('vnd.pgrst.object')) {
    return rows.length === 1 ? json(200, rows[0]) : json(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
  }
  return json(200, rows, { 'content-range': `0-${Math.max(rows.length - 1, 0)}/*` });
}

// 外部字型：預設回傳空白（測試不依賴網路）；REAL_FONTS=1 時以 curl 下載，供檢視設計截圖
const fontCache = new Map();
async function fontRoute(route) {
  const url = route.request().url();
  if (!process.env.REAL_FONTS) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
  if (!fontCache.has(url)) {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
    fontCache.set(url, require('node:child_process').execFileSync('curl', ['-sS', '-m', '30', '-A', ua, url]));
  }
  return route.fulfill({ status: 200, contentType: url.includes('googleapis') ? 'text/css' : 'font/woff2', headers: { 'access-control-allow-origin': '*' }, body: fontCache.get(url) });
}
// 設計檢視用截圖（設定 SHOT_DIR 時才輸出）
async function shot(page, name) {
  if (!process.env.SHOT_DIR) return;
  await page.evaluate(() => Promise.all([document.fonts.ready, ...document.getAnimations().map((a) => a.finished)]));
  await page.screenshot({ path: path.join(process.env.SHOT_DIR, name + '.png'), fullPage: true });
}

/* ---------- 測試 ---------- */
let server, base, browser;
const errors = [];
test.before(async () => {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const f = path.join(DOCS, p === '/' ? 'index.html' : p);
    fs.readFile(f, (e, d) => (e ? res.writeHead(404).end() : res.writeHead(200, { 'content-type': types[path.extname(f)] || 'text/plain' }).end(d)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
test.after(async () => {
  await browser.close();
  server.close();
});

async function login(username, viewport) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 1280, height: 800 } });
  await ctx.route(SUPABASE + '/**', handleSupabase);
  await ctx.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, fontRoute);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${username}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${username}: ${m.text()}`); });
  page.on('dialog', (d) => d.accept());
  await page.goto(base);
  await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', 'pass1234');
  await page.click('button.btn-primary');
  return page;
}

test('未登入導向登入頁、密碼錯誤顯示訊息', async () => {
  const ctx = await browser.newContext();
  await ctx.route(SUPABASE + '/**', handleSupabase);
  await ctx.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, fontRoute);
  const page = await ctx.newPage();
  await page.goto(base + '#/review');
  await page.waitForSelector('input[name=username]');
  assert.match(page.url(), /#\/login\?next=%2Freview/);
  assert.strictEqual(await page.textContent('.login h1'), '工作週報系統');
  assert.strictEqual(await page.title(), '工作週報系統');
  await shot(page, 'd-login');
  await page.fill('input[name=username]', 'amy');
  await page.fill('input[name=password]', 'wrong');
  await page.click('button.btn-primary');
  await page.waitForSelector('.alert-error');
  assert.match(await page.textContent('.alert-error'), /帳號或密碼錯誤/);
  await ctx.close();
});

test('主管：查閱名單 → 檢視週報 → 標記查閱完成', async () => {
  const page = await login('boss');
  await page.waitForSelector('.stats');
  assert.match(page.url(), /#\/review$/);
  await shot(page, 'd-review');
  const body = await page.textContent('main');
  assert.match(body, /陳小明/);
  assert.doesNotMatch(body, /黃大偉/, '其他部門人員不應出現');

  await page.goto(base + '#/review?week=all&status=pending');
  await page.waitForSelector('a.btn-sm[href^="#/reports/1"]');
  assert.match(await page.textContent('td.summary'), /^一：拜訪大成科技/);
  await page.click('a.btn-sm[href^="#/reports/1"]');
  await page.waitForSelector('[data-review]');
  // XSS：週報內容必須以文字顯示
  assert.match(await page.textContent('.report-body'), /<script>alert\(1\)<\/script>/);
  assert.strictEqual(await page.$('.report-body script'), null);
  assert.match(await page.textContent('.daily-view'), /週三[\s\S]*完成長興報價[\s\S]*週六[\s\S]*週六展覽/);

  await page.fill('textarea[name=comment]', '做得好');
  await page.click('button[value=review]');
  await page.waitForSelector('.review-box.is-reviewed');
  assert.match(await page.textContent('.alert-success'), /查閱完成/);
  assert.match(await page.textContent('.timeline'), /王經理 標記查閱完成/);
  assert.deepStrictEqual(rpcCalls.at(-1), { fn: 'review_report', args: { p_id: 1, p_action: 'review', p_comment: '做得好' }, uid: U.boss });
  await shot(page, 'ui-report-view');
  await page.context().close();
});

test('業務：看到查閱結果、填寫本週週報並提交', async () => {
  const page = await login('amy');
  await page.waitForSelector('.highlight');
  assert.match(page.url(), /#\/reports$/);
  await shot(page, 'd-mine');
  assert.match(await page.textContent('table'), /已查閱/);
  assert.match(await page.textContent('table'), /做得好/);
  assert.strictEqual(await page.$('a[href="#/review"]'), null, '業務不應看到查閱選單');

  await page.click(`a[href="#/reports/new?week=${THIS_WEEK}"]`);
  await page.waitForSelector('textarea[name=day0]');
  // 週一～週五直接顯示、週末收合；欄位標示日期
  assert.match(await page.textContent('[data-day-label="0"]'), new RegExp('週一 ' + THIS_WEEK.slice(5).replace('-', '/')));
  assert.strictEqual(await page.isVisible('textarea[name=day4]'), true);
  assert.strictEqual(await page.isVisible('textarea[name=day6]'), false);
  assert.strictEqual(await page.$('textarea[name=work_summary]'), null, '新週報不顯示舊版欄位');
  assert.match(await page.textContent('.prev-plan'), /追蹤簽約/);
  await page.click('button[value=submit]');
  await page.waitForSelector('[data-error] .alert-error'); // 未填內容
  await page.fill('textarea[name=day0]', '拜訪三家客戶');
  await page.fill('textarea[name=day2]', '準備報價');
  await page.click('details.weekend summary');
  await page.fill('textarea[name=day6]', '週日拜訪');
  await shot(page, 'ui-daily-form');
  await page.click('button[value=submit]');
  await page.waitForSelector('.report-body');
  const call = rpcCalls.at(-1);
  assert.strictEqual(call.fn, 'save_report');
  assert.deepStrictEqual({ p_id: call.args.p_id, p_week: call.args.p_week, p_submit: call.args.p_submit, p_work_summary: call.args.p_work_summary, p_daily_work: call.args.p_daily_work },
    { p_id: null, p_week: THIS_WEEK, p_submit: true, p_work_summary: '', p_daily_work: ['拜訪三家客戶', '', '準備報價', '', '', '', '週日拜訪'] });
  // 檢視頁：平日都列出、週末只列出有內容的那天
  const view = await page.textContent('.daily-view');
  assert.match(view, /週一[\s\S]*拜訪三家客戶[\s\S]*週二[\s\S]*未填寫[\s\S]*週三[\s\S]*準備報價/);
  assert.match(view, /週日[\s\S]*週日拜訪/);
  assert.doesNotMatch(view, /週六/);
  assert.match(await page.textContent('main'), /待查閱/);

  await page.goto(base + '#/admin/users');
  await page.waitForSelector('h1');
  assert.match(await page.textContent('h1'), /權限不足/);
  await page.context().close();
});

test('首次登入強制變更密碼', async () => {
  const page = await login('bob');
  await page.waitForSelector('input[name=current]');
  assert.match(page.url(), /#\/password$/);
  await page.fill('input[name=current]', 'pass1234');
  await page.fill('input[name=password]', 'newpass123');
  await page.fill('input[name=confirm]', 'different1');
  await page.click('form[data-form] button');
  await page.waitForSelector('[data-error] .alert-error');
  await page.fill('input[name=confirm]', 'newpass123');
  await page.click('form[data-form] button');
  await page.waitForSelector('.highlight');
  assert.match(page.url(), /#\/reports$/);
  await page.context().close();
});

test('繳交統計：管理員看全部部門、數字正確', async () => {
  const page = await login('admin');
  await page.waitForSelector('.stats');
  await page.click('a[href="#/stats"]');
  await page.waitForSelector('h1:has-text("繳交統計")');
  assert.match(await page.textContent('.page-head .muted'), /共 8 週/); // 預設近 8 週
  await page.goto(base + '#/stats?weeks=4');
  await page.waitForSelector('.page-head .muted:has-text("共 4 週")');
  // 近 4 週：陳小明 前兩週未繳、上週已查閱（逾期提交）、本週待查閱 → 2/4；
  // 王經理 前三週未繳、本週進行中 → 0/3；黃大偉 本週才建立 → 0/0
  const deptRows = await page.$$eval('.stats-table:not(.grid) tbody tr', (trs) => trs.map((tr) => [...tr.cells].map((td) => td.textContent.trim())));
  assert.deepStrictEqual(deptRows, [
    ['北區業務部', '2', '7', '2', '5', '29%', '50%', '1', '50%'],
    ['南區業務部', '1', '0', '0', '0', '—', '—', '0', '—'],
  ]);
  const people = await page.$$eval('.stats-table.grid tbody tr', (trs) => trs.map((tr) => {
    const c = [...tr.cells];
    return [c[1].textContent.trim(), c.slice(2, 6).map((td) => (td.querySelector('.cell') || {}).className.replace('cell ', '').trim()), c[6].textContent.trim(), c[7].textContent.trim()];
  }));
  assert.deepStrictEqual(people, [
    ['陳小明', ['cell-bad', 'cell-bad', 'cell-ok late', 'cell-warn'], '2／4', '50%'],
    ['王經理 主管', ['cell-bad', 'cell-bad', 'cell-bad', 'cell-muted'], '0／3', '0%'],
    ['黃大偉', ['cell-na', 'cell-na', 'cell-na', 'cell-muted'], '0／0', '—'],
  ]);
  assert.match(await page.textContent('.stats'), /應繳份數[\s\S]*29%[\s\S]*未繳份數/);
  await shot(page, 'd-stats');
  // 點格子開啟週報，並能返回統計
  await page.click('.stats-table.grid a.cell-ok');
  await page.waitForSelector('.report-body');
  assert.match(await page.getAttribute('a.small.no-print', 'href'), /^#\/stats/);
  // 列印版面（橫向）可輸出 PDF
  await page.goto(base + '#/stats?weeks=4');
  await page.waitForSelector('.stats-table.grid');
  await page.emulateMedia({ media: 'print' });
  assert.strictEqual(await page.isVisible('.topbar'), false);
  assert.strictEqual(await page.isVisible('form[data-filters]'), false);
  const pdf = await page.pdf({ path: path.join(process.env.SHOT_DIR || '/tmp', 'sample-stats.pdf'), preferCSSPageSize: true, printBackground: true });
  assert.strictEqual(pdf.subarray(0, 4).toString(), '%PDF');
  await page.context().close();
});

test('繳交統計：主管只看到自己負責的部門；業務人員不能進入', async () => {
  const page = await login('boss');
  await page.waitForSelector('.stats');
  await page.goto(base + '#/stats?weeks=4');
  await page.waitForSelector('.stats-table.grid');
  const text = await page.textContent('main');
  assert.match(text, /陳小明/);
  assert.doesNotMatch(text, /黃大偉|南區業務部/);
  assert.strictEqual(await page.$$eval('select[name=dept] option', (o) => o.length), 2); // 全部部門 + 北區
  await page.context().close();

  const staff = await login('amy');
  await staff.waitForSelector('.highlight');
  assert.strictEqual(await staff.$('a[href="#/stats"]'), null);
  await staff.goto(base + '#/stats');
  await staff.waitForSelector('h1');
  assert.match(await staff.textContent('h1'), /權限不足/);
  await staff.context().close();
});

test('列印：單份週報與整週批次列印、輸出 PDF', async () => {
  const page = await login('boss');
  await page.waitForSelector('.stats');
  await page.goto(base + '#/reports/1');
  await page.waitForSelector('[data-print]');
  // 按鈕會呼叫瀏覽器列印
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed += 1; }; });
  await page.click('[data-print]');
  assert.strictEqual(await page.evaluate(() => window.__printed), 1);
  // 列印版面：隱藏選單與操作，顯示列印資訊
  await page.emulateMedia({ media: 'print' });
  assert.strictEqual(await page.isVisible('.topbar'), false);
  assert.strictEqual(await page.isVisible('[data-print]'), false);
  assert.strictEqual(await page.isVisible('.print-meta'), true);
  assert.match(await page.textContent('.print-meta'), /工作週報系統[\s\S]*列印人：王經理/);
  assert.strictEqual(await page.isVisible('.daily-view'), true);
  assert.strictEqual(await page.isVisible('.review-box'), true);
  const pdf1 = await page.pdf({ path: path.join(process.env.SHOT_DIR || '/tmp', 'sample-report.pdf'), preferCSSPageSize: true, printBackground: true });
  assert.strictEqual(pdf1.subarray(0, 4).toString(), '%PDF');
  await page.emulateMedia({ media: 'screen' });

  // 週報查閱 → 列印上週週報
  await page.goto(base + `#/review?week=${LAST_WEEK}`);
  await page.waitForSelector('.section-title-row');
  await page.click('a[href^="#/print"]');
  await page.waitForSelector('h1:has-text("列印週報")');
  assert.strictEqual(await page.$$eval('.print-report', (a) => a.length), 1);
  assert.match(await page.textContent('.print-report'), /陳小明 的週報[\s\S]*拜訪大成科技[\s\S]*已查閱完成/);
  const pdf2 = await page.pdf({ path: path.join(process.env.SHOT_DIR || '/tmp', 'sample-batch.pdf'), preferCSSPageSize: true, printBackground: true });
  assert.strictEqual(pdf2.subarray(0, 4).toString(), '%PDF');
  await page.context().close();
});

test('客戶：填寫週報時的輸入建議、過往紀錄與新增客戶', async () => {
  const page = await login('amy');
  await page.waitForSelector('.highlight');
  await page.goto(base + `#/reports/new?week=${NEXT_WEEK}`);
  await page.waitForSelector('[data-cust-panel]');
  assert.match(await page.textContent('[data-cust-list]'), /寫到名錄中的客戶時/);

  // 輸入別名「大成」→ 建議「大成科技」（不會出現別部門的「南方企業」）→ Enter 補成正式名稱
  await page.click('textarea[name=day1]');
  await page.keyboard.type('下午去大成');
  await page.waitForSelector('.suggest:not([hidden]) .suggest-item');
  const items = await page.$$eval('.suggest:not([hidden]) .suggest-item', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  assert.match(items[0], /^大成科技\s*別名：大成$/);
  assert.match(items.at(-1), /新增「大成」到客戶名錄/);
  assert.ok(!items.some((t) => t.includes('南方企業')));
  await page.keyboard.press('Enter');
  assert.strictEqual(await page.inputValue('textarea[name=day1]'), '下午去大成科技');
  assert.strictEqual(await page.isVisible('.suggest'), false);

  // 面板列出提到的客戶，點選顯示過往紀錄（上週週報，客戶名稱標示）
  await page.waitForSelector('.chip[data-cid="1"]');
  await page.click('.chip[data-cid="1"]');
  await page.waitForSelector('.cust-records li');
  assert.match(await page.textContent('.cust-records'), /週一[\s\S]*陳小明[\s\S]*拜訪大成科技/);
  assert.strictEqual(await page.textContent('.cust-records mark'), '大成科技');
  assert.strictEqual(await page.getAttribute('.cust-records a', 'href'), '#/reports/1');
  await shot(page, 'd-cust-form');

  // 選取文字後「新增客戶到名錄」→ 自動帶入名稱
  await page.fill('textarea[name=customer_visits]', '長興企業洽談合約');
  await page.evaluate(() => { const t = document.querySelector('textarea[name=customer_visits]'); t.focus(); t.setSelectionRange(0, 4); });
  await page.click('[data-cust-add]');
  await page.waitForSelector('dialog.customer-dialog[open]');
  assert.strictEqual(await page.inputValue('dialog input[name=name]'), '長興企業');
  await page.fill('dialog input[name=aliases]', '長興、 長興');
  await page.click('dialog button.btn-primary');
  await page.waitForSelector('.chip:has-text("長興企業")');
  assert.deepStrictEqual(rpcCalls.at(-1).args, { p_id: null, p_department_id: 1, p_name: '長興企業', p_aliases: ['長興', '長興'], p_active: true });

  // 名稱或別名重複：顯示資料庫回傳的說明（瀏覽器會記錄這一次預期中的 400 錯誤）
  const before = errors.length;
  await page.click('[data-cust-add]');
  await page.fill('dialog input[name=name]', '大成');
  await page.click('dialog button.btn-primary');
  await page.waitForSelector('dialog .alert-error');
  assert.match(await page.textContent('dialog .alert-error'), /「大成」已經是客戶「大成科技」/);
  const expected = errors.splice(before);
  assert.deepStrictEqual(expected, ['amy: Failed to load resource: the server responded with a status of 400 (Bad Request)']);
  await page.click('dialog [data-cancel]');
  assert.strictEqual(await page.$('dialog'), null);
  await page.context().close();
});

test('客戶頁：搜尋、統計、紀錄與權限', async () => {
  const page = await login('boss');
  await page.waitForSelector('.stats');
  await page.click('a[href="#/customers"]');
  await page.waitForSelector('h1:has-text("客戶")');
  const table = await page.textContent('table');
  assert.match(table, /大成科技[\s\S]*長興企業/);
  assert.doesNotMatch(table, /南方企業/, '看不到別部門的客戶');
  assert.strictEqual(await page.$$eval('[data-edit]', (b) => b.length), 2, '主管可編輯負責部門的客戶');
  assert.strictEqual(await page.$('[data-del-cust]'), null, '主管不能刪除客戶');

  // 搜尋別名 → Enter 進入客戶頁
  await page.fill('#cust-q', '大成');
  await page.waitForSelector('.cust-results:not([hidden]) .suggest-item');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-records] li');
  assert.match(page.url(), /#\/customers\?id=1$/);
  assert.match(await page.textContent('.cust-stats'), /1\s*紀錄次數[\s\S]*最後紀錄日期[\s\S]*接觸人員：陳小明 1/);
  assert.match(await page.textContent('[data-records]'), /週一[\s\S]*陳小明[\s\S]*每日工作內容[\s\S]*拜訪大成科技/);
  assert.strictEqual(await page.isVisible('[data-more]'), false);
  await shot(page, 'd-customer');

  // 編輯客戶（主管）
  await page.click('[data-edit]');
  await page.fill('dialog input[name=aliases]', '大成、DC電子');
  await page.click('dialog button.btn-primary');
  await page.waitForSelector('.alert-success');
  assert.deepStrictEqual(rpcCalls.filter((c) => c.fn === 'save_customer').at(-1).args, { p_id: 1, p_department_id: 1, p_name: '大成科技', p_aliases: ['大成', 'DC電子'], p_active: true });
  assert.match(await page.textContent('.page-head .muted'), /別名：大成、DC電子/);

  // 開啟週報後可返回客戶頁
  await page.click('[data-records] a');
  await page.waitForSelector('.report-body');
  assert.strictEqual(await page.getAttribute('a.small.no-print', 'href'), '#/customers?id=1');
  await page.context().close();

  // 業務人員：看得到名錄、可以新增，但不能編輯
  const staff = await login('amy');
  await staff.waitForSelector('.highlight');
  await staff.goto(base + '#/customers');
  await staff.waitForSelector('h1:has-text("客戶")');
  assert.strictEqual(await staff.$('[data-edit]'), null);
  assert.ok(await staff.$('[data-add]'));
  await staff.goto(base + '#/customers?id=2');
  await staff.waitForSelector('h1:has-text("找不到客戶")'); // 別部門的客戶
  await staff.context().close();

  // 系統管理員：看得到所有部門的客戶，並標示部門
  const adm = await login('admin');
  await adm.waitForSelector('.stats');
  await adm.goto(base + '#/customers');
  await adm.waitForSelector('h1:has-text("客戶")');
  assert.match(await adm.textContent('table'), /南方企業[\s\S]*南區業務部/);
  // 系統管理員刪除客戶（確認後）
  let confirmText = '';
  adm.removeAllListeners('dialog');
  adm.on('dialog', (d) => { confirmText = d.message(); d.accept(); });
  await adm.click('[data-del-cust="2"]');
  await adm.waitForSelector('.alert-success');
  assert.match(confirmText, /確定刪除客戶「南方企業」[\s\S]*週報內容不會刪除/);
  assert.match(await adm.textContent('.alert-success'), /已刪除客戶「南方企業」/);
  assert.doesNotMatch(await adm.textContent('table'), /南方企業/);
  assert.deepStrictEqual(rpcCalls.filter((c) => c.fn === 'admin_delete_customer'), [{ fn: 'admin_delete_customer', args: { p_id: 2 }, uid: U.admin }]);
  // 取消確認時不會刪除
  adm.removeAllListeners('dialog');
  adm.on('dialog', (d) => d.dismiss());
  await adm.click('[data-del-cust="1"]');
  assert.strictEqual(rpcCalls.filter((c) => c.fn === 'admin_delete_customer').length, 1, '取消後沒有刪除');
  assert.match(await adm.textContent('table'), /大成科技/);
  await adm.context().close();
});

test('管理員：人員列表、人員表單、部門管理', async () => {
  const page = await login('admin');
  await page.waitForSelector('.stats');
  await page.click('a[href="#/admin/users"]');
  await page.waitForSelector('h1:has-text("人員與權限")');
  const text = await page.textContent('table');
  for (const n of ['王經理', '陳小明', '黃大偉', '系統管理員']) assert.match(text, new RegExp(n));
  await shot(page, 'ui-users');

  await page.click(`a[href="#/admin/users/${U.boss}"]`);
  await page.waitForSelector('[data-managed]');
  assert.strictEqual(await page.isVisible('[data-managed]'), true);
  assert.strictEqual(await page.isChecked('input[name=managed][value="1"]'), true);
  await page.selectOption('select[name=role]', 'staff');
  assert.strictEqual(await page.isVisible('[data-managed]'), false);
  await page.selectOption('select[name=role]', 'manager');
  await page.check('input[name=managed][value="2"]');
  await page.click('form[data-form] button.btn-primary');
  await page.waitForSelector('.alert-success');
  const call = rpcCalls.at(-1);
  assert.strictEqual(call.fn, 'admin_save_user');
  assert.deepStrictEqual(call.args, { p_id: U.boss, p_username: 'boss', p_name: '王經理', p_role: 'manager', p_department_id: 1, p_managed: [1, 2], p_active: true, p_password: '' });

  await page.click('a[href="#/admin/departments"]');
  await page.waitForSelector('[data-create]');
  assert.strictEqual(await page.inputValue('[data-rename="1"] input[name=name]'), '北區業務部');
  assert.match(await page.textContent('table'), /2 人[\s\S]*王經理/);
  await page.fill('[data-create] input[name=name]', '東區業務部');
  await page.click('[data-create] button');
  await page.waitForSelector('.alert-success');
  assert.deepStrictEqual(rpcCalls.at(-1).args, { p_id: null, p_name: '東區業務部' });
  await page.context().close();
});

test('手機版面不會水平捲動', async () => {
  const page = await login('boss', { width: 390, height: 800 });
  await page.waitForSelector('.stats');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.strictEqual(overflow, false);
  await shot(page, 'ui-review-mobile');
  await page.goto(base + '#/reports/1');
  await page.waitForSelector('.seal');
  assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await shot(page, 'd-report-mobile');
  await page.context().close();
});

test('全程沒有 JavaScript 錯誤', () => {
  assert.deepStrictEqual(errors, []);
});
