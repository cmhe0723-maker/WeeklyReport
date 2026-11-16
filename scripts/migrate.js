'use strict';
// 在 DATABASE_URL 指向的資料庫執行 supabase/schema.sql：npm run db:migrate
const db = require('../src/db');

db.migrate()
  .then(() => db.ensureAdmin())
  .then(() => console.log('資料表建立／更新完成。'))
  .catch((e) => { console.error('[migrate 失敗]', e.message); process.exitCode = 1; })
  .finally(() => db.close());
