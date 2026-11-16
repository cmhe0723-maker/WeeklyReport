(function () {
  'use strict';
  // 確認對話框
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-confirm]');
    if (el && !window.confirm(el.getAttribute('data-confirm'))) e.preventDefault();
  });
  // 篩選條件變更自動送出
  document.querySelectorAll('[data-autosubmit]').forEach(function (el) {
    el.addEventListener('change', function () { el.form.submit(); });
  });
  // 全選待查閱
  var all = document.querySelector('[data-check-all]');
  if (all) all.addEventListener('change', function () {
    document.querySelectorAll('input[name="ids"]').forEach(function (c) { c.checked = all.checked; });
  });
  // 主管才顯示「可查閱部門」
  var role = document.querySelector('[data-role-select]');
  var managed = document.querySelector('[data-managed]');
  if (role && managed) {
    var sync = function () { managed.hidden = role.value !== 'manager'; };
    role.addEventListener('change', sync); sync();
  }
  // 週次即時顯示
  var picker = document.querySelector('[data-week-picker]');
  var label = document.querySelector('[data-week-label]');
  if (picker && label) picker.addEventListener('change', function () {
    var d = new Date(picker.value + 'T00:00:00Z');
    if (isNaN(d)) { label.textContent = ''; return; }
    d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    var e = new Date(d); e.setUTCDate(e.getUTCDate() + 6);
    var f = function (x) { return (x.getUTCMonth() + 1 + '').padStart(2, '0') + '/' + (x.getUTCDate() + '').padStart(2, '0'); };
    label.textContent = '本週報週次：' + f(d) + ' ~ ' + f(e);
  });
  // 未儲存提醒
  var form = document.querySelector('.report-form');
  if (form) {
    var dirty = false;
    form.addEventListener('input', function () { dirty = true; });
    form.addEventListener('submit', function () { dirty = false; });
    window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  }
})();
