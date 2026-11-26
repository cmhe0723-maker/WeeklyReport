/* 工作週報系統 — 前端（GitHub Pages 靜態網站 + Supabase）
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
  const ROLE_LABELS = { admin: '系統管理員', user: '一般人員' };
  // 每週欄位（「每日工作內容」另外處理）
  const FIELDS = [
    ['customer_visits', '客戶拜訪紀錄'],
    ['sales_progress', '業績與案件進度'],
    ['next_week_plan', '下週工作計畫'],
    ['issues', '問題與需協助事項'],
  ];

  let me = null;          // 目前登入者 profile
  let myManaged = [];     // 額外可查閱的部門 id
  let ranks = [];         // 職級（由高到低）
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
  const DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
  // 週報的每日工作內容 → 長度 7 的字串陣列（週一～週日）
  function dailyOf(r) {
    const a = r && Array.isArray(r.daily_work) ? r.daily_work : [];
    return DAY_NAMES.map((_, i) => String(a[i] || ''));
  }
  // 每日多筆拜訪 → 長度 7 的陣列，每天是 [{ customer, contact, content }]；舊週報由每日文字轉成一筆
  function dailyEntriesOf(r) {
    const e = r && Array.isArray(r.daily_entries) ? r.daily_entries : [];
    const text = dailyOf(r);
    return DAY_NAMES.map((_, i) => {
      const list = Array.isArray(e[i]) ? e[i].filter((x) => x && (x.customer || x.contact || x.content)) : [];
      if (list.length) return list.map((x) => ({ customer: x.customer || '', contact: x.contact || '', content: x.content || '' }));
      return text[i] ? [{ customer: '', contact: '', content: text[i] }] : [];
    });
  }
  function dayLabel(ws, i) {
    return `週${DAY_NAMES[i]} ${addDays(ws, i).slice(5).replace('-', '/')}`;
  }
  function dayLabelHtml(ws, i) {
    return esc(dayLabel(ws, i)) + (addDays(ws, i) === todayStr() ? ' <span class="tag tag-manager">今天</span>' : '');
  }
  // 列表用的內容摘要：「一：…；三：…」
  function workPreview(r) {
    const parts = dailyOf(r).map((t, i) => (t ? `${DAY_NAMES[i]}：${t.replace(/\s+/g, ' ')}` : '')).filter(Boolean);
    if (r.work_summary) parts.push(r.work_summary.replace(/\s+/g, ' '));
    return parts.join('；');
  }
  // ISO 時間 → 指定時區的日期 YYYY-MM-DD
  function dateInTZ(iso) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  }
  // Supabase 每次最多回傳 1000 筆，超過時分頁讀取。build() 每次須回傳新的查詢
  async function fetchAll(build) {
    const size = 1000;
    let out = [];
    for (let from = 0; ; from += size) {
      const rows = must(await build().range(from, from + size - 1));
      out = out.concat(rows);
      if (rows.length < size) return out;
    }
  }
  function pct(a, b) {
    return b ? Math.round((a * 100) / b) + '%' : '—';
  }
  // 民國年日期，例：115.11.17
  function rocDate(iso) {
    const [y, m, d] = dateInTZ(iso).split('-');
    return `${Number(y) - 1911}.${m}.${d}`;
  }
  // 逐級核閱的簽核欄：每個層級一個日期章，尚未核閱的層級顯示虛線圈
  let justReviewed = null;
  function levelsOf(report, st) {
    if (st) return st.levels || [];
    // 沒有核閱狀態時（例如只讀到週報本身）：已查閱就以最後查閱人顯示一個章
    return report.reviewed_at ? [{ rank_name: '查閱', stamped: true, user_name: report.reviewer_name, created_at: report.reviewed_at }] : [];
  }
  function signoffHtml(report, st) {
    const levels = levelsOf(report, st);
    if (!levels.length || report.status !== 'submitted') return '';
    const fresh = justReviewed === report.id;
    if (fresh) justReviewed = null;
    const lastStamped = levels.map((l) => l.stamped).lastIndexOf(true);
    return `<div class="signoff" aria-label="核閱">
      <span class="signoff-label">核閱</span>
      <ol class="signoff-levels">${levels.map((l, i) => (l.stamped
        ? `<li class="seal ${fresh && i === lastStamped ? 'seal-fresh' : ''}" role="img"
             aria-label="${esc(`${l.admin ? '系統管理員' : l.rank_name} ${l.user_name || ''} 已於 ${fmtDateTime(l.created_at)} 核閱`)}"
             title="${esc(l.comment ? '意見：' + l.comment : '')}">
             <span class="seal-top">${esc(l.admin ? '代閱' : l.rank_name)}</span><span class="seal-date">${rocDate(l.created_at)}</span><span class="seal-name">${esc(l.user_name || '')}</span></li>`
        : `<li class="seal-empty" aria-label="${esc(l.rank_name)} 尚未核閱"><span>${esc(l.rank_name)}</span><small>待核閱</small></li>`)).join('')}</ol>
    </div>`;
  }
  // 讀取多份週報的核閱狀態 → Map(id → 狀態)
  async function reviewStates(ids) {
    const map = new Map();
    const list = [...new Set(ids)].filter(Boolean);
    for (let i = 0; i < list.length; i += 200) {
      must(await sb.rpc('report_review_states', { p_ids: list.slice(i, i + 200) })).forEach((r) => map.set(r.report_id, r));
    }
    return map;
  }
  // 核閱進度文字，例：核閱中（1/3）
  function progressText(st) {
    if (!st) return '';
    const done = st.levels.filter((l) => l.stamped).length;
    return `${done}/${st.levels.length}`;
  }
  // 週報內容（檢視頁與列印頁共用）
  function reportBodyHtml(report, deptLabel, st) {
    return `
      <dl class="doc-head">
        <div><dt>週次</dt><dd>${weekLabel(report.week_start)}</dd></div>
        <div><dt>部門</dt><dd>${esc(deptLabel || '未分配部門')}</dd></div>
        <div><dt>提交</dt><dd>${report.submitted_at ? fmtDateTime(report.submitted_at) : '尚未提交'}</dd></div>
        <div><dt>最後更新</dt><dd>${fmtDateTime(report.updated_at)}</dd></div>
      </dl>
      ${signoffHtml(report, st)}
      <h3>每日工作內容</h3>
      <div class="daily-view">${dailyEntriesOf(report).map((list, i) => (i < 5 || list.length ? `<div class="day-row">
        <div class="day-name">${esc(dayLabel(report.week_start, i))}</div>
        <div class="day-entries">${list.length ? list.map((e) => `<div class="entry-view">
          ${e.customer || e.contact ? `<div class="entry-who">${e.customer ? `<strong>${esc(e.customer)}</strong>` : ''}${e.contact ? `<span class="entry-contact-name">聯絡人：${esc(e.contact)}</span>` : ''}</div>` : ''}
          ${e.content ? `<div class="pre">${esc(e.content)}</div>` : ''}</div>`).join('') : '<div class="pre muted">（未填寫）</div>'}</div></div>` : '')).join('')}</div>
      ${report.work_summary ? `<h3>本週工作內容</h3><div class="pre">${esc(report.work_summary)}</div>` : ''}
      ${FIELDS.map(([k, label]) => `<h3>${label}</h3><div class="pre ${report[k] ? '' : 'muted'}">${esc(report[k] || '（未填寫）')}</div>`).join('')}`;
  }
  // 核閱狀態文字（不含操作表單）
  function reviewStatusHtml(report, st) {
    if (report.status === 'draft') return '<p class="muted">草稿尚未提交，主管無法查看。</p>';
    // 有逐級意見時逐級列出；否則（舊版週報）顯示單一意見
    const stamped = st ? st.levels.filter((l) => l.stamped && l.comment) : [];
    const comment = stamped.length
      ? `<ul class="stamp-comments">${stamped.map((l) => `<li><strong>${esc(l.admin ? '系統管理員' : l.rank_name)}</strong> ${esc(l.user_name || '')}：${esc(l.comment)}</li>`).join('')}</ul>`
      : report.review_comment ? `<div class="pre comment">${esc(report.review_comment)}</div>` : '';
    if (report.reviewed_at) {
      return `<p><strong>✔ 已完成核閱</strong></p>
        <p class="small">最後核閱：${esc(report.reviewer_name || '—')}<br>完成時間：${fmtDateTime(report.reviewed_at)}</p>${comment}`;
    }
    const next = st && st.next_rank_name;
    const progress = st && st.levels.length ? `（${progressText(st)}）` : '';
    return `<p class="warn-text">⏳ 核閱中${progress}</p>
      <p class="small">${next ? `目前輪到：${esc(next)}` : '沒有其他可核閱的層級，請由系統管理員代為完成核閱。'}</p>${comment}`;
  }
  const PRINT_TIP = '在列印視窗的「目的地」選擇「另存為 PDF」，即可輸出 PDF 檔。';
  function printButton(label) {
    return `<button class="btn btn-primary no-print" data-print title="${esc(PRINT_TIP)}">🖨 ${label || '列印／輸出 PDF'}</button>`;
  }
  function bindPrint() {
    root.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => window.print()));
  }
  /* ---------- 客戶名錄共用 ---------- */
  const FIELD_LABELS = { daily: '每日工作內容', customer_visits: '客戶拜訪紀錄', work_summary: '本週工作內容' };
  async function loadCustomers() {
    return must(await sb.from('customers').select('id, department_id, name, aliases, contacts, active').order('name'));
  }
  const termsOf = (c) => [c.name, ...(c.aliases || [])];
  // 依客戶欄文字找名錄中的客戶（正式名稱或別名，不分大小寫）
  const findCustomer = (text, list) => {
    const t = String(text || '').trim().toLowerCase();
    return t ? list.find((c) => termsOf(c).some((x) => x.toLowerCase() === t)) || null : null;
  };
  // 文字中提到的客戶
  function mentionedIn(text, customers) {
    const t = text.toLowerCase();
    return customers.filter((c) => termsOf(c).some((term) => t.includes(term.toLowerCase())));
  }
  // 可以新增客戶的部門：業務＝自己部門；主管＝負責部門＋自己部門；系統管理員＝全部
  // 可以新增客戶的部門：所屬部門＋額外可查閱部門；系統管理員全部
  function addableDepts(allDepts) {
    if (isAdmin()) return allDepts;
    return allDepts.filter((d) => myScope().includes(d.id));
  }
  // 修改、停用、刪除：有主管權限的職級（所屬及額外可查閱部門）、系統管理員
  const canEditCustomer = (c) => canManageDept(c.department_id);
  const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 擷取提到客戶的那一段文字，並標示客戶名稱
  function snippetHtml(content, terms, radius = 45) {
    const text = String(content || '').replace(/\s+/g, ' ').trim();
    const lower = text.toLowerCase();
    const hits = terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0);
    const at = hits.length ? Math.min(...hits) : 0;
    const start = Math.max(0, at - radius);
    const end = Math.min(text.length, at + radius * 2);
    const part = text.slice(start, end);
    const re = new RegExp('(' + [...terms].sort((a, b) => b.length - a.length).map(escRe).join('|') + ')', 'gi');
    const html = part.split(re).map((seg, i) => (i % 2 ? `<mark>${esc(seg)}</mark>` : esc(seg))).join('');
    return (start > 0 ? '…' : '') + html + (end < text.length ? '…' : '');
  }
  function recordDateLabel(r) {
    if (r.day_index == null) return weekLabel(r.week_start);
    return `${r.record_date.replace(/-/g, '/')}（週${DAY_NAMES[r.day_index]}）`;
  }
  const parseAliases = (v) => String(v || '').split(/[、,，;；\n]/).map((x) => x.trim()).filter(Boolean);

  // 新增／編輯客戶的對話框；完成時回傳客戶 id，取消回傳 null
  function customerDialog({ customer, name, departments }) {
    return new Promise((resolve) => {
      const editing = Boolean(customer);
      const depts = editing && !isAdmin() ? departments.filter((d) => canManageDept(d.id)) : departments;
      const dlg = document.createElement('dialog');
      dlg.className = 'customer-dialog';
      dlg.innerHTML = `
        <form method="dialog" class="stack" data-cust-form>
          <h2>${editing ? '編輯客戶' : '新增客戶到名錄'}</h2>
          <div data-error></div>
          ${depts.length > 1 ? `<label>部門<select name="department_id">${depts.map((d) => `<option value="${d.id}" ${d.id === (customer ? customer.department_id : me.department_id) ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>`
            : `<input type="hidden" name="department_id" value="${depts[0] ? depts[0].id : ''}"><p class="muted small">加入「${esc(depts[0] ? depts[0].name : '')}」的客戶名錄</p>`}
          <label>客戶名稱（正式名稱）<input name="name" value="${esc(customer ? customer.name : name || '')}" maxlength="100" required autocomplete="off"></label>
          <label>別名或簡稱 <span class="hint">用「、」或逗號分隔，每個至少 2 個字</span>
            <input name="aliases" value="${esc(customer ? customer.aliases.join('、') : '')}" placeholder="例：大成、大成電子" autocomplete="off"></label>
          <label>聯絡人 <span class="hint">用「、」或逗號分隔；填寫週報時也會自動加入</span>
            <input name="contacts" value="${esc(customer ? (customer.contacts || []).join('、') : '')}" placeholder="例：王經理、李小姐" autocomplete="off"></label>
          ${editing ? `<label class="check-label"><input type="checkbox" name="active" value="1" ${customer.active ? 'checked' : ''}> 使用中（取消勾選即停用，不再出現在輸入建議）</label>` : ''}
          <div class="actions"><button type="button" class="btn" data-cancel>取消</button><button class="btn btn-primary" value="save">${editing ? '儲存' : '加入名錄'}</button></div>
        </form>`;
      document.body.appendChild(dlg);
      const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
      dlg.querySelector('[data-cancel]').addEventListener('click', () => done(null));
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
      const form = dlg.querySelector('form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const btn = form.querySelector('button.btn-primary');
        btn.disabled = true;
        try {
          const id = must(await sb.rpc('save_customer', {
            p_id: customer ? customer.id : null,
            p_department_id: Number(fd.get('department_id')) || null,
            p_name: String(fd.get('name') || '').trim(),
            p_aliases: parseAliases(fd.get('aliases')),
            p_active: editing ? fd.get('active') === '1' : true,
            p_contacts: parseAliases(fd.get('contacts')),
          }));
          done(id);
        } catch (err) {
          form.querySelector('[data-error]').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
          btn.disabled = false;
        }
      });
      dlg.showModal();
      dlg.querySelector('input[name=name]').focus();
    });
  }

  // 輸入時的客戶建議（支援注音等輸入法：選字完成後才比對）
  function attachCustomerSuggest(textareas, getCustomers, onAdd) {
    const box = document.createElement('div');
    box.className = 'suggest';
    box.setAttribute('role', 'listbox');
    box.hidden = true;
    document.body.appendChild(box);
    let state = null; // { ta, k, items: [{ c } | { add: frag }], active }
    const close = () => { box.hidden = true; state = null; };
    const choose = (item) => {
      const { ta, k } = state;
      const caret = ta.selectionStart;
      close();
      if (item.add !== undefined) return onAdd(item.add);
      ta.focus();
      ta.setRangeText(item.c.name, caret - k, caret, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const render = () => {
      box.innerHTML = state.items.map((it, i) => `<div class="suggest-item ${i === state.active ? 'active' : ''}" role="option" data-i="${i}" aria-selected="${i === state.active}">
        ${it.c ? `<strong>${esc(it.c.name)}</strong>${it.c.aliases.length ? `<span class="muted small">別名：${esc(it.c.aliases.join('、'))}</span>` : ''}`
               : `<span class="suggest-add">＋ 新增「${esc(it.add)}」到客戶名錄</span>`}
      </div>`).join('');
      const r = state.ta.getBoundingClientRect();
      box.style.left = `${r.left + window.scrollX}px`;
      box.style.top = `${r.bottom + window.scrollY + 4}px`;
      box.style.width = `${Math.min(r.width, 380)}px`;
      box.hidden = false;
    };
    const update = (ta) => {
      const caret = ta.selectionStart;
      if (caret !== ta.selectionEnd) return close();
      const pre = ta.value.slice(0, caret);
      const lower = pre.toLowerCase();
      const list = getCustomers().filter((c) => c.active);
      // 游標前已是完整的客戶名稱就不提示
      if (list.some((c) => lower.endsWith(c.name.toLowerCase()))) return close();
      for (let k = Math.min(20, pre.length); k >= 2; k--) {
        const frag = lower.slice(-k);
        if (/\s/.test(frag)) continue;
        const hits = list.filter((c) => termsOf(c).some((t) => t.toLowerCase().startsWith(frag)));
        if (hits.length) {
          state = { ta, k, active: 0, items: [...hits.slice(0, 5).map((c) => ({ c })), { add: pre.slice(-k) }] };
          return render();
        }
      }
      close();
    };
    const bind = (ta) => {
      ta.setAttribute('aria-autocomplete', 'list');
      ta.addEventListener('input', (e) => { if (!e.isComposing) update(ta); });
      ta.addEventListener('compositionend', () => update(ta));
      ta.addEventListener('keydown', (e) => {
        if (!state || state.ta !== ta || e.isComposing || e.keyCode === 229) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          state.active = (state.active + (e.key === 'ArrowDown' ? 1 : -1) + state.items.length) % state.items.length;
          render();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          choose(state.items[state.active]);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      });
      ta.addEventListener('blur', () => setTimeout(() => { if (state && state.ta === ta && document.activeElement !== ta) close(); }, 150));
    };
    textareas.forEach(bind);
    box.addEventListener('mousedown', (e) => {
      const el = e.target.closest('[data-i]');
      if (!el) return;
      e.preventDefault();
      choose(state.items[Number(el.dataset.i)]);
    });
    window.addEventListener('hashchange', () => box.remove(), { once: true });
    return bind;
  }

  // 查看週報後可返回的列表頁
  function safeBack(v) {
    return typeof v === 'string' && /^\/(review|stats|print|customers)(\?|$)/.test(v) ? v : null;
  }
  // 他人週報在查閱名單上的狀態：mine＝輪到我核閱、progress＝核閱中、reviewed＝已查閱
  function reviewRowState(r, st) {
    const base = reportState(r);
    if (base !== 'pending') return base;
    // 系統管理員：只有沒有層級可核閱、需要代為完成的週報才算「待我核閱」
    if (st && (st.can_stamp || (st.is_admin && !st.complete && !st.next_rank_name))) return 'mine';
    return 'progress';
  }
  function badge(state) {
    const [t, c] = {
      missing: ['未提交', 'muted'], draft: ['草稿', 'muted'], pending: ['待核閱', 'warn'], reviewed: ['已查閱', 'ok'],
      mine: ['待我核閱', 'warn'], progress: ['核閱中', 'info'],
    }[state];
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
  const isAdmin = () => me && me.role === 'admin';
  const isWriter = () => me && me.role === 'user';
  // 有比自己低的職級（可能有下屬）或系統管理員，才顯示「週報查閱」「繳交統計」
  const isReviewer = () => me && (isAdmin() || (me.rank && ranks.some((r) => r.seniority < me.rank.seniority)));
  // 主管權限：管理客戶名錄、週會紀錄
  const hasManagerRight = () => me && (isAdmin() || Boolean(me.rank && me.rank.is_manager));
  // 涵蓋的部門：所屬部門＋額外可查閱部門
  const myScope = () => [...new Set([me.department_id, ...myManaged].filter(Boolean))];
  const canManageDept = (dept) => isAdmin() || (hasManagerRight() && myScope().includes(dept));
  const rankLabel = (p) => (p.role === 'admin' ? '系統管理員' : (p.rank && p.rank.name) || '');
  const rankOrder = (p) => (p.rank ? p.rank.seniority : -1e9);

  /* ------------------------------------------------------------------ 版面 */
  function navLink(href, label, active) {
    return `<a href="#${href}" class="${active ? 'active' : ''}">${label}</a>`;
  }
  function layout(body, section) {
    const f = flash;
    flash = null;
    const dept = me.department ? esc(me.department.name) + ' ' : '';
    root.innerHTML = `
      <header class="topbar"><div class="topbar-inner">
        <a class="brand" href="#/"><span class="brand-seal" aria-hidden="true">週</span>工作週報系統</a>
        <nav class="nav">
          ${isWriter() ? navLink('/reports', '我的週報', section === 'reports') : ''}
          ${isReviewer() ? navLink('/review', '週報查閱', section === 'review') + navLink('/stats', '繳交統計', section === 'stats') : ''}
          ${navLink('/meetings', '週會紀錄', section === 'meetings')}
          ${navLink('/customers', '客戶', section === 'customers')}
          ${isAdmin() ? navLink('/admin/users', '人員與權限', section === 'users') + navLink('/admin/ranks', '職級', section === 'ranks') + navLink('/admin/departments', '部門管理', section === 'departments') : ''}
        </nav>
        <div class="me">
          <span class="me-name">${esc(me.name)}<small>${dept}${esc(rankLabel(me))}</small></span>
          <a href="#/password">變更密碼</a>
          <button class="link" data-logout>登出</button>
        </div>
      </div></header>
      <main class="container ${section ? 'page-' + section : ''}">
        <div class="print-only print-meta">工作週報系統　列印人：${esc(me.name)}　列印時間：${fmtDateTime(new Date().toISOString())}</div>
        ${f ? `<div class="alert alert-${esc(f.type)}">${esc(f.text)}</div>` : ''}
        ${body}
      </main>`;
    root.querySelector('[data-logout]').addEventListener('click', async () => {
      await sb.auth.signOut();
      me = null;
      go('/login');
    });
    bindCommon();
    bindPrint();
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
      const buttons = form.querySelectorAll('button:not(:disabled)');
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
      <main class="container login-page"><section class="login">
        <span class="brand-seal brand-seal-lg" aria-hidden="true">週</span>
        <h1>工作週報系統</h1>
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
      .select('id, username, name, role, rank_id, department_id, active, must_change_password, department:departments!profiles_department_id_fkey(name), rank:ranks(id, name, seniority, is_manager)')
      .eq('id', data.session.user.id).maybeSingle());
    myManaged = [];
    ranks = [];
    if (profile && profile.active) {
      const [md, rk] = await Promise.all([
        sb.from('manager_departments').select('department_id').eq('user_id', profile.id),
        sb.from('ranks').select('id, name, seniority, is_manager').order('seniority', { ascending: false }),
      ]);
      myManaged = must(md).map((r) => r.department_id);
      ranks = must(rk);
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
    const states = await reviewStates(reports.filter((r) => r.status === 'submitted' && !r.reviewed_at).map((r) => r.id));
    // 自己的週報：核閱中（已有章）顯示進度；有章後不能再編輯
    const myState = (r) => {
      const st = states.get(r.id);
      return reportState(r) === 'pending' && st && st.levels.some((l) => l.stamped) ? 'progress' : reportState(r);
    };
    const stateHtml = (r) => {
      const st = states.get(r.id);
      return badge(myState(r)) + (st && st.levels.length ? ` <span class="muted small">${progressText(st)}</span>` : '');
    };
    const editable = (r) => !r.reviewed_at && myState(r) !== 'progress';
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
      ${me.department_id ? '' : '<div class="alert alert-warning">您尚未設定所屬部門，無法提交週報，請洽系統管理員設定。</div>'}
      <section class="card highlight"><div class="row-between">
        <div><div class="muted small">本週</div><strong>${weekLabel(thisWeek)}</strong></div>
        ${cur ? `<div class="row-gap">${stateHtml(cur)}<a class="btn" href="#/reports/${cur.id}">查看</a></div>`
              : `<a class="btn btn-primary" href="#/reports/new?week=${thisWeek}">填寫本週週報</a>`}
      </div></section>
      <section class="card">
        ${!reports.length ? '<p class="muted center">尚未有任何週報。</p>' : `
        <div class="table-wrap"><table>
          <thead><tr><th>週次</th><th>狀態</th><th>提交時間</th><th>主管核閱</th><th></th></tr></thead>
          <tbody>${reports.map((r) => `
            <tr>
              <td><a href="#/reports/${r.id}">${weekLabel(r.week_start)}</a></td>
              <td class="nowrap">${stateHtml(r)}</td>
              <td class="nowrap">${fmtDateTime(r.submitted_at) || '—'}</td>
              <td>${r.reviewed_at ? `${esc(r.reviewer_name || '—')} <span class="muted small">${fmtDateTime(r.reviewed_at)}</span>` : states.get(r.id) && states.get(r.id).next_rank_name ? `<span class="muted small">輪到 ${esc(states.get(r.id).next_rank_name)}</span>` : '<span class="muted">—</span>'}${r.review_comment ? `<div class="small comment-preview">💬 ${esc(r.review_comment)}</div>` : ''}</td>
              <td class="nowrap right">${editable(r) ? `<a href="#/reports/${r.id}/edit">編輯</a>` : ''}</td>
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
      const st = report.status === 'submitted' ? (await reviewStates([report.id])).get(report.id) : null;
      if (report.reviewed_at || (st && st.levels.some((l) => l.stamped))) {
        setFlash('warning', '此週報已有主管核閱，無法再修改。如需修改請洽主管撤回核閱。');
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
    // 自己部門的客戶名錄（建議與「本週提到的客戶」都以填寫人的部門為準）
    let allDepts = [];
    let myCustomers = [];
    if (me.department_id) {
      const [cs, ds] = await Promise.all([loadCustomers(), sb.from('departments').select('id, name').order('name').then(must)]);
      myCustomers = cs.filter((c) => c.department_id === me.department_id);
      allDepts = ds;
    }

    const entries = dailyEntriesOf(report);
    const dayBlock = (i) => `<div class="day-block" data-day="${i}">
      <div class="day-head"><span data-day-label="${i}">${dayLabelHtml(report.week_start, i)}</span></div>
      <div class="day-body">
        <div class="entries">${(entries[i].length ? entries[i] : [{}]).map(entryHtml).join('')}</div>
        <button type="button" class="btn btn-sm btn-add-entry" data-add-entry>＋ 新增一筆</button>
      </div>
    </div>`;
    const ta = (name, rows, ph) => `<textarea name="${name}" rows="${rows}" maxlength="10000" placeholder="${esc(ph || '')}">${esc(report[name] || '')}</textarea>`;
    layout(`
      <div class="page-head">
        <h1>${report.id ? '編輯週報' : '填寫週報'}</h1>
        <a href="#${report.id ? '/reports/' + report.id : '/reports'}">← 返回</a>
      </div>
      <div class="form-layout ${me.department_id ? 'has-panel' : ''}">
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
        <fieldset class="daily">
          <legend>每日工作內容 <span class="req">*</span> <span class="hint">至少填寫一天；每筆可填客戶與聯絡人</span></legend>
          ${[0, 1, 2, 3, 4].map(dayBlock).join('')}
          <details class="weekend" ${entries[5].length || entries[6].length ? 'open' : ''}>
            <summary>週六、週日（選填）</summary>
            ${[5, 6].map(dayBlock).join('')}
          </details>
          <datalist id="dl-customers">${myCustomers.filter((c) => c.active).map((c) => `<option value="${esc(c.name)}">${esc(c.aliases.join('、'))}</option>`).join('')}</datalist>
        </fieldset>
        ${report.work_summary ? `<label>本週工作內容（舊版欄位）${ta('work_summary', 4)}</label>` : ''}
        <label>客戶拜訪紀錄${ta('customer_visits', 5, '客戶名稱／拜訪日期／洽談重點')}</label>
        <label>業績與案件進度${ta('sales_progress', 4, '成交金額、報價中案件、預計結案時間等')}</label>
        <label>下週工作計畫${ta('next_week_plan', 5)}</label>
        <label>問題與需協助事項${ta('issues', 3)}</label>
        <div class="actions">
          ${report.status === 'submitted'
            ? '<button class="btn" value="draft" data-confirm="改回草稿後主管將看不到這份週報，確定嗎？">改回草稿</button><button class="btn btn-primary" value="submit">更新並提交</button>'
            : '<button class="btn" value="draft">儲存草稿</button><button class="btn btn-primary" value="submit">提交給主管</button>'}
        </div>
      </form>
      ${me.department_id ? `<aside class="card customer-panel" data-cust-panel>
        <h3>本週提到的客戶</h3>
        <div data-cust-list></div>
        <div data-cust-records></div>
        <button type="button" class="btn btn-sm" data-cust-add title="可先在欄位中選取客戶名稱，再按這裡">＋ 新增客戶到名錄</button>
      </aside>` : ''}
      </div>`, 'reports');

    const form = root.querySelector('[data-form]');
    form.addEventListener('input', () => { dirty = true; });
    const picker = form.querySelector('[data-week-picker]');
    if (picker) picker.addEventListener('change', () => {
      const ws = weekStartOf(picker.value);
      form.querySelector('[data-week-label]').textContent = ws ? '本週報週次：' + weekLabel(ws) : '';
      if (ws) form.querySelectorAll('[data-day-label]').forEach((el) => { el.innerHTML = dayLabelHtml(ws, Number(el.dataset.dayLabel)); });
    });
    // 新增一筆、刪除一筆；客戶欄改變時更新聯絡人建議
    const hooks = { bindContent: () => {} };
    const fillContacts = (entry) => {
      const c = findCustomer(entry.querySelector('[name=customer]').value, myCustomers);
      const dl = entry.querySelector('datalist');
      dl.innerHTML = c ? (c.contacts || []).map((x) => `<option value="${esc(x)}"></option>`).join('') : '';
    };
    form.querySelectorAll('.entry').forEach(fillContacts);
    form.addEventListener('click', (e) => {
      const add = e.target.closest('[data-add-entry]');
      if (add) {
        const list = add.closest('.day-block').querySelector('.entries');
        if (list.children.length >= 20) return window.alert('每天最多 20 筆。');
        list.insertAdjacentHTML('beforeend', entryHtml({}));
        const entry = list.lastElementChild;
        hooks.bindContent(entry.querySelector('textarea'));
        entry.querySelector('[name=customer]').focus();
        dirty = true;
        return;
      }
      const rm = e.target.closest('[data-remove-entry]');
      if (rm) {
        const entry = rm.closest('.entry');
        if (entry.parentElement.children.length > 1) entry.remove();
        else entry.querySelectorAll('input, textarea').forEach((x) => { x.value = ''; });
        dirty = true;
        form.dispatchEvent(new Event('input'));
      }
    });
    form.addEventListener('input', (e) => { if (e.target.name === 'customer') fillContacts(e.target.closest('.entry')); });
    if (me.department_id) bindCustomerPanel(form, report, allDepts, myCustomers, hooks);
    onSubmit(form, async (fd, action) => {
      const text = (k) => String(fd.get(k) || '').replace(/\r\n/g, '\n').trim();
      const submit = action === 'submit';
      const clean = (v) => String(v || '').replace(/\r\n/g, '\n').trim();
      const daily = [...form.querySelectorAll('.day-block')].map((b) => [...b.querySelectorAll('.entry')].map((en) => ({
        customer: clean(en.querySelector('[name=customer]').value),
        contact: clean(en.querySelector('[name=contact]').value),
        content: clean(en.querySelector('[name=content]').value),
      })).filter((x) => x.customer || x.contact || x.content));
      if (daily.some((d) => d.length > 20)) throw new Error('每天最多 20 筆。');
      if (submit && !daily.some((d) => d.length) && !text('work_summary')) throw new Error('提交前請至少填寫一天的工作內容。');
      const week = report.id ? null : weekStartOf(String(fd.get('week') || ''));
      if (!report.id && !week) throw new Error('請選擇正確的週次日期。');
      const newId = must(await sb.rpc('save_report', {
        p_id: report.id, p_week: week,
        p_work_summary: text('work_summary'), p_daily_work: null, p_daily_entries: daily, p_customer_visits: text('customer_visits'),
        p_sales_progress: text('sales_progress'), p_next_week_plan: text('next_week_plan'),
        p_issues: text('issues'), p_submit: submit,
      }));
      dirty = false;
      setFlash('success', submit ? '週報已提交，等待主管核閱。' : '草稿已儲存。');
      go('/reports/' + newId);
    });
  }

  // 每日一筆拜訪的輸入欄（客戶、聯絡人、內容）
  let entrySeq = 0;
  function entryHtml(e) {
    const n = ++entrySeq;
    return `<div class="entry">
      <div class="entry-meta">
        <label class="entry-field">客戶<input name="customer" value="${esc(e.customer || '')}" maxlength="100" autocomplete="off" list="dl-customers" placeholder="可留空"></label>
        <label class="entry-field">聯絡人<input name="contact" value="${esc(e.contact || '')}" maxlength="100" autocomplete="off" list="dl-contacts-${n}" placeholder="可留空"></label>
        <datalist id="dl-contacts-${n}"></datalist>
        <button type="button" class="entry-remove" data-remove-entry title="刪除這一筆" aria-label="刪除這一筆">✕</button>
      </div>
      <textarea name="content" rows="2" maxlength="4000" aria-label="工作內容" placeholder="工作內容，例：說明新方案、完成報價">${esc(e.content || '')}</textarea>
    </div>`;
  }

  // 填寫週報旁的「本週提到的客戶」與輸入建議
  function bindCustomerPanel(form, report, allDepts, customers, hooks) {
    const textFields = () => [...form.querySelectorAll('.entry [name=customer], .entry textarea[name=content], textarea[name=customer_visits], textarea[name=work_summary]')];
    const panel = root.querySelector('[data-cust-panel]');
    const listEl = panel.querySelector('[data-cust-list]');
    const recEl = panel.querySelector('[data-cust-records]');
    let lastField = textFields()[0];
    let selected = null;
    const cache = new Map();
    form.addEventListener('focusin', (e) => { if (e.target.matches('input[name=customer], textarea')) lastField = e.target; });

    const addCustomer = async (name) => {
      const id = await customerDialog({ name, departments: addableDepts(allDepts) });
      if (!id) return;
      const fresh = await loadCustomers();
      customers.splice(0, customers.length, ...fresh.filter((c) => c.department_id === me.department_id));
      const dl = form.querySelector('#dl-customers');
      if (dl) dl.innerHTML = customers.filter((c) => c.active).map((c) => `<option value="${esc(c.name)}">${esc(c.aliases.join('、'))}</option>`).join('');
      refresh();
      if (lastField) lastField.focus();
    };
    const showRecords = async (c) => {
      selected = c.id;
      refresh();
      recEl.innerHTML = '<p class="muted small">讀取中…</p>';
      try {
        if (!cache.has(c.id)) cache.set(c.id, must(await sb.rpc('customer_records', { p_customer_id: c.id, p_limit: 6, p_offset: 0 })));
        const rows = cache.get(c.id).filter((r) => r.report_id !== report.id).slice(0, 5);
        if (selected !== c.id) return;
        recEl.innerHTML = `<h4>${esc(c.name)} 的過往紀錄</h4>
          ${rows.length ? `<ul class="cust-records">${rows.map((r) => `<li>
            <a href="#/reports/${r.report_id}" target="_blank" rel="noopener">${esc(recordDateLabel(r))}</a>
            <span class="muted small">${esc(r.author_name || '')}</span>
            <div class="snippet">${snippetHtml(r.content, termsOf(c), 30)}</div></li>`).join('')}</ul>`
            : '<p class="muted small">還沒有已提交的週報提到這家客戶。</p>'}
          <a class="small" href="#/customers?id=${c.id}" target="_blank" rel="noopener">查看全部紀錄</a>`;
      } catch (e) {
        recEl.innerHTML = `<p class="alert alert-error">${esc(e.message)}</p>`;
      }
    };
    const refresh = () => {
      const found = mentionedIn(textFields().map((f) => f.value).join('\n'), customers);
      if (selected && !found.some((c) => c.id === selected)) { selected = null; recEl.innerHTML = ''; }
      listEl.innerHTML = found.length
        ? `<ul class="cust-chips">${found.map((c) => `<li><button type="button" class="chip ${c.id === selected ? 'active' : ''}" data-cid="${c.id}">${esc(c.name)}</button></li>`).join('')}</ul>`
        : `<p class="muted small">在工作內容或客戶拜訪紀錄寫到名錄中的客戶時，會列在這裡，點選可看過往紀錄。${customers.length ? '' : '<br>目前部門的客戶名錄還是空的。'}</p>`;
      listEl.querySelectorAll('[data-cid]').forEach((b) => b.addEventListener('click', () => showRecords(customers.find((c) => c.id === Number(b.dataset.cid)))));
    };
    let timer = null;
    form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 250); });
    panel.querySelector('[data-cust-add]').addEventListener('click', () => {
      const sel = lastField ? lastField.value.slice(lastField.selectionStart, lastField.selectionEnd).trim() : '';
      addCustomer(sel.length <= 100 ? sel : '');
    });
    hooks.bindContent = attachCustomerSuggest(
      [...form.querySelectorAll('.entry textarea[name=content], textarea[name=customer_visits], textarea[name=work_summary]')],
      () => customers, addCustomer);
    refresh();
  }

  /* ------------------------------------------------------------------ 檢視週報 */
  async function pageReportView(id, query) {
    const report = must(await sb.from('reports')
      .select('*, author:profiles!reports_user_id_fkey(name, department_id, department:departments!profiles_department_id_fkey(name))')
      .eq('id', id).maybeSingle());
    if (!report) return notFound();
    const logs = must(await sb.from('review_logs').select('action, comment, user_name, created_at').eq('report_id', id).order('id', { ascending: false }));
    const isOwner = report.user_id === me.id;
    const author = report.author || {};
    const st = report.status === 'submitted' ? (await reviewStates([report.id])).get(report.id) : null;
    const back = safeBack(query.get('back')) || (isOwner ? '/reports' : '/review');
    // 作者自己看：已有章就是「核閱中」；他人看：是否輪到自己
    const state = isOwner
      ? (reportState(report) === 'pending' && st && st.levels.some((l) => l.stamped) ? 'progress' : reportState(report))
      : reviewRowState(report, st);
    const locked = Boolean(report.reviewed_at || (st && st.levels.some((l) => l.stamped)));
    const L = { reviewed: '核閱', unreviewed: '撤回核閱', commented: '更新意見' };
    const myRankName = me.rank ? me.rank.name : '';
    // 可執行的核閱動作（由資料庫判斷，這裡只決定顯示哪些按鈕）
    const actions = st ? [
      st.can_stamp && `<button class="btn btn-primary" value="review">✔ 核閱（${esc(myRankName)}）</button>`,
      st.is_admin && !st.complete && '<button class="btn btn-primary" value="review" data-confirm="以系統管理員身分代為完成核閱？未核閱的層級將不再需要核閱。">代為完成核閱</button>',
      st.can_withdraw && '<button class="btn" value="comment">更新我的意見</button>',
      st.can_withdraw && '<button class="btn btn-danger-outline" value="unreview" data-confirm="確定撤回您的核閱？">撤回我的核閱</button>',
      st.is_admin && st.levels.some((l) => l.stamped) && '<button class="btn btn-danger-outline" value="unreview" data-confirm="撤回這份週報的全部核閱？撤回後作者可再次修改。">撤回全部核閱</button>',
    ].filter(Boolean) : [];

    layout(`
      <div class="page-head">
        <div>
          <a href="#${esc(back)}" class="small no-print">← 返回列表</a>
          <h1>${esc(author.name || me.name)} 的週報 ${badge(state)}</h1>
        </div>
        <div class="row-gap no-print">
          ${isOwner && !locked ? `<a class="btn" href="#/reports/${report.id}/edit">編輯</a>
            ${report.status === 'draft' ? '<button class="btn btn-danger" data-delete data-confirm="確定刪除這份草稿？">刪除</button>' : ''}` : ''}
          ${printButton()}
        </div>
      </div>
      <div class="grid-2">
        <section class="card sheet report-body">${reportBodyHtml(report, author.department && author.department.name, st)}</section>
        <aside class="stack">
          <section class="card review-box ${report.reviewed_at ? 'is-reviewed' : ''}">
            <h3>主管核閱</h3>
            ${reviewStatusHtml(report, st)}
            ${actions.length ? `<form class="stack" data-review>
              <div data-error></div>
              <label>核閱意見（選填）<textarea name="comment" rows="3" maxlength="2000"></textarea></label>
              ${actions.join('')}
            </form>` : ''}
          </section>
          ${logs.length ? `<section class="card review-log"><h3>核閱紀錄</h3><ul class="timeline">
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
      if (action === 'review') justReviewed = report.id;
      setFlash('success', { review: '已完成核閱。', unreview: '已撤回核閱。', comment: '核閱意見已更新。' }[action]);
      go(`/reports/${report.id}${qs({ back: query.get('back') })}`);
    });
  }

  /* ------------------------------------------------------------------ 週報查閱 */
  async function pageReview(query) {
    if (!isReviewer()) return forbidden();
    const { departments, deptName, deptFilter, scopeIds } = await reviewScope(query);
    const thisWeek = currentWeekStart();
    const weekParam = query.has('week') ? query.get('week') : thisWeek;
    const week = weekParam === 'all' ? null : (weekStartOf(weekParam) || thisWeek);
    // 狀態：mine＝待我核閱、progress＝核閱中（含待我核閱）、reviewed＝已查閱、missing＝未提交
    const status = ['mine', 'progress', 'reviewed', 'missing'].includes(query.get('status')) ? query.get('status') : 'all';
    const backUrl = '/review' + qs({ week: week || 'all', dept: deptFilter || '', status });
    const link = (o) => '#/review' + qs({ week: week || 'all', dept: deptFilter || '', status, ...o });

    // 待我核閱（所有週次）
    const myTurn = must(await sb.rpc('my_review_queue')).length;

    const author = 'author:profiles!reports_user_id_fkey!inner(name, role, department_id, rank:ranks(name, seniority))';
    let rows = [];
    let summary = null;
    if (scopeIds.length && week) {
      // 看得到的人員（依職級，由資料庫 RLS 決定）
      const people = must(await sb.from('profiles').select('id, name, role, department_id, rank:ranks(name, seniority)')
        .eq('active', true).eq('role', 'user').neq('id', me.id).in('department_id', scopeIds));
      const reports = must(await sb.from('reports')
        .select('id, user_id, week_start, status, submitted_at, reviewed_at, reviewer_name, work_summary, daily_work').eq('week_start', week));
      const states = await reviewStates(reports.filter((r) => r.status === 'submitted').map((r) => r.id));
      const byUser = Object.fromEntries(reports.map((r) => [r.user_id, r]));
      rows = people.map((p) => {
        const r = byUser[p.id] || {};
        const st = states.get(r.id);
        return { ...r, st, author_name: p.name, rank: p.rank, department_id: p.department_id, department_name: deptName[p.department_id] || '—', state: reviewRowState(r, st) };
      }).map((r) => (r.state === 'draft' ? { ...r, state: 'missing', id: null } : r));
      summary = {
        total: rows.length,
        missing: rows.filter((r) => r.state === 'missing').length,
        progress: rows.filter((r) => r.state === 'mine' || r.state === 'progress').length,
        mine: rows.filter((r) => r.state === 'mine').length,
        reviewed: rows.filter((r) => r.state === 'reviewed').length,
      };
    } else if (scopeIds.length && status !== 'missing') {
      let q = sb.from('reports')
        .select(`id, user_id, week_start, status, reviewed_at, reviewer_name, work_summary, daily_work, ${author}`)
        .eq('status', 'submitted').neq('user_id', me.id).in('author.department_id', scopeIds)
        .order('week_start', { ascending: false }).limit(500);
      if (status === 'reviewed') q = q.not('reviewed_at', 'is', null);
      if (status === 'mine' || status === 'progress') q = q.is('reviewed_at', null);
      const list = must(await q);
      const states = await reviewStates(list.filter((r) => !r.reviewed_at).map((r) => r.id));
      rows = list.map((r) => {
        const st = states.get(r.id);
        return { ...r, st, author_name: r.author.name, rank: r.author.rank, department_id: r.author.department_id, department_name: deptName[r.author.department_id] || '—', state: reviewRowState(r, st) };
      });
    }
    if (status === 'progress') rows = rows.filter((r) => r.state === 'mine' || r.state === 'progress');
    else if (status !== 'all') rows = rows.filter((r) => r.state === status);
    if (week) rows.sort((a, b) => a.department_name.localeCompare(b.department_name, 'zh-Hant')
      || rankOrder(b) - rankOrder(a) || a.author_name.localeCompare(b.author_name, 'zh-Hant'));
    const printable = summary ? summary.progress + summary.reviewed : 0;

    const opt = (v, label, cur) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${label}</option>`;
    layout(`
      <div class="page-head">
        <h1>週報查閱</h1>
        <a class="pending-pill ${myTurn ? '' : 'zero'}" href="#/review?week=all&status=mine">待我核閱：<strong>${myTurn}</strong> 份</a>
      </div>
      ${!departments.length ? '<div class="alert alert-warning">您目前沒有所屬部門或可查閱的部門，請洽系統管理員設定。</div>' : ''}
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
            ${opt('all', '全部狀態', status)}${opt('mine', '待我核閱', status)}${opt('progress', '核閱中', status)}${opt('reviewed', '已查閱', status)}${week ? opt('missing', '未提交', status) : ''}
          </select>
        </div>
      </form>
      ${week ? `<div class="row-between section-title-row">
          <h2 class="section-title">${weekLabel(week)}</h2>
          ${printable ? `<a class="btn btn-sm" href="#/print${qs({ week, dept: deptFilter || '', status: status === 'reviewed' ? 'reviewed' : status === 'mine' || status === 'progress' ? 'pending' : '' })}">🖨 列印本週週報</a>` : ''}
        </div>
        <div class="stats">
          <div class="stat"><span>${summary ? summary.total : 0}</span>應填人數</div>
          <div class="stat stat-muted"><span>${summary ? summary.missing : 0}</span>未提交</div>
          <div class="stat stat-warn"><span>${summary ? summary.progress : 0}</span>核閱中${summary && summary.mine ? `（待我核閱 ${summary.mine}）` : ''}</div>
          <div class="stat stat-ok"><span>${summary ? summary.reviewed : 0}</span>已查閱</div>
        </div>` : '<h2 class="section-title">所有週次已提交週報</h2>'}
      <form class="card" data-batch>
        <div data-error></div>
        ${!rows.length ? '<p class="muted center">沒有符合條件的資料。</p>' : `
        <div class="table-wrap"><table>
          <thead><tr>
            <th class="check"><input type="checkbox" data-check-all title="全選待我核閱"></th>
            ${week ? '' : '<th>週次</th>'}<th>部門</th><th>姓名</th><th>狀態</th><th>內容摘要</th><th>核閱</th><th></th>
          </tr></thead>
          <tbody>${rows.map((r) => {
            const visible = r.state !== 'missing' && r.state !== 'draft';
            const sum = workPreview(r);
            return `<tr class="state-${r.state}">
              <td class="check">${r.state === 'mine' ? `<input type="checkbox" name="ids" value="${r.id}">` : ''}</td>
              ${week ? '' : `<td class="nowrap">${weekLabel(r.week_start)}</td>`}
              <td class="nowrap">${esc(r.department_name)}</td>
              <td class="nowrap">${esc(r.author_name)}${r.rank ? ` <span class="tag">${esc(r.rank.name)}</span>` : ''}</td>
              <td class="nowrap">${badge(r.state)}${r.st && !r.st.complete && r.st.levels.length ? ` <span class="muted small">${progressText(r.st)}</span>` : ''}</td>
              <td class="summary">${visible ? esc(sum.slice(0, 60)) + (sum.length > 60 ? '…' : '') : '<span class="muted">—</span>'}</td>
              <td class="nowrap small">${r.reviewed_at ? `${esc(r.reviewer_name || '—')}<br><span class="muted">${fmtDateTime(r.reviewed_at)}</span>`
                : r.st && r.st.next_rank_name ? `<span class="muted">輪到 ${esc(r.st.next_rank_name)}</span>` : '<span class="muted">—</span>'}</td>
              <td class="nowrap right">${visible ? `<a class="btn btn-sm" href="#/reports/${r.id}${qs({ back: backUrl })}">查看</a>` : ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
        ${rows.some((r) => r.state === 'mine') ? '<div class="actions"><button class="btn btn-primary" data-confirm="確定核閱勾選的週報？">✔ 核閱勾選的週報</button></div>' : ''}`}
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
      if (!ids.length) throw new Error('請先勾選要核閱的週報。');
      const n = must(await sb.rpc('review_reports', { p_ids: ids }));
      setFlash(n ? 'success' : 'warning', n ? `已核閱 ${n} 份週報。` : '沒有輪到您核閱的週報。');
      go(backUrl);
    });
  }

  // 可查閱的部門：系統管理員全部；其他人＝所屬部門＋額外可查閱部門
  async function reviewScope(query) {
    const allDepts = must(await sb.from('departments').select('id, name').order('name'));
    const departments = isAdmin() ? allDepts : allDepts.filter((d) => myScope().includes(d.id));
    const deptIds = departments.map((d) => d.id);
    const deptFilter = Number(query.get('dept')) || 0;
    return {
      departments,
      deptName: Object.fromEntries(allDepts.map((d) => [d.id, d.name])),
      deptFilter: deptIds.includes(deptFilter) ? deptFilter : 0,
      scopeIds: deptIds.includes(deptFilter) ? [deptFilter] : deptIds,
    };
  }
  const byDeptRoleName = (deptName) => (a, b) => (deptName[a.department_id] || '').localeCompare(deptName[b.department_id] || '', 'zh-Hant')
    || rankOrder(b) - rankOrder(a) || a.name.localeCompare(b.name, 'zh-Hant');

  /* ------------------------------------------------------------------ 列印多份週報 */
  async function pagePrint(query) {
    if (!isReviewer()) return forbidden();
    const { deptName, deptFilter, scopeIds } = await reviewScope(query);
    const week = weekStartOf(query.get('week') || '') || currentWeekStart();
    const status = ['pending', 'reviewed'].includes(query.get('status')) ? query.get('status') : '';
    let reports = scopeIds.length ? await fetchAll(() => sb.from('reports')
      .select('*, author:profiles!reports_user_id_fkey!inner(name, role, department_id, rank:ranks(name, seniority))')
      .eq('week_start', week).eq('status', 'submitted').neq('user_id', me.id)
      .in('author.department_id', scopeIds).order('id')) : [];
    const states = await reviewStates(reports.map((r) => r.id));
    if (status === 'pending') reports = reports.filter((r) => !r.reviewed_at);
    if (status === 'reviewed') reports = reports.filter((r) => r.reviewed_at);
    const sortKey = byDeptRoleName(deptName);
    reports.sort((a, b) => sortKey({ ...a.author }, { ...b.author }));
    const scopeLabel = deptFilter ? deptName[deptFilter] : '全部部門';
    const back = '/review' + qs({ week, dept: deptFilter || '', status });

    layout(`
      <div class="page-head no-print">
        <div>
          <a href="#${esc(back)}" class="small">← 返回週報查閱</a>
          <h1>列印週報</h1>
          <div class="muted">${weekLabel(week)}，${esc(scopeLabel)}${status ? '，只含' + (status === 'pending' ? '核閱中' : '已查閱') : ''}，共 ${reports.length} 份</div>
        </div>
        ${reports.length ? printButton(`列印／輸出 PDF（${reports.length} 份）`) : ''}
      </div>
      ${reports.length ? `<div class="alert alert-info no-print">${PRINT_TIP}每份週報會從新的一頁開始。</div>` : '<p class="card muted center">這一週沒有可列印的已提交週報。</p>'}
      ${reports.map((r) => `
        <article class="card print-report">
          <header class="print-report-head">
            <h2>${esc(r.author.name)} 的週報 ${badge(reviewRowState(r, states.get(r.id)) === 'mine' ? 'progress' : reviewRowState(r, states.get(r.id)))}</h2>
          </header>
          <div class="sheet report-body">${reportBodyHtml(r, deptName[r.author.department_id], states.get(r.id))}</div>
          <section class="review-box print-review ${r.reviewed_at ? 'is-reviewed' : ''}"><h3>主管核閱</h3>${reviewStatusHtml(r, states.get(r.id))}</section>
        </article>`).join('')}`, 'review');
  }

  /* ------------------------------------------------------------------ 繳交統計 */
  async function pageStats(query) {
    if (!isReviewer()) return forbidden();
    const { departments, deptName, deptFilter, scopeIds } = await reviewScope(query);
    const thisWeek = currentWeekStart();
    const to = weekStartOf(query.get('to') || '') || thisWeek;
    const n = [4, 8, 12, 26].includes(Number(query.get('weeks'))) ? Number(query.get('weeks')) : 8;
    const weeks = Array.from({ length: n }, (_, i) => addDays(to, -7 * (n - 1 - i)));
    const from = weeks[0];
    const here = (o) => '/stats' + qs({ to, weeks: n, dept: deptFilter || '', ...o });

    let people = [];
    let reports = [];
    if (scopeIds.length) {
      people = must(await sb.from('profiles').select('id, name, role, department_id, created_at, rank:ranks(name, seniority)')
        .eq('active', true).eq('role', 'user').neq('id', me.id).in('department_id', scopeIds));
      reports = await fetchAll(() => sb.from('reports').select('id, user_id, week_start, status, submitted_at, reviewed_at')
        .eq('status', 'submitted').gte('week_start', from).lte('week_start', to).order('id'));
    }
    people.sort(byDeptRoleName(deptName));
    const byKey = Object.fromEntries(reports.map((r) => [r.user_id + '|' + r.week_start, r]));

    // 每一格：reviewed 已查閱、pending 待查閱、missing 未繳、ongoing 本週進行中（不計）、na 尚未到職（不計）
    const cellOf = (p, w) => {
      const r = byKey[p.id + '|' + w];
      if (r) return { state: r.reviewed_at ? 'reviewed' : 'pending', r, onTime: dateInTZ(r.submitted_at) <= addDays(w, 6) };
      if (p.created_at && w < weekStartOf(dateInTZ(p.created_at))) return { state: 'na' };
      if (w >= thisWeek) return { state: 'ongoing' };
      return { state: 'missing' };
    };
    const empty = () => ({ due: 0, submitted: 0, onTime: 0, reviewed: 0 });
    const add = (acc, c) => {
      if (c.state === 'na' || c.state === 'ongoing') return;
      acc.due += 1;
      if (c.r) {
        acc.submitted += 1;
        if (c.onTime) acc.onTime += 1;
        if (c.state === 'reviewed') acc.reviewed += 1;
      }
    };
    const rows = people.map((p) => {
      const cells = weeks.map((w) => cellOf(p, w));
      const sum = empty();
      cells.forEach((c) => add(sum, c));
      return { p, cells, sum };
    });
    const total = empty();
    const byDept = {};
    const byWeek = weeks.map(() => empty());
    for (const row of rows) {
      const d = (byDept[row.p.department_id] = byDept[row.p.department_id] || { people: 0, ...empty() });
      d.people += 1;
      row.cells.forEach((c, i) => { add(d, c); add(total, c); add(byWeek[i], c); });
    }
    const deptRows = departments.filter((d) => scopeIds.includes(d.id)).map((d) => ({ d, s: byDept[d.id] || { people: 0, ...empty() } }));
    const rateClass = (a, b) => (b && a / b < 0.8 ? 'rate-low' : '');
    const CELL = {
      reviewed: ['cell-ok', '✔', '已查閱'], pending: ['cell-warn', '●', '已提交、待查閱'], missing: ['cell-bad', '✕', '未繳交'],
      ongoing: ['cell-muted', '…', '本週進行中（不列入統計）'], na: ['cell-na', '', '尚未建立帳號（不列入統計）'],
    };
    const cellHtml = (c, w) => {
      const [cls, sym, title] = CELL[c.state];
      const t = c.r && !c.onTime ? title + '（逾期提交）' : title;
      return c.r
        ? `<a class="cell ${cls} ${c.onTime ? '' : 'late'}" href="#/reports/${c.r.id}${qs({ back: here() })}" title="${esc(weekLabel(w) + '：' + t)}">${sym}</a>`
        : `<span class="cell ${cls}" title="${esc(weekLabel(w) + '：' + t)}">${sym}</span>`;
    };
    const opt = (v, label, cur) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${label}</option>`;
    const md = (w) => w.slice(5).replace('-', '/');

    layout(`
      <div class="page-head">
        <div>
          <h1>繳交統計</h1>
          <div class="muted">${esc(deptFilter ? deptName[deptFilter] : '全部部門')}，${from.replace(/-/g, '/')} ～ ${addDays(to, 6).replace(/-/g, '/')}，共 ${n} 週</div>
        </div>
        ${printButton()}
      </div>
      ${!departments.length ? '<div class="alert alert-warning">您目前沒有被指派任何可查閱的部門，請洽系統管理員設定。</div>' : ''}
      <form class="card filters" data-filters>
        <div class="week-nav">
          <label class="inline-label">統計到<input type="date" name="to" value="${to}"></label>
          <select name="weeks">${[4, 8, 12, 26].map((k) => opt(k, `近 ${k} 週`, n)).join('')}</select>
          <a class="btn btn-sm ${to === thisWeek ? 'btn-primary' : ''}" href="#${here({ to: thisWeek })}">到本週</a>
        </div>
        <select name="dept">${opt('', '全部部門', deptFilter || '')}${departments.map((d) => opt(d.id, esc(d.name), deptFilter)).join('')}</select>
      </form>

      <div class="stats">
        <div class="stat"><span>${total.due}</span>應繳份數</div>
        <div class="stat stat-ok"><span>${pct(total.submitted, total.due)}</span>繳交率（${total.submitted} 份）</div>
        <div class="stat stat-bad"><span>${total.due - total.submitted}</span>未繳份數</div>
        <div class="stat"><span>${pct(total.onTime, total.submitted)}</span>準時率</div>
      </div>

      <h2 class="section-title">各部門</h2>
      <section class="card"><div class="table-wrap"><table class="stats-table">
        <thead><tr><th>部門</th><th class="num">人數</th><th class="num">應繳</th><th class="num">已繳</th><th class="num">未繳</th><th class="num">繳交率</th><th class="num">準時率</th><th class="num">已查閱</th><th class="num">查閱率</th></tr></thead>
        <tbody>${deptRows.map(({ d, s }) => `<tr>
          <td><a href="#${here({ dept: d.id })}">${esc(d.name)}</a></td>
          <td class="num">${s.people}</td><td class="num">${s.due}</td><td class="num">${s.submitted}</td>
          <td class="num ${s.due - s.submitted ? 'rate-low' : ''}">${s.due - s.submitted}</td>
          <td class="num ${rateClass(s.submitted, s.due)}"><strong>${pct(s.submitted, s.due)}</strong></td>
          <td class="num">${pct(s.onTime, s.submitted)}</td><td class="num">${s.reviewed}</td><td class="num">${pct(s.reviewed, s.submitted)}</td>
        </tr>`).join('')}</tbody>
        ${deptRows.length > 1 ? `<tfoot><tr><th>合計</th><th class="num">${rows.length}</th><th class="num">${total.due}</th><th class="num">${total.submitted}</th>
          <th class="num">${total.due - total.submitted}</th><th class="num">${pct(total.submitted, total.due)}</th><th class="num">${pct(total.onTime, total.submitted)}</th>
          <th class="num">${total.reviewed}</th><th class="num">${pct(total.reviewed, total.submitted)}</th></tr></tfoot>` : ''}
      </table></div></section>

      <h2 class="section-title">人員逐週繳交情況</h2>
      <p class="legend small muted">
        <span class="cell cell-ok">✔</span> 已查閱　<span class="cell cell-warn">●</span> 待查閱　<span class="cell cell-bad">✕</span> 未繳交　<span class="cell cell-ok late">✔</span> 逾期提交（底線）　<span class="cell cell-muted">…</span> 本週進行中　<span class="cell cell-na"></span> 尚未建立帳號<br>
        「本週進行中」與「尚未建立帳號」的週次不列入統計；「準時」指在該週週日（含）以前提交。點選格子可開啟該份週報。
      </p>
      <section class="card">${!rows.length ? '<p class="muted center">沒有可統計的人員。</p>' : `<div class="table-wrap"><table class="stats-table grid">
        <thead><tr><th>部門</th><th>姓名</th>${weeks.map((w) => `<th class="wk ${w === thisWeek ? 'this-week' : ''}" title="${esc(weekLabel(w))}">${md(w)}</th>`).join('')}
          <th class="num">已繳／應繳</th><th class="num">繳交率</th><th class="num">準時</th></tr></thead>
        <tbody>${rows.map(({ p, cells, sum }) => `<tr>
          <td class="nowrap">${esc(deptName[p.department_id] || '—')}</td>
          <td class="nowrap">${esc(p.name)}${p.rank ? ` <span class="tag">${esc(p.rank.name)}</span>` : ''}</td>
          ${cells.map((c, i) => `<td class="wk ${weeks[i] === thisWeek ? 'this-week' : ''}">${cellHtml(c, weeks[i])}</td>`).join('')}
          <td class="num">${sum.submitted}／${sum.due}</td>
          <td class="num ${rateClass(sum.submitted, sum.due)}"><strong>${pct(sum.submitted, sum.due)}</strong></td>
          <td class="num">${sum.onTime}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr><th colspan="2">各週繳交</th>${byWeek.map((s) => `<th class="wk small">${s.due ? `${s.submitted}/${s.due}` : '—'}</th>`).join('')}
          <th class="num">${total.submitted}／${total.due}</th><th class="num">${pct(total.submitted, total.due)}</th><th class="num">${total.onTime}</th></tr></tfoot>
      </table></div>`}</section>`, 'stats');

    const filters = root.querySelector('[data-filters]');
    filters.addEventListener('change', () => {
      const fd = new FormData(filters);
      go('/stats' + qs({ to: weekStartOf(String(fd.get('to') || '')) || thisWeek, weeks: fd.get('weeks'), dept: fd.get('dept') }));
    });
    filters.addEventListener('submit', (e) => e.preventDefault());
  }

  /* ------------------------------------------------------------------ 客戶 */
  // 刪除客戶（負責該部門的主管、系統管理員）：只刪名錄，週報內容不變
  function delCustomerBtn(c, size) {
    const msg = `確定刪除客戶「${c.name}」？\n\n只會從客戶名錄移除，週報內容不會刪除；日後重新加入同名客戶，紀錄會再出現。\n若只是不想再出現在輸入建議，可改用「編輯」→ 取消「使用中」來停用。`;
    return `<button class="btn ${size} btn-danger-outline" data-del-cust="${c.id}" data-confirm="${esc(msg)}">刪除</button>`;
  }
  async function pageCustomers(query) {
    const [customers, allDepts] = await Promise.all([loadCustomers(), sb.from('departments').select('id, name').order('name').then(must)]);
    const deptName = Object.fromEntries(allDepts.map((d) => [d.id, d.name]));
    const multiDept = new Set(customers.map((c) => c.department_id)).size > 1 || isAdmin() || myScope().length > 1;
    const addable = addableDepts(allDepts);
    const id = Number(query.get('id')) || 0;
    const current = customers.find((c) => c.id === id) || null;
    const label = (c) => esc(c.name) + (multiDept ? ` <span class="muted small">${esc(deptName[c.department_id] || '')}</span>` : '');
    const stats = customers.length
      ? must(await sb.rpc('customer_stats', { p_customer_ids: current ? [current.id] : customers.map((c) => c.id) }))
      : [];
    const sumBy = {};
    for (const s of stats) {
      const t = (sumBy[s.customer_id] = sumBy[s.customer_id] || { records: 0, last: '', people: [] });
      t.records += Number(s.records);
      if (s.last_date > t.last) t.last = s.last_date;
      t.people.push(s);
    }
    const searchBox = `
      <div class="cust-search" data-cust-search>
        <label class="sr" for="cust-q">搜尋客戶</label>
        <input id="cust-q" type="search" placeholder="輸入客戶名稱或別名" autocomplete="off" value="">
        <div class="suggest cust-results" role="listbox" hidden></div>
      </div>`;

    if (id && !current) return errorPage('找不到客戶', '客戶不存在，或不在您可查看的部門。');

    if (!current) {
      layout(`
        <div class="page-head">
          <div><h1>客戶</h1><div class="muted">${isAdmin() ? '全部部門' : esc(myScope().map((d) => deptName[d]).filter(Boolean).join('、'))}的客戶名錄，共 ${customers.length} 家</div></div>
          ${addable.length ? '<button class="btn btn-primary" data-add>＋ 新增客戶</button>' : ''}
        </div>
        ${searchBox}
        <section class="card">${!customers.length ? '<p class="muted center">名錄還是空的。按「新增客戶」加入第一家客戶，或在填寫週報時直接加入。</p>' : `
          <div class="table-wrap"><table>
            <thead><tr><th>客戶</th><th>別名</th><th class="num">紀錄次數</th><th>最後紀錄</th><th>狀態</th><th></th></tr></thead>
            <tbody>${customers.map((c) => {
              const t = sumBy[c.id] || { records: 0, last: '' };
              return `<tr class="${c.active ? '' : 'inactive'}">
                <td><a href="#/customers?id=${c.id}">${esc(c.name)}</a>${multiDept ? `<div class="muted small">${esc(deptName[c.department_id] || '')}</div>` : ''}</td>
                <td class="small">${esc(c.aliases.join('、')) || '<span class="muted">—</span>'}</td>
                <td class="num">${t.records}</td>
                <td class="nowrap">${t.last ? t.last.replace(/-/g, '/') : '<span class="muted">—</span>'}</td>
                <td>${c.active ? '使用中' : '<span class="badge badge-muted">停用</span>'}</td>
                <td class="right nowrap">${canEditCustomer(c) ? `<button class="btn btn-sm" data-edit="${c.id}">編輯</button>` : ''}
                  ${canEditCustomer(c) ? delCustomerBtn(c, 'btn-sm') : ''}</td>
              </tr>`;
            }).join('')}</tbody>
          </table></div>`}
        </section>
        <p class="muted small">紀錄次數以「您看得到的已提交週報」計算：每日工作內容提到的每一天算 1 次；只寫在客戶拜訪紀錄的，該週算 1 次。</p>`, 'customers');
    } else {
      const t = sumBy[current.id] || { records: 0, last: '', people: [] };
      t.people.sort((a, b) => Number(b.records) - Number(a.records));
      layout(`
        <div class="page-head">
          <div>
            <a href="#/customers" class="small">← 全部客戶</a>
            <h1>${esc(current.name)} ${current.active ? '' : '<span class="badge badge-muted">停用</span>'}</h1>
            <div class="muted">${esc(deptName[current.department_id] || '')}${current.aliases.length ? `，別名：${esc(current.aliases.join('、'))}` : ''}</div>
            ${(current.contacts || []).length ? `<div class="muted small">聯絡人：${esc(current.contacts.join('、'))}</div>` : ''}
          </div>
          <div class="row-gap">
            ${canEditCustomer(current) ? `<button class="btn" data-edit="${current.id}">編輯客戶</button>` : ''}
            ${canEditCustomer(current) ? delCustomerBtn(current, '') : ''}
          </div>
        </div>
        ${searchBox}
        <div class="stats cust-stats">
          <div class="stat"><span>${t.records}</span>紀錄次數</div>
          <div class="stat"><span>${t.last ? t.last.replace(/-/g, '/') : '—'}</span>最後紀錄日期</div>
          <div class="stat stat-people"><span>${t.people.length}</span>${t.people.length ? `接觸人員：${t.people.map((p) => `${esc(p.author_name || '—')} ${p.records}`).join('、')}` : '接觸人員'}</div>
        </div>
        <section class="card">
          <ol class="cust-timeline" data-records></ol>
          <p class="muted center" data-empty hidden>還沒有您看得到的已提交週報提到這家客戶。</p>
          <div class="center"><button class="btn btn-sm" data-more hidden>載入更多</button></div>
        </section>`, 'customers');

      const list = root.querySelector('[data-records]');
      const more = root.querySelector('[data-more]');
      const back = '/customers?id=' + current.id;
      let offset = 0;
      const PAGE = 50;
      const loadMore = async () => {
        more.disabled = true;
        const rows = must(await sb.rpc('customer_records', { p_customer_id: current.id, p_limit: PAGE, p_offset: offset }));
        offset += rows.length;
        list.insertAdjacentHTML('beforeend', rows.map((r) => `<li>
          <div class="cust-rec-head"><strong>${esc(recordDateLabel(r))}</strong>
            <span>${esc(r.author_name || '—')}</span><span class="muted small">${FIELD_LABELS[r.field] || ''}</span>
            <a class="small" href="#/reports/${r.report_id}${qs({ back })}">開啟週報</a></div>
          <div class="snippet">${snippetHtml(r.content, termsOf(current))}</div>
        </li>`).join(''));
        root.querySelector('[data-empty]').hidden = offset > 0;
        more.hidden = rows.length < PAGE;
        more.disabled = false;
      };
      more.addEventListener('click', () => loadMore().catch((e) => window.alert(e.message)));
      await loadMore();
    }

    // 搜尋：輸入即列出符合的客戶（名稱或別名包含輸入文字）
    const box = root.querySelector('[data-cust-search]');
    const input = box.querySelector('input');
    const results = box.querySelector('.cust-results');
    let active = 0;
    let hits = [];
    const renderHits = () => {
      results.innerHTML = hits.length
        ? hits.map((c, i) => `<a class="suggest-item ${i === active ? 'active' : ''}" role="option" href="#/customers?id=${c.id}">
            <strong>${label(c)}</strong>${c.aliases.length ? `<span class="muted small">別名：${esc(c.aliases.join('、'))}</span>` : ''}${c.active ? '' : ' <span class="badge badge-muted">停用</span>'}</a>`).join('')
        : '<div class="suggest-item muted">找不到符合的客戶</div>';
      results.hidden = false;
    };
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { results.hidden = true; return; }
      hits = customers.filter((c) => termsOf(c).some((term) => term.toLowerCase().includes(q))).slice(0, 8);
      active = 0;
      renderHits();
    });
    input.addEventListener('keydown', (e) => {
      if (results.hidden || !hits.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
        renderHits();
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        go('/customers?id=' + hits[active].id);
      } else if (e.key === 'Escape') {
        results.hidden = true;
      }
    });
    input.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 150));

    root.querySelectorAll('[data-del-cust]').forEach((b) => b.addEventListener('click', async () => {
      const c = customers.find((x) => x.id === Number(b.dataset.delCust));
      try {
        must(await sb.rpc('admin_delete_customer', { p_id: c.id }));
        setFlash('success', `已刪除客戶「${c.name}」。週報內容沒有變動。`);
        go('/customers');
      } catch (e) { window.alert(e.message); }
    }));
    const reload = () => go('/customers' + (current ? '?id=' + current.id : ''));
    const add = root.querySelector('[data-add]');
    if (add) add.addEventListener('click', async () => {
      const newId = await customerDialog({ departments: addable });
      if (newId) { setFlash('success', '已加入客戶名錄。'); go('/customers?id=' + newId); }
    });
    root.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', async () => {
      const c = customers.find((x) => x.id === Number(b.dataset.edit));
      const saved = await customerDialog({ customer: c, departments: allDepts });
      if (saved) { setFlash('success', `已更新客戶「${c.name}」。`); reload(); }
    }));
  }

  /* ------------------------------------------------------------------ 管理：部門 */
  async function pageDepartments() {
    if (!isAdmin()) return forbidden();
    const [departments, profiles, managed] = await Promise.all([
      sb.from('departments').select('id, name').order('name'),
      sb.from('profiles').select('id, name, role, department_id, active, rank:ranks(name, seniority, is_manager)'),
      sb.from('manager_departments').select('user_id, department_id'),
    ]).then((rs) => rs.map(must));
    // 具主管權限的人員：所屬部門或額外可查閱部門為該部門，且職級有主管權限
    const managersOf = (deptId) => profiles
      .filter((p) => p.active && p.role === 'user' && p.rank && p.rank.is_manager
        && (p.department_id === deptId || managed.some((m) => m.user_id === p.id && m.department_id === deptId)))
      .sort((a, b) => rankOrder(b) - rankOrder(a))
      .map((p) => `${p.name}（${p.rank.name}）`);
    layout(`
      <div class="page-head"><h1>部門管理</h1></div>
      <form class="card inline-form" data-create>
        <input name="name" placeholder="新部門名稱" maxlength="50" required>
        <button class="btn btn-primary">新增部門</button>
      </form>
      <section class="card">
        ${!departments.length ? '<p class="muted center">尚未建立部門。</p>' : `
        <div class="table-wrap"><table>
          <thead><tr><th>部門名稱</th><th>人數</th><th>具主管權限的人員</th><th></th></tr></thead>
          <tbody>${departments.map((d) => {
            const count = profiles.filter((p) => p.department_id === d.id).length;
            const managers = managersOf(d.id);
            return `<tr>
              <td><form class="inline-form" data-rename="${d.id}"><input name="name" value="${esc(d.name)}" maxlength="50" required><button class="btn btn-sm">更名</button></form></td>
              <td><a href="#/admin/users?dept=${d.id}">${count} 人</a></td>
              <td>${esc(managers.join('、')) || '—'}</td>
              <td class="right"><button class="btn btn-sm btn-danger-outline" data-del="${d.id}" data-confirm="確定刪除部門「${esc(d.name)}」？該部門的客戶名錄也會一併刪除。" ${count ? 'disabled title="部門仍有人員"' : ''}>刪除</button></td>
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
    if (!isAdmin()) return forbidden();
    const dept = Number(query.get('dept')) || 0;
    const [departments, profiles, managed] = await Promise.all([
      sb.from('departments').select('id, name').order('name'),
      sb.from('profiles').select('id, username, name, role, department_id, active, rank:ranks(name, seniority)'),
      sb.from('manager_departments').select('user_id, department_id'),
    ]).then((rs) => rs.map(must));
    const deptName = Object.fromEntries(departments.map((d) => [d.id, d.name]));
    const users = profiles.filter((u) => !dept || u.department_id === dept).sort((a, b) =>
      (b.active - a.active) || (a.role === b.role ? 0 : a.role === 'admin' ? -1 : 1)
      || (deptName[a.department_id] || '').localeCompare(deptName[b.department_id] || '', 'zh-Hant')
      || rankOrder(b) - rankOrder(a) || a.name.localeCompare(b.name, 'zh-Hant'));
    layout(`
      <div class="page-head"><h1>人員與權限</h1><a class="btn btn-primary" href="#/admin/users/new">＋ 新增人員</a></div>
      <form class="card inline-form" data-filter>
        <select name="dept"><option value="">全部部門</option>${departments.map((d) => `<option value="${d.id}" ${d.id === dept ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
      </form>
      <section class="card"><div class="table-wrap"><table>
        <thead><tr><th>姓名</th><th>帳號</th><th>職級</th><th>所屬部門</th><th>額外可查閱部門</th><th>狀態</th><th></th></tr></thead>
        <tbody>${users.map((u) => `
          <tr class="${u.active ? '' : 'inactive'}">
            <td>${esc(u.name)}</td>
            <td><code>${esc(u.username)}</code></td>
            <td>${u.role === 'admin' ? '<span class="tag tag-admin">系統管理員</span>' : `<span class="tag ${u.rank && ranks.find((r) => r.name === u.rank.name && r.is_manager) ? 'tag-manager' : ''}">${esc(u.rank ? u.rank.name : '—')}</span>`}</td>
            <td>${esc(deptName[u.department_id] || '—')}</td>
            <td>${u.role === 'admin' ? '全部' : esc(managed.filter((m) => m.user_id === u.id).map((m) => deptName[m.department_id]).join('、')) || '—'}</td>
            <td>${u.active ? '啟用' : '停用'}</td>
            <td class="right"><a class="btn btn-sm" href="#/admin/users/${u.id}">編輯</a></td>
          </tr>`).join('')}
        </tbody>
      </table></div></section>
      <section class="card muted small">
        <strong>權限說明</strong>
        <ul>
          <li><b>職級</b>：可查閱同部門（含額外可查閱部門）中職級比自己低的人員與週報；同職級、較高職級看不到。職級名稱與高低在「<a href="#/admin/ranks">職級</a>」設定。</li>
          <li><b>逐級核閱</b>：週報由低到高、每一個職級各核閱一次（同職級任一人即可），全部完成才算「已查閱」。</li>
          <li><b>主管權限</b>（在「職級」勾選）：可管理所屬及額外可查閱部門的客戶名錄、週會紀錄。</li>
          <li><b>系統管理員</b>：可查閱所有週報、代為完成核閱，並管理部門、職級、人員帳號與權限。</li>
        </ul>
      </section>`, 'users');
    root.querySelector('[data-filter]').addEventListener('change', (e) => go('/admin/users' + qs({ dept: e.target.value })));
  }

  async function pageUserForm(id) {
    if (!isAdmin()) return forbidden();
    const departments = must(await sb.from('departments').select('id, name').order('name'));
    const lowest = ranks.length ? ranks[ranks.length - 1].id : null;
    let user = { id: null, username: '', name: '', role: 'user', rank_id: lowest, department_id: null, active: true, managed: [] };
    if (id) {
      const u = must(await sb.from('profiles').select('id, username, name, role, rank_id, department_id, active').eq('id', id).maybeSingle());
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
          <label>帳號類型<select name="role" data-role>${['user', 'admin'].map((r) => `<option value="${r}" ${user.role === r ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`).join('')}</select></label>
          <label data-user-only>職級<select name="rank_id">${ranks.map((r) => `<option value="${r.id}" ${r.id === user.rank_id ? 'selected' : ''}>${esc(r.name)}${r.is_manager ? '（主管權限）' : ''}</option>`).join('')}</select></label>
          <label>所屬部門<select name="department_id"><option value="">（無）</option>${departments.map((d) => `<option value="${d.id}" ${d.id === user.department_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
        </div>
        <fieldset class="managed" data-user-only>
          <legend>額外可查閱的部門（選填）</legend>
          <p class="hint" style="flex-basis:100%;margin:0">在這些部門裡，同樣可查閱職級比自己低的人員（例如一位協理同時負責兩個部門）。</p>
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
    const sync = () => root.querySelectorAll('[data-user-only]').forEach((el) => { el.hidden = role.value !== 'user'; });
    role.addEventListener('change', sync);
    sync();
    onSubmit(root.querySelector('[data-form]'), async (fd) => {
      const name = String(fd.get('name') || '').trim();
      const isUser = fd.get('role') === 'user';
      must(await sb.rpc('admin_save_user', {
        p_id: user.id,
        p_username: String(fd.get('username') || '').trim(),
        p_name: name,
        p_role: fd.get('role'),
        p_rank_id: isUser ? Number(fd.get('rank_id')) || null : null,
        p_department_id: Number(fd.get('department_id')) || null,
        p_extra_depts: isUser ? fd.getAll('managed').map(Number) : [],
        p_active: fd.get('active') === '1',
        p_password: String(fd.get('password') || ''),
      }));
      setFlash('success', id ? `已更新人員「${name}」。` : `已新增人員「${name}」，首次登入需變更密碼。`);
      go('/admin/users');
    });
  }

  /* ------------------------------------------------------------------ 管理：職級 */
  async function pageRanks() {
    if (!isAdmin()) return forbidden();
    const [list, people] = await Promise.all([
      sb.from('ranks').select('id, name, seniority, is_manager').order('seniority', { ascending: false }),
      sb.from('profiles').select('rank_id').eq('role', 'user'),
    ]).then((rs) => rs.map(must));
    const count = (id) => people.filter((p) => p.rank_id === id).length;
    layout(`
      <div class="page-head">
        <div><h1>職級</h1><div class="muted">由高到低排列。高職級可查閱同部門（含額外可查閱部門）職級較低的人員，週報由低到高逐級核閱。</div></div>
      </div>
      <section class="card"><div class="table-wrap"><table>
        <thead><tr><th>高低</th><th>職級名稱</th><th>主管權限</th><th class="num">人數</th><th></th></tr></thead>
        <tbody>${list.map((r, i) => `
          <tr>
            <td class="nowrap">
              <button type="button" class="btn btn-sm" data-move="${r.id}" data-up="1" ${i === 0 ? 'disabled' : ''} aria-label="調高「${esc(r.name)}」">↑</button>
              <button type="button" class="btn btn-sm" data-move="${r.id}" data-up="0" ${i === list.length - 1 ? 'disabled' : ''} aria-label="調低「${esc(r.name)}」">↓</button>
            </td>
            <td><form class="inline-form" data-rank="${r.id}">
              <input name="name" value="${esc(r.name)}" maxlength="20" required aria-label="職級名稱">
              <label class="check-label small"><input type="checkbox" name="is_manager" value="1" ${r.is_manager ? 'checked' : ''}> 主管權限</label>
              <button class="btn btn-sm">儲存</button>
            </form></td>
            <td>${r.is_manager ? '<span class="tag tag-manager">有</span>' : '<span class="muted">—</span>'}</td>
            <td class="num"><a href="#/admin/users">${count(r.id)} 人</a></td>
            <td class="right"><button type="button" class="btn btn-sm btn-danger-outline" data-del-rank="${r.id}" data-confirm="確定刪除職級「${esc(r.name)}」？" ${count(r.id) ? 'disabled title="仍有人員是這個職級"' : ''}>刪除</button></td>
          </tr>`).join('')}
        </tbody>
      </table></div></section>
      <form class="card inline-form" data-create>
        <input name="name" placeholder="新職級名稱" maxlength="20" required>
        <label class="check-label small"><input type="checkbox" name="is_manager" value="1"> 主管權限</label>
        <button class="btn btn-primary">新增職級</button>
        <span class="hint">新增的職級會排在最低，可再用 ↑ 調整位置。</span>
      </form>
      <section class="card muted small">
        <strong>說明</strong>
        <ul>
          <li>調整高低後立即生效：誰看得到誰、週報要經過哪些層級核閱都會跟著改變；已蓋的核閱章會保留。</li>
          <li><b>主管權限</b>：可管理所屬及額外可查閱部門的客戶名錄（修改、停用、刪除）與週會紀錄。</li>
          <li>仍有人員的職級不能刪除，請先到「人員與權限」調整這些人員的職級。</li>
        </ul>
      </section>`, 'ranks');

    const done = async (msg) => { ranks = must(await sb.from('ranks').select('id, name, seniority, is_manager').order('seniority', { ascending: false })); setFlash('success', msg); go('/admin/ranks'); };
    onSubmit(root.querySelector('[data-create]'), async (fd) => {
      must(await sb.rpc('admin_save_rank', { p_id: null, p_name: fd.get('name'), p_is_manager: fd.get('is_manager') === '1' }));
      await done(`已新增職級「${String(fd.get('name')).trim()}」。`);
    });
    root.querySelectorAll('[data-rank]').forEach((f) => onSubmit(f, async (fd) => {
      must(await sb.rpc('admin_save_rank', { p_id: Number(f.dataset.rank), p_name: fd.get('name'), p_is_manager: fd.get('is_manager') === '1' }));
      await done('職級已更新。');
    }));
    root.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', async () => {
      try {
        must(await sb.rpc('admin_move_rank', { p_id: Number(b.dataset.move), p_up: b.dataset.up === '1' }));
        await done('職級順序已調整。');
      } catch (e) { window.alert(e.message); }
    }));
    root.querySelectorAll('[data-del-rank]').forEach((b) => b.addEventListener('click', async () => {
      try {
        must(await sb.rpc('admin_delete_rank', { p_id: Number(b.dataset.delRank) }));
        await done('職級已刪除。');
      } catch (e) { window.alert(e.message); }
    }));
  }

  /* ------------------------------------------------------------------ 週會紀錄 */
  function canManageMeeting(dept) {
    return canManageDept(dept);
  }
  function departmentOptions(departments, selected) {
    return departments.map((d) => `<option value="${d.id}" ${d.id === selected ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  }
  function meetingBadge(meeting) {
    return meeting.published_at ? '<span class="badge badge-ok">已發布</span>' : badge('draft');
  }
  async function pageMeetings(query) {
    const ticket = routing;
    const visible = (id) => canManageMeeting(id) || id === me.department_id;
    const departments = (await fetchAll(() => sb.from('departments').select('id, name').order('name').order('id'))).filter((d) => visible(d.id));
    const managed = departments.filter((d) => canManageMeeting(d.id));
    const dept = departments.find((d) => String(d.id) === query.get('dept'))?.id;
    const week = weekStartOf(query.get('week'));
    const meetings = await fetchAll(() => {
      let request = sb.from('meeting_minutes')
        .select('id, department_id, meeting_date, recorder_name, published_at')
        .order('meeting_date', { ascending: false }).order('id', { ascending: false });
      if (dept) request = request.eq('department_id', dept);
      if (week) request = request.gte('meeting_date', week).lte('meeting_date', addDays(week, 6));
      return request;
    });
    if (ticket !== routing) return;
    const names = new Map(departments.map((d) => [d.id, d.name]));
    layout(`
      <div class="page-head">
        <h1>週會紀錄</h1>
        ${managed.length ? `<form class="inline-form" data-new-meeting>
          <label>開會部門<select name="dept">${departmentOptions(managed, dept || me.department_id)}</select></label>
          <button class="btn btn-primary">新增紀錄</button>
        </form>` : ''}
      </div>
      <form class="card inline-form" data-meeting-filters>
        <label>部門<select name="dept"><option value="">全部部門</option>${departmentOptions(departments, dept)}</select></label>
        <label>週次（選該週任一天）<input type="date" name="week" value="${esc(week)}"></label>
        <button class="btn">查詢</button>
        <a class="btn" href="#/meetings">清除</a>
      </form>
      <section class="card">
        ${meetings.length ? `<div class="table-wrap"><table>
          <thead><tr><th>會議日期／週次</th><th>部門</th><th>記錄人</th><th>狀態</th></tr></thead>
          <tbody>${meetings.map((m) => `<tr>
            <td><a href="#/meetings/${m.id}">${esc(m.meeting_date)}</a><div class="muted small">${weekLabel(weekStartOf(m.meeting_date))}</div></td>
            <td>${esc(names.get(m.department_id))}</td><td>${esc(m.recorder_name)}</td><td>${meetingBadge(m)}</td>
          </tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted center">目前沒有符合條件的週會紀錄。</p>'}
      </section>`, 'meetings');
    root.querySelector('[data-new-meeting]')?.addEventListener('submit', (e) => {
      e.preventDefault();
      go('/meetings/new' + qs({ dept: new FormData(e.target).get('dept') }));
    });
    root.querySelector('[data-meeting-filters]').addEventListener('submit', (e) => {
      e.preventDefault();
      go('/meetings' + qs(Object.fromEntries(new FormData(e.target))));
    });
  }

  async function pageMeeting(id, dept) {
    const ticket = routing;
    const meeting = id ? must(await sb.from('meeting_minutes').select('*').eq('id', id).maybeSingle()) : {
      department_id: dept, meeting_date: todayStr(), recorder_id: me.id, recorder_name: me.name,
      attendees: [], notes: '', revision: null,
    };
    if (ticket !== routing) return;
    if (!meeting) return errorPage('找不到週會紀錄', '紀錄不存在，或您沒有權限查看。');
    const canManage = canManageMeeting(meeting.department_id);
    if (!id && (!dept || !canManage)) return forbidden();
    const department = must(await sb.from('departments').select('name').eq('id', meeting.department_id).maybeSingle());
    if (ticket !== routing) return;
    if (!department) return errorPage('找不到部門', '請返回週會紀錄列表。');

    const back = '<a class="small" href="#/meetings">返回週會紀錄</a>';
    if (meeting.published_at) {
      layout(`
        <div class="page-head"><div>${back}<h1>週會紀錄</h1></div>${meetingBadge(meeting)}</div>
        <section class="card field-grid">
          <div><strong>部門</strong><div>${esc(department.name)}</div></div>
          <div><strong>會議日期／週次</strong><div>${esc(meeting.meeting_date)} · ${weekLabel(weekStartOf(meeting.meeting_date))}</div></div>
          <div><strong>記錄人</strong><div>${esc(meeting.recorder_name)}</div></div>
        </section>
        <section class="card stack">
          <h2>與會人員報告</h2>
          ${meeting.attendees.map((a) => `<details class="meeting-attendee">
            <summary>${esc(a.name)}</summary>
            <div class="stack meeting-attendee-body">
              <div><strong>報告內容</strong><div class="pre">${esc(a.report) || '—'}</div></div>
              ${a.note ? `<div><strong>個人附註</strong><div class="pre">${esc(a.note)}</div></div>` : ''}
            </div>
          </details>`).join('')}
        </section>
        ${meeting.notes ? `<section class="card"><h2>全場附註</h2><div class="pre">${esc(meeting.notes)}</div></section>` : ''}`, 'meetings');
      return;
    }

    const roster = must(await sb.rpc('meeting_roster', { p_department_id: meeting.department_id, p_meeting_id: id }));
    if (ticket !== routing) return;
    const recorders = new Map([[meeting.recorder_id, meeting.recorder_name], [me.id, me.name], ...roster.map((p) => [p.id, p.name])]);
    layout(`
      <div class="page-head"><div>${back}<h1>${id ? '編輯週會紀錄' : '新增週會紀錄'}</h1></div>${id ? meetingBadge(meeting) : ''}</div>
      <form class="stack" data-meeting-form>
        <div data-error role="alert"></div>
        <section class="card stack">
          <h2>會議基本資料</h2>
          <div class="field-grid">
            <div><strong>部門</strong><div>${esc(department.name)}</div></div>
            <label>會議日期<input type="date" name="date" required value="${esc(meeting.meeting_date)}"></label>
            <div><strong>週次</strong><div data-meeting-week>${weekLabel(weekStartOf(meeting.meeting_date))}</div></div>
            ${canManage ? `<label>記錄人<select name="recorder">${[...recorders].map(([key, name]) =>
              `<option value="${esc(key)}" ${key === meeting.recorder_id ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label>`
              : `<div><strong>記錄人</strong><div>${esc(meeting.recorder_name)}</div></div>`}
          </div>
        </section>
        <section class="card stack">
          <h2>與會人員報告</h2>
          <div class="inline-form">
            <label>部門人員<select data-roster><option value="">選擇人員</option>${roster.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('')}</select></label>
            <button type="button" class="btn" data-add-person>加入人員</button>
            <button type="button" class="btn" data-add-guest>加入臨時出席者</button>
          </div>
          <div class="stack" data-attendees></div>
        </section>
        <section class="card stack">
          <label>全場附註（選填）<textarea name="notes" rows="4" maxlength="10000">${esc(meeting.notes)}</textarea></label>
          <div class="actions">
            <button class="btn ${canManage ? '' : 'btn-primary'}" value="draft">儲存草稿</button>
            ${canManage ? '<button class="btn btn-primary" value="publish" data-confirm="確定發布？發布後將開放同部門人員查閱，並鎖定內容。">發布紀錄</button>' : ''}
          </div>
        </section>
      </form>`, 'meetings');

    const form = root.querySelector('[data-meeting-form]');
    const entries = form.querySelector('[data-attendees]');
    const rosterSelect = form.querySelector('[data-roster]');
    const addPerson = form.querySelector('[data-add-person]');
    const addGuest = form.querySelector('[data-add-guest]');
    const date = form.elements.date;
    const syncOrder = () => {
      const rows = [...entries.children];
      for (const [i, row] of rows.entries()) {
        row.querySelector('[data-up]').disabled = i === 0;
        row.querySelector('[data-down]').disabled = i === rows.length - 1;
      }
      addPerson.disabled = !rosterSelect.value || rows.length >= 100;
      addGuest.disabled = rows.length >= 100;
    };
    function addAttendee(attendee, editing = false) {
      const row = document.createElement('details');
      row.className = 'meeting-attendee';
      row.open = editing;
      row.innerHTML = `
        <summary>${esc(attendee.name || '臨時出席者')}</summary>
        <div class="meeting-attendee-body stack">
          <label>姓名<input name="attendee_name" maxlength="50" value="${esc(attendee.name)}"></label>
          <label>報告內容<textarea name="report" rows="5" maxlength="10000">${esc(attendee.report)}</textarea></label>
          <label>個人附註（選填）<textarea name="note" rows="2" maxlength="5000">${esc(attendee.note)}</textarea></label>
          <div class="row-gap meeting-attendee-actions">
            <button type="button" class="btn" data-up>上移</button>
            <button type="button" class="btn" data-down>下移</button>
            <button type="button" class="btn" data-remove>移除</button>
          </div>
        </div>`;
      entries.append(row);
      const name = row.querySelector('input');
      name.addEventListener('input', () => { row.querySelector('summary').textContent = name.value.trim() || '臨時出席者'; });
      row.querySelector('[data-up]').addEventListener('click', () => {
        row.previousElementSibling?.before(row);
        syncOrder();
        dirty = true;
        row.querySelector('summary').focus();
      });
      row.querySelector('[data-down]').addEventListener('click', () => {
        row.nextElementSibling?.after(row);
        syncOrder();
        dirty = true;
        row.querySelector('summary').focus();
      });
      row.querySelector('[data-remove]').addEventListener('click', () => {
        if (!window.confirm('移除此人員及其報告內容？')) return;
        row.remove();
        syncOrder();
        dirty = true;
        rosterSelect.focus();
      });
      if (editing) {
        (attendee.name ? row.querySelector('textarea') : name).focus();
        dirty = true;
      }
    }
    meeting.attendees.forEach((a) => addAttendee(a));
    syncOrder();
    rosterSelect.addEventListener('change', syncOrder);
    addPerson.addEventListener('click', () => {
      addAttendee({ name: roster[Number(rosterSelect.value)].name }, true);
      rosterSelect.value = '';
      syncOrder();
    });
    addGuest.addEventListener('click', () => {
      addAttendee({}, true);
      syncOrder();
    });
    date.addEventListener('input', () => {
      form.querySelector('[data-meeting-week]').textContent = weekLabel(weekStartOf(date.value));
    });
    form.addEventListener('input', () => { dirty = true; });
    root.querySelector('.page-head a').addEventListener('click', (e) => {
      if (dirty && !window.confirm('尚未儲存，確定返回列表？')) e.preventDefault();
    });
    onSubmit(form, async (fd, action) => {
      const attendees = [...entries.children].map((row) => ({
        name: row.querySelector('[name=attendee_name]').value.trim(),
        report: row.querySelector('[name=report]').value,
        note: row.querySelector('[name=note]').value,
      }));
      if (attendees.some((a) => !a.name)) throw new Error('請填寫所有與會人員的姓名。');
      const saved = must(await sb.rpc('save_meeting_minutes', {
        p_id: id, p_revision: meeting.revision, p_department_id: meeting.department_id,
        p_meeting_date: fd.get('date'), p_recorder_id: canManage ? fd.get('recorder') || null : meeting.recorder_id,
        p_attendees: attendees, p_notes: fd.get('notes'), p_publish: action === 'publish',
      }));
      if (ticket !== routing) return;
      dirty = false;
      setFlash('success', action === 'publish' ? '已發布週會紀錄。' : '已儲存週會草稿。');
      go('/meetings/' + saved);
    });
  }

  /* ------------------------------------------------------------------ 路由 */
  const routes = [
    [/^\/$/, () => go(isReviewer() ? '/review' : '/reports')],
    [/^\/password$/, pagePassword],
    [/^\/reports$/, pageMyReports],
    [/^\/reports\/new$/, (m, q) => pageReportForm(null, q)],
    [/^\/reports\/(\d+)\/edit$/, (m, q) => pageReportForm(Number(m[1]), q)],
    [/^\/reports\/(\d+)$/, (m, q) => pageReportView(Number(m[1]), q)],
    [/^\/review$/, (m, q) => pageReview(q)],
    [/^\/print$/, (m, q) => pagePrint(q)],
    [/^\/stats$/, (m, q) => pageStats(q)],
    [/^\/meetings$/, (m, q) => pageMeetings(q)],
    [/^\/meetings\/new$/, (m, q) => pageMeeting(null, Number(q.get('dept')))],
    [/^\/meetings\/(\d+)$/, (m) => pageMeeting(Number(m[1]))],
    [/^\/customers$/, (m, q) => pageCustomers(q)],
    [/^\/admin\/departments$/, pageDepartments],
    [/^\/admin\/ranks$/, pageRanks],
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
