'use strict';
/**
 * 依存パッケージなし（Node.js 18+ の標準機能のみ）のオンラインマダミス用サーバー
 *
 *  - 静的ファイル配信      : index.html / style.css / app.js / config.js
 *  - リアルタイム配信(SSE)  : GET  /api/events?code=XXXXXX&token=...
 *  - 操作(POST)            : POST /api/create | /api/join | /api/action
 *  - ヘルスチェック        : GET  /healthz
 *
 * 環境変数は README.md を参照。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const game = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN || ''; // クライアントを別ドメインに置く場合だけ設定
const CLIENT_DIR = __dirname;
// 公開してよいファイルだけを配信する（サーバーのソースコードは配信しない）
const PUBLIC_FILES = new Set(['index.html', 'style.css', 'app.js', 'config.js']);
const MAX_BODY = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

// 部屋の乱立対策: IPごとに1分あたり20回まで作成・参加を許可
const ipHits = new Map();
function ipLimited(ip) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  ipHits.set(ip, arr);
  if (ipHits.size > 5000) for (const [k, v] of ipHits) if (!v.some((t) => now - t < 60000)) ipHits.delete(k);
  return arr.length > 20;
}
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function setCors(req, res) {
  if (!CORS_ORIGIN) return;
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new game.UserError('リクエストが大きすぎます。'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch (e) {
        reject(new game.UserError('リクエストの形式が正しくありません。'));
      }
    });
    req.on('error', reject);
  });
}

function handleEvents(req, res, url) {
  const code = url.searchParams.get('code');
  const token = url.searchParams.get('token');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...(CORS_ORIGIN ? { 'Access-Control-Allow-Origin': CORS_ORIGIN, Vary: 'Origin' } : {})
  });
  res.write('retry: 2000\n\n');
  const a = game.auth(code, token);
  if (!a) {
    res.write(`event: fatal\ndata: ${JSON.stringify({ message: '部屋が見つからないか、セッションの有効期限が切れました。' })}\n\n`);
    res.end();
    return;
  }
  const { room, player } = a;
  req.socket.setKeepAlive(true);
  req.socket.setNoDelay(true);
  const hb = setInterval(() => {
    try {
      res.write(`event: tick\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);
    } catch (e) {}
  }, 10000);
  let closed = false;
  const onClose = () => {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    game.detachConn(room, player, res);
  };
  req.on('close', onClose);
  res.on('close', onClose);
  game.attachConn(room, player, res);
}

async function handleApi(req, res, url) {
  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'POSTで呼び出してください。' });
    const body = await readBody(req);
    if (url.pathname === '/api/create') {
      if (ipLimited(clientIp(req))) throw new game.UserError('短時間に操作しすぎです。少し待ってからお試しください。');
      const { room, player } = game.createRoom(body.name);
      return json(res, 200, { code: room.code, token: player.token, playerId: player.id });
    }
    if (url.pathname === '/api/join') {
      if (ipLimited(clientIp(req))) throw new game.UserError('短時間に操作しすぎです。少し待ってからお試しください。');
      const { room, player } = game.joinRoom(body.code, body.name);
      return json(res, 200, { code: room.code, token: player.token, playerId: player.id });
    }
    if (url.pathname === '/api/action') {
      const a = game.auth(body.code, body.token);
      if (!a) return json(res, 401, { error: 'セッションが無効です。部屋に入り直してください。', fatal: true });
      game.handleAction(a.room, a.player, body);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e instanceof game.UserError) return json(res, 400, { error: e.message });
    console.error('API error:', e);
    return json(res, 500, { error: 'サーバーでエラーが発生しました。' });
  }
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const name = p.replace(/^\//, '');
  if (!PUBLIC_FILES.has(name)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('見つかりません');
  }
  const file = path.join(CLIENT_DIR, name);
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('見つかりません');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    res.writeHead(400);
    return res.end('Bad request');
  }
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  if (url.pathname === '/healthz') return json(res, 200, { ok: true, ...game.stats() });
  if (url.pathname === '/api/events' && req.method === 'GET') return handleEvents(req, res, url);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  return serveStatic(req, res, url);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

game.startTimers();
server.listen(PORT, HOST, () => {
  console.log(`深夜0時の館 server listening on http://${HOST}:${PORT}`);
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
process.on('uncaughtException', (e) => console.error('uncaughtException', e));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
