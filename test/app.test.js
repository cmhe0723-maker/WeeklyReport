'use strict';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'admin1234';
const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/app');
const util = require('../src/util');

let server, base;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => server.close());

// 簡易瀏覽器：保留 cookie、自動帶 CSRF
function client() {
  let cookie = '';
  let csrf = '';
  async function req(method, path, form) {
    const opts = { method, redirect: 'manual', headers: { cookie } };
    if (form) {
      opts.headers['content-type'] = 'application/x-www-form-urlencoded';
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries({ _csrf: csrf, ...form })) {
        for (const x of [].concat(v)) p.append(k, x);
      }
      opts.body = p.toString();
    }
    const res = await fetch(base + path, opts);
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const body = await res.text();
    const m = body.match(/name="_csrf" value="([^"]+)"/);
    if (m) csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), body };
  }
  return {
    get: (p) => req('GET', p),
    post: (p, f) => req('POST', p, f),
    async login(u, pw) { await req('GET', '/login'); return req('POST', '/login', { username: u, password: pw }); },
  };
}

const week = util.currentWeekStart();

test('完整流程：管理員設定 → 業務填寫 → 主管查閱', async () => {
  const admin = client();
  let r = await admin.login('admin', 'admin1234');
  assert.strictEqual(r.status, 302);
  r = await admin.get('/review');
  assert.strictEqual(r.location, '/account/password', '首次登入需改密碼');
  await admin.get('/account/password');
  r = await admin.post('/account/password', { current: 'admin1234', password: 'newpass123', confirm: 'newpass123' });
  assert.strictEqual(r.status, 302);

  // 無 CSRF 拒絕
  const raw = await fetch(base + '/admin/departments', { method: 'POST', body: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.strictEqual(raw.status, 403);

  await admin.get('/admin/departments');
  await admin.post('/admin/departments', { name: '北區業務部' });
  await admin.post('/admin/departments', { name: '南區業務部' });
  r = await admin.get('/admin/departments');
  const ids = [...r.body.matchAll(/action="\/admin\/departments\/(\d+)"/g)].map(m => m[1]);
  assert.strictEqual(ids.length, 2);
  const [d1, d2] = ids; // 依名稱排序：北區、南區

  await admin.get('/admin/users/new');
  r = await admin.post('/admin/users', { username: 'boss', name: '王經理', role: 'manager', department_id: d1, managed: [d1], password: 'pass12345', active: '1' });
  assert.strictEqual(r.status, 302);
  r = await admin.post('/admin/users', { username: 'bad', name: '無部門主管', role: 'manager', department_id: d1, password: 'pass12345', active: '1' });
  assert.strictEqual(r.status, 400, '主管必須有可查閱部門');
  await admin.post('/admin/users', { username: 'amy', name: '業務 Amy', role: 'staff', department_id: d1, password: 'pass12345', active: '1' });
  await admin.post('/admin/users', { username: 'bob', name: '業務 Bob', role: 'staff', department_id: d2, password: 'pass12345', active: '1' });

  // 業務登入（強制改密碼）
  const amy = client();
  await amy.login('amy', 'pass12345');
  await amy.get('/account/password');
  await amy.post('/account/password', { current: 'pass12345', password: 'amy123456', confirm: 'amy123456' });
  r = await amy.get('/review');
  assert.strictEqual(r.status, 403, '業務不能進查閱頁');
  await amy.get('/reports/new');
  r = await amy.post('/reports', { week_start: week, work_summary: '拜訪客戶 A', next_week_plan: '追蹤 A', action: 'draft' });
  assert.strictEqual(r.status, 302);
  const reportId = r.location.split('/').pop();

  // 主管看不到草稿
  const boss = client();
  await boss.login('boss', 'pass12345');
  await boss.get('/account/password');
  await boss.post('/account/password', { current: 'pass12345', password: 'boss12345', confirm: 'boss12345' });
  r = await boss.get(`/reports/${reportId}`);
  assert.strictEqual(r.status, 404);
  r = await boss.get(`/review?week=${week}`);
  assert.match(r.body, /業務 Amy/);
  assert.doesNotMatch(r.body, /業務 Bob/, '不同部門人員不顯示');

  // 業務提交
  await amy.get(`/reports/${reportId}/edit`);
  r = await amy.post(`/reports/${reportId}`, { work_summary: '拜訪客戶 A、B', action: 'submit' });
  assert.strictEqual(r.status, 302);

  // 主管查閱
  r = await boss.get(`/reports/${reportId}`);
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /標記為查閱完成/);
  r = await boss.post(`/reports/${reportId}/review`, { action: 'review', comment: '做得好' });
  assert.strictEqual(r.status, 302);
  r = await boss.get(`/review?week=${week}&status=reviewed`);
  assert.match(r.body, /已查閱/);

  // 業務看到查閱狀態，且無法再編輯
  r = await amy.get(`/reports/${reportId}`);
  assert.match(r.body, /已查閱完成/);
  assert.match(r.body, /做得好/);
  r = await amy.get(`/reports/${reportId}/edit`);
  assert.strictEqual(r.status, 302);
  r = await amy.post(`/reports/${reportId}`, { work_summary: '偷改', action: 'submit' });
  r = await amy.get(`/reports/${reportId}`);
  assert.doesNotMatch(r.body, /偷改/);

  // 另一部門業務無法看
  const bob = client();
  await bob.login('bob', 'pass12345');
  await bob.get('/account/password');
  await bob.post('/account/password', { current: 'pass12345', password: 'bob123456', confirm: 'bob123456' });
  r = await bob.get(`/reports/${reportId}`);
  assert.strictEqual(r.status, 404);

  // 管理員可看全部，撤回查閱
  r = await admin.get(`/reports/${reportId}`);
  assert.strictEqual(r.status, 200);
  r = await admin.post(`/reports/${reportId}/review`, { action: 'unreview' });
  r = await amy.get(`/reports/${reportId}/edit`);
  assert.strictEqual(r.status, 200, '撤回後可再編輯');

  // 批次查閱
  await boss.get(`/review?week=${week}`);
  r = await boss.post('/review/batch', { ids: [reportId], back: '/review' });
  r = await boss.get(`/reports/${reportId}`);
  assert.match(r.body, /已查閱完成/);

  // 停用帳號後立即無法使用
  r = await admin.get('/admin/users');
  const amyId = r.body.match(/業務 Amy[\s\S]*?\/admin\/users\/(\d+)/)[1];
  await admin.get(`/admin/users/${amyId}`);
  await admin.post(`/admin/users/${amyId}`, { username: 'amy', name: '業務 Amy', role: 'staff', department_id: d1 });
  r = await amy.get('/reports');
  assert.strictEqual(r.status, 302);
  assert.match(r.location, /^\/login/);
  r = await amy.login('amy', 'amy123456');
  assert.strictEqual(r.status, 401);
});
