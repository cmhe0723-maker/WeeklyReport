'use strict';
// 建立示範資料：npm run seed:demo
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const util = require('../src/util');

async function main() {
  await db.init();
  const pw = bcrypt.hashSync('demo1234', 10);

  const dept = async (name) => {
    await db.query('insert into departments (name) values ($1) on conflict (name) do nothing', [name]);
    return (await db.one('select id from departments where name = $1', [name])).id;
  };
  const user = async (username, name, role, deptId, managed = []) => {
    await db.query(
      `insert into users (username, password_hash, name, role, department_id) values ($1, $2, $3, $4, $5)
       on conflict do nothing`,
      [username, pw, name, role, deptId]
    );
    const id = (await db.one('select id from users where lower(username) = lower($1)', [username])).id;
    for (const d of managed) {
      await db.query('insert into manager_departments (user_id, department_id) values ($1, $2) on conflict do nothing', [id, d]);
    }
    return id;
  };

  const north = await dept('北區業務部');
  const south = await dept('南區業務部');
  await user('manager.north', '王經理', 'manager', north, [north]);
  await user('manager.south', '李經理', 'manager', south, [south]);
  const s1 = await user('sales.chen', '陳小明', 'staff', north);
  const s2 = await user('sales.lin', '林美華', 'staff', north);
  await user('sales.huang', '黃大偉', 'staff', south);

  const lastWeek = util.addDays(util.currentWeekStart(), -7);
  const ins = (uid, a, b, c, d) => db.query(
    `insert into reports (user_id, week_start, work_summary, customer_visits, sales_progress, next_week_plan, status, submitted_at)
     values ($1, $2, $3, $4, $5, $6, 'submitted', now()) on conflict (user_id, week_start) do nothing`,
    [uid, lastWeek, a, b, c, d]
  );
  await ins(s1, '1. 拜訪大成科技，介紹新產品方案\n2. 完成長興企業報價單', '大成科技－採購王課長，對方案有興趣', '長興企業報價 NT$ 350,000，預計月底簽約', '追蹤長興企業簽約進度');
  await ins(s2, '1. 參加產業展覽，收集 20 張名片\n2. 電話開發 15 家', '', '新增潛在客戶 6 家', '安排潛在客戶拜訪');

  console.log('示範資料建立完成，示範帳號密碼皆為 demo1234：');
  console.log('  主管：manager.north / manager.south');
  console.log('  業務：sales.chen / sales.lin / sales.huang');
}

main()
  .catch((e) => { console.error('[seed 失敗]', e.message); process.exitCode = 1; })
  .finally(() => db.close());
