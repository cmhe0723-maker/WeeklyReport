-- =============================================================================
-- 工作週報系統 — Supabase 建表 SQL
--
-- 架構：網頁（GitHub Pages 靜態網站）以 publishable key 直接連 Supabase。
--   * 登入：Supabase Auth（帳號 username 對應到 username@weeklyreport.example.com，
--     此信箱僅作為登入識別，不會寄信）
--   * 讀取：Row Level Security（RLS）限制每個人只看得到有權限的資料
--   * 寫入：一律透過本檔的資料庫函式（RPC），函式內檢查權限；
--     前端角色對資料表沒有 insert / update / delete 權限
--
-- 使用方式：整份貼到 Supabase Dashboard → SQL Editor 執行。可重複執行。
-- 第一次執行會建立預設管理員：帳號 admin、密碼 admin1234（首次登入強制變更）。
-- =============================================================================

begin;

-- 舊版（自建帳號、bigint 使用者 id）資料表與本版不相容
do $$
begin
  if to_regclass('public.users') is not null and to_regclass('public.profiles') is null then
    raise exception using message =
      '偵測到舊版資料表 public.users。新版改用 Supabase Auth，結構不相容。'
      '若舊表沒有要保留的資料，請先執行：'
      'drop table if exists public.review_logs, public.reports, public.manager_departments, '
      'public.users, public.departments, public.sessions, public.settings cascade; 再重新執行本檔。';
  end if;
end
$$;

create extension if not exists pgcrypto with schema extensions;

-- 不對外公開（PostgREST 不會暴露）的內部函式放在 private schema
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- =============================================================================
-- 資料表
-- =============================================================================

-- 部門
create table if not exists public.departments (
  id          bigint generated always as identity primary key,
  name        text        not null unique check (char_length(btrim(name)) between 1 and 50),
  created_at  timestamptz not null default now()
);
comment on table public.departments is '部門';

-- 人員資料（對應 Supabase Auth 的 auth.users）
create table if not exists public.profiles (
  id                   uuid        primary key references auth.users (id) on delete cascade,
  username             text        not null check (username ~ '^[A-Za-z0-9._-]{3,50}$'),
  name                 text        not null check (char_length(btrim(name)) between 1 and 50),
  role                 text        not null check (role in ('admin', 'manager', 'staff')),
  department_id        bigint      references public.departments (id) on delete set null,
  active               boolean     not null default true,
  must_change_password boolean     not null default false,
  created_at           timestamptz not null default now()
);
comment on table  public.profiles      is '人員資料與角色';
comment on column public.profiles.role is 'admin=系統管理員, manager=主管, staff=業務人員';
create unique index if not exists profiles_username_lower_key on public.profiles (lower(username));
create index if not exists profiles_department_id_idx on public.profiles (department_id);

-- 主管可查閱的部門（一位主管可負責多個部門）
create table if not exists public.manager_departments (
  user_id       uuid   not null references public.profiles (id)    on delete cascade,
  department_id bigint not null references public.departments (id) on delete cascade,
  primary key (user_id, department_id)
);
comment on table public.manager_departments is '主管可查閱的部門';
create index if not exists manager_departments_department_id_idx on public.manager_departments (department_id);

-- 週報（每人每週一份，week_start 為該週週一）
create table if not exists public.reports (
  id              bigint generated always as identity primary key,
  user_id         uuid        not null references public.profiles (id) on delete cascade,
  week_start      date        not null check (extract(isodow from week_start) = 1),
  work_summary    text        not null default '' check (char_length(work_summary)    <= 10000),
  customer_visits text        not null default '' check (char_length(customer_visits) <= 10000),
  sales_progress  text        not null default '' check (char_length(sales_progress)  <= 10000),
  next_week_plan  text        not null default '' check (char_length(next_week_plan)  <= 10000),
  issues          text        not null default '' check (char_length(issues)          <= 10000),
  status          text        not null default 'draft' check (status in ('draft', 'submitted')),
  submitted_at    timestamptz,
  reviewed_by     uuid        references public.profiles (id) on delete set null,
  reviewer_name   text        not null default '',
  reviewed_at     timestamptz,
  review_comment  text        not null default '' check (char_length(review_comment) <= 2000),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, week_start),
  constraint reports_submitted_at_chk check ((status = 'submitted') = (submitted_at is not null)),
  constraint reports_review_requires_submitted_chk check (reviewed_at is null or status = 'submitted'),
  constraint reports_reviewed_by_chk check (reviewed_by is null or reviewed_at is not null)
);
comment on table  public.reports                 is '業務週報';
comment on column public.reports.week_start      is '該週週一';
comment on column public.reports.work_summary    is '本週工作內容（舊版欄位；新版改以 daily_work 逐日記錄）';
comment on column public.reports.customer_visits is '客戶拜訪紀錄';
comment on column public.reports.sales_progress  is '業績與案件進度';
comment on column public.reports.next_week_plan  is '下週工作計畫';
comment on column public.reports.issues          is '問題與需協助事項';
comment on column public.reports.reviewed_at     is '主管標記查閱完成的時間；null 代表尚未查閱';
comment on column public.reports.reviewer_name   is '查閱主管姓名（快照，讓業務人員不需讀取主管資料也能顯示）';
-- 每日工作內容：7 個字串的陣列，依序為週一～週日（新增欄位，舊資料預設為空陣列）
alter table public.reports
  add column if not exists daily_work jsonb not null default '[]'::jsonb
  constraint reports_daily_work_chk
    check (jsonb_typeof(daily_work) = 'array' and jsonb_array_length(daily_work) <= 7);
comment on column public.reports.daily_work      is '每日工作內容（文字），陣列依序為週一～週日；有 daily_entries 時由其自動產生';
-- 每日多筆拜訪：7 個陣列（週一～週日），每筆 {customer, contact, content}
alter table public.reports
  add column if not exists daily_entries jsonb not null default '[]'::jsonb
  constraint reports_daily_entries_chk
    check (jsonb_typeof(daily_entries) = 'array' and jsonb_array_length(daily_entries) <= 7);
comment on column public.reports.daily_entries   is '每日多筆拜訪，陣列依序為週一～週日，每筆含 customer、contact、content';
create index if not exists reports_week_start_idx  on public.reports (week_start);
create index if not exists reports_reviewed_by_idx on public.reports (reviewed_by);
create index if not exists reports_pending_idx     on public.reports (week_start)
  where status = 'submitted' and reviewed_at is null;

-- 查閱歷程
create table if not exists public.review_logs (
  id         bigint generated always as identity primary key,
  report_id  bigint      not null references public.reports (id) on delete cascade,
  user_id    uuid        references public.profiles (id) on delete set null,
  user_name  text        not null default '',
  action     text        not null check (action in ('reviewed', 'unreviewed', 'commented')),
  comment    text        not null default '' check (char_length(comment) <= 2000),
  created_at timestamptz not null default now()
);
comment on table public.review_logs is '週報查閱歷程';
create index if not exists review_logs_report_id_idx on public.review_logs (report_id, id desc);
create index if not exists review_logs_user_id_idx   on public.review_logs (user_id);

-- 週報內容變更時自動更新 updated_at
create or replace function private.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists reports_set_updated_at on public.reports;
create trigger reports_set_updated_at
  before update of work_summary, daily_work, daily_entries, customer_visits, sales_progress, next_week_plan, issues, status
  on public.reports
  for each row execute function private.set_updated_at();

-- =============================================================================
-- 內部輔助函式（RLS 與 RPC 共用）
-- =============================================================================

-- 帳號 → 登入用信箱（前端 config.js 的 emailDomain 必須一致）
create or replace function private.login_email(p_username text)
returns text language sql immutable set search_path = '' as $$
  select lower(btrim(p_username)) || '@weeklyreport.example.com'
$$;

-- 目前登入者的角色（帳號停用或沒有 profile 時為 null）
create or replace function private.my_role()
returns text language sql stable security definer set search_path = '' as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.active
$$;

create or replace function private.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(private.my_role() = 'admin', false)
$$;

-- 目前登入者能否查閱某部門的週報：管理員全部可以；主管限負責的部門
create or replace function private.can_review_dept(p_department_id bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_admin()
      or (p_department_id is not null and exists (
            select 1
            from public.manager_departments md
            join public.profiles p on p.id = md.user_id
            where md.user_id = auth.uid() and p.active and p.role = 'manager'
              and md.department_id = p_department_id))
$$;

-- 某位人員的所屬部門
create or replace function private.user_dept(p_user_id uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select p.department_id from public.profiles p where p.id = p_user_id
$$;

-- 建立 Supabase Auth 帳號（僅供本檔內部使用，前端無法呼叫）
create or replace function private.create_auth_user(p_email text, p_password text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', p_email,
    extensions.crypt(p_password, extensions.gen_salt('bf', 10)), now(),
    '', '', '', '',
    '{"provider": "email", "providers": ["email"]}'::jsonb, '{}'::jsonb, now(), now()
  );
  insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (
    v_id::text, v_id,
    jsonb_build_object('sub', v_id::text, 'email', p_email, 'email_verified', true, 'phone_verified', false),
    'email', now(), now(), now()
  );
  return v_id;
end;
$$;

-- =============================================================================
-- Row Level Security（只開放 SELECT；寫入一律走下方 RPC）
-- =============================================================================
alter table public.departments         enable row level security;
alter table public.profiles            enable row level security;
alter table public.manager_departments enable row level security;
alter table public.reports             enable row level security;
alter table public.review_logs         enable row level security;

drop policy if exists departments_select on public.departments;
create policy departments_select on public.departments
  for select to authenticated
  using (private.my_role() is not null);

-- 自己、管理員、或負責該部門的主管
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or private.can_review_dept(department_id));

drop policy if exists manager_departments_select on public.manager_departments;
create policy manager_departments_select on public.manager_departments
  for select to authenticated
  using ((user_id = (select auth.uid()) and private.my_role() is not null) or private.is_admin());

-- 自己的週報（含草稿）；他人的週報需已提交且有查閱權限
drop policy if exists reports_select on public.reports;
create policy reports_select on public.reports
  for select to authenticated
  using (
    (user_id = (select auth.uid()) and private.my_role() is not null)
    or (status = 'submitted' and private.can_review_dept(private.user_dept(user_id)))
  );

-- 看得到週報才看得到其查閱歷程
drop policy if exists review_logs_select on public.review_logs;
create policy review_logs_select on public.review_logs
  for select to authenticated
  using (exists (select 1 from public.reports r where r.id = report_id));

revoke all on public.departments, public.profiles, public.manager_departments,
              public.reports, public.review_logs
  from anon, authenticated;
grant select on public.departments, public.profiles, public.manager_departments,
                public.reports, public.review_logs
  to authenticated;

-- =============================================================================
-- RPC：業務人員／主管
-- =============================================================================

-- 新增或修改自己的週報。p_id 為 null 表示新增；p_submit = true 表示提交給主管
-- p_daily_entries：每日多筆拜訪，7 個陣列（週一～週日），每筆 {customer, contact, content}；
--   每天最多 20 筆，客戶與聯絡人各最多 100 字、內容最多 4000 字。
--   有傳入時，daily_work（每日文字）會自動由它產生，例如「環宇貿易（王經理）：說明新方案」。
--   客戶欄若是自己部門名錄中的客戶（名稱或別名），聯絡人會自動加入該客戶的聯絡人清單。
-- p_daily_work：舊版每日文字（每天一段）；p_daily_entries 為 null 時才使用，供舊版網頁相容
-- p_work_summary：舊版「本週工作內容」欄位，新週報傳空字串即可
drop function if exists public.save_report(bigint, date, text, text, text, text, text, boolean);
drop function if exists public.save_report(bigint, date, text, text[], text, text, text, text, boolean);
create or replace function public.save_report(
  p_id              bigint,
  p_week            date,
  p_work_summary    text,
  p_daily_work      text[],
  p_customer_visits text,
  p_sales_progress  text,
  p_next_week_plan  text,
  p_issues          text,
  p_submit          boolean,
  p_daily_entries   jsonb default null
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_role    text := private.my_role();
  v_old     public.reports;
  v_id      bigint;
  v_days    text[] := '{}';
  v_entries jsonb := '[]'::jsonb;
  v_day     jsonb;
  v_list    jsonb;
  v_lines   text[];
  v_e       jsonb;
  v_cust    text;
  v_contact text;
  v_content text;
  i         integer;
begin
  if v_role is null or v_role not in ('staff', 'manager') then
    raise exception '沒有權限填寫週報。';
  end if;
  p_work_summary    := btrim(coalesce(p_work_summary, ''));
  p_customer_visits := btrim(coalesce(p_customer_visits, ''));
  p_sales_progress  := btrim(coalesce(p_sales_progress, ''));
  p_next_week_plan  := btrim(coalesce(p_next_week_plan, ''));
  p_issues          := btrim(coalesce(p_issues, ''));
  p_submit          := coalesce(p_submit, false);

  if p_daily_entries is not null then
    if jsonb_typeof(p_daily_entries) <> 'array' or jsonb_array_length(p_daily_entries) > 7 then
      raise exception '每日工作內容格式不正確。';
    end if;
    for i in 0..6 loop
      v_day := coalesce(p_daily_entries -> i, '[]'::jsonb);
      if jsonb_typeof(v_day) <> 'array' then
        raise exception '每日工作內容格式不正確。';
      end if;
      v_list := '[]'::jsonb;
      v_lines := '{}';
      for v_e in select value from jsonb_array_elements(v_day) loop
        if jsonb_typeof(v_e) <> 'object' then
          raise exception '每日工作內容格式不正確。';
        end if;
        v_cust    := left(btrim(coalesce(v_e ->> 'customer', '')), 100);
        v_contact := left(btrim(coalesce(v_e ->> 'contact', '')), 100);
        v_content := left(btrim(coalesce(v_e ->> 'content', '')), 4000);
        continue when v_cust = '' and v_contact = '' and v_content = '';
        v_list := v_list || jsonb_build_array(jsonb_build_object('customer', v_cust, 'contact', v_contact, 'content', v_content));
        v_lines := array_append(v_lines,
          case when v_cust = '' and v_contact = '' then v_content
               else concat(v_cust,
                           case when v_contact <> '' then '（' || v_contact || '）' end,
                           case when v_content <> '' then '：' || v_content end) end);
      end loop;
      if jsonb_array_length(v_list) > 20 then
        raise exception '每天最多 20 筆。';
      end if;
      v_entries := v_entries || jsonb_build_array(v_list);
      v_days := array_append(v_days, left(array_to_string(v_lines, E'\n'), 20000));
    end loop;
  else
    -- 舊版網頁：每天一段文字
    if coalesce(cardinality(p_daily_work), 0) > 7 then
      raise exception '每日工作內容最多 7 天。';
    end if;
    v_days := array(
      select left(btrim(coalesce(d, '')), 4000)
      from unnest(coalesce(p_daily_work, '{}'::text[])) with ordinality as t(d, n)
      order by n
    );
    while coalesce(cardinality(v_days), 0) < 7 loop
      v_days := array_append(v_days, '');
    end loop;
    for i in 1..7 loop
      v_entries := v_entries || jsonb_build_array(case when v_days[i] = '' then '[]'::jsonb
        else jsonb_build_array(jsonb_build_object('customer', '', 'contact', '', 'content', v_days[i])) end);
    end loop;
  end if;

  if p_submit and p_work_summary = '' and not exists (select 1 from unnest(v_days) d where d <> '') then
    raise exception '提交前請至少填寫一天的工作內容。';
  end if;

  if p_id is null then
    if p_week is null then
      raise exception '請選擇正確的週次日期。';
    end if;
    insert into public.reports (user_id, week_start, work_summary, daily_work, daily_entries, customer_visits,
                                sales_progress, next_week_plan, issues, status, submitted_at)
    values (v_uid, date_trunc('week', p_week)::date, p_work_summary, to_jsonb(v_days), v_entries, p_customer_visits,
            p_sales_progress, p_next_week_plan, p_issues,
            case when p_submit then 'submitted' else 'draft' end,
            case when p_submit then now() end)
    on conflict (user_id, week_start) do nothing
    returning id into v_id;
    if v_id is null then
      raise exception '該週已有週報，請改為編輯該份週報。';
    end if;
  else
    select * into v_old from public.reports where id = p_id and user_id = v_uid for update;
    if not found then
      raise exception '週報不存在。';
    end if;
    if v_old.reviewed_at is not null then
      raise exception '此週報主管已查閱，無法再修改。如需修改請洽主管撤回查閱。';
    end if;
    update public.reports set
      work_summary    = p_work_summary,
      daily_work      = to_jsonb(v_days),
      daily_entries   = v_entries,
      customer_visits = p_customer_visits,
      sales_progress  = p_sales_progress,
      next_week_plan  = p_next_week_plan,
      issues          = p_issues,
      status          = case when p_submit then 'submitted' else 'draft' end,
      submitted_at    = case when p_submit then coalesce(v_old.submitted_at, now()) end
    where id = p_id;
    v_id := p_id;
  end if;

  -- 聯絡人自動加入自己部門名錄中對應客戶的聯絡人清單（不分大小寫、不重複，每家最多 100 位）
  for v_e in
    select e.value from jsonb_array_elements(v_entries) as d(value), jsonb_array_elements(d.value) as e(value)
  loop
    v_cust := v_e ->> 'customer';
    v_contact := v_e ->> 'contact';
    continue when v_cust = '' or v_contact = '';
    update public.customers c
       set contacts = c.contacts || array[v_contact]
     where c.department_id = private.my_dept()
       and (lower(c.name) = lower(v_cust) or lower(v_cust) = any (array(select lower(a) from unnest(c.aliases) as a)))
       and not (lower(v_contact) = any (array(select lower(x) from unnest(c.contacts) as x)))
       and cardinality(c.contacts) < 100;
  end loop;
  return v_id;
end;
$$;

-- 刪除自己的草稿
create or replace function public.delete_draft(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if private.my_role() is null then
    raise exception '沒有權限。';
  end if;
  delete from public.reports where id = p_id and user_id = auth.uid() and status = 'draft';
  if not found then
    raise exception '只有草稿可以刪除。';
  end if;
end;
$$;

-- 變更自己的密碼（需輸入目前密碼）
create or replace function public.change_my_password(p_current text, p_new text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_hash text;
begin
  if private.my_role() is null then
    raise exception '沒有權限。';
  end if;
  select encrypted_password into v_hash from auth.users where id = auth.uid();
  if v_hash is null or v_hash = '' or extensions.crypt(coalesce(p_current, ''), v_hash) <> v_hash then
    raise exception '目前密碼不正確。';
  end if;
  if char_length(coalesce(p_new, '')) < 8 then
    raise exception '新密碼至少需 8 個字元。';
  end if;
  if p_new = p_current then
    raise exception '新密碼不可與目前密碼相同。';
  end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_new, extensions.gen_salt('bf', 10)), updated_at = now()
   where id = auth.uid();
  update public.profiles set must_change_password = false where id = auth.uid();
end;
$$;

-- =============================================================================
-- RPC：主管查閱
-- =============================================================================

-- p_action：review = 標記查閱完成、unreview = 撤回查閱、comment = 只更新意見
create or replace function public.review_report(p_id bigint, p_action text, p_comment text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_r       public.reports;
  v_name    text;
  v_comment text := left(btrim(coalesce(p_comment, '')), 2000);
begin
  select * into v_r from public.reports where id = p_id for update;
  if not found or v_r.status <> 'submitted' or v_r.user_id = auth.uid()
     or not private.can_review_dept(private.user_dept(v_r.user_id)) then
    raise exception '週報不存在，或您沒有權限查閱。';
  end if;
  select name into v_name from public.profiles where id = auth.uid();

  if p_action = 'review' then
    update public.reports
       set reviewed_by = auth.uid(), reviewer_name = v_name, reviewed_at = now(), review_comment = v_comment
     where id = p_id;
  elsif p_action = 'unreview' then
    update public.reports
       set reviewed_by = null, reviewer_name = '', reviewed_at = null, review_comment = ''
     where id = p_id;
  elsif p_action = 'comment' then
    if v_comment = '' then
      raise exception '請輸入主管意見。';
    end if;
    update public.reports set review_comment = v_comment where id = p_id;
  else
    raise exception '無效的動作。';
  end if;

  insert into public.review_logs (report_id, user_id, user_name, action, comment)
  values (p_id, auth.uid(), v_name,
          case p_action when 'review' then 'reviewed' when 'unreview' then 'unreviewed' else 'commented' end,
          v_comment);
end;
$$;

-- 批次標記查閱完成，回傳實際標記的筆數
create or replace function public.review_reports(p_ids bigint[])
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_n    integer;
begin
  if coalesce(private.my_role(), '') not in ('admin', 'manager') then
    raise exception '沒有權限。';
  end if;
  if coalesce(cardinality(p_ids), 0) > 500 then
    raise exception '一次最多標記 500 份。';
  end if;
  select name into v_name from public.profiles where id = auth.uid();
  with done as (
    update public.reports r
       set reviewed_by = auth.uid(), reviewer_name = v_name, reviewed_at = now()
     where r.id = any (p_ids)
       and r.status = 'submitted' and r.reviewed_at is null and r.user_id <> auth.uid()
       and private.can_review_dept(private.user_dept(r.user_id))
    returning r.id
  )
  insert into public.review_logs (report_id, user_id, user_name, action)
  select id, auth.uid(), v_name, 'reviewed' from done;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- =============================================================================
-- RPC：系統管理員
-- =============================================================================

-- 新增（p_id 為 null）或更名部門
create or replace function public.admin_save_department(p_id bigint, p_name text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint;
begin
  if not private.is_admin() then
    raise exception '沒有權限。';
  end if;
  p_name := btrim(coalesce(p_name, ''));
  if p_name = '' or char_length(p_name) > 50 then
    raise exception '部門名稱需為 1–50 個字。';
  end if;
  if exists (select 1 from public.departments where name = p_name and id is distinct from p_id) then
    raise exception '部門名稱已存在。';
  end if;
  if p_id is null then
    insert into public.departments (name) values (p_name) returning id into v_id;
  else
    update public.departments set name = p_name where id = p_id returning id into v_id;
    if v_id is null then
      raise exception '部門不存在。';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.admin_delete_department(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then
    raise exception '沒有權限。';
  end if;
  if exists (select 1 from public.profiles where department_id = p_id) then
    raise exception '此部門仍有人員，請先將人員移至其他部門。';
  end if;
  if exists (select 1 from public.meeting_minutes where department_id = p_id) then
    raise exception '此部門仍有週會紀錄，無法刪除。';
  end if;
  delete from public.departments where id = p_id;
end;
$$;

-- 新增（p_id 為 null）或修改人員。p_password 留空表示不變更（新增時必填）。
-- 設定或重設密碼後，該人員下次登入需自行變更密碼。
create or replace function public.admin_save_user(
  p_id            uuid,
  p_username      text,
  p_name          text,
  p_role          text,
  p_department_id bigint,
  p_managed       bigint[],
  p_active        boolean,
  p_password      text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id    uuid := p_id;
  v_email text;
begin
  if not private.is_admin() then
    raise exception '沒有權限。';
  end if;
  p_username := btrim(coalesce(p_username, ''));
  p_name     := btrim(coalesce(p_name, ''));
  p_password := coalesce(p_password, '');
  p_active   := coalesce(p_active, true);
  p_managed  := coalesce(p_managed, '{}');
  v_email    := private.login_email(p_username);

  if p_username !~ '^[A-Za-z0-9._-]{3,50}$' then
    raise exception '帳號需為 3–50 個英數字或 . _ - 符號。';
  end if;
  if p_name = '' or char_length(p_name) > 50 then
    raise exception '請輸入姓名（50 字以內）。';
  end if;
  if p_role is null or p_role not in ('admin', 'manager', 'staff') then
    raise exception '角色不正確。';
  end if;
  if p_role <> 'admin' and p_department_id is null then
    raise exception '請選擇所屬部門。';
  end if;
  if p_department_id is not null and not exists (select 1 from public.departments where id = p_department_id) then
    raise exception '所屬部門不存在。';
  end if;
  if p_role = 'manager' and cardinality(p_managed) = 0 then
    raise exception '主管至少需設定一個可查閱的部門。';
  end if;
  if p_id is null and char_length(p_password) < 8 then
    raise exception '初始密碼至少需 8 個字元。';
  end if;
  if p_id is not null and p_password <> '' and char_length(p_password) < 8 then
    raise exception '重設密碼至少需 8 個字元。';
  end if;
  if exists (select 1 from public.profiles where lower(username) = lower(p_username) and id is distinct from p_id)
     or exists (select 1 from auth.users where lower(email) = v_email and id is distinct from p_id) then
    raise exception '此帳號已被使用。';
  end if;

  if p_id is null then
    v_id := private.create_auth_user(v_email, p_password);
    insert into public.profiles (id, username, name, role, department_id, active, must_change_password)
    values (v_id, p_username, p_name, p_role, p_department_id, p_active, true);
    if not p_active then
      update auth.users set banned_until = '2999-12-31 00:00:00+00' where id = v_id;
    end if;
  else
    if not exists (select 1 from public.profiles where id = p_id) then
      raise exception '人員不存在。';
    end if;
    if p_id = auth.uid() and (p_role <> 'admin' or not p_active) then
      raise exception '不可停用自己的帳號或移除自己的管理員權限。';
    end if;
    update public.profiles
       set username = p_username, name = p_name, role = p_role, department_id = p_department_id,
           active = p_active,
           must_change_password = must_change_password or p_password <> ''
     where id = p_id;
    update auth.users
       set email = v_email,
           encrypted_password = case when p_password <> ''
                                     then extensions.crypt(p_password, extensions.gen_salt('bf', 10))
                                     else encrypted_password end,
           banned_until = case when p_active then null else '2999-12-31 00:00:00+00'::timestamptz end,
           updated_at = now()
     where id = p_id;
    update auth.identities
       set identity_data = identity_data || jsonb_build_object('email', v_email), updated_at = now()
     where user_id = p_id and provider = 'email';
    if not p_active then
      -- 停用時登出所有裝置（即使無法刪除，RLS 也已拒絕停用帳號的所有存取）
      begin
        delete from auth.sessions where user_id = p_id;
      exception when insufficient_privilege or undefined_table then
        null;
      end;
    end if;
  end if;

  delete from public.manager_departments where user_id = v_id;
  if p_role = 'manager' then
    insert into public.manager_departments (user_id, department_id)
    select v_id, d.id from public.departments d where d.id = any (p_managed)
    on conflict do nothing;
  end if;
  return v_id;
end;
$$;

-- =============================================================================
-- 客戶名錄與客戶紀錄查詢
--   * 每家客戶屬於一個部門；名稱與別名在同一部門內不可重複（不分大小寫）
--   * 看得到名錄：自己所屬部門；主管另含負責的部門；系統管理員全部
--   * 新增：看得到該部門名錄的人都可以新增；修改／停用：主管（負責部門）與系統管理員
--   * 客戶紀錄：以名稱與別名即時比對「該部門人員」已提交週報的內容（舊週報也找得到）。
--     查詢函式以呼叫者身分執行（security invoker），因此沿用週報的 RLS：
--     業務只看到自己的、主管看到負責部門的、系統管理員看到全部。
-- =============================================================================

create table if not exists public.customers (
  id            bigint generated always as identity primary key,
  department_id bigint      not null references public.departments (id) on delete cascade,
  name          text        not null check (char_length(btrim(name)) between 2 and 100),
  aliases       text[]      not null default '{}' check (cardinality(aliases) <= 20),
  active        boolean     not null default true,
  created_by    uuid        references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table  public.customers         is '客戶名錄（依部門）';
comment on column public.customers.aliases is '簡稱或別名，例如「大成」＝「大成科技」';
create unique index if not exists customers_dept_name_key on public.customers (department_id, lower(name));
-- 聯絡人清單：填寫週報時自動累積，主管與系統管理員可在「編輯客戶」修改
alter table public.customers
  add column if not exists contacts text[] not null default '{}'
  constraint customers_contacts_chk check (cardinality(contacts) <= 100);
comment on column public.customers.contacts is '聯絡人清單（填寫週報時自動加入）';

drop trigger if exists customers_set_updated_at on public.customers;
create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function private.set_updated_at();

-- 目前登入者的所屬部門（帳號停用時為 null）
create or replace function private.my_dept()
returns bigint language sql stable security definer set search_path = '' as $$
  select p.department_id from public.profiles p where p.id = auth.uid() and p.active
$$;

-- 看得到（也可以新增）某部門的客戶名錄
create or replace function private.can_view_customers(p_department_id bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.my_role() is not null
     and (private.can_review_dept(p_department_id) or p_department_id = private.my_dept())
$$;

-- 可以修改／停用某部門的客戶
create or replace function private.can_edit_customers(p_department_id bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(private.my_role() in ('admin', 'manager'), false) and private.can_review_dept(p_department_id)
$$;

alter table public.customers enable row level security;
drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers
  for select to authenticated
  using (private.can_view_customers(department_id));
revoke all on public.customers from anon, authenticated;
grant select on public.customers to authenticated;

-- 新增（p_id 為 null）或修改客戶。業務人員只能新增；修改、停用需主管或系統管理員
-- p_contacts：聯絡人清單；修改時傳 null 表示不變更
drop function if exists public.save_customer(bigint, bigint, text, text[], boolean);
create or replace function public.save_customer(
  p_id            bigint,
  p_department_id bigint,
  p_name          text,
  p_aliases       text[],
  p_active        boolean,
  p_contacts      text[] default null
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_old      public.customers;
  v_terms    text[];
  v_conflict record;
  v_id       bigint;
begin
  if private.my_role() is null then
    raise exception '沒有權限。';
  end if;
  p_name := btrim(coalesce(p_name, ''));
  if char_length(p_name) < 2 or char_length(p_name) > 100 then
    raise exception '客戶名稱需為 2–100 個字。';
  end if;
  -- 別名：去除空白與重複、移除與名稱相同者
  p_aliases := array(
    select a from (
      select distinct on (lower(a)) a
      from (select btrim(x) as a from unnest(coalesce(p_aliases, '{}'::text[])) as x) s
      where a <> '' and lower(a) <> lower(p_name)
      order by lower(a)
    ) d order by a
  );
  if cardinality(p_aliases) > 20 then
    raise exception '別名最多 20 個。';
  end if;
  if exists (select 1 from unnest(p_aliases) a where char_length(a) < 2 or char_length(a) > 50) then
    raise exception '每個別名需為 2–50 個字（避免一個字的別名誤判）。';
  end if;
  if p_department_id is null or not exists (select 1 from public.departments where id = p_department_id) then
    raise exception '請選擇客戶所屬的部門。';
  end if;
  if p_contacts is not null then
    p_contacts := array(
      select c from (
        select distinct on (lower(c)) c, n
        from (select btrim(x) as c, n from unnest(p_contacts) with ordinality as t(x, n)) s
        where c <> ''
        order by lower(c), n
      ) d order by n
    );
    if cardinality(p_contacts) > 100 then
      raise exception '聯絡人最多 100 位。';
    end if;
    if exists (select 1 from unnest(p_contacts) c where char_length(c) > 100) then
      raise exception '每位聯絡人最多 100 個字。';
    end if;
  end if;

  if p_id is null then
    if not private.can_view_customers(p_department_id) then
      raise exception '您不能在這個部門新增客戶。';
    end if;
  else
    select * into v_old from public.customers where id = p_id for update;
    if not found or not private.can_view_customers(v_old.department_id) then
      raise exception '客戶不存在。';
    end if;
    if not (private.can_edit_customers(v_old.department_id) and private.can_edit_customers(p_department_id)) then
      raise exception '只有主管或系統管理員可以修改客戶名錄。';
    end if;
  end if;

  v_terms := array(select lower(t) from unnest(array[p_name] || p_aliases) as t);
  select c.name as customer_name, u.term into v_conflict
  from public.customers c cross join lateral unnest(array[c.name] || c.aliases) as u(term)
  where c.department_id = p_department_id and c.id is distinct from p_id and lower(u.term) = any (v_terms)
  limit 1;
  if found then
    raise exception '「%」已經是客戶「%」的名稱或別名。', v_conflict.term, v_conflict.customer_name;
  end if;

  if p_id is null then
    insert into public.customers (department_id, name, aliases, contacts, created_by)
    values (p_department_id, p_name, p_aliases, coalesce(p_contacts, '{}'), auth.uid())
    returning id into v_id;
  else
    update public.customers
       set department_id = p_department_id, name = p_name, aliases = p_aliases,
           contacts = coalesce(p_contacts, contacts),
           active = coalesce(p_active, active)
     where id = p_id
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

-- 刪除客戶：負責該部門的主管與系統管理員（與修改權限相同）。
-- 只刪除名錄資料；週報內容不受影響，紀錄是即時比對產生的
create or replace function public.admin_delete_customer(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_dept bigint;
begin
  select department_id into v_dept from public.customers where id = p_id;
  if not found or not private.can_view_customers(v_dept) then
    raise exception '客戶不存在。';
  end if;
  if not private.can_edit_customers(v_dept) then
    raise exception '只有負責這個部門的主管或系統管理員可以刪除客戶。';
  end if;
  delete from public.customers where id = p_id;
end;
$$;

-- 客戶在週報中被提到的紀錄（以呼叫者身分執行，套用週報與人員的 RLS）
--   每日工作內容提到：每一天算 1 筆，日期為那一天
--   只在「客戶拜訪紀錄」或舊版「本週工作內容」提到：該週算 1 筆，日期為該週週一（day_index 為 null）
create or replace function public.customer_mentions(p_customer_ids bigint[])
returns table (
  customer_id bigint, report_id bigint, week_start date, day_index integer, record_date date,
  field text, content text, author_id uuid, author_name text
)
language sql stable security invoker set search_path = '' as $$
  with c as (
    select cu.id, cu.department_id,
           array(select lower(t) from unnest(array[cu.name] || cu.aliases) as t) as terms
    from public.customers cu
    where cu.id = any (p_customer_ids)
  ),
  r as (
    select rp.id, rp.user_id, rp.week_start, rp.daily_work, rp.customer_visits, rp.work_summary,
           p.name as author_name, p.department_id
    from public.reports rp
    join public.profiles p on p.id = rp.user_id
    where rp.status = 'submitted' and p.department_id in (select department_id from c)
  ),
  entries as (
    select r.id as report_id, r.user_id, r.author_name, r.department_id, r.week_start,
           (d.i - 1)::integer as day_index, 'daily'::text as field, d.t as content, 0 as prio
    from r cross join lateral jsonb_array_elements_text(r.daily_work) with ordinality as d(t, i)
    where d.t <> ''
    union all
    select r.id, r.user_id, r.author_name, r.department_id, r.week_start, null, 'customer_visits', r.customer_visits, 1
    from r where r.customer_visits <> ''
    union all
    select r.id, r.user_id, r.author_name, r.department_id, r.week_start, null, 'work_summary', r.work_summary, 2
    from r where r.work_summary <> ''
  ),
  matched as (
    select c.id as customer_id, e.*
    from c join entries e on e.department_id = c.department_id
    where exists (select 1 from unnest(c.terms) as t where strpos(lower(e.content), t) > 0)
  ),
  ranked as (
    select m.*,
           bool_or(m.field = 'daily') over (partition by m.customer_id, m.report_id) as has_daily,
           row_number() over (partition by m.customer_id, m.report_id, (m.field = 'daily') order by m.prio) as rn
    from matched m
  )
  select ranked.customer_id, ranked.report_id, ranked.week_start, ranked.day_index,
         case when ranked.day_index is null then ranked.week_start else ranked.week_start + ranked.day_index end,
         ranked.field, ranked.content, ranked.user_id, ranked.author_name
  from ranked
  where ranked.field = 'daily' or (not ranked.has_daily and ranked.rn = 1)
$$;

-- 單一客戶的紀錄，新到舊，分頁讀取
create or replace function public.customer_records(p_customer_id bigint, p_limit integer default 50, p_offset integer default 0)
returns table (
  report_id bigint, week_start date, day_index integer, record_date date,
  field text, content text, author_id uuid, author_name text
)
language sql stable security invoker set search_path = '' as $$
  select m.report_id, m.week_start, m.day_index, m.record_date, m.field, m.content, m.author_id, m.author_name
  from public.customer_mentions(array[p_customer_id]) as m
  order by m.record_date desc, m.report_id desc, m.day_index desc nulls last
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

-- 客戶紀錄統計：每位人員的紀錄次數與最後紀錄日期
create or replace function public.customer_stats(p_customer_ids bigint[])
returns table (customer_id bigint, author_id uuid, author_name text, records bigint, last_date date)
language sql stable security invoker set search_path = '' as $$
  select m.customer_id, m.author_id, m.author_name, count(*), max(m.record_date)
  from public.customer_mentions(p_customer_ids) as m
  group by m.customer_id, m.author_id, m.author_name
$$;

-- 週會紀錄：與會者姓名依報告順序保存，保留會議當時的姓名。
create table if not exists public.meeting_minutes (
  id bigint generated always as identity primary key,
  department_id bigint not null references public.departments (id),
  meeting_date date not null,
  recorder_id uuid references public.profiles (id) on delete set null,
  recorder_name text not null,
  attendees jsonb not null default '[]',
  notes text not null default '',
  published_at timestamptz,
  revision integer not null default 1
);
create index if not exists meeting_minutes_department_date_idx
  on public.meeting_minutes (department_id, meeting_date desc, id desc);

alter table public.meeting_minutes enable row level security;
drop policy if exists meeting_minutes_select on public.meeting_minutes;
create policy meeting_minutes_select on public.meeting_minutes
  for select to authenticated
  using (
    private.can_review_dept(department_id)
    or (department_id = private.my_dept()
        and (published_at is not null or recorder_id = (select auth.uid())))
  );
revoke all on public.meeting_minutes from anon, authenticated;
grant select on public.meeting_minutes to authenticated;

-- 只提供登打與會名單所需的姓名。記錄人限本人負責的草稿。
create or replace function public.meeting_roster(p_department_id bigint, p_meeting_id bigint)
returns table (id uuid, name text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.name
  from public.profiles p
  where p.active and p.department_id = p_department_id
    and (private.can_review_dept(p_department_id)
         or (p_department_id = private.my_dept() and exists (
           select 1 from public.meeting_minutes m
           where m.id = p_meeting_id and m.department_id = p_department_id
             and m.recorder_id = auth.uid() and m.published_at is null
         )))
  order by p.name, p.id
$$;

create or replace function public.save_meeting_minutes(
  p_id bigint, p_revision integer, p_department_id bigint, p_meeting_date date,
  p_recorder_id uuid, p_attendees jsonb, p_notes text, p_publish boolean
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_meeting public.meeting_minutes;
  v_can_manage boolean := private.can_review_dept(p_department_id);
  v_recorder_name text;
  v_id bigint;
begin
  if p_id is null then
    if not v_can_manage or p_department_id is null then
      raise exception '您沒有權限新增此部門的週會紀錄。';
    end if;
  else
    select * into v_meeting from public.meeting_minutes where id = p_id for update;
    if not found or v_meeting.department_id is distinct from p_department_id
       or not (v_can_manage or coalesce(
         p_department_id = private.my_dept() and v_meeting.recorder_id = auth.uid(), false)) then
      raise exception '您沒有權限編輯此週會紀錄。';
    end if;
    if v_meeting.published_at is not null then
      raise exception '這份週會紀錄已發布。';
    end if;
    if v_meeting.revision is distinct from p_revision then
      raise exception '這份週會紀錄已更新，請複製尚未儲存的內容，再重新開啟。';
    end if;
  end if;

  if p_publish and not v_can_manage then
    raise exception '請由部門主管或系統管理員發布。';
  end if;
  if p_id is not null and p_recorder_id is not distinct from v_meeting.recorder_id then
    v_recorder_name := v_meeting.recorder_name;
  elsif v_can_manage then
    select p.name into v_recorder_name from public.profiles p
    where p.id = p_recorder_id and p.active
      and (p.department_id = p_department_id or p.id = auth.uid());
  end if;
  if v_recorder_name is null then
    raise exception '請指定有效的記錄人。';
  end if;
  if p_meeting_date is null then
    raise exception '請填寫會議日期。';
  end if;
  if jsonb_typeof(p_attendees) is distinct from 'array' then
    raise exception '與會人員格式錯誤。';
  end if;
  if jsonb_array_length(p_attendees) > 100
     or (p_publish and jsonb_array_length(p_attendees) = 0) then
    raise exception '與會人員最多 100 位，發布前須至少填寫一位。';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_attendees) a
    where jsonb_typeof(a) is distinct from 'object'
       or jsonb_typeof(a->'name') is distinct from 'string'
       or char_length(btrim(a->>'name')) not between 1 and 50
       or jsonb_typeof(a->'report') is distinct from 'string'
       or char_length(a->>'report') > 10000
       or jsonb_typeof(a->'note') is distinct from 'string'
       or char_length(a->>'note') > 5000
  ) or char_length(coalesce(p_notes, '')) > 10000 then
    raise exception '請檢查姓名、報告內容及附註的格式或長度。';
  end if;
  -- 僅儲存表單欄位，陣列順序即發言順序。
  select coalesce(jsonb_agg(jsonb_build_object(
    'name', btrim(a->>'name'), 'report', a->>'report', 'note', a->>'note'
  ) order by ord), '[]'::jsonb) into p_attendees
  from jsonb_array_elements(p_attendees) with ordinality as entries(a, ord);

  if p_id is null then
    insert into public.meeting_minutes
      (department_id, meeting_date, recorder_id, recorder_name, attendees, notes, published_at)
    values (p_department_id, p_meeting_date, p_recorder_id, v_recorder_name,
            p_attendees, coalesce(p_notes, ''), case when p_publish then now() end)
    returning id into v_id;
  else
    update public.meeting_minutes
    set meeting_date = p_meeting_date, recorder_id = p_recorder_id,
        recorder_name = v_recorder_name, attendees = p_attendees,
        notes = coalesce(p_notes, ''), published_at = case when p_publish then now() end,
        revision = revision + 1
    where id = p_id returning id into v_id;
  end if;
  return v_id;
end
$$;

-- =============================================================================
-- 函式權限：RPC 只開放給已登入者；內部函式不開放
-- =============================================================================
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'save_report', 'delete_draft', 'change_my_password', 'review_report', 'review_reports',
      'admin_save_department', 'admin_delete_department', 'admin_save_user',
      'meeting_roster', 'save_meeting_minutes',
      'save_customer', 'customer_mentions', 'customer_records', 'customer_stats', 'admin_delete_customer')
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end
$$;
-- RLS 政策會呼叫這些函式，因此登入者需要執行權限（函式本身只回傳自己的權限判斷）
grant execute on function private.my_role(), private.is_admin(),
                          private.can_review_dept(bigint), private.user_dept(uuid),
                          private.my_dept(), private.can_view_customers(bigint)
  to authenticated;

-- =============================================================================
-- 預設管理員：admin / admin1234（首次登入強制變更密碼）
-- =============================================================================
do $$
declare
  v_id uuid;
begin
  if not exists (select 1 from public.profiles where role = 'admin') then
    select id into v_id from auth.users where lower(email) = private.login_email('admin');
    if v_id is null then
      v_id := private.create_auth_user(private.login_email('admin'), 'admin1234');
    end if;
    insert into public.profiles (id, username, name, role, must_change_password)
    values (v_id, 'admin', '系統管理員', 'admin', true)
    on conflict (id) do update set role = 'admin', active = true;
  end if;
end
$$;

commit;
