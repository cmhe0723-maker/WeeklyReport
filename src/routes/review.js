'use strict';
const express = require('express');
const db = require('../db');
const { requireRole, managedDeptIds, canReview, flash } = require('../auth');
const util = require('../util');

const router = express.Router();
const reviewers = requireRole('admin', 'manager');

async function scopeDepartments(user) {
  const ids = await managedDeptIds(user);
  const all = await db.query('select id, name from departments order by name');
  return ids === null ? all : all.filter((d) => ids.includes(d.id));
}

function stateOf(r) {
  if (!r.id) return 'missing';
  if (r.status === 'draft') return 'draft';
  return r.reviewed_at ? 'reviewed' : 'pending';
}

router.get('/review', reviewers, async (req, res) => {
  const departments = await scopeDepartments(req.user);
  const deptIds = departments.map((d) => d.id);
  const weekParam = req.query.week === undefined ? util.currentWeekStart() : String(req.query.week);
  const week = weekParam === 'all' ? null : (util.weekStartOf(weekParam) || util.currentWeekStart());
  const deptFilter = Number(req.query.dept) || 0;
  const status = ['pending', 'reviewed', 'missing'].includes(req.query.status) ? req.query.status : 'all';

  const scopeIds = deptFilter && deptIds.includes(deptFilter) ? [deptFilter] : deptIds;
  const qs = new URLSearchParams({ week: week || 'all', dept: String(deptFilter || ''), status }).toString();
  const backUrl = '/review?' + qs;

  // 待查閱總數（所有週次）
  const { c: pendingTotal } = await db.one(
    `select count(*) as c from reports r join users u on u.id = r.user_id
     where r.status = 'submitted' and r.reviewed_at is null and u.department_id = any($1::bigint[]) and r.user_id <> $2`,
    [scopeIds, req.user.id]
  );

  let rows = [];
  let summary = null;
  if (week) {
    // 指定週：列出範圍內所有人員與週報狀態（含未填寫）
    rows = await db.query(
      `select u.id as user_id, u.name as author_name, u.role, d.name as department_name,
              r.id, r.status, r.submitted_at, r.reviewed_at, r.review_comment, r.work_summary, rv.name as reviewer_name
       from users u
       left join departments d on d.id = u.department_id
       left join reports r on r.user_id = u.id and r.week_start = $1
       left join users rv on rv.id = r.reviewed_by
       where u.active and u.role in ('staff', 'manager') and u.id <> $2 and u.department_id = any($3::bigint[])
       order by d.name, u.role desc, u.name`,
      [week, req.user.id, scopeIds]
    );
    for (const r of rows) r.state = stateOf(r);
    summary = {
      total: rows.length,
      missing: rows.filter((r) => r.state === 'missing' || r.state === 'draft').length,
      pending: rows.filter((r) => r.state === 'pending').length,
      reviewed: rows.filter((r) => r.state === 'reviewed').length,
    };
    if (status === 'pending') rows = rows.filter((r) => r.state === 'pending');
    else if (status === 'reviewed') rows = rows.filter((r) => r.state === 'reviewed');
    else if (status === 'missing') rows = rows.filter((r) => r.state === 'missing' || r.state === 'draft');
  } else if (status !== 'missing') {
    // 所有週次：列出已提交週報
    const cond = status === 'pending' ? 'and r.reviewed_at is null' : status === 'reviewed' ? 'and r.reviewed_at is not null' : '';
    rows = await db.query(
      `select r.id, r.user_id, r.week_start, r.status, r.submitted_at, r.reviewed_at, r.review_comment, r.work_summary,
              u.name as author_name, u.role, d.name as department_name, rv.name as reviewer_name
       from reports r
       join users u on u.id = r.user_id
       left join departments d on d.id = u.department_id
       left join users rv on rv.id = r.reviewed_by
       where r.status = 'submitted' and r.user_id <> $1 and u.department_id = any($2::bigint[]) ${cond}
       order by r.week_start desc, d.name, u.name limit 500`,
      [req.user.id, scopeIds]
    );
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

// 批次標記查閱完成
router.post('/review/batch', reviewers, async (req, res) => {
  let ids = req.body.ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = [...new Set(ids.slice(0, 500).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
  const back = typeof req.body.back === 'string' && req.body.back.startsWith('/review') ? req.body.back : '/review';

  const candidates = ids.length ? await db.query(
    `select r.id, r.user_id, r.status, r.reviewed_at, u.department_id as author_department_id
     from reports r join users u on u.id = r.user_id where r.id = any($1::bigint[])`,
    [ids]
  ) : [];
  const allowed = [];
  for (const r of candidates) {
    if (!r.reviewed_at && (await canReview(req.user, r))) allowed.push(r.id);
  }
  const n = allowed.length ? await db.tx(async (t) => {
    const done = await t.query(
      `update reports set reviewed_by = $1, reviewed_at = now()
       where id = any($2::bigint[]) and reviewed_at is null and status = 'submitted' returning id`,
      [req.user.id, allowed]
    );
    await t.query(
      "insert into review_logs (report_id, user_id, action) select unnest($1::bigint[]), $2, 'reviewed'",
      [done.map((r) => r.id), req.user.id]
    );
    return done.length;
  }) : 0;
  flash(req, n ? 'success' : 'warning', n ? `已將 ${n} 份週報標記為查閱完成。` : '沒有可標記的週報。');
  res.redirect(back);
});

module.exports = router;
