'use strict';
const session = require('express-session');

// 以資料庫 sessions 資料表儲存登入狀態，伺服器重啟或多台主機都能共用
class PgStore extends session.Store {
  constructor(db, ttlMs) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    const timer = setInterval(() => {
      this.db.query('delete from sessions where expires < now()').catch((e) => console.error('[session] 清除過期 session 失敗：', e.message));
    }, 60 * 60 * 1000);
    timer.unref();
  }
  expiry(sess) {
    const exp = sess && sess.cookie && sess.cookie.expires;
    return exp ? new Date(exp) : new Date(Date.now() + this.ttlMs);
  }
  get(sid, cb) {
    this.db.one('select data from sessions where sid = $1 and expires > now()', [sid])
      .then((row) => cb(null, row ? row.data : null), cb);
  }
  set(sid, sess, cb) {
    this.db.query(
      `insert into sessions (sid, data, expires) values ($1, $2, $3)
       on conflict (sid) do update set data = excluded.data, expires = excluded.expires`,
      [sid, JSON.stringify(sess), this.expiry(sess)]
    ).then(() => cb && cb(null), (e) => cb && cb(e));
  }
  destroy(sid, cb) {
    this.db.query('delete from sessions where sid = $1', [sid]).then(() => cb && cb(null), (e) => cb && cb(e));
  }
  touch(sid, sess, cb) {
    this.db.query('update sessions set expires = $1 where sid = $2', [this.expiry(sess), sid])
      .then(() => cb && cb(null), (e) => cb && cb(e));
  }
}

module.exports = PgStore;
