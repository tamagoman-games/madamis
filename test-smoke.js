'use strict';
/**
 * スモークテスト: 実際にサーバーを起動し、5人分のクライアントがHTTP/SSEで通信して
 * ロビー → 全フェーズ → 投票 → 結果 → ロビー復帰まで通します。
 * さらに「他人の秘密が結果発表前に1バイトも届いていないこと」を検証します。
 *
 *   node test/smoke.js
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const scenario = require('./scenario');

const PORT = 3100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;

function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      BASE + p,
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

class Client {
  constructor(name) {
    this.name = name;
    this.state = null;
    this.chat = [];
    this.raw = ''; // 受信した全データ（秘密漏洩チェック用）
    this.fatal = null;
  }
  async create() {
    const r = await post('/api/create', { name: this.name });
    assert.strictEqual(r.status, 200, 'create failed ' + JSON.stringify(r.body));
    Object.assign(this, r.body);
  }
  async join(code) {
    const r = await post('/api/join', { code, name: this.name });
    assert.strictEqual(r.status, 200, 'join failed ' + JSON.stringify(r.body));
    Object.assign(this, r.body);
  }
  connect() {
    return new Promise((resolve) => {
      this.req = http.get(`${BASE}/api/events?code=${this.code}&token=${this.token}`, (res) => {
        this.res = res;
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
            if (ev[1] === 'chatlog') this.chat = data;
            if (ev[1] === 'chat') this.chat.push(data);
            if (ev[1] === 'fatal') this.fatal = data;
          }
        });
      });
      this._first = resolve;
    });
  }
  disconnect() { if (this.req) this.req.destroy(); }
  async act(type, extra) {
    const r = await post('/api/action', Object.assign({ code: this.code, token: this.token, type }, extra || {}));
    return r;
  }
  async ok(type, extra) {
    const r = await this.act(type, extra);
    assert.strictEqual(r.status, 200, `${this.name} ${type} -> ${JSON.stringify(r.body)}`);
    return r;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 4000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error('timeout waiting for: ' + label);
}

(async () => {
  const server = spawn('node', [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), MIN_PHASE_SEC: '1' }),
    stdio: ['ignore', 'inherit', 'inherit']
  });
  let failed = false;
  try {
    for (let i = 0; i < 40; i++) {
      try { await post('/healthz', {}); break; } catch (e) { await sleep(100); }
    }

    // --- ロビー ---
    const names = ['ホスト', 'アキ', 'ベル', 'シズ', 'タケ'];
    const cs = names.map((n) => new Client(n));
    await cs[0].create();
    assert.match(cs[0].code, /^[A-HJ-NP-Z2-9]{6}$/, 'room code format');
    await cs[0].connect();
    for (let i = 1; i < 5; i++) { await cs[i].join(cs[0].code); await cs[i].connect(); }
    await until(() => cs[0].state.players.length === 5, 'all joined');
    assert.strictEqual((await cs[0].act('start')).status, 400, 'start must fail before ready');
    assert.strictEqual((await post('/api/join', { code: cs[0].code, name: 'ホスト' })).status, 400, 'dup name rejected');
    assert.strictEqual((await post('/api/join', { code: cs[0].code, name: 'ろく' })).status, 400, 'room full');
    assert.strictEqual((await cs[1].act('start')).status, 400, 'non-host cannot start');
    assert.strictEqual((await cs[1].act('settings', { durations: { vote: 5 } })).status, 400, 'non-host cannot edit settings');
    await cs[0].ok('settings', { durations: { discussion: 2, vote: 2 } });
    await until(() => cs[3].state.settings.durations.discussion === 2, 'settings sync');
    for (let i = 1; i < 5; i++) await cs[i].ok('ready', { value: true });
    await until(() => cs[0].state.players.every((p) => p.ready), 'ready sync');

    // 再接続（ページ更新相当）: シズが切断→同じトークンで再接続
    cs[3].disconnect();
    await until(() => cs[0].state.players.find((p) => p.name === 'シズ').connected === false, 'disconnect shown');
    cs[3].raw = '';
    await cs[3].connect();
    await until(() => cs[0].state.players.find((p) => p.name === 'シズ').connected === true, 'reconnect shown');

    await cs[0].ok('start');
    await until(() => cs.every((c) => c.state.phase === 'character'), 'character phase');

    // --- キャラクター割り当て ---
    const chars = cs.map((c) => c.state.me.charId);
    assert.strictEqual(new Set(chars).size, 5, 'unique characters');
    const culpritClient = cs.find((c) => c.state.me.charId === scenario.culpritId);
    assert(culpritClient, 'culprit assigned to a human');
    for (const c of cs) {
      assert(c.state.sheet && c.state.sheet.name, 'sheet present');
      assert.strictEqual(c.state.sheet.secret, undefined, 'secret hidden during character phase');
    }

    // --- 秘密漏洩チェック用: 各キャラの秘密文・秘密手がかり ---
    const secretsOf = (cid) => {
      const ch = scenario.characters.find((x) => x.id === cid);
      return [ch.secret, ...ch.clues.filter((k) => k.secret).map((k) => k.text)];
    };
    const mine = (c) => c.state.me.charId;
    function assertNoLeak(label) {
      for (const c of cs) {
        for (const other of scenario.characters) {
          if (other.id === mine(c)) continue;
          for (const s of secretsOf(other.id)) {
            const frag = s.slice(0, 18);
            assert(!c.raw.includes(JSON.stringify(frag).slice(1, -1)), `LEAK(${label}): ${c.name} received secret of ${other.id}: ${frag}`);
          }
          // 公開済みの手がかりなら届いてよいが、未公開の個人手がかりは届いてはいけない
          for (const k of other.clues) {
            const published = c.state.publicClues.some((p) => p.id === k.id);
            if (published) continue;
            const frag = JSON.stringify(k.text.slice(0, 20)).slice(1, -1);
            assert(!c.raw.includes(frag), `LEAK(${label}): ${c.name} received unpublished clue ${k.id}`);
          }
        }
        // 犯人の識別子・犯人専用メモが非犯人に届いていない
        if (mine(c) !== scenario.culpritId) {
          assert(!c.raw.includes('あなたは嘘をついても構いません'), `LEAK(${label}): culprit note`);
          assert(!c.raw.includes('"culpritId"'), `LEAK(${label}): culpritId before result`);
        }
      }
    }
    assertNoLeak('character');

    // --- 進行: skip で次へ ---
    await Promise.all(cs.map((c) => c.ok('skip')));
    await until(() => cs.every((c) => c.state.phase === 'opening'), 'opening');
    assert(cs[0].state.intro && cs[0].state.intro.paragraphs.length > 3, 'intro visible');
    assert(cs[0].state.publicClues.some((p) => p.id === 'pub_body'), 'body clue public');
    await Promise.all(cs.map((c) => c.ok('skip')));
    await until(() => cs.every((c) => c.state.phase === 'personal'), 'personal');
    for (const c of cs) {
      assert(c.state.sheet.secret && c.state.sheet.goals.length >= 2, 'secret visible to owner in personal phase');
      assert.strictEqual(!!c.state.sheet.isCulprit, c.name === culpritClient.name, 'culprit flag only for culprit');
    }
    assertNoLeak('personal');
    await Promise.all(cs.map((c) => c.ok('skip')));
    await until(() => cs.every((c) => c.state.phase === 'info'), 'info');
    assert(cs[0].state.publicClues.length >= 5, 'info evidence revealed');

    // 調査（1人2回まで）と公開
    const [a, b] = cs;
    await a.ok('investigate', { placeId: 'hall' });
    await a.ok('investigate', { placeId: 'pantry' });
    assert.strictEqual((await a.act('investigate', { placeId: 'shed' })).status, 400, 'investigation cap');
    assert.strictEqual((await a.act('investigate', { placeId: 'hall' })).status, 400, 'no repeat');
    await until(() => a.state.hand.some((h) => h.id === 'loc_hall'), 'hand updated');
    assert(!b.state.hand.some((h) => h.id === 'loc_hall'), 'others do not see my hand');
    await a.ok('publish', { clueId: 'loc_pantry' });
    await until(() => b.state.publicClues.some((p) => p.id === 'loc_pantry'), 'publish synced');
    assert.strictEqual((await b.act('publish', { clueId: 'loc_pantry' })).status, 400, 'cannot publish what you do not hold');
    // 犯人が自分の手がかりを公開しても、犯人用の助言(hint)は公開側に出ない
    await culpritClient.ok('publish', { clueId: 'akari_runner' });
    await until(() => b.state.publicClues.some((p) => p.id === 'akari_runner'), 'culprit clue public');
    assert(!JSON.stringify(b.state.publicClues).includes('事実です'), 'culprit hint must not be public');
    assert(!JSON.stringify(b.state.publicClues).includes('hint'), 'no hint field in public clues');
    assertNoLeak('info');

    await Promise.all(cs.map((c) => c.ok('skip')));
    await until(() => cs.every((c) => c.state.phase === 'discussion'), 'discussion');

    // --- チャット ---
    await cs[1].ok('chat', { text: '<b>こんにちは</b>' });
    await until(() => cs[2].chat.some((m) => m.type === 'chat' && m.name === 'アキ'), 'chat delivered');
    assert.strictEqual((await cs[1].act('chat', { text: 'x'.repeat(301) })).status, 400, 'long chat rejected');

    // --- 退出 → NPC ---
    const leaver = cs.find((c) => c !== culpritClient && c !== cs[0] && c !== cs[1]);
    await leaver.ok('leave');
    await until(() => cs[0].chat.some((m) => m.type === 'system' && m.text.includes(leaver.name + 'が退出しました')), 'leave message');
    await until(() => cs[0].state.players.find((p) => p.name === leaver.name).npc === true, 'leaver is npc');
    assert.strictEqual((await leaver.act('chat', { text: 'hi' })).status, 401, 'left player session invalid');

    const active = cs.filter((c) => c !== leaver);

    // タイマー自動進行 (discussion 2秒)
    await until(() => active.every((c) => c.state.phase === 'extra'), 'timer advanced discussion->extra', 6000);
    const remainingOk = active[0].state.phaseEndsAt > active[0].state.serverTime - 1000;
    assert(remainingOk, 'phaseEndsAt is server-provided');
    assert(active[0].state.publicClues.some((p) => p.id === 'pub_vial'), 'extra evidence revealed');
    await Promise.all(active.map((c) => c.ok('skip')));
    await until(() => active.every((c) => c.state.phase === 'final'), 'final');
    assertNoLeak('final');
    await Promise.all(active.map((c) => c.ok('skip')));
    await until(() => active.every((c) => c.state.phase === 'vote'), 'vote');

    // --- 投票 ---
    for (const c of active) assert.strictEqual(c.state.me.vote, null);
    const target = (c, id) => c.ok('vote', { charId: id });
    assert.strictEqual((await active[0].act('vote', { charId: active[0].state.me.charId })).status, 400, 'cannot vote self');
    // 犯人以外の全員が犯人に投票。犯人は誰か別の人へ。最後の1票の前に「結果・他人の票が見えない」ことを確認する。
    const castVote = (c) => {
      if (c === culpritClient) {
        const other = active.find((x) => x !== c);
        return target(c, other.state.me.charId);
      }
      return target(c, scenario.culpritId);
    };
    for (const c of active.slice(0, -1)) await castVote(c);
    await until(() => active.every((c) => c.state.votesCast === active.length - 1), 'votes counted');
    for (const c of active) {
      assert.strictEqual(c.state.phase, 'vote');
      assert(!c.state.result, 'result hidden during vote');
      assert(!('votes' in c.state), 'votes map not sent');
      assert(!c.raw.includes('"voterChar"'), 'vote details not sent before result');
    }
    await castVote(active[active.length - 1]);
    await until(() => active.every((c) => c.state.phase === 'result'), 'result (all voted)');
    const res = active[0].state.result;
    assert.strictEqual(res.culpritId, scenario.culpritId);
    assert.strictEqual(res.caught, true, 'culprit caught');
    assert.strictEqual(res.votes.length, 4);
    assert.strictEqual(res.characters.length, 5);
    assert(res.characters.every((c) => c.ending && c.ending.length > 10), 'endings present');
    assert(res.truth.steps.length > 3, 'truth present');

    // --- ロビーへ戻る → もう一度 ---
    await active[1].ok('again');
    await until(() => active.every((c) => c.state.phase === 'lobby'), 'back to lobby');
    assert.strictEqual(active[0].state.players.length, 4, 'NPC removed after reset');
    assert.strictEqual(active[0].state.publicClues.length, 0, 'public clues reset');
    console.log('\n✅ すべてのテストに成功しました');
  } catch (e) {
    failed = true;
    console.error('\n❌ テスト失敗:', e.message);
    console.error(e.stack);
  } finally {
    server.kill();
    setTimeout(() => process.exit(failed ? 1 : 0), 200);
  }
})();
