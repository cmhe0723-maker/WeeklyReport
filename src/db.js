'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'weekly-report.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS departments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash        TEXT NOT NULL,
  name                 TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('admin','manager','staff')),
  department_id        INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  active               INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 主管可管理（查閱）的部門，一位主管可管理多個部門
CREATE TABLE IF NOT EXISTS manager_departments (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, department_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start      TEXT NOT NULL,              -- 該週週一 YYYY-MM-DD
  work_summary    TEXT NOT NULL DEFAULT '',   -- 本週工作內容
  customer_visits TEXT NOT NULL DEFAULT '',   -- 客戶拜訪紀錄
  sales_progress  TEXT NOT NULL DEFAULT '',   -- 業績 / 案件進度
  next_week_plan  TEXT NOT NULL DEFAULT '',   -- 下週工作計畫
  issues          TEXT NOT NULL DEFAULT '',   -- 問題與需協助事項
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
  submitted_at    TEXT,
  reviewed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     TEXT,
  review_comment  TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_reports_week ON reports(week_start);

-- 查閱歷程（標記查閱、撤回查閱）
CREATE TABLE IF NOT EXISTS review_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id  INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL CHECK (action IN ('reviewed','unreviewed','commented')),
  comment    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  data    TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`);

function nowIso() {
  return new Date().toISOString();
}

// 第一次啟動時建立預設系統管理員
function ensureAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;
  const password = process.env.ADMIN_PASSWORD || 'admin1234';
  db.prepare(
    `INSERT INTO users (username, password_hash, name, role, must_change_password)
     VALUES (?, ?, ?, 'admin', 1)`
  ).run(process.env.ADMIN_USERNAME || 'admin', bcrypt.hashSync(password, 10), '系統管理員');
  console.log(`[init] 已建立預設管理員帳號：${process.env.ADMIN_USERNAME || 'admin'}（首次登入需變更密碼）`);
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, ensureAdmin, nowIso, transaction };
