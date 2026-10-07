'use strict';
// テスト共通部品: サーバー起動・HTTPクライアント・SSEクライアント（密談イベント対応）
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

function post(base, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      base + p,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let s = '';
        res.on('data', (c) => (s += c));
        res.on('end', () => {
          let j = {};
          try { j = JSON.parse(s); } catch (e) {}
          resolve({ status: res.statusCode, body: j });
        });
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 5000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error('timeout waiting for: ' + label);
}

class Client {
  constructor(base, name) {
    this.base = base;
    this.name = name;
    this.state = null;
    this.chat = [];
    this.raw = ''; // 受信した全データ（漏洩チェック用）
    this.sc = {}; // 密談メタ
    this.scMsgs = {}; // 密談メッセージ
    this.fatal = null;
  }
  async create() {
    const r = await post(this.base, '/api/create', { name: this.name });
    assert.strictEqual(r.status, 200, 'create failed ' + JSON.stringify(r.body));
    Object.assign(this, r.body);
  }
  async join(code) {
    const r = await post(this.base, '/api/join', { code, name: this.name });
    assert.strictEqual(r.status, 200, 'join failed ' + JSON.stringify(r.body));
    Object.assign(this, r.body);
  }
  connect() {
    this.raw = '';
    return new Promise((resolve) => {
      this.req = http.get(`${this.base}/api/events?code=${this.code}&token=${this.token}`, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          this.raw += chunk;
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /event: (.*)/.exec(block);
            const da = /data: (.*)/.exec(block);
            if (!ev || !da) continue;
            const data = JSON.parse(da[1]);
            if (ev[1] === 'state') { this.state = data; if (this._first) { this._first(); this._first = null; } }
            else if (ev[1] === 'chatlog') this.chat = data;
            else if (ev[1] === 'chat') this.chat.push(data);
            else if (ev[1] === 'fatal') this.fatal = data;
            else if (ev[1] === 'sc_log') { this.scMsgs = data; }
            else if (ev[1] === 'sc_meta') this.sc[data.id] = data;
            else if (ev[1] === 'sc_msg') (this.scMsgs[data.chatId] = this.scMsgs[data.chatId] || []).push(data.msg);
          }
        });
      });
      this._first = resolve;
    });
  }
  disconnect() { if (this.req) this.req.destroy(); }
  act(type, extra) {
    return post(this.base, '/api/action', Object.assign({ code: this.code, token: this.token, type }, extra || {}));
  }
  async ok(type, extra) {
    const r = await this.act(type, extra);
    assert.strictEqual(r.status, 200, `${this.name} ${type} -> ${JSON.stringify(r.body)}`);
    return r;
  }
  async bad(type, extra, label) {
    const r = await this.act(type, extra);
    assert(r.status >= 400, `${label || type}: expected failure but got ${r.status}`);
    return r;
  }
}

let server = null;
async function startServer(port, env) {
  server = spawn('node', [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), MIN_PHASE_SEC: '1' }, env || {}),
    stdio: ['ignore', 'inherit', 'inherit']
  });
  for (let i = 0; i < 50; i++) {
    try { await post(`http://127.0.0.1:${port}`, '/healthz', {}); return; } catch (e) { await sleep(100); }
  }
  throw new Error('server did not start');
}
function stopServer() { if (server) server.kill(); }

module.exports = { post, sleep, until, Client, startServer, stopServer };
