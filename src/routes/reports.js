'use strict';
const express = require('express');
const db = require('../db');
const { requireLogin, requireRole, canView, canReview, flash } = require('../auth');
const util = require('../util');

const router = express.Router();
const FIELDS = ['work_summary', 'customer_visits', 'sales_progress', 'next_week_plan', 'issues'];
const MAX_LEN = 10000;

function getReport(id) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return db.one(
    `select r.*, u.name as author_name, u.username as author_username, u.department_id as author_department_id,
            d.name as department_name, rv.name as reviewer_name
     from reports r
     join users u on u.id = r.user_id
     left join departments d on d.id = u.department_id
     left join users rv on rv.id = r.reviewed_by
     where r.id = $1`,
    [n]
  );
}

const writers = requireRole('staff', 'manager');

// 我的週報列表
router.get('/reports', writers, async (req, res) => {
  const reports = await db.query(
    `select r.id, r.week_start, r.status, r.submitted_at, r.updated_at, r.reviewed_at, r.review_comment, rv.name as reviewer_name
     from reports r left join users rv on rv.id = r.reviewed_by
     where r.user_id = $1 order by r.week_start desc`,
    [req.user.id]
  );
  const thisWeek = util.currentWeekStart();
  const thisWeekReport = reports.find((r) => r.week_start === thisWeek) || null;
  res.render('reports/mine', { title: '我的週報', reports, thisWeek, thisWeekReport });
});

// 新增（指定週次）：若已存在則導向編輯
router.get('/reports/new', writers, async (req, res) => {
  const week = util.weekStartOf(String(req.query.week || '')) || util.currentWeekStart();
  const existing = await db.one('select id from reports where user_id = $1 and week_start = $2', [req.user.id, week]);
  if (existing) return res.redirect(`/reports/${existing.id}/edit`);
  await renderForm(res, req.user, { id: null, week_start: week, status: 'draft' }, null);
});

function previousPlan(userId, week) {
  return db.one(
    `select week_start, next_week_plan from reports
     where user_id = $1 and week_start < $2 and next_week_plan <> '' order by week_start desc limit 1`,
    [userId, week]
  );
}

async function renderForm(res, user, report, error, status = 200) {
  res.status(status).render('reports/form', {
    title: report.id ? '編輯週報' : '填寫週報',
    report,
    error,
    prev: await previousPlan(user.id, report.week_start),
  });
}

function readFields(body) {
  const out = {};
  for (const f of FIELDS) out[f] = String(body[f] || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_LEN);
  return out;
}

router.post('/reports', writers, async (req, res) => {
  const week = util.weekStartOf(String(req.body.week_start || ''));
  const fields = readFields(req.body);
  const submit = req.body.action === 'submit';
  const draft = { id: null, week_start: week || util.currentWeekStart(), status: 'draft', ...fields };
  if (!week) return renderForm(res, req.user, draft, '請選擇正確的週次日期。', 400);
  if (submit && !fields.work_summary) return renderForm(res, req.user, draft, '提交前請填寫「本週工作內容」。', 400);

  const row = await db.one(
    `insert into reports (user_id, week_start, ${FIELDS.join(', ')}, status, submitted_at)
     values ($1, $2, ${FIELDS.map((_, i) => `$${i + 3}`).join(', ')}, $8, $9)
     on conflict (user_id, week_start) do nothing
     returning id`,
    [req.user.id, week, ...FIELDS.map((f) => fields[f]), submit ? 'submitted' : 'draft', submit ? new Date() : null]
  );
  if (!row) return renderForm(res, req.user, draft, `${util.weekLabel(week)} 已有週報，請改為編輯該份週報。`, 409);
  flash(req, 'success', submit ? '週報已提交，等待主管查閱。' : '草稿已儲存。');
  res.redirect(`/reports/${row.id}`);
});

router.get('/reports/:id/edit', writers, async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report || report.user_id !== req.user.id) return notFound(res);
  if (report.reviewed_at) {
    flash(req, 'warning', '此週報主管已查閱，無法再修改。如需修改請洽主管撤回查閱。');
    return res.redirect(`/reports/${report.id}`);
  }
  await renderForm(res, req.user, report, null);
});

router.post('/reports/:id', writers, async (req, res) => {
  const report = await getReport(req.params.id);
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
  // reviewed_at is null：避免在主管剛好標記查閱的同時被覆寫
  const updated = await db.one(
    `update reports set ${FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ')}, status = $6, submitted_at = $7
     where id = $8 and reviewed_at is null returning id`,
    [...FIELDS.map((f) => fields[f]), submit ? 'submitted' : 'draft',
      submit ? (report.submitted_at || new Date()) : null, report.id]
  );
  if (!updated) flash(req, 'warning', '此週報主管已查閱，無法再修改。');
  else flash(req, 'success', submit ? '週報已更新並提交。' : '草稿已儲存。');
  res.redirect(`/reports/${report.id}`);
});

router.post('/reports/:id/delete', writers, async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report || report.user_id !== req.user.id) return notFound(res);
  const deleted = await db.one("delete from reports where id = $1 and status = 'draft' returning id", [report.id]);
  if (!deleted) {
    flash(req, 'warning', '只有草稿可以刪除。');
    return res.redirect(`/reports/${report.id}`);
  }
  flash(req, 'success', '草稿已刪除。');
  res.redirect('/reports');
});

// 檢視週報（本人或有權限的主管／管理員）
router.get('/reports/:id', requireLogin, async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report || !(await canView(req.user, report))) return notFound(res);
  const logs = await db.query(
    `select l.action, l.comment, l.created_at, u.name as user_name from review_logs l
     left join users u on u.id = l.user_id where l.report_id = $1 order by l.id desc`,
    [report.id]
  );
  if (report.user_id !== req.user.id) res.locals.path = '/review'; // 導覽列標示「週報查閱」
  res.render('reports/view', {
    title: `${report.author_name} 的週報`,
    report,
    logs,
    canReview: await canReview(req.user, report),
    isOwner: report.user_id === req.user.id,
    backUrl: safeBack(req.query.back) || (report.user_id === req.user.id ? '/reports' : '/review'),
  });
});

// 主管查閱：標記已查閱／撤回／僅留言
router.post('/reports/:id/review', requireRole('admin', 'manager'), async (req, res) => {
  const report = await getReport(req.params.id);
  if (!report || !(await canReview(req.user, report))) return notFound(res);
  const comment = String(req.body.comment || '').trim().slice(0, 2000);
  const action = req.body.action;
  const back = safeBack(req.body.back);
  const backQs = back ? `?back=${encodeURIComponent(back)}` : '';

  await db.tx(async (t) => {
    const log = (a) => t.query(
      'insert into review_logs (report_id, user_id, action, comment) values ($1, $2, $3, $4)',
      [report.id, req.user.id, a, comment]
    );
    if (action === 'review') {
      await t.query("update reports set reviewed_by = $1, reviewed_at = now(), review_comment = $2 where id = $3 and status = 'submitted'",
        [req.user.id, comment, report.id]);
      await log('reviewed');
      flash(req, 'success', '已標記為「查閱完成」。');
    } else if (action === 'unreview') {
      await t.query("update reports set reviewed_by = null, reviewed_at = null, review_comment = '' where id = $1", [report.id]);
      await log('unreviewed');
      flash(req, 'success', '已撤回查閱狀態，業務人員可再次修改。');
    } else if (action === 'comment' && comment) {
      await t.query('update reports set review_comment = $1 where id = $2', [comment, report.id]);
      await log('commented');
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
