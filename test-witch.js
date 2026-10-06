'use strict';
/**
 * 新機能のテスト: シナリオ選択 / 4人版 / 5人版 / 密談（第三者に漏れないこと）/ 推理の公平性
 *   node test-witch.js
 */
const assert = require('assert');
const { sleep, until, Client, startServer, stopServer, post } = require('./test-helpers');
const witch = require('./scenario-witch');

const PORT = 4100 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------
//  静的チェック: シナリオの作りが仕様どおりか / 推理が公平か
// ---------------------------------------------------------------
function staticChecks() {
  for (const n of [4, 5]) {
    const sc = witch.resolve(n);
    const tag = `${n}人版`;
    assert.strictEqual(sc.characters.length, n, `${tag}: キャラ数`);
    assert(sc.characters.some((c) => c.id === sc.culpritId), `${tag}: 犯人がキャラの中にいる`);
    const types = new Set();
    for (const c of sc.characters) {
      assert(/^[ァ-ヶー]+$/.test(c.name), `${tag}: 名前がカタカナ ${c.name}`);
      for (const f of ['age', 'personality', 'publicProfile', 'witchRelation', 'secret', 'suspicious']) assert(c[f], `${tag}: ${c.name}.${f}`);
      assert(c.goals.length >= 2, `${tag}: ${c.name} goals`);
      assert(c.clues.length >= 3, `${tag}: ${c.name} 知っている情報 >= 3`);
      assert.strictEqual(Object.keys(c.relationships).length, n - 1, `${tag}: ${c.name} 他キャラとの関係が全員分ある`);
      for (const k of Object.keys(c.relationships)) assert(sc.characters.some((x) => x.id === k), `${tag}: relationship target ${k}`);
      assert(c.endings && Object.keys(c.endings).length >= 2, `${tag}: ${c.name} endings`);
      if (c.id !== sc.culpritId) {
        assert(c.clues.some((k) => k.secret), `${tag}: 犯人以外の${c.name}も秘密を持つ`);
        for (const e of ['victory', 'costly', 'unsolved']) assert(c.endings[e], `${tag}: ${c.name}.endings.${e}`);
      } else {
        for (const label of ['【動機】', '【方法】', '【時間】', '【アリバイ】', '【偽証', '【隠している情報】', '【勝利条件】']) assert(c.culpritNote.includes(label), `${tag}: 犯人メモに${label}`);
        assert(c.endings.caught && c.endings.escaped);
      }
      c.goals.forEach((g) => types.add(g.type));
    }
    for (const t of ['vote_culprit', 'secret_hidden', 'escape']) assert(types.has(t), `${tag}: 目標の種類 ${t}`);
    assert(types.has('caught') || types.has('caught_clue'), `${tag}: 遺産を取り戻す系の目標`);
    // 公平性: 犯人特定に必要な各事実を、2か所以上（公開証拠/場所/別々の人）が裏付ける
    const sysIds = new Set(Object.values(sc.systemClues).flat().map((k) => k.id));
    const placeIds = new Set(sc.places.map((p) => p.clue.id));
    const holder = (id) => {
      if (sysIds.has(id)) return 'public';
      if (placeIds.has(id)) return 'place:' + id;
      const ch = sc.characters.find((c) => c.clues.some((k) => k.id === id));
      assert(ch, `${tag}: critical source ${id} exists`);
      return 'char:' + ch.id;
    };
    for (const f of sc.critical) {
      const hs = new Set(f.sources.map(holder));
      const isPublic = hs.has('public');
      assert(isPublic || hs.size >= 2, `${tag}: 事実「${f.fact}」は1人しか知らない`);
      for (const id of f.sources) assert(!sc.clueMap[id].secret, `${tag}: 決め手 ${id} は自白(秘密)に頼っていない`);
    }
    // 場所の手がかり・公開証拠のIDが重複しない
    const ids = Object.keys(sc.clueMap);
    assert(ids.length >= 20, `${tag}: 証拠が十分ある (${ids.length})`);
  }
  console.log('  ✓ シナリオ構造・推理の公平性チェック');
}

// ---------------------------------------------------------------
//  ゲームの流れ（4人 / 5人）
// ---------------------------------------------------------------
async function setup(n, names) {
  const cs = names.slice(0, n).map((nm) => new Client(BASE, nm));
  await cs[0].create();
  await cs[0].connect();
  // ホスト以外はシナリオを変えられない
  await cs[0].ok('scenario', { scenarioId: 'midnight-mansion' });
  await cs[0].bad('scenario', { scenarioId: 'nope' }, 'unknown scenario');
  await cs[0].ok('scenario', { scenarioId: 'witch-heritage' });
  for (let i = 1; i < n; i++) {
    await cs[i].join(cs[0].code);
    await cs[i].connect();
    await cs[i].bad('scenario', { scenarioId: 'midnight-mansion' }, 'non-host scenario');
  }
  await until(() => cs.every((c) => c.state.scenarioId === 'witch-heritage' && c.state.players.length === n), 'scenario synced');
  assert.strictEqual(cs[n - 1].state.scenario.title, '消えた魔女の遺産');
  assert(cs[1].state.catalog.length >= 2, 'catalog sent');
  return cs;
}
const skipAll = (cs) => Promise.all(cs.map((c) => c.ok('skip')));
async function toPhase(cs, phase) {
  const act = cs.filter((c) => !c.fatal);
  for (let i = 0; i < 12 && !act.every((c) => c.state.phase === phase); i++) {
    const cur = act[0].state.phase;
    await skipAll(act);
    await until(() => act.every((c) => c.state.phase !== cur), `leave ${cur}`);
  }
  await until(() => act.every((c) => c.state.phase === phase), 'phase ' + phase);
}

function assertNoLeak(cs, sc, label) {
  for (const c of cs) {
    const me = c.state.me.charId;
    for (const other of sc.characters) {
      if (other.id === me) continue;
      for (const k of other.clues) {
        const published = c.state.publicClues.some((p) => p.id === k.id);
        if (published) continue;
        const frag = JSON.stringify(k.text.slice(0, 22)).slice(1, -1);
        assert(!c.raw.includes(frag), `LEAK(${label}): ${c.name}(${me}) received unpublished clue ${k.id}`);
      }
      assert(!c.raw.includes(JSON.stringify(other.secret.slice(0, 18)).slice(1, -1)), `LEAK(${label}): ${c.name} got secret of ${other.id}`);
    }
    if (me !== sc.culpritId) {
      assert(!c.raw.includes('あなたは嘘をついても構いません'), `LEAK(${label}): culprit note`);
      assert(!c.raw.includes('"culpritId"'), `LEAK(${label}): culpritId before result`);
    }
  }
}

async function runGame(n) {
  console.log(`\n▶ ${n}人プレイ`);
  const names = ['ホスト', 'アキ', 'ベル', 'シズ', 'タケ'];
  const cs = await setup(n, names);
  const code = cs[0].code;
  const sc = witch.resolve(n);

  // 人数不足なら開始できない（4人用なので3人では不可）
  if (n === 4) {
    const tmp = [cs[0], cs[1], cs[2]];
    // 4人目がまだ準備していない状態でも、準備完了前は開始できない
    assert.strictEqual((await cs[0].act('start')).status, 400, 'start before ready fails');
  }
  for (let i = 1; i < n; i++) await cs[i].ok('ready', { value: true });
  await until(() => cs[0].state.players.every((p) => p.ready), 'ready');
  await cs[0].ok('settings', { durations: { discussion: 600 } });
  await cs[0].ok('start');
  await until(() => cs.every((c) => c.state.phase === 'opening'), 'opening');
  console.log('  ✓ 部屋作成・参加・準備・開始・シナリオ選択の同期');

  // 開始後はシナリオを変えられない
  assert.strictEqual((await cs[0].act('scenario', { scenarioId: 'midnight-mansion' })).status, 400, 'no scenario change after start');
  // 人数に応じた版
  assert.strictEqual(cs[0].state.scenario.variant, `${n}人用`, 'variant');
  assert.strictEqual(cs[0].state.phaseLabel, 'オープニング');
  assert.strictEqual(cs[0].state.characters.length, n, 'character count');
  assert.strictEqual(new Set(cs.map((c) => c.state.me.charId)).size, n, 'unique chars');
  const culpritClient = cs.find((c) => c.state.me.charId === sc.culpritId);
  assert(culpritClient, 'culprit is human');
  for (const c of cs) assert(!c.state.sheet, 'sheet hidden during opening');
  assert(cs[0].state.intro.paragraphs[3].includes(`${n}人`), 'intro mentions headcount');
  console.log(`  ✓ ${n}人用シナリオを読み込み（${sc.characters.map((c) => c.name).join('・')}）`);

  await skipAll(cs);
  await until(() => cs.every((c) => c.state.phase === 'character'), 'character');
  assert.strictEqual(cs[0].state.phaseLabel, 'キャラクター確認');
  for (const c of cs) {
    assert(c.state.sheet.secret && c.state.sheet.goals.length >= 2 && c.state.sheet.suspicious, 'own secret visible');
    assert(c.state.hand.length >= 3, 'known info visible');
    assert.strictEqual(!!c.state.sheet.isCulprit, c === culpritClient, 'culprit flag only for culprit');
  }
  assert(culpritClient.state.sheet.culpritNote.includes('【勝利条件】'), 'culprit sheet');
  assertNoLeak(cs, sc, 'character');
  console.log('  ✓ 秘密情報の分離（本人にだけ届く）');

  await skipAll(cs);
  await until(() => cs.every((c) => c.state.phase === 'info'), 'info');
  assert.strictEqual(cs[0].state.phaseLabel, '第一調査');
  assert(cs[0].state.publicClues.length >= 4, 'first evidence is public');

  // --- 調査・公開（既存機能） ---
  const noel = cs.find((c) => c.state.me.charId === 'noel');
  const marg = cs.find((c) => c.state.me.charId === 'marg');
  await marg.ok('investigate', { placeId: 'woodshed' });
  await until(() => marg.state.hand.some((h) => h.id === (n === 4 ? 'loc_woodshed' : 'loc_woodshed5')), 'investigated');

  // --- 密談は議論フェーズ以外では使えない ---
  await cs[0].bad('sc_request', { toId: cs[1].playerId }, 'secret chat in info phase');

  await skipAll(cs);
  await until(() => cs.every((c) => c.state.phase === 'discussion'), 'discussion');
  assert.strictEqual(cs[0].state.phaseLabel, '第一議論');
  assert(cs[0].state.secretChat.enabled, 'secret chat enabled in discussion');

  // --- 通常チャット ---
  await cs[1].ok('chat', { text: '全体チャットのテストです' });
  await until(() => cs.every((c) => c.chat.some((m) => m.text === '全体チャットのテストです')), 'public chat');
  console.log('  ✓ 全体チャット');

  // --- 密談 ---
  const [A, B, C, D] = [cs[0], cs[1], cs[2], cs[3]];
  const others = cs.filter((c) => c !== A && c !== B);
  const T1 = 'SECRET-ALPHA-4821';
  const T2 = 'SECRET-BRAVO-9937';
  await A.bad('sc_request', { toId: A.playerId }, 'self request');
  await A.bad('sc_request', { toId: 'zzzz' }, 'unknown target');
  await A.ok('sc_request', { toId: B.playerId });
  await until(() => Object.values(B.sc).some((m) => m.status === 'pending' && !m.mine), 'B sees request');
  const chat1 = Object.values(B.sc).find((m) => m.status === 'pending').id;
  assert.strictEqual(B.sc[chat1].other.name, A.name, 'request shows requester name');
  await until(() => A.state.secretChat.chats.length === 1 && B.state.secretChat.chats.length === 1, 'meta in state');
  for (const c of others) {
    assert.strictEqual(c.state.secretChat.chats.length, 0, 'third party has no chat meta');
    assert(!c.raw.includes('sc_meta') && !c.raw.includes(chat1), 'third party got no request');
  }
  await A.bad('sc_request', { toId: C.playerId }, 'second outgoing request');
  await C.bad('sc_respond', { chatId: chat1, accept: true }, 'third party cannot accept');
  await A.bad('sc_respond', { chatId: chat1, accept: true }, 'requester cannot accept own request');
  await C.bad('sc_send', { chatId: chat1, text: 'こっそり' }, 'third party cannot send');
  await A.bad('sc_send', { chatId: chat1, text: 'まだ許可前' }, 'cannot send before accept');
  await B.ok('sc_respond', { chatId: chat1, accept: true });
  await until(() => A.sc[chat1] && A.sc[chat1].status === 'active' && B.sc[chat1].status === 'active', 'active');
  await A.ok('sc_send', { chatId: chat1, text: T1 });
  await sleep(450);
  await B.ok('sc_send', { chatId: chat1, text: T2 });
  await until(() => (A.scMsgs[chat1] || []).length >= 2 && (B.scMsgs[chat1] || []).length >= 2, 'both received');
  assert(A.scMsgs[chat1].some((m) => m.text === T2) && B.scMsgs[chat1].some((m) => m.text === T1), 'A and B exchange messages');
  // 第三者にはメッセージも存在も届かない（サーバーが送っていない）
  await sleep(300);
  for (const c of others) {
    for (const t of [T1, T2, chat1, 'sc_msg']) assert(!c.raw.includes(t), `LEAK: third party ${c.name} received ${t}`);
    assert(!c.chat.some((m) => (m.text || '').includes('SECRET')), 'not in public chat');
    assert.strictEqual(Object.keys(c.scMsgs).length, 0, 'no secret logs for third party');
  }
  assert(!A.chat.some((m) => (m.text || '').includes('SECRET')) && !B.chat.some((m) => (m.text || '').includes('SECRET')), 'not mixed into public chat');
  console.log('  ✓ 密談申請→許可→密談チャット（第三者のブラウザには何も届かない）');

  // 同時に参加できる密談は1人1組
  await A.bad('sc_request', { toId: C.playerId }, 'A is busy');
  await C.bad('sc_request', { toId: A.playerId }, 'target is busy');
  await C.bad('sc_request', { toId: B.playerId }, 'target B is busy');
  if (n >= 4) {
    // 別の2人は並行して密談できる（A・Bの内容は引き続き漏れない）
    const T3 = 'SECRET-CHARLIE-1177';
    await C.ok('sc_request', { toId: D.playerId });
    await until(() => Object.values(D.sc).some((m) => m.status === 'pending'), 'D sees request');
    const chat2 = Object.values(D.sc).find((m) => m.status === 'pending').id;
    await D.ok('sc_respond', { chatId: chat2, accept: true });
    await until(() => C.sc[chat2] && C.sc[chat2].status === 'active', 'C-D active');
    await C.ok('sc_send', { chatId: chat2, text: T3 });
    await until(() => (D.scMsgs[chat2] || []).length === 1, 'D got C message');
    await sleep(200);
    for (const c of [A, B]) assert(!c.raw.includes(T3) && !c.raw.includes(chat2), `LEAK: ${c.name} saw C-D chat`);
    for (const c of [C, D]) assert(!c.raw.includes(T1) && !c.raw.includes(T2), `LEAK: ${c.name} saw A-B chat`);
    if (n === 5) assert(!cs[4].raw.includes(T3) && !cs[4].raw.includes(T1), 'fifth player sees neither');
    await C.ok('sc_end', { chatId: chat2 });
    await until(() => D.sc[chat2].status === 'ended', 'C-D ended');
    await D.bad('sc_send', { chatId: chat2, text: '終了後' }, 'send after end');
    // 拒否のフロー
    await C.ok('sc_request', { toId: D.playerId });
    await until(() => Object.values(D.sc).some((m) => m.status === 'pending'), 'second request');
    const chat3 = Object.values(D.sc).find((m) => m.status === 'pending').id;
    await D.ok('sc_respond', { chatId: chat3, accept: false });
    await until(() => C.sc[chat3].status === 'declined', 'declined');
    // 取り消しのフロー
    await C.ok('sc_request', { toId: D.playerId });
    await until(() => Object.values(C.sc).some((m) => m.status === 'pending' && m.mine), 'pending mine');
    const chat4 = Object.values(C.sc).find((m) => m.status === 'pending' && m.mine).id;
    await C.ok('sc_cancel', { chatId: chat4 });
    await until(() => C.sc[chat4].status === 'cancelled' && D.sc[chat4].status === 'cancelled', 'cancelled');
  }
  console.log('  ✓ 1人1組・並行密談・拒否・取り消し・密談終了');

  // 再接続すると、自分の密談の履歴だけが戻る
  B.disconnect();
  await sleep(200);
  await B.connect();
  await until(() => (B.scMsgs[chat1] || []).length === 2, 'B restored secret log');
  assert(!JSON.stringify(B.scMsgs).includes('CHARLIE'), 'B never had C-D log');

  // フェーズが議論でなくなったら密談は自動終了
  await skipAll(cs);
  await until(() => cs.every((c) => c.state.phase === 'extra'), 'extra');
  assert.strictEqual(cs[0].state.phaseLabel, '第二調査');
  await until(() => A.sc[chat1].status === 'ended' && B.sc[chat1].status === 'ended', 'auto-ended');
  await A.bad('sc_send', { chatId: chat1, text: 'x' }, 'send after phase end');
  await C.bad('sc_request', { toId: D.playerId }, 'request in extra phase');
  console.log('  ✓ 議論フェーズ以外では密談できない（自動終了）');

  // --- 第二調査 → 証拠公開 ---
  assert(cs[0].state.publicClues.some((p) => p.id === (n === 4 ? 'pub_stairs' : 'pub_ring5')), 'new evidence revealed in 2nd investigation');
  await skipAll(cs);
  await until(() => cs.every((c) => c.state.phase === 'discussion2'), 'discussion2');
  assert.strictEqual(cs[0].state.phaseLabel, '第二議論');
  assert(cs[0].state.secretChat.enabled);

  // 5人版: 途中退出（密談中の相手に通知・NPC化・公開可能な情報の自動公開）
  let leaver = null;
  if (n === 5) {
    leaver = cs.find((c) => c !== culpritClient && c !== cs[0] && c !== noel && c !== marg);
    const buddy = cs.find((c) => c !== leaver && c !== cs[0]);
    await leaver.ok('sc_request', { toId: buddy.playerId });
    await until(() => Object.values(buddy.sc).some((m) => m.status === 'pending' && m.other.id === leaver.playerId), 'req to buddy');
    const cid = Object.values(buddy.sc).find((m) => m.status === 'pending' && m.other.id === leaver.playerId).id;
    await buddy.ok('sc_respond', { chatId: cid, accept: true });
    await until(() => buddy.sc[cid].status === 'active', 'buddy active');
    const leaverChar = leaver.state.me.charId;
    await leaver.ok('leave');
    await until(() => buddy.sc[cid].status === 'ended', 'secret chat ended by leave');
    await until(() => cs[0].state.players.find((p) => p.id === leaver.playerId).npc, 'npc');
    await until(() => cs[0].chat.some((m) => m.type === 'system' && m.text.includes(`${leaver.name}が退出しました`)), 'leave msg');
    const lc = sc.characters.find((c) => c.id === leaverChar);
    for (const k of lc.clues.filter((x) => !x.secret)) assert(cs[0].state.publicClues.some((p) => p.id === k.id), `NPC clue ${k.id} auto-published`);
    for (const k of lc.clues.filter((x) => x.secret)) assert(!cs[0].state.publicClues.some((p) => p.id === k.id), 'NPC secret stays secret');
    console.log('  ✓ 途中退出（NPC化・密談終了・公開できる情報の自動公開）');
  }
  const active = cs.filter((c) => c !== leaver);

  // 秘密の暴露がゴール判定に反映される（マルグリットの遺品持ち出し）
  if (n === 4) {
    await marg.ok('publish', { clueId: 'loc_woodshed' });
    await until(() => cs[0].state.publicClues.some((p) => p.id === 'loc_woodshed'), 'woodshed public');
  }
  await skipAll(active);
  await until(() => active.every((c) => c.state.phase === 'final'), 'final');
  assert.strictEqual(active[0].state.phaseLabel, '最終議論');
  assertNoLeak(active, sc, 'final');
  // ノエルは遺産の三分の一のため、孫である証拠を公開する
  await noel.ok('publish', { clueId: 'n_proof' });
  await skipAll(active);
  await until(() => active.every((c) => c.state.phase === 'vote'), 'vote');
  console.log('  ✓ フェーズ移行（オープニング→確認→第一調査→第一議論→第二調査→第二議論→最終議論→投票）');

  // --- 投票 ---
  await active[0].bad('vote', { charId: active[0].state.me.charId }, 'self vote');
  const castVote = (c) => {
    if (c === culpritClient) {
      const other = active.find((x) => x !== c);
      return c.ok('vote', { charId: other.state.me.charId });
    }
    return c.ok('vote', { charId: sc.culpritId });
  };
  for (const c of active.slice(0, -1)) await castVote(c);
  await until(() => active.every((c) => c.state.votesCast === active.length - 1), 'votes counted');
  for (const c of active) {
    assert(!c.state.result && !c.raw.includes('"voterChar"'), 'votes hidden until the end');
  }
  await castVote(active[active.length - 1]);
  await until(() => active.every((c) => c.state.phase === 'result'), 'result');
  const R = active[0].state.result;
  assert.strictEqual(R.culpritId, sc.culpritId);
  assert.strictEqual(R.scenarioTitle, '消えた魔女の遺産');
  assert.strictEqual(R.caught, true, 'culprit caught');
  assert.strictEqual(R.characters.length, n);
  assert(R.truth.steps.length >= 5 && R.truth.motive, 'truth');
  assert(R.characters.every((c) => c.ending && c.ending.length > 20 && c.goals.length >= 2), 'endings + goals for all');
  const rc = (id) => R.characters.find((c) => c.id === id);
  assert.strictEqual(rc(sc.culpritId).endingKey, 'caught');
  const nr = rc('noel');
  assert(nr.goals.find((g) => g.type === 'caught_clue').achieved, 'noel claim goal achieved after publishing proof');
  if (n === 4) {
    assert.strictEqual(rc('marg').goals.find((g) => g.type === 'secret_hidden').achieved, false, 'exposed secret detected');
    assert.strictEqual(rc('marg').endingKey, 'costly');
    assert.strictEqual(rc('elvin').goals.find((g) => g.type === 'secret_hidden').achieved, true, 'unexposed secret kept');
    assert.strictEqual(rc('elvin').endingKey, 'victory');
  }
  assert.strictEqual(rc('noel').endingKey, 'victory');
  console.log('  ✓ 投票・結果発表・真相・個人目標の判定・個人エンディング');

  // もう一度（ロビーに戻る）
  await active[1].ok('again');
  await until(() => active.every((c) => c.state.phase === 'lobby'), 'lobby again');
  assert.strictEqual(active[0].state.secretChat.chats.length, 0, 'secret chats cleared');
  for (const c of cs) c.disconnect();
}

(async () => {
  let failed = false;
  try {
    console.log('▶ 静的チェック');
    staticChecks();
    await startServer(PORT);
    // 3人では「消えた魔女の遺産」は始められない
    {
      const hs = [new Client(BASE, 'ホスト'), new Client(BASE, 'アキ'), new Client(BASE, 'ベル')];
      await hs[0].create(); await hs[0].connect();
      await hs[0].ok('scenario', { scenarioId: 'witch-heritage' });
      for (const h of hs.slice(1)) { await h.join(hs[0].code); await h.connect(); await h.ok('ready', { value: true }); }
      await until(() => hs[0].state.players.every((p) => p.ready), 'ready3');
      const r = await hs[0].act('start');
      assert.strictEqual(r.status, 400, '3 players cannot start a 4-5 player scenario');
      // 既存シナリオなら3人でも始められる（既存機能の維持）
      await hs[0].ok('scenario', { scenarioId: 'midnight-mansion' });
      await hs[0].ok('start');
      await until(() => hs.every((h) => h.state.phase === 'character'), 'midnight still works');
      assert.strictEqual(hs[0].state.scenario.title, '深夜0時の館');
      hs.forEach((h) => h.disconnect());
      console.log('\n  ✓ 人数不足の検証・既存シナリオの維持');
    }
    await runGame(4);
    await runGame(5);
    console.log('\n✅ 新機能のテストにすべて成功しました');
  } catch (e) {
    failed = true;
    console.error('\n❌ テスト失敗:', e.message);
    console.error(e.stack);
  } finally {
    stopServer();
    setTimeout(() => process.exit(failed ? 1 : 0), 200);
  }
})();
