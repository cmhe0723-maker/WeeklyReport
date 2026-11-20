# 工作週報系統

業務人員記錄每週工作會報的網站。管理員設定部門與人員的登入權限，主管登入後查看所屬部門的週報，並記錄是否已查閱完成。

- 網站：<https://cmhe0723-maker.github.io/WeeklyReport/>（GitHub Pages）
- 資料庫與登入：Supabase

## 功能

| 角色 | 可以做的事 |
| --- | --- |
| **業務人員** | 填寫每週週報：每日工作內容（週一～週五逐日填寫，週六日選填；每天可加多筆拜訪，每筆有客戶、聯絡人、內容，聯絡人會自動記入客戶名錄並在下次填寫時建議），以及客戶拜訪紀錄、業績與案件進度、下週工作計畫、問題與需協助事項；可存草稿或提交；查看主管的查閱狀態與意見 |
| **主管** | 查看「可查閱部門」內人員**已提交**的週報；標記「查閱完成」（記錄查閱人與時間）、留下意見、撤回查閱；可批次標記；可依週次／部門／狀態篩選，並看到每週誰還沒交；主管本人也能填寫週報 |
| **系統管理員** | 查閱所有部門週報；新增／更名／刪除部門；新增人員、設定角色、所屬部門、主管可查閱的部門、重設密碼、停用帳號 |

- **繳交統計**（主管、系統管理員）：選擇期間（近 4／8／12／26 週）與部門，查看各部門應繳、已繳、未繳、繳交率、準時率、查閱率，以及每位人員逐週的繳交狀況。主管只看得到自己負責的部門。本週尚未結束、或人員帳號建立之前的週次不列入統計。
- **客戶名錄與客戶紀錄**：每個部門有自己的客戶名錄（名稱＋別名，例如「大成」＝「大成科技」）。填寫週報時打到客戶名稱或別名會跳出建議，旁邊列出本週提到的客戶與最近 5 筆過往紀錄；「客戶」頁可搜尋客戶，查看紀錄次數、最後紀錄日期、接觸人員與所有提到該客戶的內容。紀錄以名稱即時比對已提交的週報（舊週報也找得到），並沿用週報權限：業務只看到自己的、主管看到負責部門的、系統管理員看到全部。業務可新增客戶；主管可修改、停用、刪除負責部門的客戶，系統管理員可處理所有部門（刪除只移除名錄，週報內容不受影響）。
- **週會紀錄**：主管可為負責的部門新增紀錄並指定記錄人，逐人整理報告內容與個人附註，也可記下全場附註。草稿可由記錄人續編，主管確認後發布。發布後同部門人員可依週次查閱。系統管理員可管理所有部門。
- **列印／輸出 PDF**：每份週報、繳交統計都可列印；主管可在「週報查閱」一次列印整週週報（每份一頁）。在列印視窗的「目的地」選擇「另存為 PDF」即可輸出 PDF。
- 週次以「週一～週日」為一週，選擇該週任一天即可，每人每週一份。
- 主管標記查閱完成後，業務人員就不能再修改；主管撤回查閱後才可再修改。每次標記、撤回、更新意見都會留下查閱紀錄。
- 草稿只有本人看得到。
- 新帳號或被重設密碼的帳號，首次登入時必須自行變更密碼。
- 停用帳號立即生效（無法登入，已登入的裝置也讀不到任何資料）。

## 架構與安全

```
瀏覽器（docs/，GitHub Pages 靜態網站）
   │  supabase-js + publishable key
   ▼
Supabase
   ├─ Auth：帳號密碼登入
   ├─ 資料表：Row Level Security，只開放「讀取自己有權限的資料」
   └─ 資料庫函式（RPC）：所有新增／修改／查閱／管理動作，函式內檢查權限
```

- publishable key 本來就是公開的金鑰，網頁原始碼中看得到是正常的；資料安全完全由資料庫端的 RLS 與函式把關，前端無法直接寫入任何資料表。
- 帳號 `amy` 在 Supabase Auth 中對應的登入信箱是 `amy@weeklyreport.example.com`。這只是登入識別，不會寄信。
- **請勿**把 Supabase 的 secret key / service_role key 放進本專案。

## 第一次設定

### 1. 在 Supabase 建立資料表

Supabase Dashboard → **SQL Editor** → New query → 貼上 [`supabase/schema.sql`](supabase/schema.sql) 全部內容 → **Run**。

會同時建立預設管理員：帳號 `admin`、密碼 `admin1234`（首次登入會要求變更）。之後更新版本時重新執行同一個檔案即可，不會影響既有資料。

### 2. 關閉 Supabase 的自行註冊（建議）

Dashboard → **Authentication** → **Sign In / Providers** → 關閉 **Allow new users to sign up**，並確認 **Email** 登入方式為啟用。

本系統的帳號一律由管理員在網站上建立，關閉自行註冊可避免陌生人在 Supabase 建立帳號（即使建立了，沒有人員資料也讀不到任何東西）。

### 3. 開啟 GitHub Pages

GitHub repository → **Settings** → **Pages** → Build and deployment：

- Source：**Deploy from a branch**
- Branch：**main**，資料夾 **/docs** → **Save**

約 1 分鐘後即可開啟 <https://cmhe0723-maker.github.io/WeeklyReport/>。

### 4. 開始使用

1. 以 `admin` / `admin1234` 登入並變更密碼。
2. 「部門管理」新增部門。
3. 「人員與權限」新增人員：業務選「業務人員」並選所屬部門；主管選「主管」並勾選可查閱的部門。
4. 業務登入後在「我的週報」填寫並提交；主管在「週報查閱」查看並標記查閱完成。

## 設定

既有站台啟用週會紀錄時，先在 Supabase SQL Editor 重新執行 [建表 SQL](supabase/schema.sql)，再部署更新的前端。

[`docs/config.js`](docs/config.js)：Supabase 網址、publishable key、時區。換 Supabase 專案時修改這個檔案即可。

## 本機預覽

```bash
npm run serve
```

開啟 http://localhost:8080 （會連到 config.js 設定的 Supabase）。

## 測試

```bash
npm install
```

資料庫權限測試需要一個**可以清空**的 PostgreSQL 資料庫（會模擬 Supabase 的 auth 與角色），請勿指向正式的 Supabase：

```bash
TEST_DATABASE_URL=postgresql://postgres@localhost:5432/wr_test npm test
```

前端畫面測試需要 Playwright，會攔截所有 Supabase 請求改用模擬資料，不會連到正式環境。未設定資料庫或未安裝 Playwright 時，對應的測試會自動略過。

## 專案結構

```
docs/                    GitHub Pages 網站
  index.html
  app.js                 所有頁面與操作
  config.js              Supabase 連線設定
  style.css
  vendor/                supabase-js 2.118.0（MIT）
supabase/schema.sql      資料表、RLS、資料庫函式、預設管理員
test/schema.test.js      資料庫權限測試
test/supabase-mock.sql   測試用：在一般 PostgreSQL 模擬 Supabase
test/ui.test.js          前端畫面測試
scripts/serve.js         本機預覽
```
