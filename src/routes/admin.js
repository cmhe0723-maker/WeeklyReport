'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, transaction } = require('../db');
const { requireRole, flash } = require('../auth');

const router = express.Router();
const admin = requireRole('admin');
const ROLES = ['admin', 'manager', 'staff'];

/* ---------- 部門 ---------- */
router.get('/admin/departments', admin, (req, res) => {
  const departments = db.prepare(
    `SELECT d.id, d.name,
       (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id) AS member_count,
       (SELECT GROUP_CONCAT(u.name, '、') FROM manager_departments md JOIN users u ON u.id = md.user_id
          WHERE md.department_id = d.id AND u.active = 1) AS managers
     FROM departments d ORDER BY d.name`
  ).all();
  res.render('admin/departments', { title: '部門管理', departments });
});

router.post('/admin/departments', admin, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 50);
  if (!name) flash(req, 'error', '請輸入部門名稱。');
  else if (db.prepare('SELECT 1 FROM departments WHERE name = ?').get(name)) flash(req, 'error', '部門名稱已存在。');
  else {
    db.prepare('INSERT INTO departments (name) VALUES (?)').run(name);
    flash(req, 'success', `已新增部門「${name}」。`);
  }
  res.redirect('/admin/departments');
});

router.post('/admin/departments/:id', admin, (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body.name || '').trim().slice(0, 50);
  if (!name) flash(req, 'error', '部門名稱不可空白。');
  else if (db.prepare('SELECT 1 FROM departments WHERE name = ? AND id <> ?').get(name, id)) flash(req, 'error', '部門名稱已存在。');
  else {
    db.prepare('UPDATE departments SET name = ? WHERE id = ?').run(name, id);
    flash(req, 'success', '部門名稱已更新。');
  }
  res.redirect('/admin/departments');
});

router.post('/admin/departments/:id/delete', admin, (req, res) => {
  const id = Number(req.params.id);
  const members = db.prepare('SELECT COUNT(*) AS c FROM users WHERE department_id = ?').get(id).c;
  if (members > 0) flash(req, 'error', '此部門仍有人員，請先將人員移至其他部門。');
  else {
    db.prepare('DELETE FROM departments WHERE id = ?').run(id);
    flash(req, 'success', '部門已刪除。');
  }
  res.redirect('/admin/departments');
});

/* ---------- 人員 ---------- */
router.get('/admin/users', admin, (req, res) => {
  const dept = Number(req.query.dept) || 0;
  const users = db.prepare(
    `SELECT u.id, u.username, u.name, u.role, u.active, u.department_id, d.name AS department_name,
       (SELECT GROUP_CONCAT(d2.name, '、') FROM manager_departments md JOIN departments d2 ON d2.id = md.department_id
          WHERE md.user_id = u.id) AS managed
     FROM users u LEFT JOIN departments d ON d.id = u.department_id
     ${dept ? 'WHERE u.department_id = ?' : ''}
     ORDER BY u.active DESC, d.name, CASE u.role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, u.name`
  ).all(...(dept ? [dept] : []));
  const departments = db.prepare('SELECT id, name FROM departments ORDER BY name').all();
  res.render('admin/users', { title: '人員與權限', users, departments, dept });
});

function formData(user) {
  return {
    user,
    departments: db.prepare('SELECT id, name FROM departments ORDER BY name').all(),
  };
}

router.get('/admin/users/new', admin, (req, res) => {
  res.render('admin/user-form', {
    title: '新增人員', error: null,
    ...formData({ id: null, username: '', name: '', role: 'staff', department_id: null, active: 1, managed: [] }),
  });
});

router.get('/admin/users/:id', admin, (req, res) => {
  const user = db.prepare('SELECT id, username, name, role, department_id, active FROM users WHERE id = ?').get(Number(req.params.id));
  if (!user) return res.status(404).render('error', { title: '找不到人員', message: '人員不存在。' });
  user.managed = db.prepare('SELECT department_id FROM manager_departments WHERE user_id = ?').all(user.id).map(r => r.department_id);
  res.render('admin/user-form', { title: '編輯人員', error: null, ...formData(user) });
});

function parseUserBody(body) {
  let managed = body.managed || [];
  if (!Array.isArray(managed)) managed = [managed];
  return {
    username: String(body.username || '').trim().slice(0, 50),
    name: String(body.name || '').trim().slice(0, 50),
    role: ROLES.includes(body.role) ? body.role : 'staff',
    department_id: Number(body.department_id) || null,
    active: body.active ? 1 : 0,
    managed: [...new Set(managed.map(Number).filter(Boolean))],
    password: String(body.password || ''),
  };
}

function validate(data, isNew, editingId) {
  if (!/^[A-Za-z0-9._-]{3,50}$/.test(data.username)) return '帳號需為 3–50 個英數字或 . _ - 符號。';
  if (!data.name) return '請輸入姓名。';
  if (data.role !== 'admin' && !data.department_id) return '請選擇所屬部門。';
  if (isNew && data.password.length < 8) return '初始密碼至少需 8 個字元。';
  if (!isNew && data.password && data.password.length < 8) return '重設密碼至少需 8 個字元。';
  if (data.role === 'manager' && data.managed.length === 0) return '主管至少需設定一個可查閱的部門。';
  const dup = db.prepare('SELECT id FROM users WHERE username = ?').get(data.username);
  if (dup && dup.id !== editingId) return '此帳號已被使用。';
  return null;
}

function saveManaged(userId, role, managed) {
  db.prepare('DELETE FROM manager_departments WHERE user_id = ?').run(userId);
  if (role !== 'manager') return;
  const ins = db.prepare('INSERT OR IGNORE INTO manager_departments (user_id, department_id) SELECT ?, id FROM departments WHERE id = ?');
  for (const d of managed) ins.run(userId, d);
}

router.post('/admin/users', admin, (req, res) => {
  const data = parseUserBody(req.body);
  const error = validate(data, true, null);
  if (error) {
    return res.status(400).render('admin/user-form', { title: '新增人員', error, ...formData({ id: null, ...data }) });
  }
  transaction(() => {
    const info = db.prepare(
      `INSERT INTO users (username, password_hash, name, role, department_id, active, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    ).run(data.username, bcrypt.hashSync(data.password, 10), data.name, data.role, data.department_id, data.active);
    saveManaged(Number(info.lastInsertRowid), data.role, data.managed);
  });
  flash(req, 'success', `已新增人員「${data.name}」，首次登入需變更密碼。`);
  res.redirect('/admin/users');
});

router.post('/admin/users/:id', admin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).render('error', { title: '找不到人員', message: '人員不存在。' });
  const data = parseUserBody(req.body);
  let error = validate(data, false, id);
  if (!error && id === req.user.id && (data.role !== 'admin' || !data.active)) {
    error = '不可停用自己的帳號或移除自己的管理員權限。';
  }
  if (error) {
    return res.status(400).render('admin/user-form', { title: '編輯人員', error, ...formData({ id, ...data }) });
  }
  transaction(() => {
    db.prepare('UPDATE users SET username = ?, name = ?, role = ?, department_id = ?, active = ? WHERE id = ?')
      .run(data.username, data.name, data.role, data.department_id, data.active, id);
    if (data.password) {
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?')
        .run(bcrypt.hashSync(data.password, 10), id);
    }
    saveManaged(id, data.role, data.managed);
    if (!data.active) db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?").run(id);
  });
  flash(req, 'success', `已更新人員「${data.name}」。`);
  res.redirect('/admin/users');
});

module.exports = router;
