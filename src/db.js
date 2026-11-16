'use strict';
const fs = require('node:fs');
const path = require('node:path');
const pg = require('pg');
const bcrypt = require('bcryptjs');

// bigint (int8) → Number：本系統的 id 與 COUNT 都在安全整數範圍內
pg.types.setTypeParser(20, (v) => Number(v));
// date → 'YYYY-MM-DD' 字串（避免被轉成本地時區的 Date）
pg.types.setTypeParser(1082, (v) => v);

const SCHEMA_FILE = path.join(__dirname, '..', 'supabase', 'schema.sql');

/**
 * 連線設定
 *   DATABASE_URL      Supabase 連線字串（Dashboard → Connect）
 *   DATABASE_SSL      off | require | verify（預設：本機為 off，其他為 require）
 *   DATABASE_CA_CERT  DATABASE_SSL=verify 時使用的 CA 憑證檔路徑（Supabase 可下載）
 */
function poolConfig() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error('未設定 DATABASE_URL。請在 Supabase Dashboard → Connect 取得連線字串並設定此環境變數。');
  }
  const url = new URL(raw);
  // 由下方 ssl 選項統一控制，避免連線字串中的 sslmode 覆蓋設定
  url.searchParams.delete('sslmode');
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  const mode = process.env.DATABASE_SSL || (isLocal ? 'off' : 'require');
  let ssl = false;
  if (mode === 'require') ssl = { rejectUnauthorized: false };
  else if (mode === 'verify') {
    ssl = { rejectUnauthorized: true };
    if (process.env.DATABASE_CA_CERT) ssl.ca = fs.readFileSync(process.env.DATABASE_CA_CERT, 'utf8');
  } else if (mode !== 'off') {
    throw new Error(`DATABASE_SSL 只能是 off、require 或 verify，目前為「${mode}」。`);
  }
  return {
    connectionString: url.toString(),
    ssl,
    max: Number(process.env.DB_POOL_MAX) || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };
}

let pool = null;
function getPool() {
  if (!pool) {
    pool = new pg.Pool(poolConfig());
    pool.on('error', (err) => console.error('[db] 閒置連線發生錯誤：', err.message));
  }
  return pool;
}

// 查詢多筆
async function query(text, params) {
  return (await getPool().query(text, params)).rows;
}
// 查詢單筆（沒有則回傳 null）
async function one(text, params) {
  return (await getPool().query(text, params)).rows[0] || null;
}

// 交易：fn 收到 { query, one }，丟出例外即 rollback
async function tx(fn) {
  const client = await getPool().connect();
  const q = {
    query: async (t, p) => (await client.query(t, p)).rows,
    one: async (t, p) => (await client.query(t, p)).rows[0] || null,
  };
  try {
    await client.query('begin');
    const result = await fn(q);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// 執行 supabase/schema.sql 建立資料表（可重複執行）
async function migrate() {
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const client = await getPool().connect();
  try {
    await client.query(sql);
  } finally {
    client.release();
  }
}

async function ensureSchema() {
  const row = await one("select to_regclass('public.users') is not null as ok");
  if (row.ok) return;
  if (process.env.DB_AUTO_MIGRATE === '1') {
    console.log('[init] 找不到資料表，執行 supabase/schema.sql 建立中…');
    await migrate();
    return;
  }
  throw new Error('資料庫尚未建立資料表。請先執行 `npm run db:migrate`，或在 Supabase SQL Editor 執行 supabase/schema.sql。');
}

// 第一次啟動時建立預設系統管理員
async function ensureAdmin() {
  const { c } = await one('select count(*) as c from users');
  if (c > 0) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin1234';
  await query(
    `insert into users (username, password_hash, name, role, must_change_password)
     values ($1, $2, '系統管理員', 'admin', true)
     on conflict do nothing`,
    [username, bcrypt.hashSync(password, 10)]
  );
  console.log(`[init] 已建立預設管理員帳號：${username}（首次登入需變更密碼）`);
}

async function init() {
  await ensureSchema();
  await ensureAdmin();
}

async function close() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

module.exports = { query, one, tx, migrate, init, ensureAdmin, close, getPool };
