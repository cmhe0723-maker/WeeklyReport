'use strict';

const TZ = process.env.APP_TIMEZONE || 'Asia/Taipei';

// 取得指定時區的「今天」 YYYY-MM-DD
function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== s) return null;
  return d;
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

// 任一日期 → 該週週一
function weekStartOf(s) {
  const d = parseDate(s);
  if (!d) return null;
  const dow = (d.getUTCDay() + 6) % 7; // 週一 = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return fmt(d);
}

function currentWeekStart() {
  return weekStartOf(todayStr());
}

function addDays(s, n) {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

// ISO 週次
function isoWeek(s) {
  const d = parseDate(s);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3); // 該週週四
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return { year: d.getUTCFullYear(), week };
}

function weekLabel(weekStart) {
  if (!weekStart) return '';
  const { year, week } = isoWeek(weekStart);
  const end = addDays(weekStart, 6);
  return `${year} 第 ${week} 週（${weekStart.slice(5).replace('-', '/')} ~ ${end.slice(5).replace('-', '/')}）`;
}

function fmtDateTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

const ROLE_LABELS = { admin: '系統管理員', manager: '主管', staff: '業務人員' };

module.exports = { TZ, todayStr, parseDate, weekStartOf, currentWeekStart, addDays, isoWeek, weekLabel, fmtDateTime, ROLE_LABELS };
