-- =============================================================================
-- 業務週報系統 — Supabase (PostgreSQL) 建表 SQL
-- 對應程式：src/db.js（原 SQLite 結構）
--
-- 使用方式：貼到 Supabase Dashboard → SQL Editor 執行，或 `psql -f supabase/schema.sql`
-- 可重複執行（皆使用 IF NOT EXISTS / OR REPLACE）。
--
-- 存取設計：
--   本系統自行管理帳號（users.password_hash，bcrypt），不使用 Supabase Auth。
--   所有資料表都啟用 RLS 且「不建立任何 policy」，因此 anon / authenticated
--   金鑰無法讀寫任何資料；只有後端伺服器以 service_role 金鑰或資料庫連線字串
--   (postgres 角色) 存取，權限判斷仍由後端程式（src/auth.js）負責。
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 共用：自動更新 updated_at
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 部門
-- -----------------------------------------------------------------------------
create table if not exists public.departments (
  id          bigint generated always as identity primary key,
  name        text        not null unique check (char_length(btrim(name)) between 1 and 50),
  created_at  timestamptz not null default now()
);
comment on table public.departments is '部門';

-- -----------------------------------------------------------------------------
-- 人員（登入帳號）
--   role: admin = 系統管理員、manager = 主管、staff = 業務人員
-- -----------------------------------------------------------------------------
create table if not exists public.users (
  id                   bigint generated always as identity primary key,
  username             text        not null check (username ~ '^[A-Za-z0-9._-]{3,50}$'),
  password_hash        text        not null,
  name                 text        not null check (char_length(btrim(name)) between 1 and 50),
  role                 text        not null check (role in ('admin', 'manager', 'staff')),
  department_id        bigint      references public.departments (id) on delete set null,
  active               boolean     not null default true,
  must_change_password boolean     not null default false,
  created_at           timestamptz not null default now()
);
comment on table  public.users                      is '人員與登入帳號';
comment on column public.users.role                 is 'admin=系統管理員, manager=主管, staff=業務人員';
comment on column public.users.must_change_password is '下次登入需變更密碼（新建或被重設密碼時為 true）';

-- 帳號不分大小寫唯一（對應 SQLite 的 COLLATE NOCASE）
create unique index if not exists users_username_lower_key on public.users (lower(username));
create index if not exists users_department_id_idx on public.users (department_id);

-- -----------------------------------------------------------------------------
-- 主管可查閱的部門（一位主管可管理多個部門）
-- -----------------------------------------------------------------------------
create table if not exists public.manager_departments (
  user_id       bigint not null references public.users (id)       on delete cascade,
  department_id bigint not null references public.departments (id) on delete cascade,
  primary key (user_id, department_id)
);
comment on table public.manager_departments is '主管可查閱的部門';
create index if not exists manager_departments_department_id_idx on public.manager_departments (department_id);

-- -----------------------------------------------------------------------------
-- 週報（每人每週一份，week_start 為該週週一）
-- -----------------------------------------------------------------------------
create table if not exists public.reports (
  id              bigint generated always as identity primary key,
  user_id         bigint      not null references public.users (id) on delete cascade,
  week_start      date        not null check (extract(isodow from week_start) = 1),
  work_summary    text        not null default '' check (char_length(work_summary)    <= 10000),
  customer_visits text        not null default '' check (char_length(customer_visits) <= 10000),
  sales_progress  text        not null default '' check (char_length(sales_progress)  <= 10000),
  next_week_plan  text        not null default '' check (char_length(next_week_plan)  <= 10000),
  issues          text        not null default '' check (char_length(issues)          <= 10000),
  status          text        not null default 'draft' check (status in ('draft', 'submitted')),
  submitted_at    timestamptz,
  reviewed_by     bigint      references public.users (id) on delete set null,
  reviewed_at     timestamptz,
  review_comment  text        not null default '' check (char_length(review_comment) <= 2000),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, week_start),
  -- 已提交必須有提交時間；草稿不可有提交時間
  constraint reports_submitted_at_chk
    check ((status = 'submitted') = (submitted_at is not null)),
  -- 只有已提交的週報可以被標記查閱
  constraint reports_review_requires_submitted_chk
    check (reviewed_at is null or status = 'submitted'),
  -- 有查閱人就一定有查閱時間（查閱人帳號刪除時 reviewed_by 會變 null，故不反向要求）
  constraint reports_reviewed_by_chk
    check (reviewed_by is null or reviewed_at is not null)
);
comment on table  public.reports                 is '業務週報';
comment on column public.reports.week_start      is '該週週一（YYYY-MM-DD）';
comment on column public.reports.work_summary    is '本週工作內容';
comment on column public.reports.customer_visits is '客戶拜訪紀錄';
comment on column public.reports.sales_progress  is '業績與案件進度';
comment on column public.reports.next_week_plan  is '下週工作計畫';
comment on column public.reports.issues          is '問題與需協助事項';
comment on column public.reports.reviewed_by     is '查閱主管；null 且 reviewed_at 為 null 代表尚未查閱';
comment on column public.reports.reviewed_at     is '主管標記查閱完成的時間';

create index if not exists reports_week_start_idx  on public.reports (week_start);
create index if not exists reports_reviewed_by_idx on public.reports (reviewed_by);
-- 「待查閱」查詢用
create index if not exists reports_pending_idx     on public.reports (week_start)
  where status = 'submitted' and reviewed_at is null;

drop trigger if exists reports_set_updated_at on public.reports;
create trigger reports_set_updated_at
  before update of work_summary, customer_visits, sales_progress, next_week_plan, issues, status
  on public.reports
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 查閱歷程（標記查閱、撤回查閱、更新意見）
-- -----------------------------------------------------------------------------
create table if not exists public.review_logs (
  id         bigint generated always as identity primary key,
  report_id  bigint      not null references public.reports (id) on delete cascade,
  user_id    bigint      references public.users (id) on delete set null,
  action     text        not null check (action in ('reviewed', 'unreviewed', 'commented')),
  comment    text        not null default '' check (char_length(comment) <= 2000),
  created_at timestamptz not null default now()
);
comment on table public.review_logs is '週報查閱歷程';
create index if not exists review_logs_report_id_idx on public.review_logs (report_id, id desc);
create index if not exists review_logs_user_id_idx   on public.review_logs (user_id);

-- -----------------------------------------------------------------------------
-- 登入 Session（express-session 儲存區）
-- -----------------------------------------------------------------------------
create table if not exists public.sessions (
  sid     text        primary key,
  data    jsonb       not null,
  expires timestamptz not null
);
comment on table public.sessions is 'express-session 登入工作階段';
create index if not exists sessions_expires_idx on public.sessions (expires);
-- 停用帳號時依 userId 清除 session 用
create index if not exists sessions_user_id_idx on public.sessions (((data ->> 'userId')::bigint));

-- -----------------------------------------------------------------------------
-- 系統設定（例：未設定 SESSION_SECRET 時自動產生的金鑰）
-- -----------------------------------------------------------------------------
create table if not exists public.settings (
  key   text primary key,
  value text not null
);
comment on table public.settings is '系統設定';

-- -----------------------------------------------------------------------------
-- Row Level Security：全部啟用、不開放任何 policy（僅後端 service_role 可存取）
-- -----------------------------------------------------------------------------
alter table public.departments         enable row level security;
alter table public.users               enable row level security;
alter table public.manager_departments enable row level security;
alter table public.reports             enable row level security;
alter table public.review_logs         enable row level security;
alter table public.sessions            enable row level security;
alter table public.settings            enable row level security;

-- 額外保險：撤銷前端金鑰角色的直接權限（含密碼雜湊、session 等敏感資料）
revoke all on public.departments, public.users, public.manager_departments,
              public.reports, public.review_logs, public.sessions, public.settings
  from anon, authenticated;
revoke all on function public.set_updated_at() from anon, authenticated;

commit;

-- =============================================================================
-- 預設管理員
--   不在此直接寫入（需要 bcrypt 雜湊）。後端程式第一次啟動時，若 users 表沒有任何
--   帳號，會自動建立 admin / admin1234（首次登入強制改密碼），與 SQLite 版行為相同。
-- =============================================================================
