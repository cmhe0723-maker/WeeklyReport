'use strict';
// 建立示範資料：npm run seed:demo
const bcrypt = require('bcryptjs');
const { db, ensureAdmin, nowIso } = require('../src/db');
const util = require('../src/util');

ensureAdmin();
const pw = bcrypt.hashSync('demo1234', 10);

function dept(name) {
  db.prepare('INSERT OR IGNORE INTO departments (name) VALUES (?)').run(name);
  return db.prepare('SELECT id FROM departments WHERE name = ?').get(name).id;
}
function user(username, name, role, deptId, managed = []) {
  db.prepare(`INSERT OR IGNORE INTO users (username, password_hash, name, role, department_id) VALUES (?, ?, ?, ?, ?)`)
    .run(username, pw, name, role, deptId);
  const id = db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
  for (const d of managed) db.prepare('INSERT OR IGNORE INTO manager_departments VALUES (?, ?)').run(id, d);
  return id;
}

const north = dept('北區業務部');
const south = dept('南區業務部');
user('manager.north', '王經理', 'manager', north, [north]);
user('manager.south', '李經理', 'manager', south, [south]);
const s1 = user('sales.chen', '陳小明', 'staff', north);
const s2 = user('sales.lin', '林美華', 'staff', north);
user('sales.huang', '黃大偉', 'staff', south);

const lastWeek = util.addDays(util.currentWeekStart(), -7);
const ins = db.prepare(`INSERT OR IGNORE INTO reports (user_id, week_start, work_summary, customer_visits, sales_progress, next_week_plan, status, submitted_at)
  VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?)`);
ins.run(s1, lastWeek, '1. 拜訪大成科技，介紹新產品方案\n2. 完成長興企業報價單', '大成科技－採購王課長，對方案有興趣', '長興企業報價 NT$ 350,000，預計月底簽約', '追蹤長興企業簽約進度', nowIso());
ins.run(s2, lastWeek, '1. 參加產業展覽，收集 20 張名片\n2. 電話開發 15 家', '', '新增潛在客戶 6 家', '安排潛在客戶拜訪', nowIso());

console.log('示範資料建立完成，示範帳號密碼皆為 demo1234：');
console.log('  主管：manager.north / manager.south');
console.log('  業務：sales.chen / sales.lin / sales.huang');
