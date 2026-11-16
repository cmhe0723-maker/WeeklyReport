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
    { id: U.admin, username: 'admin', name: '系統管理員', role: 'admin', department_id: null, active: true, must_change_password: false },
    { id: U.boss, username: 'boss', name: '王經理', role: 'manager', department_id: 1, active: true, must_change_password: false },
    { id: U.amy, username: 'amy', name: '陳小明', role: 'staff', department_id: 1, active: true, must_change_password: false },
    { id: U.bob, username: 'bob', name: '黃大偉', role: 'staff', department_id: 2, active: true, must_change_password: true },
  ],
  manager_departments: [{ user_id: U.boss, department_id: 1 }],
  reports: [
    {
      id: 1, user_id: U.amy, week_start: LAST_WEEK, work_summary: '拜訪大成科技<script>alert(1)</script>', customer_visits: '採購王課長',
      sales_progress: '報價 35 萬', next_week_plan: '追蹤簽約', issues: '', status: 'submitted',
      submitted_at: new Date().toISOString(), updated_at: new Date().toISOString(), reviewed_at: null, reviewed_by: null, reviewer_name: '', review_comment: '',
    },
  ],
  review_logs: [],
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
    default: return [];
  }
}
function applyQuery(rows, params) {
  let out = rows;
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    const get = (r) => k.split('.').reduce((o, p) => (o == null ? o : o[p]), r);
    const vals = (s) => s.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''));
    let f;
    if (v.startsWith('eq.')) f = (r) => String(get(r)) === v.slice(3);
    else if (v.startsWith('neq.')) f = (r) => String(get(r)) !== v.slice(4);
    else if (v.startsWith('lt.')) f = (r) => String(get(r)) < v.slice(3);
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
  if (params.get('limit')) out = out.slice(0, Number(params.get('limit')));
  return out;
}

function rpc(fn, args, uid) {
  rpcCalls.push({ fn, args, uid });
  const me = profileOf(uid);
  const now = new Date().toISOString();
  switch (fn) {
    case 'save_report': {
      if (args.p_id) {
        const r = db.reports.find((x) => x.id === args.p_id);
        Object.assign(r, { work_summary: args.p_work_summary, status: args.p_submit ? 'submitted' : 'draft', submitted_at: args.p_submit ? (r.submitted_at || now) : null, updated_at: now });
        return r.id;
      }
      const id = Math.max(...db.reports.map((x) => x.id)) + 1;
      db.reports.push({ id, user_id: uid, week_start: args.p_week, work_summary: args.p_work_summary, customer_visits: args.p_customer_visits, sales_progress: args.p_sales_progress, next_week_plan: args.p_next_week_plan, issues: args.p_issues, status: args.p_submit ? 'submitted' : 'draft', submitted_at: args.p_submit ? now : null, updated_at: now, reviewed_at: null, reviewed_by: null, reviewer_name: '', review_comment: '' });
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
  if (m[1]) return json(200, rpc(m[2], JSON.parse(req.postData() || '{}'), uid));
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
  const page = await ctx.newPage();
  await page.goto(base + '#/review');
  await page.waitForSelector('input[name=username]');
  assert.match(page.url(), /#\/login\?next=%2Freview/);
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
  const body = await page.textContent('main');
  assert.match(body, /陳小明/);
  assert.doesNotMatch(body, /黃大偉/, '其他部門人員不應出現');

  await page.goto(base + '#/review?week=all&status=pending');
  await page.waitForSelector('a.btn-sm[href^="#/reports/1"]');
  await page.click('a.btn-sm[href^="#/reports/1"]');
  await page.waitForSelector('[data-review]');
  // XSS：週報內容必須以文字顯示
  assert.match(await page.textContent('.report-body'), /<script>alert\(1\)<\/script>/);
  assert.strictEqual(await page.$('.report-body script'), null);

  await page.fill('textarea[name=comment]', '做得好');
  await page.click('button[value=review]');
  await page.waitForSelector('.review-box.is-reviewed');
  assert.match(await page.textContent('.alert-success'), /查閱完成/);
  assert.match(await page.textContent('.timeline'), /王經理 標記查閱完成/);
  assert.deepStrictEqual(rpcCalls.at(-1), { fn: 'review_report', args: { p_id: 1, p_action: 'review', p_comment: '做得好' }, uid: U.boss });
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || '/tmp', 'ui-report-view.png'), fullPage: true });
  await page.context().close();
});

test('業務：看到查閱結果、填寫本週週報並提交', async () => {
  const page = await login('amy');
  await page.waitForSelector('.highlight');
  assert.match(page.url(), /#\/reports$/);
  assert.match(await page.textContent('table'), /已查閱/);
  assert.match(await page.textContent('table'), /做得好/);
  assert.strictEqual(await page.$('a[href="#/review"]'), null, '業務不應看到查閱選單');

  await page.click(`a[href="#/reports/new?week=${THIS_WEEK}"]`);
  await page.waitForSelector('textarea[name=work_summary]');
  assert.match(await page.textContent('.prev-plan'), /追蹤簽約/);
  await page.click('button[value=submit]');
  await page.waitForSelector('[data-error] .alert-error'); // 未填內容
  await page.fill('textarea[name=work_summary]', '拜訪三家客戶');
  await page.click('button[value=submit]');
  await page.waitForSelector('.report-body');
  const call = rpcCalls.at(-1);
  assert.strictEqual(call.fn, 'save_report');
  assert.deepStrictEqual({ p_id: call.args.p_id, p_week: call.args.p_week, p_submit: call.args.p_submit, p_work_summary: call.args.p_work_summary },
    { p_id: null, p_week: THIS_WEEK, p_submit: true, p_work_summary: '拜訪三家客戶' });
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

test('管理員：人員列表、人員表單、部門管理', async () => {
  const page = await login('admin');
  await page.waitForSelector('.stats');
  await page.click('a[href="#/admin/users"]');
  await page.waitForSelector('h1:has-text("人員與權限")');
  const text = await page.textContent('table');
  for (const n of ['王經理', '陳小明', '黃大偉', '系統管理員']) assert.match(text, new RegExp(n));
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || '/tmp', 'ui-users.png'), fullPage: true });

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
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || '/tmp', 'ui-review-mobile.png'), fullPage: true });
  await page.context().close();
});

test('全程沒有 JavaScript 錯誤', () => {
  assert.deepStrictEqual(errors, []);
});
