'use strict';
const db = require('./db');

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (!roles.includes(req.user.role)) {
      return res.status(403).render('error', { title: '權限不足', message: '您沒有權限使用此功能。' });
    }
    next();
  };
}

// 使用者可查閱的部門 id 清單；admin 回傳 null 代表全部
async function managedDeptIds(user) {
  if (user.role === 'admin') return null;
  if (user.role !== 'manager') return [];
  const rows = await db.query('select department_id from manager_departments where user_id = $1', [user.id]);
  return rows.map((r) => r.department_id);
}

// 可查看他人週報：admin，或負責該員所屬部門的主管；且週報需已提交
async function canReview(user, report) {
  if (report.user_id === user.id) return false;
  if (report.status !== 'submitted') return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'manager' || report.author_department_id == null) return false;
  const ids = await managedDeptIds(user);
  return ids.includes(report.author_department_id);
}

async function canView(user, report) {
  return report.user_id === user.id || canReview(user, report);
}

function flash(req, type, text) {
  req.session.flash = { type, text };
}

module.exports = { requireLogin, requireRole, managedDeptIds, canReview, canView, flash };
