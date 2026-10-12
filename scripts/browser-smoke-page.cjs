'use strict';
const http = require('node:http');
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>SC Browser MCP smoke</title><h1 id="sc-smoke">SC_BROWSER_MCP_SMOKE_READY</h1><p>Local fixture. No login, model request or user data.</p></html>');
});
server.listen(0, '127.0.0.1', () => {
  console.log('[BrowserSmoke] http://127.0.0.1:' + server.address().port + '/');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
