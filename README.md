# 業務週報系統

業務人員記錄每週工作會報的網站。管理員設定部門與人員的登入權限，主管登入後查看所屬部門的週報，並記錄是否已查閱完成。

## 功能

| 角色 | 可以做的事 |
| --- | --- |
| **業務人員** | 填寫每週週報（本週工作內容、客戶拜訪紀錄、業績與案件進度、下週工作計畫、問題與需協助事項）；可存草稿或提交；查看主管的查閱狀態與意見 |
| **主管** | 查看「可查閱部門」內人員**已提交**的週報；標記「查閱完成」（記錄查閱人與時間）、留下意見、撤回查閱；可批次標記；可依週次／部門／狀態篩選，並看到每週誰還沒交；主管本人也能填寫週報 |
| **系統管理員** | 查閱所有部門週報；新增／更名／刪除部門；新增人員、設定角色、所屬部門、主管可查閱的部門、重設密碼、停用帳號 |

其他細節：

- 週次以「週一～週日」為一週，選擇該週任一天即可，每人每週一份。
- 主管標記查閱完成後，業務人員就不能再修改該週報；主管撤回查閱後才可再修改。
- 每次標記、撤回、更新意見都會記在「查閱紀錄」。
- 草稿只有本人看得到。
- 填寫新週報時，會顯示上一份週報的「下週工作計畫」供參考。
- 新帳號或被重設密碼的帳號，首次登入時必須自行變更密碼。
- 停用帳號立即生效，已登入的工作階段也會失效。
- 安全性：密碼以 bcrypt 雜湊、所有表單有 CSRF 保護、同帳號連續登入失敗 5 次鎖定 15 分鐘。

## 安裝與啟動

需求：Node.js 22.9 以上、一個 [Supabase](https://supabase.com) 專案（資料存放在 Supabase 的 PostgreSQL）。

### 1. 取得 Supabase 連線字串

在 Supabase Dashboard 開啟專案 → 上方 **Connect** → 選 **Session pooler**（或 Direct connection），複製連線字串，並把 `[YOUR-PASSWORD]` 換成資料庫密碼。

> 本系統是長駐伺服器，請使用 Session pooler（port 5432）或 Direct connection，不建議使用 Transaction pooler（port 6543）。

### 2. 設定環境變數

```bash
cp .env.example .env
```

編輯 `.env`，填入 `DATABASE_URL`。`npm` 指令會自動讀取 `.env`。

### 3. 安裝套件並建立資料表

```bash
npm install
```

```bash
npm run db:migrate
```

`db:migrate` 會執行 `supabase/schema.sql`。也可以改成把該檔內容貼到 Supabase Dashboard → SQL Editor 執行，兩者擇一即可，重複執行也不會出錯。

### 4. 啟動

```bash
npm start
```

開啟 http://localhost:3000 ，以預設管理員登入：

- 帳號：`admin`
- 密碼：`admin1234`（首次登入會要求變更）

### 建議使用順序

1. 管理員到「部門管理」新增部門（例如：北區業務部、南區業務部）。
2. 到「人員與權限」新增人員：
   - 業務人員：角色選「業務人員」，選擇所屬部門。
   - 主管：角色選「主管」，並勾選他可查閱的部門（可多個）。
3. 業務人員登入後在「我的週報」填寫並提交。
4. 主管登入後在「週報查閱」查看本週提交狀況，點進週報後按「標記為查閱完成」。

### 示範資料（選用）

```bash
npm run seed:demo
```

會建立兩個部門、兩位主管（`manager.north`、`manager.south`）與三位業務（`sales.chen`、`sales.lin`、`sales.huang`），密碼皆為 `demo1234`。

## 資料存取與安全

- 後端以 `DATABASE_URL`（資料庫連線字串）直接連線，誰能看哪份週報由後端程式判斷。
- 所有資料表都啟用 Row Level Security 且未開放任何 policy，並撤銷 `anon`、`authenticated` 角色的權限，所以前端用 Supabase 公開金鑰（anon key）**讀不到任何資料**，包含密碼雜湊與登入 session。
- 本系統使用自己的帳號表（`users`），不使用 Supabase Auth。
- 備份：Supabase 付費方案有每日自動備份；免費方案可用 `pg_dump` 自行備份。

## 設定（環境變數）

| 變數 | 預設值 | 說明 |
| --- | --- | --- |
| `DATABASE_URL` | （必填） | Supabase 連線字串 |
| `DATABASE_SSL` | 本機 `off`，其他 `require` | `require`：加密連線；`verify`：加密並驗證伺服器憑證（搭配 `DATABASE_CA_CERT`）；`off`：不加密 |
| `DATABASE_CA_CERT` | 未設定 | `DATABASE_SSL=verify` 時使用的 CA 憑證檔（Supabase Dashboard → Database Settings → SSL 下載） |
| `DB_POOL_MAX` | `10` | 資料庫連線池上限 |
| `DB_AUTO_MIGRATE` | 未設定 | 設為 `1` 時，啟動若發現沒有資料表會自動執行 `schema.sql` |
| `PORT` | `3000` | 服務埠號 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `admin1234` | 第一次啟動（沒有任何帳號）時建立的管理員 |
| `APP_TIMEZONE` | `Asia/Taipei` | 計算「本週」與顯示時間所用的時區 |
| `SESSION_SECRET` | 自動產生並存於資料庫 | Session 簽章金鑰 |
| `COOKIE_SECURE` | 未設定 | 以 HTTPS 對外服務時設為 `1` |
| `TRUST_PROXY` | 未設定 | 架在反向代理（Nginx 等）後方時設為 `1` |

## 測試

測試會**清空**指定的資料庫，請使用另一個空的 PostgreSQL 資料庫，不要指向正式的 Supabase 專案：

```bash
TEST_DATABASE_URL=postgresql://postgres@localhost:5432/wr_test npm test
```

未設定 `TEST_DATABASE_URL` 時測試會自動略過。

## 專案結構

```
src/
  server.js          啟動入口
  app.js             Express 設定、Session、CSRF
  session-store.js   登入 session 存放在資料庫
  db.js              資料庫連線（pg）、交易、初始化
  auth.js            登入檢查與權限判斷
  util.js            週次與日期工具
  routes/            auth / reports / review / admin
views/               EJS 頁面
public/              CSS 與前端 JS
supabase/schema.sql  Supabase 建表 SQL
scripts/migrate.js   執行建表 SQL
scripts/seed-demo.js 示範資料
test/                整合測試
```
