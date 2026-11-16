'use strict';
// 資料庫權限測試：在本機 PostgreSQL 模擬 Supabase（test/supabase-mock.sql），
// 以 authenticated 角色 + JWT sub 模擬各使用者，驗證 RLS 與 RPC。
// 測試會清空資料庫，請勿指向正式的 Supabase 專案：
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/wr_test npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const URL_ = process.env.TEST_DATABASE_URL;
if (!URL_) {
  test('資料庫測試（未設定 TEST_DATABASE_URL，略過）', { skip: true }, () => {});
  return;
}
const { Pool } = require('pg');
const pool = new Pool({ connectionString: URL_ });
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// 以某位使用者身分執行（uid 為 null 代表未登入的 anon）
async function as(uid, sql, params = []) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${uid ? 'authenticated' : 'anon'}`);
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: uid ? 'authenticated' : 'anon' })]);
    const r = await c.query(sql, params);
    await c.query('commit');
    return r.rows;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}
const sys = async (sql, params) => (await pool.query(sql, params)).rows;
const rpcUser = (uid, fields) => as(uid,
  'select public.admin_save_user($1,$2,$3,$4,$5,$6,$7,$8) as id',
  [fields.id || null, fields.username, fields.name, fields.role, fields.dept || null, fields.managed || [], fields.active ?? true, fields.password || '']
).then((r) => r[0].id);
// work：週一的工作內容（其餘天空白）
const saveDays = (uid, id, week, days, submit, legacy = '') => as(uid,
  `select public.save_report(p_id => $1, p_week => $2, p_work_summary => $3, p_daily_work => $4,
     p_customer_visits => '', p_sales_progress => '', p_next_week_plan => '', p_issues => '', p_submit => $5) as id`,
  [id, week, legacy, days, submit]).then((r) => r[0].id);
const save = (uid, id, week, work, submit) => saveDays(uid, id, week, [work], submit);

let admin, d1, d2, boss, amy, bob;
const WEEK = '2026-11-16';

test.before(async () => {
  await sys('drop schema if exists public cascade; drop schema if exists private cascade; drop schema if exists auth cascade; create schema public;');
  await pool.query(read('test/supabase-mock.sql'));
  await pool.query(read('supabase/schema.sql'));
  await pool.query(read('supabase/schema.sql')); // 可重複執行
  admin = (await sys("select id from profiles where username = 'admin'"))[0].id;
});
test.after(() => pool.end());

test('預設管理員與密碼', async () => {
  const [u] = await sys("select email, extensions.crypt('admin1234', encrypted_password) = encrypted_password as ok, aud, role from auth.users");
  assert.deepStrictEqual(u, { email: 'admin@weeklyreport.example.com', ok: true, aud: 'authenticated', role: 'authenticated' });
  const [i] = await sys('select provider, email from auth.identities');
  assert.deepStrictEqual(i, { provider: 'email', email: 'admin@weeklyreport.example.com' });
});

test('未登入（anon）完全無法存取', async () => {
  await assert.rejects(as(null, 'select * from public.profiles'), /permission denied/);
  await assert.rejects(as(null, 'select * from public.reports'), /permission denied/);
  await assert.rejects(as(null, "select public.admin_save_department(null, 'x')"), /permission denied/);
  await assert.rejects(as(null, "select private.create_auth_user('a@b.c', 'x')"), /permission denied/);
});

test('管理員設定部門與人員', async () => {
  d1 = await as(admin, "select public.admin_save_department(null, '北區業務部') as id").then((r) => r[0].id);
  d2 = await as(admin, "select public.admin_save_department(null, '南區業務部') as id").then((r) => r[0].id);
  await assert.rejects(as(admin, "select public.admin_save_department(null, '北區業務部')"), /部門名稱已存在/);

  boss = await rpcUser(admin, { username: 'boss', name: '王經理', role: 'manager', dept: d1, managed: [d1], password: 'pass12345' });
  amy = await rpcUser(admin, { username: 'amy', name: '業務 Amy', role: 'staff', dept: d1, password: 'pass12345' });
  bob = await rpcUser(admin, { username: 'bob', name: '業務 Bob', role: 'staff', dept: d2, password: 'pass12345' });

  await assert.rejects(rpcUser(admin, { username: 'AMY', name: 'x', role: 'staff', dept: d1, password: 'pass12345' }), /此帳號已被使用/);
  await assert.rejects(rpcUser(admin, { username: 'mgr2', name: 'x', role: 'manager', dept: d1, password: 'pass12345' }), /至少需設定一個可查閱的部門/);
  await assert.rejects(rpcUser(admin, { username: 'staff2', name: 'x', role: 'staff', password: 'pass12345' }), /請選擇所屬部門/);
  await assert.rejects(rpcUser(admin, { username: 'staff3', name: 'x', role: 'staff', dept: d1, password: 'short' }), /至少需 8 個字元/);
  await assert.rejects(rpcUser(admin, { id: admin, username: 'admin', name: 'x', role: 'staff', dept: d1 }), /不可停用自己的帳號/);

  // 非管理員不能管理
  await assert.rejects(rpcUser(boss, { username: 'hack', name: 'x', role: 'admin', password: 'pass12345' }), /沒有權限/);
  await assert.rejects(as(amy, "select public.admin_save_department(null, '駭客部')"), /沒有權限/);

  const [u] = await sys("select email, extensions.crypt('pass12345', encrypted_password) = encrypted_password as ok from auth.users where id = $1", [amy]);
  assert.deepStrictEqual(u, { email: 'amy@weeklyreport.example.com', ok: true });
  assert.strictEqual((await sys('select must_change_password from profiles where id = $1', [amy]))[0].must_change_password, true);
  assert.deepStrictEqual((await sys('select department_id from manager_departments where user_id = $1', [boss])).map((r) => r.department_id), [d1]);
});

test('變更密碼', async () => {
  await assert.rejects(as(amy, "select public.change_my_password('wrong', 'newpass123')"), /目前密碼不正確/);
  await assert.rejects(as(amy, "select public.change_my_password('pass12345', 'short')"), /至少需 8 個字元/);
  await as(amy, "select public.change_my_password('pass12345', 'amy123456')");
  const [u] = await sys("select extensions.crypt('amy123456', encrypted_password) = encrypted_password as ok from auth.users where id = $1", [amy]);
  assert.strictEqual(u.ok, true);
  assert.strictEqual((await sys('select must_change_password from profiles where id = $1', [amy]))[0].must_change_password, false);
});

test('RLS：人員資料可見範圍', async () => {
  const names = async (uid) => (await as(uid, 'select username from public.profiles order by username')).map((r) => r.username);
  assert.deepStrictEqual(await names(amy), ['amy']);
  assert.deepStrictEqual(await names(boss), ['amy', 'boss']);
  assert.deepStrictEqual(await names(admin), ['admin', 'amy', 'bob', 'boss']);
  assert.strictEqual((await as(amy, 'select * from public.manager_departments')).length, 0);
  assert.strictEqual((await as(boss, 'select * from public.manager_departments')).length, 1);
});

test('前端角色不能直接寫入資料表', async () => {
  await assert.rejects(as(amy, "insert into public.reports (user_id, week_start) values ($1, '2026-11-16')", [amy]), /permission denied/);
  await assert.rejects(as(amy, "update public.profiles set role = 'admin' where id = $1", [amy]), /permission denied/);
  await assert.rejects(as(boss, 'delete from public.departments'), /permission denied/);
  await assert.rejects(as(amy, 'select * from auth.users'), /permission denied/);
});

let rid;
test('週報流程：草稿 → 提交 → 查閱 → 鎖定 → 撤回', async () => {
  rid = await save(amy, null, '2026-11-19', '拜訪客戶 A', false); // 週四 → 自動換算為週一
  assert.strictEqual((await sys('select week_start::text from reports where id = $1', [rid]))[0].week_start, WEEK);
  await assert.rejects(save(amy, null, WEEK, '重複', false), /該週已有週報/);
  await assert.rejects(save(amy, rid, null, '', true), /提交前請至少填寫一天/);

  // 草稿：主管看不到，也不能查閱
  assert.strictEqual((await as(boss, 'select id from public.reports')).length, 0);
  await assert.rejects(as(boss, "select public.review_report($1, 'review', '')", [rid]), /沒有權限查閱/);

  await save(amy, rid, null, '拜訪客戶 A、B', true);
  assert.strictEqual((await as(boss, 'select id from public.reports')).length, 1);
  assert.strictEqual((await as(admin, 'select id from public.reports')).length, 1);
  assert.strictEqual((await as(bob, 'select id from public.reports')).length, 0, '其他業務看不到');

  // 業務不能查閱自己的週報，其他部門主管不能查閱
  await assert.rejects(as(amy, "select public.review_report($1, 'review', '')", [rid]), /沒有權限查閱/);
  const boss2 = await rpcUser(admin, { username: 'boss2', name: '李經理', role: 'manager', dept: d2, managed: [d2], password: 'pass12345' });
  await assert.rejects(as(boss2, "select public.review_report($1, 'review', '')", [rid]), /沒有權限查閱/);
  assert.strictEqual((await as(boss2, 'select id from public.reports')).length, 0);

  await as(boss, "select public.review_report($1, 'review', '做得好')", [rid]);
  const [r] = await as(amy, 'select reviewed_at is not null as reviewed, reviewer_name, review_comment from public.reports where id = $1', [rid]);
  assert.deepStrictEqual(r, { reviewed: true, reviewer_name: '王經理', review_comment: '做得好' });
  await assert.rejects(save(amy, rid, null, '偷改', true), /主管已查閱/);
  await assert.rejects(as(amy, 'select public.delete_draft($1)', [rid]), /只有草稿可以刪除/);

  const logs = await as(amy, 'select action, user_name from public.review_logs where report_id = $1', [rid]);
  assert.deepStrictEqual(logs, [{ action: 'reviewed', user_name: '王經理' }]);
  assert.strictEqual((await as(bob, 'select * from public.review_logs')).length, 0);

  await as(admin, "select public.review_report($1, 'unreview', '')", [rid]);
  await save(amy, rid, null, '補充內容', true);
  assert.deepStrictEqual((await sys('select daily_work from reports where id = $1', [rid]))[0].daily_work, ['補充內容', '', '', '', '', '', '']);
});

test('批次查閱只會標記有權限的週報', async () => {
  const rb = await save(bob, null, WEEK, 'Bob 的週報', true);
  const n = await as(boss, 'select public.review_reports($1) as n', [[rid, rb]]).then((r) => r[0].n);
  assert.strictEqual(n, 1);
  assert.strictEqual((await sys('select reviewed_at is null as pending from reports where id = $1', [rb]))[0].pending, true);
  await assert.rejects(as(amy, 'select public.review_reports($1)', [[rid]]), /沒有權限/);
});

test('刪除草稿', async () => {
  const id = await save(amy, null, '2026-11-23', '下週草稿', false);
  await assert.rejects(as(bob, 'select public.delete_draft($1)', [id]), /只有草稿可以刪除/);
  await as(amy, 'select public.delete_draft($1)', [id]);
  assert.strictEqual((await sys('select count(*)::int as c from reports where id = $1', [id]))[0].c, 0);
});

test('部門刪除保護', async () => {
  await assert.rejects(as(admin, 'select public.admin_delete_department($1)', [d1]), /仍有人員/);
  const tmp = await as(admin, "select public.admin_save_department(null, '臨時部門') as id").then((r) => r[0].id);
  await as(admin, 'select public.admin_delete_department($1)', [tmp]);
  assert.strictEqual((await sys('select count(*)::int as c from departments where id = $1', [tmp]))[0].c, 0);
});

test('停用帳號：立即失去所有存取，且無法登入', async () => {
  await sys('insert into auth.sessions (user_id) values ($1)', [amy]);
  await rpcUser(admin, { id: amy, username: 'amy', name: '業務 Amy', role: 'staff', dept: d1, active: false });
  const [u] = await sys("select banned_until > now() + interval '100 years' as banned from auth.users where id = $1", [amy]);
  assert.strictEqual(u.banned, true);
  assert.strictEqual((await sys('select count(*)::int as c from auth.sessions where user_id = $1', [amy]))[0].c, 0);
  assert.strictEqual((await as(amy, 'select * from public.reports')).length, 0);
  assert.strictEqual((await as(amy, 'select * from public.departments')).length, 0);
  await assert.rejects(save(amy, null, '2026-11-30', 'x', false), /沒有權限/);

  // 重新啟用並重設密碼
  await rpcUser(admin, { id: amy, username: 'amy', name: '業務 Amy', role: 'staff', dept: d1, active: true, password: 'reset1234' });
  const [v] = await sys("select banned_until, extensions.crypt('reset1234', encrypted_password) = encrypted_password as ok from auth.users where id = $1", [amy]);
  assert.deepStrictEqual(v, { banned_until: null, ok: true });
  assert.strictEqual((await sys('select must_change_password from profiles where id = $1', [amy]))[0].must_change_password, true);
  assert.strictEqual((await as(amy, 'select * from public.reports')).length, 1);
});

test('更改帳號名稱會同步登入信箱', async () => {
  await rpcUser(admin, { id: bob, username: 'bobby', name: '業務 Bob', role: 'staff', dept: d2 });
  const [u] = await sys('select u.email, i.email as identity_email from auth.users u join auth.identities i on i.user_id = u.id where u.id = $1', [bob]);
  assert.deepStrictEqual(u, { email: 'bobby@weeklyreport.example.com', identity_email: 'bobby@weeklyreport.example.com' });
});

test('每日工作內容：依週一～週日儲存、補齊 7 天、限制天數', async () => {
  await rpcUser(admin, { id: amy, username: 'amy', name: '業務 Amy', role: 'staff', dept: d1 });
  const id = await saveDays(amy, null, '2026-12-07', ['  拜訪 A  ', '', '報價 B'], true);
  const [r] = await sys('select daily_work, work_summary, status from reports where id = $1', [id]);
  assert.deepStrictEqual(r, { daily_work: ['拜訪 A', '', '報價 B', '', '', '', ''], work_summary: '', status: 'submitted' });
  await assert.rejects(saveDays(amy, id, null, ['', '', ''], true), /提交前請至少填寫一天/);
  await assert.rejects(saveDays(amy, id, null, ['1', '2', '3', '4', '5', '6', '7', '8'], true), /最多 7 天/);
  // 週日也可以單獨填寫
  await saveDays(amy, id, null, ['', '', '', '', '', '', '週日展覽'], true);
  assert.strictEqual((await sys('select daily_work->>6 as sun from reports where id = $1', [id]))[0].sun, '週日展覽');
  // 舊版「本週工作內容」仍可單獨提交
  const id2 = await saveDays(amy, null, '2026-12-14', [], true, '舊版內容');
  assert.strictEqual((await sys('select work_summary from reports where id = $1', [id2]))[0].work_summary, '舊版內容');
  // 主管讀得到每日內容
  const [v] = await as(boss, 'select daily_work from public.reports where id = $1', [id]);
  assert.strictEqual(v.daily_work[6], '週日展覽');
});
