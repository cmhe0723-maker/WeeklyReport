'use strict';
const express = require('express');
const { db, nowIso, transaction } = require('../db');
const { requireRole, managedDeptIds, canReview, flash } = require('../auth');
const util = require('../util');

const router = express.Router();
const reviewers = requireRole('admin', 'manager');

function scopeDepartments(user) {
  const ids = managedDeptIds(user);
  const all = db.prepare('SELECT id, name FROM departments ORDER BY name').all();
  return ids === null ? all : all.filter(d => ids.includes(d.id));
}

router.get('/review', reviewers, (req, res) => {
  const departments = scopeDepartments(req.user);
  const deptIds = departments.map(d => d.id);
  const weekParam = req.query.week === undefined ? util.currentWeekStart() : String(req.query.week);
  const week = weekParam === 'all' ? null : (util.weekStartOf(weekParam) || util.currentWeekStart());
  const deptFilter = Number(req.query.dept) || 0;
  const status = ['pending', 'reviewed', 'missing'].includes(req.query.status) ? req.query.status : 'all';

  const scopeIds = deptFilter && deptIds.includes(deptFilter) ? [deptFilter] : deptIds;
  const placeholders = scopeIds.map(() => '?').join(',') || 'NULL';
  const qs = new URLSearchParams({ week: week || 'all', dept: String(deptFilter || ''), status }).toString();
  const backUrl = '/review?' + qs;

  // 待查閱總數（所有週次）
  const pendingTotal = scopeIds.length ? db.prepare(
    `SELECT COUNT(*) AS c FROM reports r JOIN users u ON u.id = r.user_id
     WHERE r.status = 'submitted' AND r.reviewed_at IS NULL AND u.department_id IN (${placeholders}) AND r.user_id <> ?`
  ).get(...scopeIds, req.user.id).c : 0;

  let rows = [];
  let summary = null;
  if (week) {
    // 指定週：列出範圍內所有人員與週報狀態（含未填寫）
    rows = scopeIds.length ? db.prepare(
      `SELECT u.id AS user_id, u.name AS author_name, u.role, d.name AS department_name,
              r.id, r.status, r.submitted_at, r.reviewed_at, r.review_comment, r.work_summary, rv.name AS reviewer_name
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN reports r ON r.user_id = u.id AND r.week_start = ?
       LEFT JOIN users rv ON rv.id = r.reviewed_by
       WHERE u.active = 1 AND u.role IN ('staff','manager') AND u.id <> ? AND u.department_id IN (${placeholders})
       ORDER BY d.name, u.role DESC, u.name`
    ).all(week, req.user.id, ...scopeIds) : [];
    for (const r of rows) r.state = stateOf(r);
    summary = {
      total: rows.length,
      missing: rows.filter(r => r.state === 'missing' || r.state === 'draft').length,
      pending: rows.filter(r => r.state === 'pending').length,
      reviewed: rows.filter(r => r.state === 'reviewed').length,
    };
    if (status === 'pending') rows = rows.filter(r => r.state === 'pending');
    else if (status === 'reviewed') rows = rows.filter(r => r.state === 'reviewed');
    else if (status === 'missing') rows = rows.filter(r => r.state === 'missing' || r.state === 'draft');
  } else {
    // 所有週次：列出已提交週報
    const cond = status === 'pending' ? 'AND r.reviewed_at IS NULL' : status === 'reviewed' ? 'AND r.reviewed_at IS NOT NULL' : '';
    rows = scopeIds.length && status !== 'missing' ? db.prepare(
      `SELECT r.id, r.user_id, r.week_start, r.status, r.submitted_at, r.reviewed_at, r.review_comment, r.work_summary,
              u.name AS author_name, u.role, d.name AS department_name, rv.name AS reviewer_name
       FROM reports r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN users rv ON rv.id = r.reviewed_by
       WHERE r.status = 'submitted' AND r.user_id <> ? AND u.department_id IN (${placeholders}) ${cond}
       ORDER BY r.week_start DESC, d.name, u.name LIMIT 500`
    ).all(req.user.id, ...scopeIds) : [];
    for (const r of rows) r.state = stateOf(r);
  }

  res.render('review', {
    title: '週報查閱',
    departments, week, deptFilter, status, rows, summary, pendingTotal, backUrl,
    prevWeek: util.addDays(week || util.currentWeekStart(), -7),
    nextWeek: util.addDays(week || util.currentWeekStart(), 7),
    thisWeek: util.currentWeekStart(),
  });
});

function stateOf(r) {
  if (!r.id) return 'missing';
  if (r.status === 'draft') return 'draft';
  return r.reviewed_at ? 'reviewed' : 'pending';
}

// 批次標記查閱完成
router.post('/review/batch', reviewers, (req, res) => {
  let ids = req.body.ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  const back = typeof req.body.back === 'string' && req.body.back.startsWith('/review') ? req.body.back : '/review';
  const stmt = db.prepare(
    `SELECT r.id, r.user_id, r.status, r.reviewed_at, u.department_id AS author_department_id
     FROM reports r JOIN users u ON u.id = r.user_id WHERE r.id = ?`
  );
  const now = nowIso();
  let n = 0;
  transaction(() => {
    for (const id of ids.slice(0, 500)) {
      const r = stmt.get(Number(id) || 0);
      if (!r || r.reviewed_at || !canReview(req.user, r)) continue;
      db.prepare('UPDATE reports SET reviewed_by = ?, reviewed_at = ? WHERE id = ?').run(req.user.id, now, r.id);
      db.prepare("INSERT INTO review_logs (report_id, user_id, action, created_at) VALUES (?, ?, 'reviewed', ?)").run(r.id, req.user.id, now);
      n++;
    }
  });
  flash(req, n ? 'success' : 'warning', n ? `已將 ${n} 份週報標記為查閱完成。` : '沒有可標記的週報。');
  res.redirect(back);
});

module.exports = router;
