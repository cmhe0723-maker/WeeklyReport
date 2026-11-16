// Supabase 連線設定。
// publishable key 本來就是公開金鑰（會出現在瀏覽器），資料安全由 supabase/schema.sql 的
// Row Level Security 與資料庫函式負責。請勿把 secret key / service_role key 放在這裡。
window.APP_CONFIG = {
  supabaseUrl: 'https://ibnzecjiribbjyxbfmrj.supabase.co',
  supabaseKey: 'sb_publishable_-eQOId8v5B4E1UIOHAtJpw_Zuy38EfR',
  // 必須與 supabase/schema.sql 的 private.login_email() 一致
  emailDomain: 'weeklyreport.example.com',
  timeZone: 'Asia/Taipei',
};
