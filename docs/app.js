/* 業務週報系統 — 前端（GitHub Pages 靜態網站 + Supabase）
 * 讀取資料受 Supabase RLS 限制；所有寫入都呼叫 supabase/schema.sql 中的 RPC 函式，
 * 權限由資料庫端檢查，前端的權限判斷只用來決定要顯示哪些按鈕。
 */
(function () {
  'use strict';

  const cfg = window.APP_CONFIG;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'weekly-report-auth' },
  });
  const root = document.getElementById('app');
  const TZ = cfg.timeZone || 'Asia/Taipei';
  const ROLE_LABELS = { admin: '系統管理員', manager: '主管', staff: '業務人員' };
  const FIELDS = [
    ['work_summary', '本週工作內容'],
    ['customer_visits', '客戶拜訪紀錄'],
    ['sales_progress', '業績與案件進度'],
    ['next_week_plan', '下週工作計畫'],
    ['issues', '問題與需協助事項'],
  ];

  let me = null;          // 目前登入者 profile
  let myManaged = [];     // 主管可查閱的部門 id
  let flash = null;       // 下一次畫面要顯示的訊息
  let dirty = false;      // 表單是否有未儲存變更

  /* ------------------------------------------------------------------ 工具 */
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function todayStr() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  function parseDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(s + 'T00:00:00Z');
    return isNaN(d) || d.toISOString().slice(0, 10) !== s ? null : d;
  }
  function weekStartOf(s) {
    const d = parseDate(s);
    if (!d) return null;
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  const currentWeekStart = () => weekStartOf(todayStr());
  function addDays(s, n) {
    const d = parseDate(s);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function isoWeek(s) {
    const d = parseDate(s);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
    const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
    return { year: d.getUTCFullYear(), week };
  }
  function weekLabel(ws) {
    if (!parseDate(ws)) return '';
    const { year, week } = isoWeek(ws);
    const md = (x) => x.slice(5).replace('-', '/');
    return `${year} 第 ${week} 週（${md(ws)} ~ ${md(addDays(ws, 6))}）`;
  }
  function fmtDateTime(iso) {
    if (!iso) return '';
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  }
  function reportState(r) {
    if (!r || !r.id) return 'missing';
    if (r.status === 'draft') return 'draft';
    return r.reviewed_at ? 'reviewed' : 'pending';
  }
  function badge(state) {
    const [t, c] = { missing: ['未提交', 'muted'], draft: ['草稿', 'muted'], pending: ['待查閱', 'warn'], reviewed: ['已查閱', 'ok'] }[state];
    return `<span class="badge badge-${c}">${t}</span>`;
  }
  function toEmail(username) {
    return String(username || '').trim().toLowerCase() + '@' + cfg.emailDomain;
  }
  // Supabase 回傳 { data, error }：有錯誤就丟出（訊息即為資料庫函式的中文說明）
  function must(res) {
    if (res.error) throw new Error(res.error.message || '系統發生錯誤，請稍後再試。');
    return res.data;
  }
  function setFlash(type, text) { flash = { type, text }; }
  function go(path) {
    if (location.hash === '#' + path) route();
    else location.hash = path;
  }
  function parseHash() {
    const h = location.hash.replace(/^#/, '') || '/';
    const i = h.indexOf('?');
    return { path: i < 0 ? h : h.slice(0, i), query: new URLSearchParams(i < 0 ? '' : h.slice(i + 1)) };
  }
  function qs(obj) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) if (v !== '' && v != null) p.set(k, v);
    const s = p.toString();
    return s ? '?' + s : '';
  }
  const isWriter = () => me && (me.role === 'staff' || me.role === 'manager');
  const isReviewer = () => me && (me.role === 'manager' || me.role === 'admin');
  function canReview(report, authorDept) {
    if (!report || report.status !== 'submitted' || report.user_id === me.id) return false;
    if (me.role === 'admin') return true;
    return me.role === 'manager' && myManaged.includes(authorDept);
  }

  /* ------------------------------------------------------------------ 版面 */
  function navLink(href, label, active) {
    return `<a href="#${href}" class="${active ? 'active' : ''}">${label}</a>`;
  }
  function layout(body, section) {
    const f = flash;
    flash = null;
    const dept = me.department ? '・' + esc(me.department.name) : '';
    root.innerHTML = `
      <header class="topbar"><div class="topbar-inner">
        <a class="brand" href="#/">業務週報系統</a>
        <nav class="nav">
          ${isWriter() ? navLink('/reports', '我的週報', section === 'reports') : ''}
          ${isReviewer() ? navLink('/review', '週報查閱', section === 'review') : ''}
          ${me.role === 'admin' ? navLink('/admin/users', '人員與權限', section === 'users') + navLink('/admin/departments', '部門管理', section === 'departments') : ''}
        </nav>
        <div class="me">
          <span class="me-name">${esc(me.name)}<small>${ROLE_LABELS[me.role]}${dept}</small></span>
          <a href="#/password">變更密碼</a>
          <button class="link" data-logout>登出</button>
        </div>
      </div></header>
      <main class="container">
        ${f ? `<div class="alert alert-${esc(f.type)}">${esc(f.text)}</div>` : ''}
        ${body}
      </main>`;
    root.querySelector('[data-logout]').addEventListener('click', async () => {
      await sb.auth.signOut();
      me = null;
      go('/login');
    });
    bindCommon();
    window.scrollTo(0, 0);
  }
  function errorPage(title, message) {
    const body = `<section class="card narrow center"><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a class="btn" href="#/">回首頁</a></p></section>`;
    if (me) layout(body);
    else root.innerHTML = `<main class="container">${body}</main>`;
  }
  const notFound = () => errorPage('找不到週報', '週報不存在，或您沒有權限查看。');
  const forbidden = () => errorPage('權限不足', '您沒有權限使用此功能。');

  // 共用互動：確認對話框、篩選自動送出
  function bindCommon() {
    root.querySelectorAll('[data-confirm]').forEach((el) => {
      el.addEventListener('click', (e) => { if (!window.confirm(el.getAttribute('data-confirm'))) { e.preventDefault(); e.stopImmediatePropagation(); } });
    });
  }
  // 表單送出：鎖住按鈕避免重複送出，錯誤顯示在表單上方
  function onSubmit(form, handler) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const buttons = form.querySelectorAll('button');
      buttons.forEach((b) => { b.disabled = true; });
      const box = form.querySelector('[data-error]');
      if (box) box.innerHTML = '';
      try {
        await handler(new FormData(form), e.submitter ? e.submitter.value : '');
      } catch (err) {
        if (box) box.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
        else window.alert(err.message);
        buttons.forEach((b) => { b.disabled = false; });
      }
    });
  }

  /* ------------------------------------------------------------------ 登入 */
  function renderLogin(error, username, next) {
    root.innerHTML = `
      <main class="container"><section class="login">
        <h1>業務週報系統</h1>
        <p class="muted">請使用您的帳號登入</p>
        <form class="stack" data-login>
          <div data-error>${error ? `<div class="alert alert-error">${esc(error)}</div>` : ''}</div>
          <label>帳號<input name="username" value="${esc(username || '')}" autocomplete="username" required autofocus></label>
          <label>密碼<input type="password" name="password" autocomplete="current-password" required></label>
          <button class="btn btn-primary btn-block">登入</button>
        </form>
      </section></main>`;
    onSubmit(root.querySelector('[data-login]'), async (fd) => {
      const { error: err } = await sb.auth.signInWithPassword({ email: toEmail(fd.get('username')), password: fd.get('password') });
      if (err) {
        if (/banned/i.test(err.message)) throw new Error('此帳號已停用，請洽系統管理員。');
        if (/invalid login credentials/i.test(err.message)) throw new Error('帳號或密碼錯誤。');
        if (/rate limit|too many/i.test(err.message)) throw new Error('嘗試次數過多，請稍後再試。');
        throw new Error(err.message);
      }
      go(next && next.startsWith('/') && next !== '/login' ? next : '/');
    });
  }

  async function loadMe() {
    const { data } = await sb.auth.getSession();
    if (!data.session) return null;
    const profile = must(await sb.from('profiles')
      .select('id, username, name, role, department_id, active, must_change_password, department:departments(name)')
      .eq('id', data.session.user.id).maybeSingle());
    myManaged = [];
    if (profile && profile.active && profile.role === 'manager') {
      myManaged = must(await sb.from('manager_departments').select('department_id').eq('user_id', profile.id)).map((r) => r.department_id);
    }
    return profile;
  }

  /* ------------------------------------------------------------------ 變更密碼 */
  function pagePassword() {
    layout(`
      <section class="card narrow">
        <h1>變更密碼</h1>
        ${me.must_change_password ? '<div class="alert alert-warning">為了帳號安全，首次登入或密碼被重設後請先變更密碼。</div>' : ''}
        <form class="stack" data-form>
          <div data-error></div>
          <label>目前密碼<input type="password" name="current" autocomplete="current-password" required></label>
          <label>新密碼（至少 8 個字元）<input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
          <label>確認新密碼<input type="password" name="confirm" autocomplete="new-password" minlength="8" required></label>
          <button class="btn btn-primary">儲存</button>
        </form>
      </section>`);
    onSubmit(root.querySelector('[data-form]'), async (fd) => {
      if (fd.get('password') !== fd.get('confirm')) throw new Error('兩次輸入的新密碼不一致。');
      must(await sb.rpc('change_my_password', { p_current: fd.get('current'), p_new: fd.get('password') }));
      setFlash('success', '密碼已更新。');
      go('/');
    });
  }

  /* ------------------------------------------------------------------ 我的週報 */
  async function pageMyReports() {
    if (!isWriter()) return forbidden();
    const reports = must(await sb.from('reports')
      .select('id, week_start, status, submitted_at, reviewed_at, reviewer_name, review_comment')
      .eq('user_id', me.id).order('week_start', { ascending: false }));
    const thisWeek = currentWeekStart();
    const cur = reports.find((r) => r.week_start === thisWeek);
    layout(`
      <div class="page-head">
        <h1>我的週報</h1>
        <form class="inline-form" data-new>
          <input type="date" name="week" value="${thisWeek}" title="選擇該週任一天">
          <button class="btn btn-primary">填寫週報</button>
        </form>
      </div>
      <section class="card highlight"><div class="row-between">
        <div><div class="muted small">本週</div><strong>${weekLabel(thisWeek)}</strong></div>
        ${cur ? `<div class="row-gap">${badge(reportState(cur))}<a class="btn" href="#/reports/${cur.id}">查看</a></div>`
              : `<a class="btn btn-primary" href="#/reports/new?week=${thisWeek}">填寫本週週報</a>`}
      </div></section>
      <section class="card">
        ${!reports.length ? '<p class="muted center">尚未有任何週報。</p>' : `
        <div class="table-wrap"><table>
          <thead><tr><th>週次</th><th>狀態</th><th>提交時間</th><th>主管查閱</th><th></th></tr></thead>
          <tbody>${reports.map((r) => `
            <tr>
              <td><a href="#/reports/${r.id}">${weekLabel(r.week_start)}</a></td>
              <td>${badge(reportState(r))}</td>
              <td class="nowrap">${fmtDateTime(r.submitted_at) || '—'}</td>
              <td>${r.reviewed_at ? `${esc(r.reviewer_name || '—')} <span class="muted small">${fmtDateTime(r.reviewed_at)}</span>${r.review_comment ? `<div class="small comment-preview">💬 ${esc(r.review_comment)}</div>` : ''}` : '<span class="muted">—</span>'}</td>
              <td class="nowrap right">${r.reviewed_at ? '' : `<a href="#/reports/${r.id}/edit">編輯</a>`}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>`}
      </section>`, 'reports');
    root.querySelector('[data-new]').addEventListener('submit', (e) => {
      e.preventDefault();
      go('/reports/new?week=' + encodeURIComponent(new FormData(e.target).get('week') || ''));
    });
  }

  /* ------------------------------------------------------------------ 填寫／編輯週報 */
  async function pageReportForm(id, query) {
    if (!isWriter()) return forbidden();
    let report;
    if (id) {
      report = must(await sb.from('reports').select('*').eq('id', id).eq('user_id', me.id).maybeSingle());
      if (!report) return notFound();
      if (report.reviewed_at) {
        setFlash('warning', '此週報主管已查閱，無法再修改。如需修改請洽主管撤回查閱。');
        return go('/reports/' + id);
      }
    } else {
      const week = weekStartOf(query.get('week') || '') || currentWeekStart();
      const existing = must(await sb.from('reports').select('id').eq('user_id', me.id).eq('week_start', week).maybeSingle());
      if (existing) return go(`/reports/${existing.id}/edit`);
      report = { id: null, week_start: week, status: 'draft' };
    }
    const prev = must(await sb.from('reports').select('week_start, next_week_plan')
      .eq('user_id', me.id).lt('week_start', report.week_start).neq('next_week_plan', '')
      .order('week_start', { ascending: false }).limit(1).maybeSingle());

    const ta = (name, rows, ph) => `<textarea name="${name}" rows="${rows}" maxlength="10000" placeholder="${esc(ph || '')}">${esc(report[name] || '')}</textarea>`;
    layout(`
      <div class="page-head">
        <h1>${report.id ? '編輯週報' : '填寫週報'}</h1>
        <a href="#${report.id ? '/reports/' + report.id : '/reports'}">← 返回</a>
      </div>
      <form class="card stack report-form" data-form>
        <div data-error></div>
        <div class="field-row">
          <label>週次（選擇該週任一天）
            ${report.id ? `<input type="text" value="${weekLabel(report.week_start)}" disabled>`
                        : `<input type="date" name="week" value="${report.week_start}" required data-week-picker>`}
          </label>
          <div class="muted small" data-week-label>${weekLabel(report.week_start)}</div>
        </div>
        ${prev ? `<details class="prev-plan"><summary>參考：上次填寫的「下週工作計畫」（${weekLabel(prev.week_start)}）</summary><div class="pre">${esc(prev.next_week_plan)}</div></details>` : ''}
        <label><span>本週工作內容 <span class="req">*</span></span>${ta('work_summary', 7, '例：\n1. 拜訪 A 公司，說明新方案\n2. 完成 B 案報價')}</label>
        <label>客戶拜訪紀錄${ta('customer_visits', 5, '客戶名稱／拜訪日期／洽談重點')}</label>
        <label>業績與案件進度${ta('sales_progress', 4, '成交金額、報價中案件、預計結案時間等')}</label>
        <label>下週工作計畫${ta('next_week_plan', 5)}</label>
        <label>問題與需協助事項${ta('issues', 3)}</label>
        <div class="actions">
          ${report.status === 'submitted'
            ? '<button class="btn" value="draft" data-confirm="改回草稿後主管將看不到這份週報，確定嗎？">改回草稿</button><button class="btn btn-primary" value="submit">更新並提交</button>'
            : '<button class="btn" value="draft">儲存草稿</button><button class="btn btn-primary" value="submit">提交給主管</button>'}
        </div>
      </form>`, 'reports');

    const form = root.querySelector('[data-form]');
    form.addEventListener('input', () => { dirty = true; });
    const picker = form.querySelector('[data-week-picker]');
    if (picker) picker.addEventListener('change', () => {
      const ws = weekStartOf(picker.value);
      form.querySelector('[data-week-label]').textContent = ws ? '本週報週次：' + weekLabel(ws) : '';
    });
    onSubmit(form, async (fd, action) => {
      const text = (k) => String(fd.get(k) || '').replace(/\r\n/g, '\n').trim();
      const submit = action === 'submit';
      if (submit && !text('work_summary')) throw new Error('提交前請填寫「本週工作內容」。');
      const week = report.id ? null : weekStartOf(String(fd.get('week') || ''));
      if (!report.id && !week) throw new Error('請選擇正確的週次日期。');
      const newId = must(await sb.rpc('save_report', {
        p_id: report.id, p_week: week,
        p_work_summary: text('work_summary'), p_customer_visits: text('customer_visits'),
        p_sales_progress: text('sales_progress'), p_next_week_plan: text('next_week_plan'),
        p_issues: text('issues'), p_submit: submit,
      }));
      dirty = false;
      setFlash('success', submit ? '週報已提交，等待主管查閱。' : '草稿已儲存。');
      go('/reports/' + newId);
    });
  }

  /* ------------------------------------------------------------------ 檢視週報 */
  async function pageReportView(id, query) {
    const report = must(await sb.from('reports')
      .select('*, author:profiles!reports_user_id_fkey(name, department_id, department:departments(name))')
      .eq('id', id).maybeSingle());
    if (!report) return notFound();
    const logs = must(await sb.from('review_logs').select('action, comment, user_name, created_at').eq('report_id', id).order('id', { ascending: false }));
    const isOwner = report.user_id === me.id;
    const author = report.author || {};
    const reviewable = canReview(report, author.department_id);
    const back = (query.get('back') || '').startsWith('/review') ? query.get('back') : (isOwner ? '/reports' : '/review');
    const state = reportState(report);
    const L = { reviewed: '標記查閱完成', unreviewed: '撤回查閱', commented: '更新意見' };

    layout(`
      <div class="page-head">
        <div>
          <a href="#${esc(back)}" class="small">← 返回列表</a>
          <h1>${esc(author.name || me.name)} 的週報 ${badge(state)}</h1>
          <div class="muted">${weekLabel(report.week_start)}・${esc((author.department && author.department.name) || '未分配部門')}</div>
        </div>
        ${isOwner && !report.reviewed_at ? `<div class="row-gap">
          <a class="btn" href="#/reports/${report.id}/edit">編輯</a>
          ${report.status === 'draft' ? '<button class="btn btn-danger" data-delete data-confirm="確定刪除這份草稿？">刪除</button>' : ''}
        </div>` : ''}
      </div>
      <div class="grid-2">
        <section class="card report-body">
          ${FIELDS.map(([k, label]) => `<h3>${label}</h3><div class="pre ${report[k] ? '' : 'muted'}">${esc(report[k] || '（未填寫）')}</div>`).join('')}
          <p class="muted small meta">${report.submitted_at ? `提交：${fmtDateTime(report.submitted_at)}・` : ''}最後更新：${fmtDateTime(report.updated_at)}</p>
        </section>
        <aside class="stack">
          <section class="card review-box ${report.reviewed_at ? 'is-reviewed' : ''}">
            <h3>主管查閱</h3>
            ${report.status === 'draft' ? '<p class="muted">草稿尚未提交，主管無法查看。</p>'
              : report.reviewed_at ? `<p><strong>✔ 已查閱完成</strong></p>
                  <p class="small">查閱人：${esc(report.reviewer_name || '—')}<br>查閱時間：${fmtDateTime(report.reviewed_at)}</p>
                  ${report.review_comment ? `<div class="pre comment">${esc(report.review_comment)}</div>` : ''}`
              : `<p class="warn-text">⏳ 尚未查閱</p>${report.review_comment ? `<div class="pre comment">${esc(report.review_comment)}</div>` : ''}`}
            ${reviewable ? `<form class="stack" data-review>
              <div data-error></div>
              <label>主管意見（選填）<textarea name="comment" rows="4" maxlength="2000">${esc(report.review_comment)}</textarea></label>
              ${report.reviewed_at
                ? '<button class="btn" value="comment">更新意見</button><button class="btn btn-danger-outline" value="unreview" data-confirm="撤回後業務人員可再次修改此週報，確定撤回？">撤回查閱</button>'
                : '<button class="btn btn-primary" value="review">✔ 標記為查閱完成</button><button class="btn" value="comment">僅儲存意見</button>'}
            </form>` : ''}
          </section>
          ${logs.length ? `<section class="card"><h3>查閱紀錄</h3><ul class="timeline">
            ${logs.map((l) => `<li><span class="small muted">${fmtDateTime(l.created_at)}</span><br>${esc(l.user_name || '—')} ${L[l.action]}${l.comment ? `：<span class="muted">${esc(l.comment)}</span>` : ''}</li>`).join('')}
          </ul></section>` : ''}
        </aside>
      </div>`, isOwner ? 'reports' : 'review');

    const del = root.querySelector('[data-delete]');
    if (del) del.addEventListener('click', async () => {
      try {
        must(await sb.rpc('delete_draft', { p_id: report.id }));
        setFlash('success', '草稿已刪除。');
        go('/reports');
      } catch (e) { window.alert(e.message); }
    });
    const form = root.querySelector('[data-review]');
    if (form) onSubmit(form, async (fd, action) => {
      must(await sb.rpc('review_report', { p_id: report.id, p_action: action, p_comment: String(fd.get('comment') || '') }));
      setFlash('success', { review: '已標記為「查閱完成」。', unreview: '已撤回查閱狀態，業務人員可再次修改。', comment: '主管意見已更新。' }[action]);
      go(`/reports/${report.id}${qs({ back: query.get('back') })}`);
    });
  }

  /* ------------------------------------------------------------------ 週報查閱 */
  async function pageReview(query) {
    if (!isReviewer()) return forbidden();
    const allDepts = must(await sb.from('departments').select('id, name').order('name'));
    const departments = me.role === 'admin' ? allDepts : allDepts.filter((d) => myManaged.includes(d.id));
    const deptName = Object.fromEntries(allDepts.map((d) => [d.id, d.name]));
    const deptIds = departments.map((d) => d.id);
    const thisWeek = currentWeekStart();
    const weekParam = query.has('week') ? query.get('week') : thisWeek;
    const week = weekParam === 'all' ? null : (weekStartOf(weekParam) || thisWeek);
    const deptFilter = Number(query.get('dept')) || 0;
    const status = ['pending', 'reviewed', 'missing'].includes(query.get('status')) ? query.get('status') : 'all';
    const scopeIds = deptFilter && deptIds.includes(deptFilter) ? [deptFilter] : deptIds;
    const backUrl = '/review' + qs({ week: week || 'all', dept: deptFilter || '', status });
    const link = (o) => '#/review' + qs({ week: week || 'all', dept: deptFilter || '', status, ...o });

    const pending = await sb.from('reports').select('id', { count: 'exact', head: true })
      .eq('status', 'submitted').is('reviewed_at', null).neq('user_id', me.id);
    must(pending);
    const pendingTotal = pending.count || 0;

    let rows = [];
    let summary = null;
    if (scopeIds.length && week) {
      const people = must(await sb.from('profiles').select('id, name, role, department_id')
        .eq('active', true).in('role', ['staff', 'manager']).neq('id', me.id).in('department_id', scopeIds));
      const reports = must(await sb.from('reports')
        .select('id, user_id, status, submitted_at, reviewed_at, reviewer_name, work_summary').eq('week_start', week));
      const byUser = Object.fromEntries(reports.map((r) => [r.user_id, r]));
      rows = people.map((p) => {
        const r = byUser[p.id] || {};
        return { ...r, author_name: p.name, role: p.role, department_name: deptName[p.department_id] || '—', state: reportState(r) };
      }).map((r) => (r.state === 'draft' ? { ...r, state: 'missing', id: null } : r));
      rows.sort((a, b) => a.department_name.localeCompare(b.department_name, 'zh-Hant')
        || (a.role === b.role ? 0 : a.role === 'staff' ? -1 : 1) || a.author_name.localeCompare(b.author_name, 'zh-Hant'));
      summary = {
        total: rows.length,
        missing: rows.filter((r) => r.state === 'missing').length,
        pending: rows.filter((r) => r.state === 'pending').length,
        reviewed: rows.filter((r) => r.state === 'reviewed').length,
      };
      if (status !== 'all') rows = rows.filter((r) => r.state === status);
    } else if (scopeIds.length && status !== 'missing') {
      let q = sb.from('reports')
        .select('id, user_id, week_start, status, reviewed_at, reviewer_name, work_summary, author:profiles!reports_user_id_fkey!inner(name, role, department_id)')
        .eq('status', 'submitted').neq('user_id', me.id).in('author.department_id', scopeIds)
        .order('week_start', { ascending: false }).limit(500);
      if (status === 'pending') q = q.is('reviewed_at', null);
      if (status === 'reviewed') q = q.not('reviewed_at', 'is', null);
      rows = must(await q).map((r) => ({
        ...r, author_name: r.author.name, role: r.author.role, department_name: deptName[r.author.department_id] || '—', state: reportState(r),
      }));
    }

    const opt = (v, label, cur) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${label}</option>`;
    layout(`
      <div class="page-head">
        <h1>週報查閱</h1>
        <a class="pending-pill ${pendingTotal ? '' : 'zero'}" href="#/review?week=all&status=pending">全部待查閱：<strong>${pendingTotal}</strong> 份</a>
      </div>
      ${!departments.length ? '<div class="alert alert-warning">您目前沒有被指派任何可查閱的部門，請洽系統管理員設定。</div>' : ''}
      <form class="card filters" data-filters>
        <div class="week-nav">
          ${week ? `<a class="btn btn-sm" href="${link({ week: addDays(week, -7) })}">‹ 上週</a>` : ''}
          <input type="date" name="week" value="${week || ''}">
          ${week ? `<a class="btn btn-sm" href="${link({ week: addDays(week, 7) })}">下週 ›</a>` : ''}
          <a class="btn btn-sm ${week === thisWeek ? 'btn-primary' : ''}" href="${link({ week: thisWeek })}">本週</a>
          <a class="btn btn-sm ${!week ? 'btn-primary' : ''}" href="${link({ week: 'all', status: status === 'missing' ? 'all' : status })}">所有週次</a>
        </div>
        <div class="row-gap">
          <select name="dept">${opt('', '全部部門', deptFilter || '')}${departments.map((d) => opt(d.id, esc(d.name), deptFilter)).join('')}</select>
          <select name="status">
            ${opt('all', '全部狀態', status)}${opt('pending', '待查閱', status)}${opt('reviewed', '已查閱', status)}${week ? opt('missing', '未提交', status) : ''}
          </select>
        </div>
      </form>
      ${week ? `<h2 class="section-title">${weekLabel(week)}</h2>
        <div class="stats">
          <div class="stat"><span>${summary ? summary.total : 0}</span>應填人數</div>
          <div class="stat stat-muted"><span>${summary ? summary.missing : 0}</span>未提交</div>
          <div class="stat stat-warn"><span>${summary ? summary.pending : 0}</span>待查閱</div>
          <div class="stat stat-ok"><span>${summary ? summary.reviewed : 0}</span>已查閱</div>
        </div>` : '<h2 class="section-title">所有週次已提交週報</h2>'}
      <form class="card" data-batch>
        <div data-error></div>
        ${!rows.length ? '<p class="muted center">沒有符合條件的資料。</p>' : `
        <div class="table-wrap"><table>
          <thead><tr>
            <th class="check"><input type="checkbox" data-check-all title="全選待查閱"></th>
            ${week ? '' : '<th>週次</th>'}<th>部門</th><th>姓名</th><th>狀態</th><th>內容摘要</th><th>查閱</th><th></th>
          </tr></thead>
          <tbody>${rows.map((r) => {
            const visible = r.state === 'pending' || r.state === 'reviewed';
            const sum = r.work_summary || '';
            return `<tr class="state-${r.state}">
              <td class="check">${r.state === 'pending' ? `<input type="checkbox" name="ids" value="${r.id}">` : ''}</td>
              ${week ? '' : `<td class="nowrap">${weekLabel(r.week_start)}</td>`}
              <td class="nowrap">${esc(r.department_name)}</td>
              <td class="nowrap">${esc(r.author_name)}${r.role === 'manager' ? ' <span class="tag">主管</span>' : ''}</td>
              <td>${badge(r.state)}</td>
              <td class="summary">${visible ? esc(sum.slice(0, 60)) + (sum.length > 60 ? '…' : '') : '<span class="muted">—</span>'}</td>
              <td class="nowrap small">${r.reviewed_at ? `${esc(r.reviewer_name || '—')}<br><span class="muted">${fmtDateTime(r.reviewed_at)}</span>` : '<span class="muted">—</span>'}</td>
              <td class="nowrap right">${visible ? `<a class="btn btn-sm" href="#/reports/${r.id}${qs({ back: backUrl })}">查看</a>` : ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
        ${rows.some((r) => r.state === 'pending') ? '<div class="actions"><button class="btn btn-primary" data-confirm="確定將勾選的週報標記為查閱完成？">✔ 勾選項目標記為查閱完成</button></div>' : ''}`}
      </form>`, 'review');

    const filters = root.querySelector('[data-filters]');
    filters.addEventListener('change', () => {
      const fd = new FormData(filters);
      go('/review' + qs({ week: fd.get('week') || 'all', dept: fd.get('dept'), status: fd.get('status') }));
    });
    filters.addEventListener('submit', (e) => e.preventDefault());
    const all = root.querySelector('[data-check-all]');
    if (all) all.addEventListener('change', () => root.querySelectorAll('input[name="ids"]').forEach((c) => { c.checked = all.checked; }));
    onSubmit(root.querySelector('[data-batch]'), async (fd) => {
      const ids = fd.getAll('ids').map(Number);
      if (!ids.length) throw new Error('請先勾選要標記的週報。');
      const n = must(await sb.rpc('review_reports', { p_ids: ids }));
      setFlash(n ? 'success' : 'warning', n ? `已將 ${n} 份週報標記為查閱完成。` : '沒有可標記的週報。');
      go(backUrl);
    });
  }

  /* ------------------------------------------------------------------ 管理：部門 */
  async function pageDepartments() {
    if (me.role !== 'admin') return forbidden();
    const [departments, profiles, managed] = await Promise.all([
      sb.from('departments').select('id, name').order('name'),
      sb.from('profiles').select('id, name, department_id, active'),
      sb.from('manager_departments').select('user_id, department_id'),
    ]).then((rs) => rs.map(must));
    const nameOf = Object.fromEntries(profiles.filter((p) => p.active).map((p) => [p.id, p.name]));
    layout(`
      <div class="page-head"><h1>部門管理</h1></div>
      <form class="card inline-form" data-create>
        <input name="name" placeholder="新部門名稱" maxlength="50" required>
        <button class="btn btn-primary">新增部門</button>
      </form>
      <section class="card">
        ${!departments.length ? '<p class="muted center">尚未建立部門。</p>' : `
        <div class="table-wrap"><table>
          <thead><tr><th>部門名稱</th><th>人數</th><th>負責主管</th><th></th></tr></thead>
          <tbody>${departments.map((d) => {
            const count = profiles.filter((p) => p.department_id === d.id).length;
            const managers = managed.filter((m) => m.department_id === d.id).map((m) => nameOf[m.user_id]).filter(Boolean);
            return `<tr>
              <td><form class="inline-form" data-rename="${d.id}"><input name="name" value="${esc(d.name)}" maxlength="50" required><button class="btn btn-sm">更名</button></form></td>
              <td><a href="#/admin/users?dept=${d.id}">${count} 人</a></td>
              <td>${esc(managers.join('、')) || '—'}</td>
              <td class="right"><button class="btn btn-sm btn-danger-outline" data-del="${d.id}" data-confirm="確定刪除部門「${esc(d.name)}」？" ${count ? 'disabled title="部門仍有人員"' : ''}>刪除</button></td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>`}
      </section>`, 'departments');

    const done = (msg) => { setFlash('success', msg); go('/admin/departments'); };
    onSubmit(root.querySelector('[data-create]'), async (fd) => {
      must(await sb.rpc('admin_save_department', { p_id: null, p_name: fd.get('name') }));
      done(`已新增部門「${String(fd.get('name')).trim()}」。`);
    });
    root.querySelectorAll('[data-rename]').forEach((f) => onSubmit(f, async (fd) => {
      must(await sb.rpc('admin_save_department', { p_id: Number(f.dataset.rename), p_name: fd.get('name') }));
      done('部門名稱已更新。');
    }));
    root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      try {
        must(await sb.rpc('admin_delete_department', { p_id: Number(b.dataset.del) }));
        done('部門已刪除。');
      } catch (e) { window.alert(e.message); }
    }));
  }

  /* ------------------------------------------------------------------ 管理：人員 */
  async function pageUsers(query) {
    if (me.role !== 'admin') return forbidden();
    const dept = Number(query.get('dept')) || 0;
    const [departments, profiles, managed] = await Promise.all([
      sb.from('departments').select('id, name').order('name'),
      sb.from('profiles').select('id, username, name, role, department_id, active'),
      sb.from('manager_departments').select('user_id, department_id'),
    ]).then((rs) => rs.map(must));
    const deptName = Object.fromEntries(departments.map((d) => [d.id, d.name]));
    const roleOrder = { admin: 0, manager: 1, staff: 2 };
    const users = profiles.filter((u) => !dept || u.department_id === dept).sort((a, b) =>
      (b.active - a.active) || (deptName[a.department_id] || '').localeCompare(deptName[b.department_id] || '', 'zh-Hant')
      || roleOrder[a.role] - roleOrder[b.role] || a.name.localeCompare(b.name, 'zh-Hant'));
    layout(`
      <div class="page-head"><h1>人員與權限</h1><a class="btn btn-primary" href="#/admin/users/new">＋ 新增人員</a></div>
      <form class="card inline-form" data-filter>
        <select name="dept"><option value="">全部部門</option>${departments.map((d) => `<option value="${d.id}" ${d.id === dept ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
      </form>
      <section class="card"><div class="table-wrap"><table>
        <thead><tr><th>姓名</th><th>帳號</th><th>角色</th><th>所屬部門</th><th>可查閱部門</th><th>狀態</th><th></th></tr></thead>
        <tbody>${users.map((u) => `
          <tr class="${u.active ? '' : 'inactive'}">
            <td>${esc(u.name)}</td>
            <td><code>${esc(u.username)}</code></td>
            <td><span class="tag tag-${u.role}">${ROLE_LABELS[u.role]}</span></td>
            <td>${esc(deptName[u.department_id] || '—')}</td>
            <td>${u.role === 'admin' ? '全部' : esc(managed.filter((m) => m.user_id === u.id).map((m) => deptName[m.department_id]).join('、')) || '—'}</td>
            <td>${u.active ? '啟用' : '停用'}</td>
            <td class="right"><a class="btn btn-sm" href="#/admin/users/${u.id}">編輯</a></td>
          </tr>`).join('')}
        </tbody>
      </table></div></section>
      <section class="card muted small">
        <strong>角色說明</strong>
        <ul>
          <li><b>業務人員</b>：填寫、提交自己的週報，查看主管查閱狀態與意見。</li>
          <li><b>主管</b>：查看「可查閱部門」內人員已提交的週報，標記查閱完成並留下意見；主管本人也可填寫週報。</li>
          <li><b>系統管理員</b>：可查閱所有部門週報，並管理部門、人員帳號與權限。</li>
        </ul>
      </section>`, 'users');
    root.querySelector('[data-filter]').addEventListener('change', (e) => go('/admin/users' + qs({ dept: e.target.value })));
  }

  async function pageUserForm(id) {
    if (me.role !== 'admin') return forbidden();
    const departments = must(await sb.from('departments').select('id, name').order('name'));
    let user = { id: null, username: '', name: '', role: 'staff', department_id: null, active: true, managed: [] };
    if (id) {
      const u = must(await sb.from('profiles').select('id, username, name, role, department_id, active').eq('id', id).maybeSingle());
      if (!u) return errorPage('找不到人員', '人員不存在。');
      const m = must(await sb.from('manager_departments').select('department_id').eq('user_id', id));
      user = { ...u, managed: m.map((r) => r.department_id) };
    }
    layout(`
      <div class="page-head"><h1>${id ? '編輯人員' : '新增人員'}</h1><a href="#/admin/users">← 返回</a></div>
      ${!departments.length ? '<div class="alert alert-warning">尚未建立部門，請先到 <a href="#/admin/departments">部門管理</a> 新增部門。</div>' : ''}
      <form class="card stack narrow-form" data-form>
        <div data-error></div>
        <div class="field-grid">
          <label>登入帳號<input name="username" value="${esc(user.username)}" pattern="[A-Za-z0-9._\\-]{3,50}" title="3–50 個英數字或 . _ - 符號" required autocomplete="off"></label>
          <label>姓名<input name="name" value="${esc(user.name)}" maxlength="50" required></label>
          <label>角色<select name="role" data-role>${['staff', 'manager', 'admin'].map((r) => `<option value="${r}" ${user.role === r ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`).join('')}</select></label>
          <label>所屬部門<select name="department_id"><option value="">（無）</option>${departments.map((d) => `<option value="${d.id}" ${d.id === user.department_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
        </div>
        <fieldset class="managed" data-managed>
          <legend>可查閱的部門（主管專用）</legend>
          ${!departments.length ? '<span class="muted">尚無部門</span>' : ''}
          ${departments.map((d) => `<label class="check-label"><input type="checkbox" name="managed" value="${d.id}" ${user.managed.includes(d.id) ? 'checked' : ''}> ${esc(d.name)}</label>`).join('')}
        </fieldset>
        <label>${id ? '重設密碼（留空表示不變更）' : '初始密碼（至少 8 個字元）'}
          <input type="password" name="password" minlength="8" ${id ? '' : 'required'} autocomplete="new-password">
        </label>
        <p class="muted small">設定或重設密碼後，該人員下次登入時需自行變更密碼。</p>
        <label class="check-label"><input type="checkbox" name="active" value="1" ${user.active ? 'checked' : ''}> 帳號啟用（取消勾選即停用，無法登入）</label>
        <div class="actions"><button class="btn btn-primary">儲存</button></div>
      </form>`, 'users');

    const role = root.querySelector('[data-role]');
    const managed = root.querySelector('[data-managed]');
    const sync = () => { managed.hidden = role.value !== 'manager'; };
    role.addEventListener('change', sync);
    sync();
    onSubmit(root.querySelector('[data-form]'), async (fd) => {
      const name = String(fd.get('name') || '').trim();
      must(await sb.rpc('admin_save_user', {
        p_id: user.id,
        p_username: String(fd.get('username') || '').trim(),
        p_name: name,
        p_role: fd.get('role'),
        p_department_id: Number(fd.get('department_id')) || null,
        p_managed: fd.getAll('managed').map(Number),
        p_active: fd.get('active') === '1',
        p_password: String(fd.get('password') || ''),
      }));
      setFlash('success', id ? `已更新人員「${name}」。` : `已新增人員「${name}」，首次登入需變更密碼。`);
      go('/admin/users');
    });
  }

  /* ------------------------------------------------------------------ 路由 */
  const routes = [
    [/^\/$/, () => go(me.role === 'staff' ? '/reports' : '/review')],
    [/^\/password$/, pagePassword],
    [/^\/reports$/, pageMyReports],
    [/^\/reports\/new$/, (m, q) => pageReportForm(null, q)],
    [/^\/reports\/(\d+)\/edit$/, (m, q) => pageReportForm(Number(m[1]), q)],
    [/^\/reports\/(\d+)$/, (m, q) => pageReportView(Number(m[1]), q)],
    [/^\/review$/, (m, q) => pageReview(q)],
    [/^\/admin\/departments$/, pageDepartments],
    [/^\/admin\/users$/, (m, q) => pageUsers(q)],
    [/^\/admin\/users\/new$/, () => pageUserForm(null)],
    [/^\/admin\/users\/([0-9a-f-]{36})$/, (m) => pageUserForm(m[1])],
  ];

  let routing = 0;
  async function route() {
    const ticket = ++routing;
    const { path, query } = parseHash();
    try {
      if (path === '/login') {
        const { data } = await sb.auth.getSession();
        if (data.session) return go('/');
        return renderLogin(null, '', query.get('next'));
      }
      me = await loadMe();
      if (ticket !== routing) return;
      if (!me) {
        const { data } = await sb.auth.getSession();
        if (data.session) {
          await sb.auth.signOut();
          return renderLogin('此帳號尚未完成設定，請洽系統管理員。');
        }
        return go('/login' + qs({ next: path === '/' ? '' : path + (query.toString() ? '?' + query : '') }));
      }
      if (!me.active) {
        await sb.auth.signOut();
        me = null;
        return renderLogin('此帳號已停用，請洽系統管理員。');
      }
      if (me.must_change_password && path !== '/password') return go('/password');
      for (const [re, handler] of routes) {
        const m = path.match(re);
        if (m) return await handler(m, query);
      }
      errorPage('找不到頁面', '您要找的頁面不存在。');
    } catch (e) {
      console.error(e);
      errorPage('系統錯誤', e.message || '系統發生錯誤，請稍後再試。');
    }
  }

  window.addEventListener('hashchange', () => {
    dirty = false;
    route();
  });
  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && parseHash().path !== '/login') {
      me = null;
      go('/login');
    }
  });
  route();
})();
