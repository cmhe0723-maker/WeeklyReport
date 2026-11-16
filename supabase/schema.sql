-- =============================================================================
-- 業務週報系統 — Supabase 建表 SQL
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
comment on column public.reports.work_summary    is '本週工作內容';
comment on column public.reports.customer_visits is '客戶拜訪紀錄';
comment on column public.reports.sales_progress  is '業績與案件進度';
comment on column public.reports.next_week_plan  is '下週工作計畫';
comment on column public.reports.issues          is '問題與需協助事項';
comment on column public.reports.reviewed_at     is '主管標記查閱完成的時間；null 代表尚未查閱';
comment on column public.reports.reviewer_name   is '查閱主管姓名（快照，讓業務人員不需讀取主管資料也能顯示）';
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
  before update of work_summary, customer_visits, sales_progress, next_week_plan, issues, status
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
create or replace function public.save_report(
  p_id              bigint,
  p_week            date,
  p_work_summary    text,
  p_customer_visits text,
  p_sales_progress  text,
  p_next_week_plan  text,
  p_issues          text,
  p_submit          boolean
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_role text := private.my_role();
  v_old  public.reports;
  v_id   bigint;
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
  if p_submit and p_work_summary = '' then
    raise exception '提交前請填寫「本週工作內容」。';
  end if;

  if p_id is null then
    if p_week is null then
      raise exception '請選擇正確的週次日期。';
    end if;
    insert into public.reports (user_id, week_start, work_summary, customer_visits, sales_progress,
                                next_week_plan, issues, status, submitted_at)
    values (v_uid, date_trunc('week', p_week)::date, p_work_summary, p_customer_visits, p_sales_progress,
            p_next_week_plan, p_issues,
            case when p_submit then 'submitted' else 'draft' end,
            case when p_submit then now() end)
    on conflict (user_id, week_start) do nothing
    returning id into v_id;
    if v_id is null then
      raise exception '該週已有週報，請改為編輯該份週報。';
    end if;
    return v_id;
  end if;

  select * into v_old from public.reports where id = p_id and user_id = v_uid for update;
  if not found then
    raise exception '週報不存在。';
  end if;
  if v_old.reviewed_at is not null then
    raise exception '此週報主管已查閱，無法再修改。如需修改請洽主管撤回查閱。';
  end if;
  update public.reports set
    work_summary    = p_work_summary,
    customer_visits = p_customer_visits,
    sales_progress  = p_sales_progress,
    next_week_plan  = p_next_week_plan,
    issues          = p_issues,
    status          = case when p_submit then 'submitted' else 'draft' end,
    submitted_at    = case when p_submit then coalesce(v_old.submitted_at, now()) end
  where id = p_id;
  return p_id;
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
      'admin_save_department', 'admin_delete_department', 'admin_save_user')
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
                          private.can_review_dept(bigint), private.user_dept(uuid)
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
