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
const rankId = async (name) => (name ? ((await sys('select id from ranks where name = $1', [name]))[0] || {}).id ?? null : null);
// role：admin＝系統管理員；其他為一般人員。舊版角色對應職級：manager → 經理、staff → 專員（也可用 rank 指定）
// managed：額外可查閱部門
const rpcUser = async (uid, f) => {
  const role = f.role === 'admin' ? 'admin' : 'user';
  const rank = f.rank !== undefined ? f.rank : ({ manager: '經理', staff: '專員' })[f.role];
  return as(uid, 'select public.admin_save_user($1,$2,$3,$4,$5,$6,$7,$8,$9) as id',
    [f.id || null, f.username, f.name, role, role === 'user' ? await rankId(rank) : null,
      f.dept || null, f.managed || [], f.active ?? true, f.password || '']).then((r) => r[0].id);
};
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
  await assert.rejects(rpcUser(admin, { username: 'mgr2', name: 'x', role: 'user', rank: null, dept: d1, password: 'pass12345' }), /請選擇職級/);
  await assert.rejects(rpcUser(admin, { username: 'staff2', name: 'x', role: 'staff', password: 'pass12345' }), /請選擇所屬部門/);
  await assert.rejects(rpcUser(admin, { username: 'staff3', name: 'x', role: 'staff', dept: d1, password: 'short' }), /至少需 8 個字元/);
  await assert.rejects(rpcUser(admin, { id: admin, username: 'admin', name: 'x', role: 'staff', dept: d1 }), /不可停用自己的帳號/);

  // 非管理員不能管理
  await assert.rejects(rpcUser(boss, { username: 'hack', name: 'x', role: 'admin', password: 'pass12345' }), /沒有權限/);
  await assert.rejects(as(amy, "select public.admin_save_department(null, '駭客部')"), /沒有權限/);

  const [u] = await sys("select email, extensions.crypt('pass12345', encrypted_password) = encrypted_password as ok from auth.users where id = $1", [amy]);
  assert.deepStrictEqual(u, { email: 'amy@weeklyreport.example.com', ok: true });
  assert.strictEqual((await sys('select must_change_password from profiles where id = $1', [amy]))[0].must_change_password, true);
  // 所屬部門不需再列為額外可查閱部門
  assert.deepStrictEqual((await sys('select department_id from manager_departments where user_id = $1', [boss])).map((r) => r.department_id), []);
  assert.deepStrictEqual((await sys("select r.name from profiles p join ranks r on r.id = p.rank_id where p.id = any($1) order by r.seniority desc", [[boss, amy]])).map((r) => r.name), ['經理', '專員']);
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
  assert.strictEqual((await as(boss, 'select * from public.manager_departments')).length, 0);
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
  await assert.rejects(save(amy, rid, null, '偷改', true), /已有主管核閱/);
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
  // 沒有輪到自己核閱的週報會被略過（專員沒有下屬，核閱 0 份）
  assert.strictEqual(await as(amy, 'select public.review_reports($1) as n', [[rid, rb]]).then((r) => r[0].n), 0);
  await assert.rejects(as(null, 'select public.review_reports($1)', [[rid]]), /permission denied/);
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

test('客戶名錄：依部門隔開、權限與別名防重複', async () => {
  const d3 = await as(admin, "select public.admin_save_department(null, '客戶測試部') as id").then((r) => r[0].id);
  const mgr3 = await rpcUser(admin, { username: 'mgr3', name: '張主管', role: 'manager', dept: d3, managed: [d3], password: 'pass12345' });
  const s1 = await rpcUser(admin, { username: 'sales1', name: '業務甲', role: 'staff', dept: d3, password: 'pass12345' });
  const s2 = await rpcUser(admin, { username: 'sales2', name: '業務乙', role: 'staff', dept: d3, password: 'pass12345' });
  const s4 = await rpcUser(admin, { username: 'sales4', name: '業務丁', role: 'staff', dept: d2, password: 'pass12345' });
  const saveCust = (uid, f) => as(uid, 'select public.save_customer($1,$2,$3,$4,$5) as id',
    [f.id || null, f.dept, f.name, f.aliases || [], f.active ?? true]).then((r) => r[0].id);
  const names = async (uid) => (await as(uid, 'select name, department_id from public.customers order by department_id, name'))
    .map((c) => `${c.department_id === d3 ? 'd3' : 'd2'}:${c.name}`);

  // 先寫週報，之後才建客戶 → 舊週報也要找得到
  const W1 = '2026-10-05';
  const W2 = '2026-10-12';
  await saveDays(s1, null, W1, ['拜訪大成科技，說明方案', '', 'dc電子報價'], true);
  const s1w2 = await saveDays(s1, null, W2, ['內部會議'], true);
  await as(s1, `select public.save_report(p_id => $1, p_week => null, p_work_summary => '', p_daily_work => array['內部會議'],
    p_customer_visits => '與大成開會', p_sales_progress => '', p_next_week_plan => '', p_issues => '', p_submit => true)`, [s1w2]);
  await saveDays(s1, null, '2026-10-19', ['大成科技（草稿不列入）'], false);
  await saveDays(s2, null, W1, ['', '大成科技簽約'], true);
  await saveDays(s4, null, W1, ['南區拜訪大成科技'], true);

  // 新增：業務只能加到自己部門
  const c3 = await saveCust(s1, { dept: d3, name: '大成科技', aliases: [' 大成 ', '大成', '大成科技', ''] });
  assert.deepStrictEqual((await sys('select aliases, created_by from customers where id = $1', [c3]))[0], { aliases: ['大成'], created_by: s1 });
  await assert.rejects(saveCust(s1, { dept: d2, name: '別部門客戶' }), /不能在這個部門新增/);
  await assert.rejects(saveCust(s2, { dept: d3, name: '大成' }), /「大成」已經是客戶「大成科技」/);
  await assert.rejects(saveCust(s2, { dept: d3, name: '新客戶', aliases: ['大'] }), /2–50 個字/);
  // 不同部門可以有同名客戶
  const c2 = await saveCust(s4, { dept: d2, name: '大成科技' });
  // 修改：業務不行，主管可以
  await assert.rejects(saveCust(s1, { id: c3, dept: d3, name: '大成科技', aliases: ['大成', 'DC電子'] }), /只有具主管權限的職級或系統管理員/);
  await saveCust(mgr3, { id: c3, dept: d3, name: '大成科技', aliases: ['大成', 'DC電子'] });
  await assert.rejects(saveCust(mgr3, { id: c2, dept: d2, name: '大成科技' }), /客戶不存在/);
  await assert.rejects(as(s1, "update public.customers set name = 'x'"), /permission denied/);

  // 名錄可見範圍
  assert.deepStrictEqual(await names(s1), ['d3:大成科技']);
  assert.deepStrictEqual(await names(s4), ['d2:大成科技']);
  assert.deepStrictEqual(await names(mgr3), ['d3:大成科技']);
  assert.deepStrictEqual((await names(admin)).sort(), ['d2:大成科技', 'd3:大成科技']);
  await assert.rejects(as(null, 'select * from public.customers'), /permission denied/);

  // 紀錄：業務只看到自己的（週一、週三＋第二週「客戶拜訪紀錄」1 筆；草稿不列入）
  const rec = (uid, id, limit = 50, offset = 0) => as(uid, 'select * from public.customer_records($1, $2, $3)', [id, limit, offset]);
  const r1 = await rec(s1, c3);
  assert.deepStrictEqual(r1.map((r) => [r.field, r.day_index, String(r.record_date.toISOString().slice(0, 10))]), [
    ['customer_visits', null, W2],
    ['daily', 2, '2026-10-07'],
    ['daily', 0, W1],
  ]);
  assert.match(r1[1].content, /dc電子/); // 事後加的別名、不分大小寫
  assert.strictEqual((await rec(s2, c3)).length, 1);
  assert.strictEqual((await rec(s4, c3)).length, 0, '看不到別部門的客戶');
  assert.strictEqual((await rec(mgr3, c3)).length, 4);
  assert.strictEqual((await rec(admin, c3)).length, 4);
  assert.deepStrictEqual((await rec(admin, c2)).map((r) => r.author_name), ['業務丁'], '別部門的同名客戶各自計算');
  assert.strictEqual((await rec(mgr3, c3, 2, 2)).length, 2, '分頁');

  // 統計
  const st = await as(mgr3, 'select author_name, records::int, last_date::text from public.customer_stats($1) order by author_name', [[c3]]);
  assert.deepStrictEqual(st, [
    { author_name: '業務乙', records: 1, last_date: '2026-10-06' },
    { author_name: '業務甲', records: 3, last_date: W2 },
  ]);
  const own = await as(s1, 'select author_name, records::int from public.customer_stats($1)', [[c3]]);
  assert.deepStrictEqual(own, [{ author_name: '業務甲', records: 3 }]);

  // 停用：主管可停用，名錄仍看得到、紀錄仍查得到
  await saveCust(mgr3, { id: c3, dept: d3, name: '大成科技', aliases: ['大成', 'DC電子'], active: false });
  assert.strictEqual((await as(s1, 'select active from public.customers where id = $1', [c3]))[0].active, false);
  assert.strictEqual((await rec(s1, c3)).length, 3);
});

test('刪除客戶：負責部門的主管與系統管理員可以，週報內容不受影響', async () => {
  const [{ id: dept }] = await sys("select id from departments where name = '客戶測試部'");
  const [{ id: mgr }] = await sys("select id from profiles where username = 'mgr3'");   // 負責客戶測試部
  const [{ id: staff }] = await sys("select id from profiles where username = 'sales1'"); // 客戶測試部業務
  const newCust = (name) => as(mgr, "select public.save_customer(null, $1, $2, '{}', true) as id", [dept, name]).then((r) => r[0].id);
  const reportsBefore = (await sys('select count(*)::int as c from reports'))[0].c;

  const c1 = await newCust('待刪客戶甲');
  await assert.rejects(as(staff, 'select public.admin_delete_customer($1)', [c1]), /只有具主管權限的職級或系統管理員/);
  await assert.rejects(as(boss, 'select public.admin_delete_customer($1)', [c1]), /客戶不存在/, '別部門的主管看不到也刪不了');
  await assert.rejects(as(null, 'select public.admin_delete_customer($1)', [c1]), /permission denied/);
  await assert.rejects(as(mgr, 'delete from public.customers where id = $1', [c1]), /permission denied/);
  // 負責部門的主管可以刪除
  await as(mgr, 'select public.admin_delete_customer($1)', [c1]);
  assert.strictEqual((await sys('select count(*)::int as c from customers where id = $1', [c1]))[0].c, 0);
  await assert.rejects(as(mgr, 'select public.admin_delete_customer($1)', [c1]), /客戶不存在/);
  // 系統管理員也可以
  const c2 = await newCust('待刪客戶乙');
  await as(admin, 'select public.admin_delete_customer($1)', [c2]);
  assert.strictEqual((await sys('select count(*)::int as c from customers where id = $1', [c2]))[0].c, 0);
  assert.strictEqual((await sys('select count(*)::int as c from reports'))[0].c, reportsBefore, '週報不受影響');
});

test('每日多筆拜訪：客戶、聯絡人、內容，聯絡人自動加入名錄', async () => {
  const [{ id: dept }] = await sys("select id from departments where name = '客戶測試部'");
  const [{ id: mgr }] = await sys("select id from profiles where username = 'mgr3'");
  const [{ id: staff }] = await sys("select id from profiles where username = 'sales1'");
  const [{ id: other }] = await sys("select id from profiles where username = 'sales4'"); // 別部門
  const cid = await as(mgr, "select public.save_customer(null, $1, '環宇貿易', array['環宇'], true) as id", [dept]).then((r) => r[0].id);
  const saveEntries = (uid, id, week, entries, submit) => as(uid,
    `select public.save_report(p_id => $1, p_week => $2, p_work_summary => '', p_daily_work => null, p_daily_entries => $3::jsonb,
       p_customer_visits => '', p_sales_progress => '', p_next_week_plan => '', p_issues => '', p_submit => $4) as id`,
    [id, week, JSON.stringify(entries), submit]).then((r) => r[0].id);
  const W = '2026-12-21';

  const id = await saveEntries(staff, null, W, [
    [{ customer: ' 環宇貿易 ', contact: '王經理', content: '說明新方案' }, { customer: '', contact: '', content: '' }, { customer: '', contact: '', content: '整理報價單' }],
    [],
    [{ customer: '環宇', contact: '王經理', content: '' }, { customer: '環宇', contact: '李小姐', content: '追蹤樣品' }],
  ], true);
  const [r] = await sys('select daily_entries, daily_work from reports where id = $1', [id]);
  assert.deepStrictEqual(r.daily_entries[0], [
    { customer: '環宇貿易', contact: '王經理', content: '說明新方案' },
    { customer: '', contact: '', content: '整理報價單' },
  ], '去除空白筆數與前後空白');
  assert.strictEqual(r.daily_entries.length, 7);
  assert.deepStrictEqual(r.daily_work, ['環宇貿易（王經理）：說明新方案\n整理報價單', '', '環宇（王經理）\n環宇（李小姐）：追蹤樣品', '', '', '', '']);
  // 聯絡人自動加入（別名也能對應、不重複）
  assert.deepStrictEqual((await sys('select contacts from customers where id = $1', [cid]))[0].contacts, ['王經理', '李小姐']);
  // 大小寫不同視為同一人；別部門的人寫同名客戶不會加到這個部門
  await saveEntries(staff, id, null, [[{ customer: '環宇貿易', contact: 'amy chen', content: 'x' }], [], [{ customer: '環宇貿易', contact: 'Amy Chen', content: 'y' }]], true);
  await saveEntries(other, null, W, [[{ customer: '環宇貿易', contact: '別部門聯絡人', content: 'z' }]], true);
  assert.deepStrictEqual((await sys('select contacts from customers where id = $1', [cid]))[0].contacts, ['王經理', '李小姐', 'amy chen']);

  // 客戶紀錄查詢：以每日文字比對，週一、週三各算 1 次
  const rec = await as(mgr, 'select day_index, content from public.customer_records($1)', [cid]);
  assert.deepStrictEqual(rec.map((x) => x.day_index), [2, 0]);

  // 限制
  await assert.rejects(saveEntries(staff, id, null, [Array.from({ length: 21 }, (_, n) => ({ content: 'c' + n }))], true), /每天最多 20 筆/);
  await assert.rejects(saveEntries(staff, id, null, [[{ customer: '環宇', contact: '', content: '' }].map(() => 'bad')], true), /格式不正確/);
  await assert.rejects(saveEntries(staff, id, null, [[], [], []], true), /至少填寫一天/);

  // 舊版網頁（只傳 p_daily_work）仍可使用，並轉成每天一筆
  const oldId = await saveDays(staff, null, '2026-12-28', ['舊版內容'], true);
  assert.deepStrictEqual((await sys('select daily_entries->0 as d from reports where id = $1', [oldId]))[0].d, [{ customer: '', contact: '', content: '舊版內容' }]);

  // 主管可在「編輯客戶」修正聯絡人；業務不行
  await as(mgr, "select public.save_customer($1, $2, '環宇貿易', array['環宇'], true, array['王經理', ' 李小姐 ', '王經理', '']) as id", [cid, dept]);
  assert.deepStrictEqual((await sys('select contacts from customers where id = $1', [cid]))[0].contacts, ['王經理', '李小姐']);
  await assert.rejects(as(staff, "select public.save_customer($1, $2, '環宇貿易', array['環宇'], true, array['x'])", [cid, dept]), /只有具主管權限的職級或系統管理員/);
  // 不傳聯絡人（舊版網頁）時保留原清單
  await as(mgr, "select public.save_customer($1, $2, '環宇貿易', array['環宇'], true) as id", [cid, dept]);
  assert.deepStrictEqual((await sys('select contacts from customers where id = $1', [cid]))[0].contacts, ['王經理', '李小姐']);
});

test('週會紀錄：指定記錄人、草稿權限、版本衝突及發布', async () => {
  const [{ id: colleague }] = await as(admin,
    "select public.admin_save_user(null, 'meetingreader', '同部門人員', 'user', (select id from ranks where name = '專員'), $1, null, true, 'pass12345') as id", [d1]);
  const attendees = [
    { name: 'Amy', report: '第一段\n第二段', note: '個人附註' },
    { name: '外部來賓', report: '', note: '' },
  ];
  const write = (uid, id, rev, publish, entries = attendees, recorder = amy, dept = d1) => as(uid,
    "select public.save_meeting_minutes($1, $2, $3, '2026-11-20', $4, $5, '全場附註', $6) as id",
    [id, rev, dept, recorder, JSON.stringify(entries), publish]);
  const read = (uid, id) => as(uid, 'select * from meeting_minutes where id = $1', [id]);

  await assert.rejects(write(amy, null, null, false), /沒有權限新增/);
  await assert.rejects(write(boss, null, null, false, attendees, bob), /有效的記錄人/);
  await assert.rejects(write(boss, null, null, true, []), /至少填寫一位/);
  await assert.rejects(write(boss, null, null, false, [{ name: 'Amy' }]), /格式或長度/);
  const [{ id }] = await write(boss, null, null, false);
  assert.equal((await read(amy, id))[0].published_at, null);
  assert.equal((await read(colleague, id)).length, 0);
  assert.equal((await read(bob, id)).length, 0);
  assert.equal((await as(amy, 'select * from meeting_roster($1, $2)', [d1, id])).some((p) => p.id === colleague), true);
  assert.equal((await as(colleague, 'select * from meeting_roster($1, $2)', [d1, id])).length, 0);
  await assert.rejects(as(null, 'select * from meeting_minutes'), /permission denied/);
  await assert.rejects(as(amy, 'update meeting_minutes set notes = $1 where id = $2', ['x', id]), /permission denied/);
  await assert.rejects(write(colleague, id, 1, false), /沒有權限編輯/);
  await assert.rejects(write(amy, id, 1, true), /請由部門主管/);
  await assert.rejects(write(amy, id, 1, false, attendees, colleague), /有效的記錄人/);

  const reordered = [...attendees].reverse();
  await write(amy, id, 1, false, reordered);
  await assert.rejects(write(boss, id, 1, true), /已更新/);
  await write(boss, id, 2, true, reordered);
  const [published] = await read(colleague, id);
  assert.ok(published.published_at);
  assert.deepEqual(published.attendees, reordered);
  assert.equal(published.notes, '全場附註');
  assert.equal((await read(bob, id)).length, 0);
  await assert.rejects(write(boss, id, 3, false), /已發布/);
});

test('職級：只看得到同部門（含額外部門）職級較低的人員', async () => {
  const dR = await as(admin, "select public.admin_save_department(null, '職級測試部') as id").then((r) => r[0].id);
  const dX = await as(admin, "select public.admin_save_department(null, '外部支援部') as id").then((r) => r[0].id);
  const mk = (username, name, rank, dept, extra = []) => rpcUser(admin, { username, name, role: 'user', rank, dept, managed: extra, password: 'pass12345' });
  const A = await mk('r_vp', '協理甲', '協理', dR, [dX]);
  const B1 = await mk('r_mgr1', '經理甲', '經理', dR);
  const B2 = await mk('r_mgr2', '經理乙', '經理', dR);
  const C = await mk('r_dep', '副理甲', '副理', dR);
  const D = await mk('r_staff', '專員甲', '專員', dR);
  const E = await mk('r_ext', '專員乙', '專員', dX);
  const names = async (uid) => (await as(uid, "select name from public.profiles where username like 'r\\_%' order by name")).map((r) => r.name);
  assert.deepStrictEqual(await names(A), ['副理甲', '專員乙', '專員甲', '協理甲', '經理乙', '經理甲'].sort());
  assert.deepStrictEqual(await names(B1), ['副理甲', '專員甲', '經理甲'].sort(), '同職級（經理乙）、較高職級（協理）看不到');
  assert.deepStrictEqual(await names(C), ['副理甲', '專員甲'].sort());
  assert.deepStrictEqual(await names(D), ['專員甲']);
  assert.deepStrictEqual(await names(E), ['專員乙'], '別部門');
  // 週報：同職級、較高職級的週報看不到
  const rB2 = await save(B2, null, '2027-01-04', '經理乙的週報', true);
  assert.strictEqual((await as(B1, 'select id from public.reports where id = $1', [rB2])).length, 0);
  assert.strictEqual((await as(A, 'select id from public.reports where id = $1', [rB2])).length, 1);
  assert.strictEqual((await as(C, 'select id from public.reports where id = $1', [rB2])).length, 0);

  // 調整職級順序立即生效：副理移到經理之上 → 副理看得到經理，經理看不到副理
  const [{ id: depRank }] = await sys("select id from ranks where name = '副理'");
  await as(admin, 'select public.admin_move_rank($1, true)', [depRank]);
  assert.deepStrictEqual(await names(C), ['副理甲', '專員甲', '經理乙', '經理甲'].sort());
  assert.deepStrictEqual(await names(B1), ['專員甲', '經理甲'].sort());
  await as(admin, 'select public.admin_move_rank($1, false)', [depRank]);
  assert.deepStrictEqual(await names(C), ['副理甲', '專員甲'].sort());
  await assert.rejects(as(admin, "select public.admin_move_rank((select id from ranks where name = '協理'), true)"), /已經是最高職級/);
});

test('逐級核閱：由低到高依序蓋章，全部完成才算已查閱', async () => {
  const id = async (u) => (await sys('select id from profiles where username = $1', [u]))[0].id;
  const [A, B1, B2, C, D, E] = await Promise.all(['r_vp', 'r_mgr1', 'r_mgr2', 'r_dep', 'r_staff', 'r_ext'].map(id));
  const rid = await save(D, null, '2027-01-04', '專員的週報', true);
  const state = (uid, rep = rid) => as(uid, 'select * from public.report_review_states($1)', [[rep]]).then((r) => r[0]);
  const review = (uid, action = 'review', comment = '', rep = rid) => as(uid, 'select public.review_report($1, $2, $3)', [rep, action, comment]);
  const levels = async (uid = admin) => (await state(uid)).levels.map((l) => `${l.rank_name}:${l.stamped ? l.user_name : '待核閱'}`);

  assert.deepStrictEqual(await levels(), ['副理:待核閱', '經理:待核閱', '協理:待核閱']);
  assert.strictEqual((await state(C)).can_stamp, true);
  assert.strictEqual((await state(B1)).can_stamp, false);
  await assert.rejects(review(B1), /目前輪到「副理」核閱/);

  await review(C, 'review', '內容清楚');
  await assert.rejects(save(D, rid, null, '想再改', true), /已有主管核閱/);
  await review(B1);
  await assert.rejects(review(B2), /目前輪到「協理」核閱/, '同層級已有人核閱');
  await assert.rejects(review(C, 'unreview'), /只能撤回自己的核閱/, '上一層級已核閱');
  assert.strictEqual((await sys('select reviewed_at from reports where id = $1', [rid]))[0].reviewed_at, null);

  await review(A, 'review', '同意');
  const [done] = await sys('select reviewed_at is not null as ok, reviewer_name, review_comment from reports where id = $1', [rid]);
  assert.deepStrictEqual(done, { ok: true, reviewer_name: '協理甲', review_comment: '同意' });
  assert.deepStrictEqual(await levels(), ['副理:副理甲', '經理:經理甲', '協理:協理甲']);
  assert.strictEqual((await state(D)).complete, true, '作者也看得到核閱結果');
  await assert.rejects(review(A), /已完成核閱/);

  // 撤回：最高層級撤回後回到未完成，換下一層可撤回
  assert.strictEqual((await state(A)).can_withdraw, true);
  assert.strictEqual((await state(B1)).can_withdraw, false);
  await review(A, 'unreview');
  assert.strictEqual((await sys('select reviewed_at from reports where id = $1', [rid]))[0].reviewed_at, null);
  assert.deepStrictEqual(await levels(), ['副理:副理甲', '經理:經理甲', '協理:待核閱']);
  assert.strictEqual((await state(B1)).can_withdraw, true);
  // 系統管理員撤回全部 → 作者可再修改
  await review(admin, 'unreview');
  assert.deepStrictEqual(await levels(), ['副理:待核閱', '經理:待核閱', '協理:待核閱']);
  await save(D, rid, null, '修改後再提交', true);

  // 批次核閱只處理輪到自己的
  assert.strictEqual(await as(B1, 'select public.review_reports($1) as n', [[rid]]).then((r) => r[0].n), 0);
  assert.strictEqual(await as(C, 'select public.review_reports($1) as n', [[rid]]).then((r) => r[0].n), 1);

  // 某層級無在職人員時自動略過：停用副理 → 剩經理、協理
  const rid2 = await save(D, null, '2027-01-11', '第二週', true);
  await rpcUser(admin, { id: C, username: 'r_dep', name: '副理甲', role: 'user', rank: '副理', dept: (await sys('select department_id from profiles where id = $1', [C]))[0].department_id, active: false });
  assert.deepStrictEqual((await state(admin, rid2)).levels.map((l) => l.rank_name), ['經理', '協理']);
  await rpcUser(admin, { id: C, username: 'r_dep', name: '副理甲', role: 'user', rank: '副理', dept: (await sys('select department_id from profiles where id = $1', [C]))[0].department_id, active: true });

  // 沒有上級的週報（協理）：只有系統管理員能代為完成
  const ridA = await save(A, null, '2027-01-04', '協理的週報', true);
  assert.deepStrictEqual((await state(admin, ridA)).levels, []);
  await review(admin, 'review', '已閱', ridA);
  const [vp] = await sys('select reviewed_at is not null as ok, reviewer_name from reports where id = $1', [ridA]);
  assert.deepStrictEqual(vp, { ok: true, reviewer_name: '系統管理員' });
  assert.deepStrictEqual((await state(admin, ridA)).levels.map((l) => [l.rank_name, l.admin]), [['系統管理員', true]]);

  // 額外可查閱部門：協理是外部支援部專員的核閱層級
  const ridE = await save(E, null, '2027-01-04', '支援部週報', true);
  assert.deepStrictEqual((await state(admin, ridE)).levels.map((l) => l.rank_name), ['協理']);
  await review(A, 'review', '', ridE);
  assert.strictEqual((await state(E, ridE)).complete, true);

  // 看不到的週報拿不到核閱狀態
  assert.strictEqual(await state(B2, ridA), undefined);
  assert.strictEqual(await state(E, rid), undefined);
});

test('職級管理：只有系統管理員可以新增、改名、調整、刪除；主管權限控制客戶管理', async () => {
  const [{ id: C }] = await sys("select id from profiles where username = 'r_dep'");
  const [{ department_id: dR }] = await sys("select department_id from profiles where username = 'r_dep'");
  const [{ id: depRank }] = await sys("select id from ranks where name = '副理'");
  await assert.rejects(as(C, "select public.admin_save_rank(null, '實習生', false)"), /沒有權限/);
  await assert.rejects(as(C, 'select public.admin_move_rank($1, true)', [depRank]), /沒有權限/);
  const newRank = await as(admin, "select public.admin_save_rank(null, '實習生', false) as id").then((r) => r[0].id);
  assert.strictEqual((await sys('select name from ranks order by seniority limit 1'))[0].name, '實習生', '新增的職級排在最低');
  await assert.rejects(as(admin, "select public.admin_save_rank(null, '經理', false)"), /職級名稱已存在/);
  await as(admin, 'select public.admin_delete_rank($1)', [newRank]);
  await assert.rejects(as(admin, 'select public.admin_delete_rank($1)', [depRank]), /仍有人員是這個職級/);
  await assert.rejects(as(admin, 'delete from public.ranks'), /permission denied/);

  // 主管權限：副理預設沒有 → 不能修改客戶；勾選後可以
  const cust = await as(C, "select public.save_customer(null, $1, '職級測試客戶', '{}', true) as id", [dR]).then((r) => r[0].id);
  await assert.rejects(as(C, "select public.save_customer($1, $2, '職級測試客戶', array['職級測試'], true)", [cust, dR]), /只有具主管權限的職級/);
  await as(admin, "select public.admin_save_rank($1, '副理', true)", [depRank]);
  await as(C, "select public.save_customer($1, $2, '職級測試客戶', array['職級測試'], true)", [cust, dR]);
  await as(C, 'select public.admin_delete_customer($1)', [cust]);
  await as(admin, "select public.admin_save_rank($1, '副理', false)", [depRank]);
  // 改名
  await as(admin, "select public.admin_save_rank($1, '副理（測試）', null)", [depRank]);
  assert.strictEqual((await sys('select name, is_manager from ranks where id = $1', [depRank]))[0].name, '副理（測試）');
  await as(admin, "select public.admin_save_rank($1, '副理', null)", [depRank]);
});

test('逐級核閱：人員與職級異動、刪除職級、每人只能核閱一層、待我核閱', async () => {
  const dF = await as(admin, "select public.admin_save_department(null, '異動測試部') as id").then((r) => r[0].id);
  const mk = (username, name, rank, extra = {}) => rpcUser(admin, { username, name, role: 'user', rank, dept: dF, password: 'pass12345', ...extra });
  const tmpRank = await as(admin, "select public.admin_save_rank(null, '臨時職', false) as id").then((r) => r[0].id);
  await as(admin, 'select public.admin_move_rank($1, true)', [tmpRank]); // 移到專員之上
  const S = await mk('f_staff', '專員丙', '專員');
  const T = await mk('f_tmp', '臨時丙', '臨時職');
  const G = await mk('f_dep', '副理丙', '副理');
  const M = await mk('f_mgr', '經理丙', '經理');
  const V = await mk('f_vp', '協理丙', '協理');
  const state = (uid, rep) => as(uid, 'select * from public.report_review_states($1)', [[rep]]).then((r) => r[0]);
  const review = (uid, rep, action = 'review') => as(uid, 'select public.review_report($1, $2, $3)', [rep, action, '']);
  const levels = async (rep) => (await state(admin, rep)).levels.map((l) => `${l.rank_name}:${l.stamped ? l.user_name : '待核閱'}${l.admin ? '(管理員)' : ''}`);
  const queue = (uid) => as(uid, 'select public.my_review_queue() as id').then((r) => r.map((x) => Number(x.id)));

  const rid = await save(S, null, '2027-02-01', '異動測試', true);
  assert.deepStrictEqual(await levels(rid), ['臨時職:待核閱', '副理:待核閱', '經理:待核閱', '協理:待核閱']);
  await review(T, rid);

  // 每人只能核閱一層：臨時丙升為副理後不能再蓋副理的章
  await mk('f_tmp', '臨時丙', '副理', { id: T });
  assert.strictEqual((await state(T, rid)).can_stamp, false);
  assert.strictEqual((await state(G, rid)).can_stamp, true);
  await assert.rejects(review(T, rid), /已核閱過這份週報/);
  await review(G, rid);

  // 刪除職級：原章保留（不會變成系統管理員代閱），也不影響下一層
  await as(admin, 'select public.admin_delete_rank($1)', [tmpRank]);
  assert.deepStrictEqual(await levels(rid), ['臨時職:臨時丙', '副理:副理丙', '經理:待核閱', '協理:待核閱']);
  assert.strictEqual((await state(M, rid)).can_stamp, true);

  // 待我核閱：輪到經理；系統管理員只有需要代為完成的週報，批次核閱也不會跳過層級
  assert.ok((await queue(M)).includes(Number(rid)));
  assert.ok(!(await queue(V)).includes(Number(rid)));
  assert.ok(!(await queue(admin)).includes(Number(rid)));
  assert.strictEqual(await as(admin, 'select public.review_reports($1) as n', [[rid]]).then((r) => r[0].n), 0);
  assert.strictEqual((await sys('select count(*)::int as n from report_stamps where report_id = $1', [rid]))[0].n, 2);
  const ridV = await save(V, null, '2027-02-01', '協理的週報', true);
  assert.ok((await queue(admin)).includes(Number(ridV)), '沒有上級的週報在系統管理員的待我核閱');
  assert.strictEqual(await as(admin, 'select public.review_reports($1) as n', [[ridV]]).then((r) => r[0].n), 1);

  // 剩下的層級沒有在職人員 → 自動完成核閱
  await review(M, rid);
  assert.strictEqual((await state(admin, rid)).complete, false);
  await mk('f_vp', '協理丙', '協理', { id: V, active: false });
  const [fin] = await sys('select reviewed_at is not null as ok, reviewer_name from reports where id = $1', [rid]);
  assert.deepStrictEqual(fin, { ok: true, reviewer_name: '經理丙' });
  await mk('f_vp', '協理丙', '協理', { id: V });

  // 調整職級高低：核閱章的層級跟著調整
  const rid2 = await save(S, null, '2027-02-08', '第二週', true);
  await review(G, rid2);
  const [{ id: depRank, seniority: depSen }] = await sys("select id, seniority from ranks where name = '副理'");
  const [{ seniority: chiefSen }] = await sys("select seniority from ranks where name = '主任'");
  await as(admin, 'select public.admin_move_rank($1, false)', [depRank]);
  assert.strictEqual((await sys('select seniority from report_stamps where report_id = $1', [rid2]))[0].seniority, chiefSen);
  await as(admin, 'select public.admin_move_rank($1, true)', [depRank]);
  assert.strictEqual((await sys('select seniority from report_stamps where report_id = $1', [rid2]))[0].seniority, depSen);
  assert.deepStrictEqual(await levels(rid2), ['副理:副理丙', '經理:待核閱', '協理:待核閱']);

  // 沒有所屬部門不能填寫週報
  await sys('update profiles set department_id = null where id = $1', [S]);
  await assert.rejects(save(S, null, '2027-02-15', '沒有部門', true), /尚未設定所屬部門/);
  await sys('update profiles set department_id = $2 where id = $1', [S, dF]);
});
