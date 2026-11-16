'use strict';
const express = require('express');
const { db, nowIso, transaction } = require('../db');
const { requireLogin, requireRole, canView, canReview, flash } = require('../auth');
const util = require('../util');

const router = express.Router();
const FIELDS = ['work_summary', 'customer_visits', 'sales_progress', 'next_week_plan', 'issues'];
const MAX_LEN = 10000;

const reportStmt = db.prepare(
  `SELECT r.*, u.name AS author_name, u.username AS author_username, u.department_id AS author_department_id,
          d.name AS department_name, rv.name AS reviewer_name
   FROM reports r
   JOIN users u ON u.id = r.user_id
   LEFT JOIN departments d ON d.id = u.department_id
   LEFT JOIN users rv ON rv.id = r.reviewed_by
   WHERE r.id = ?`
);
function getReport(id) {
  return reportStmt.get(Number(id) || 0);
}

const writers = requireRole('staff', 'manager');

// 我的週報列表
router.get('/reports', writers, (req, res) => {
  const reports = db.prepare(
    `SELECT r.id, r.week_start, r.status, r.submitted_at, r.updated_at, r.reviewed_at, r.review_comment, rv.name AS reviewer_name
     FROM reports r LEFT JOIN users rv ON rv.id = r.reviewed_by
     WHERE r.user_id = ? ORDER BY r.week_start DESC`
  ).all(req.user.id);
  const thisWeek = util.currentWeekStart();
  const thisWeekReport = reports.find(r => r.week_start === thisWeek) || null;
  res.render('reports/mine', { title: '我的週報', reports, thisWeek, thisWeekReport });
});

// 新增（指定週次）：若已存在則導向編輯
router.get('/reports/new', writers, (req, res) => {
  const week = util.weekStartOf(String(req.query.week || '')) || util.currentWeekStart();
  const existing = db.prepare('SELECT id FROM reports WHERE user_id = ? AND week_start = ?').get(req.user.id, week);
  if (existing) return res.redirect(`/reports/${existing.id}/edit`);
  renderForm(res, req.user, { id: null, week_start: week, status: 'draft' }, null);
});

function previousPlan(userId, week) {
  return db.prepare(
    `SELECT week_start, next_week_plan FROM reports
     WHERE user_id = ? AND week_start < ? AND next_week_plan <> '' ORDER BY week_start DESC LIMIT 1`
  ).get(userId, week) || null;
}

function renderForm(res, user, report, error, status = 200) {
  res.status(status).render('reports/form', {
    title: report.id ? '編輯週報' : '填寫週報',
    report,
    error,
    prev: previousPlan(user.id, report.week_start),
  });
}

function readFields(body) {
  const out = {};
  for (const f of FIELDS) out[f] = String(body[f] || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_LEN);
  return out;
}

router.post('/reports', writers, (req, res) => {
  const week = util.weekStartOf(String(req.body.week_start || ''));
  const fields = readFields(req.body);
  const submit = req.body.action === 'submit';
  const draft = { id: null, week_start: week || util.currentWeekStart(), status: 'draft', ...fields };
  if (!week) return renderForm(res, req.user, draft, '請選擇正確的週次日期。', 400);
  if (submit && !fields.work_summary) return renderForm(res, req.user, draft, '提交前請填寫「本週工作內容」。', 400);
  const exists = db.prepare('SELECT id FROM reports WHERE user_id = ? AND week_start = ?').get(req.user.id, week);
  if (exists) return renderForm(res, req.user, draft, `${util.weekLabel(week)} 已有週報，請改為編輯該份週報。`, 409);

  const now = nowIso();
  const info = db.prepare(
    `INSERT INTO reports (user_id, week_start, ${FIELDS.join(', ')}, status, submitted_at, created_at, updated_at)
     VALUES (?, ?, ${FIELDS.map(() => '?').join(', ')}, ?, ?, ?, ?)`
  ).run(req.user.id, week, ...FIELDS.map(f => fields[f]), submit ? 'submitted' : 'draft', submit ? now : null, now, now);
  flash(req, 'success', submit ? '週報已提交，等待主管查閱。' : '草稿已儲存。');
  res.redirect(`/reports/${info.lastInsertRowid}`);
});

router.get('/reports/:id/edit', writers, (req, res) => {
  const report = getReport(req.params.id);
  if (!report || report.user_id !== req.user.id) return notFound(res);
  if (report.reviewed_at) {
    flash(req, 'warning', '此週報主管已查閱，無法再修改。如需修改請洽主管撤回查閱。');
    return res.redirect(`/reports/${report.id}`);
  }
  renderForm(res, req.user, report, null);
});

router.post('/reports/:id', writers, (req, res) => {
  const report = getReport(req.params.id);
  if (!report || report.user_id !== req.user.id) return notFound(res);
  if (report.reviewed_at) {
    flash(req, 'warning', '此週報主管已查閱，無法再修改。');
    return res.redirect(`/reports/${report.id}`);
  }
  const fields = readFields(req.body);
  const submit = req.body.action === 'submit' || (report.status === 'submitted' && req.body.action !== 'draft');
  if (submit && !fields.work_summary) {
    return renderForm(res, req.user, { ...report, ...fields }, '提交前請填寫「本週工作內容」。', 400);
  }
  const now = nowIso();
  db.prepare(
    `UPDATE reports SET ${FIELDS.map(f => `${f} = ?`).join(', ')}, status = ?, submitted_at = ?, updated_at = ?
     WHERE id = ? AND reviewed_at IS NULL`
  ).run(...FIELDS.map(f => fields[f]), submit ? 'submitted' : 'draft',
    submit ? (report.submitted_at || now) : null, now, report.id);
  flash(req, 'success', submit ? '週報已更新並提交。' : '草稿已儲存。');
  res.redirect(`/reports/${report.id}`);
});

router.post('/reports/:id/delete', writers, (req, res) => {
  const report = getReport(req.params.id);
  if (!report || report.user_id !== req.user.id) return notFound(res);
  if (report.status !== 'draft') {
    flash(req, 'warning', '只有草稿可以刪除。');
    return res.redirect(`/reports/${report.id}`);
  }
  db.prepare('DELETE FROM reports WHERE id = ?').run(report.id);
  flash(req, 'success', '草稿已刪除。');
  res.redirect('/reports');
});

// 檢視週報（本人或有權限的主管／管理員）
router.get('/reports/:id', requireLogin, (req, res) => {
  const report = getReport(req.params.id);
  if (!report || !canView(req.user, report)) return notFound(res);
  const logs = db.prepare(
    `SELECT l.action, l.comment, l.created_at, u.name AS user_name FROM review_logs l
     LEFT JOIN users u ON u.id = l.user_id WHERE l.report_id = ? ORDER BY l.id DESC`
  ).all(report.id);
  if (report.user_id !== req.user.id) res.locals.path = '/review'; // 導覽列標示「週報查閱」
  res.render('reports/view', {
    title: `${report.author_name} 的週報`,
    report,
    logs,
    canReview: canReview(req.user, report),
    isOwner: report.user_id === req.user.id,
    backUrl: safeBack(req.query.back) || (report.user_id === req.user.id ? '/reports' : '/review'),
  });
});

// 主管查閱：標記已查閱／撤回／僅留言
router.post('/reports/:id/review', requireRole('admin', 'manager'), (req, res) => {
  const report = getReport(req.params.id);
  if (!report || !canReview(req.user, report)) return notFound(res);
  const comment = String(req.body.comment || '').trim().slice(0, 2000);
  const action = req.body.action;
  const now = nowIso();
  const back = safeBack(req.body.back);
  const backQs = back ? `?back=${encodeURIComponent(back)}` : '';

  transaction(() => {
    if (action === 'review') {
      db.prepare('UPDATE reports SET reviewed_by = ?, reviewed_at = ?, review_comment = ? WHERE id = ?')
        .run(req.user.id, now, comment, report.id);
      db.prepare("INSERT INTO review_logs (report_id, user_id, action, comment, created_at) VALUES (?, ?, 'reviewed', ?, ?)")
        .run(report.id, req.user.id, comment, now);
      flash(req, 'success', '已標記為「查閱完成」。');
    } else if (action === 'unreview') {
      db.prepare("UPDATE reports SET reviewed_by = NULL, reviewed_at = NULL, review_comment = '' WHERE id = ?").run(report.id);
      db.prepare("INSERT INTO review_logs (report_id, user_id, action, comment, created_at) VALUES (?, ?, 'unreviewed', ?, ?)")
        .run(report.id, req.user.id, comment, now);
      flash(req, 'success', '已撤回查閱狀態，業務人員可再次修改。');
    } else if (action === 'comment' && comment) {
      db.prepare('UPDATE reports SET review_comment = ? WHERE id = ?').run(comment, report.id);
      db.prepare("INSERT INTO review_logs (report_id, user_id, action, comment, created_at) VALUES (?, ?, 'commented', ?, ?)")
        .run(report.id, req.user.id, comment, now);
      flash(req, 'success', '主管意見已更新。');
    }
  });
  res.redirect(`/reports/${report.id}${backQs}`);
});

function safeBack(v) {
  return typeof v === 'string' && v.startsWith('/review') ? v : null;
}

function notFound(res) {
  return res.status(404).render('error', { title: '找不到週報', message: '週報不存在，或您沒有權限查看。' });
}

module.exports = router;
