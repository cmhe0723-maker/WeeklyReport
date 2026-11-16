'use strict';
const app = require('./app');
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`週報系統已啟動：http://localhost:${port}`));
