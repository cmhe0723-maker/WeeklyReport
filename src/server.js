'use strict';
const { createApp } = require('./app');
const db = require('./db');

const port = Number(process.env.PORT) || 3000;

createApp()
  .then((app) => {
    const server = app.listen(port, () => console.log(`週報系統已啟動：http://localhost:${port}`));
    const shutdown = () => server.close(() => db.close().finally(() => process.exit(0)));
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  })
  .catch((err) => {
    console.error('[啟動失敗]', err.message);
    process.exit(1);
  });
