'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireRole, flash } = require('../auth');

const router = express.Router();
const admin = requireRole('admin');
const ROLES = ['admin', 'manager', 'staff'];

function idParam(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/* ---------- 部門 ---------- */
router.get('/admin/departments', admin, async (req, res) => {
  const departments = await db.query(
    `select d.id, d.name,
       (select count(*) from users u where u.department_id = d.id) as member_count,
       (select string_agg(u.name, '、' order by u.name) from manager_departments md join users u on u.id = md.user_id
          where md.department_id = d.id and u.active) as managers
     from departments d order by d.name`
  );
  res.render('admin/departments', { title: '部門管理', departments });
});

router.post('/admin/departments', admin, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 50);
  if (!name) flash(req, 'error', '請輸入部門名稱。');
  else {
    const row = await db.one('insert into departments (name) values ($1) on conflict (name) do nothing returning id', [name]);
    if (row) flash(req, 'success', `已新增部門「${name}」。`);
    else flash(req, 'error', '部門名稱已存在。');
  }
  res.redirect('/admin/departments');
});

router.post('/admin/departments/:id', admin, async (req, res) => {
  const id = idParam(req.params.id);
  const name = String(req.body.name || '').trim().slice(0, 50);
  if (!name) flash(req, 'error', '部門名稱不可空白。');
  else if (await db.one('select 1 from departments where name = $1 and id <> $2', [name, id])) flash(req, 'error', '部門名稱已存在。');
  else {
    await db.query('update departments set name = $1 where id = $2', [name, id]);
    flash(req, 'success', '部門名稱已更新。');
  }
  res.redirect('/admin/departments');
});

router.post('/admin/departments/:id/delete', admin, async (req, res) => {
  const id = idParam(req.params.id);
  const deleted = await db.one(
    'delete from departments where id = $1 and not exists (select 1 from users where department_id = $1) returning id',
    [id]
  );
  if (deleted) flash(req, 'success', '部門已刪除。');
  else flash(req, 'error', '此部門仍有人員，請先將人員移至其他部門。');
  res.redirect('/admin/departments');
});

/* ---------- 人員 ---------- */
router.get('/admin/users', admin, async (req, res) => {
  const dept = idParam(req.query.dept);
  const users = await db.query(
    `select u.id, u.username, u.name, u.role, u.active, u.department_id, d.name as department_name,
       (select string_agg(d2.name, '、' order by d2.name) from manager_departments md join departments d2 on d2.id = md.department_id
          where md.user_id = u.id) as managed
     from users u left join departments d on d.id = u.department_id
     where ($1::bigint = 0 or u.department_id = $1)
     order by u.active desc, d.name, case u.role when 'admin' then 0 when 'manager' then 1 else 2 end, u.name`,
    [dept]
  );
  const departments = await db.query('select id, name from departments order by name');
  res.render('admin/users', { title: '人員與權限', users, departments, dept });
});

async function formData(user) {
  return { user, departments: await db.query('select id, name from departments order by name') };
}

router.get('/admin/users/new', admin, async (req, res) => {
  res.render('admin/user-form', {
    title: '新增人員', error: null,
    ...(await formData({ id: null, username: '', name: '', role: 'staff', department_id: null, active: true, managed: [] })),
  });
});

router.get('/admin/users/:id', admin, async (req, res) => {
  const user = await db.one('select id, username, name, role, department_id, active from users where id = $1', [idParam(req.params.id)]);
  if (!user) return res.status(404).render('error', { title: '找不到人員', message: '人員不存在。' });
  user.managed = (await db.query('select department_id from manager_departments where user_id = $1', [user.id])).map((r) => r.department_id);
  res.render('admin/user-form', { title: '編輯人員', error: null, ...(await formData(user)) });
});

function parseUserBody(body) {
  let managed = body.managed || [];
  if (!Array.isArray(managed)) managed = [managed];
  return {
    username: String(body.username || '').trim().slice(0, 50),
    name: String(body.name || '').trim().slice(0, 50),
    role: ROLES.includes(body.role) ? body.role : 'staff',
    department_id: idParam(body.department_id) || null,
    active: Boolean(body.active),
    managed: [...new Set(managed.map(idParam).filter(Boolean))],
    password: String(body.password || ''),
  };
}

async function validate(data, isNew, editingId) {
  if (!/^[A-Za-z0-9._-]{3,50}$/.test(data.username)) return '帳號需為 3–50 個英數字或 . _ - 符號。';
  if (!data.name) return '請輸入姓名。';
  if (data.role !== 'admin' && !data.department_id) return '請選擇所屬部門。';
  if (isNew && data.password.length < 8) return '初始密碼至少需 8 個字元。';
  if (!isNew && data.password && data.password.length < 8) return '重設密碼至少需 8 個字元。';
  if (data.role === 'manager' && data.managed.length === 0) return '主管至少需設定一個可查閱的部門。';
  const dup = await db.one('select id from users where lower(username) = lower($1)', [data.username]);
  if (dup && dup.id !== editingId) return '此帳號已被使用。';
  return null;
}

async function saveManaged(t, userId, role, managed) {
  await t.query('delete from manager_departments where user_id = $1', [userId]);
  if (role !== 'manager' || !managed.length) return;
  await t.query(
    `insert into manager_departments (user_id, department_id)
     select $1, id from departments where id = any($2::bigint[]) on conflict do nothing`,
    [userId, managed]
  );
}

router.post('/admin/users', admin, async (req, res) => {
  const data = parseUserBody(req.body);
  const error = await validate(data, true, null);
  if (error) {
    return res.status(400).render('admin/user-form', { title: '新增人員', error, ...(await formData({ id: null, ...data })) });
  }
  const hash = await bcrypt.hash(data.password, 10);
  await db.tx(async (t) => {
    const row = await t.one(
      `insert into users (username, password_hash, name, role, department_id, active, must_change_password)
       values ($1, $2, $3, $4, $5, $6, true) returning id`,
      [data.username, hash, data.name, data.role, data.department_id, data.active]
    );
    await saveManaged(t, row.id, data.role, data.managed);
  });
  flash(req, 'success', `已新增人員「${data.name}」，首次登入需變更密碼。`);
  res.redirect('/admin/users');
});

router.post('/admin/users/:id', admin, async (req, res) => {
  const id = idParam(req.params.id);
  const existing = await db.one('select id from users where id = $1', [id]);
  if (!existing) return res.status(404).render('error', { title: '找不到人員', message: '人員不存在。' });
  const data = parseUserBody(req.body);
  let error = await validate(data, false, id);
  if (!error && id === req.user.id && (data.role !== 'admin' || !data.active)) {
    error = '不可停用自己的帳號或移除自己的管理員權限。';
  }
  if (error) {
    return res.status(400).render('admin/user-form', { title: '編輯人員', error, ...(await formData({ id, ...data })) });
  }
  const hash = data.password ? await bcrypt.hash(data.password, 10) : null;
  await db.tx(async (t) => {
    await t.query('update users set username = $1, name = $2, role = $3, department_id = $4, active = $5 where id = $6',
      [data.username, data.name, data.role, data.department_id, data.active, id]);
    if (hash) await t.query('update users set password_hash = $1, must_change_password = true where id = $2', [hash, id]);
    await saveManaged(t, id, data.role, data.managed);
    if (!data.active) await t.query("delete from sessions where (data ->> 'userId')::bigint = $1", [id]);
  });
  flash(req, 'success', `已更新人員「${data.name}」。`);
  res.redirect('/admin/users');
});

module.exports = router;
