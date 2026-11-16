'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const db = require('./db');
const PgStore = require('./session-store');
const util = require('./util');

const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 小時

// 未設定 SESSION_SECRET 時，將隨機金鑰保存在資料庫，避免重啟後全部登出
async function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  await db.query(
    "insert into settings (key, value) values ('session_secret', $1) on conflict (key) do nothing",
    [crypto.randomBytes(32).toString('hex')]
  );
  return (await db.one("select value from settings where key = 'session_secret'")).value;
}

async function createApp() {
  await db.init();

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
  app.disable('x-powered-by');

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.use(session({
    name: 'wr.sid',
    secret: await sessionSecret(),
    store: new PgStore(db, SESSION_TTL),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === '1',
      maxAge: SESSION_TTL,
    },
  }));

  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // 載入登入者（每次都重新讀取，停用帳號立即生效）
  app.use(async (req, res, next) => {
    if (req.session.userId) {
      const user = await db.one(
        `select u.id, u.username, u.name, u.role, u.department_id, u.active, u.must_change_password,
                d.name as department_name
         from users u left join departments d on d.id = u.department_id where u.id = $1`,
        [req.session.userId]
      );
      if (user && user.active) req.user = user;
      else delete req.session.userId;
    }
    // CSRF token
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    res.locals.csrfToken = req.session.csrf;
    res.locals.currentUser = req.user || null;
    res.locals.util = util;
    res.locals.path = req.path;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    next();
  });

  app.use((req, res, next) => {
    if (req.method === 'POST') {
      const token = req.body && req.body._csrf;
      const a = Buffer.from(String(token || ''));
      const b = Buffer.from(req.session.csrf);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(403).render('error', { title: '請求無效', message: '頁面已過期或請求無效，請重新整理後再試一次。' });
      }
    }
    next();
  });

  // 首次登入強制修改密碼
  app.use((req, res, next) => {
    if (req.user && req.user.must_change_password && !['/account/password', '/logout'].includes(req.path)) {
      return res.redirect('/account/password');
    }
    next();
  });

  app.use(require('./routes/auth'));
  app.use(require('./routes/reports'));
  app.use(require('./routes/review'));
  app.use(require('./routes/admin'));

  app.get('/', (req, res) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.role === 'staff') return res.redirect('/reports');
    return res.redirect('/review');
  });

  app.use((req, res) => {
    res.status(404).render('error', { title: '找不到頁面', message: '您要找的頁面不存在。' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { title: '系統錯誤', message: '系統發生錯誤，請稍後再試。' });
  });

  return app;
}

module.exports = { createApp };
