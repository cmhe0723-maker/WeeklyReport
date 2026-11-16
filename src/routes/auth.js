'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireLogin, flash } = require('../auth');

const router = express.Router();

// 簡易登入失敗鎖定：同帳號 + IP 連續失敗 5 次鎖 15 分鐘
const failures = new Map();
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: '登入', error: null, username: '', next: safeNext(req.query.next) });
});

router.post('/login', (req, res, next) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const nextUrl = safeNext(req.body.next);
  const key = username.toLowerCase() + '|' + req.ip;
  const f = failures.get(key);
  const fail = (msg) => res.status(401).render('login', { title: '登入', error: msg, username, next: nextUrl });

  if (f && f.count >= MAX_FAILS && Date.now() - f.last < LOCK_MS) {
    return fail('登入失敗次數過多，請 15 分鐘後再試。');
  }
  const user = db.prepare('SELECT id, password_hash, active FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    const cur = f && Date.now() - f.last < LOCK_MS ? f : { count: 0 };
    failures.set(key, { count: cur.count + 1, last: Date.now() });
    return fail('帳號或密碼錯誤。');
  }
  if (!user.active) return fail('此帳號已停用，請洽系統管理員。');
  failures.delete(key);

  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    res.redirect(nextUrl);
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('wr.sid');
    res.redirect('/login');
  });
});

router.get('/account/password', requireLogin, (req, res) => {
  res.render('password', { title: '變更密碼', error: null });
});

router.post('/account/password', requireLogin, (req, res) => {
  const { current, password, confirm } = req.body;
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const err = (msg) => res.status(400).render('password', { title: '變更密碼', error: msg });
  if (!bcrypt.compareSync(String(current || ''), row.password_hash)) return err('目前密碼不正確。');
  if (String(password || '').length < 8) return err('新密碼至少需 8 個字元。');
  if (password !== confirm) return err('兩次輸入的新密碼不一致。');
  if (password === current) return err('新密碼不可與目前密碼相同。');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(bcrypt.hashSync(password, 10), req.user.id);
  flash(req, 'success', '密碼已更新。');
  res.redirect('/');
});

module.exports = router;
