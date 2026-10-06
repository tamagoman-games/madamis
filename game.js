'use strict';
/**
 * ゲームエンジン（部屋・フェーズ・タイマー・投票・結果）
 *
 * 重要: 秘密情報は room（サーバーのメモリ）の中にだけ存在します。
 * クライアントへは viewFor(room, player) が作った「その人が見てよい分」だけを送ります。
 *
 * GMモードへの拡張ポイント:
 *   room.mode === 'auto' のときはタイマーでフェーズが自動進行します。
 *   room.mode === 'gm' を追加すると、tickRoom() の自動進行が止まり、
 *   handleAction() の 'gm_advance' だけがフェーズを進めます（下のコメント参照）。
 */

const crypto = require('crypto');
const scenario = require('./scenario');

const PHASES = ['lobby', 'character', 'opening', 'personal', 'info', 'discussion', 'extra', 'final', 'vote', 'result'];
const PHASE_LABEL = {
  lobby: 'ロビー',
  character: 'キャラクター決定',
  opening: 'オープニング',
  personal: '個人情報確認',
  info: '情報公開',
  discussion: '議論',
  extra: '追加情報',
  final: '最終議論',
  vote: '投票',
  result: '結果発表'
};
const DEFAULT_DURATIONS = {
  character: 60,
  opening: 60,
  personal: 180,
  info: 300,
  discussion: 600,
  extra: 180,
  final: 300,
  vote: 60
};
const MIN_SEC = Number(process.env.MIN_PHASE_SEC) || 10;
const MAX_SEC = 3600;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;
const ROOM_TTL_MS = (Number(process.env.ROOM_TTL_MIN) || 180) * 60 * 1000;
const LOBBY_GRACE_MS = (Number(process.env.LOBBY_GRACE_SEC) || 60) * 1000;
const INVESTIGATIONS_PER_PHASE = 2;
const CHAT_MAX = 500;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const PUBLISH_PHASES = ['info', 'discussion', 'extra', 'final'];
const INVESTIGATE_PHASES = ['info', 'extra'];
const SKIP_PHASES = ['character', 'opening', 'personal', 'info', 'discussion', 'extra', 'final'];

const rooms = new Map();

class UserError extends Error {}

// ---------- ユーティリティ ----------
function genCode() {
  for (let n = 0; n < 50; n++) {
    let s = '';
    for (let i = 0; i < 6; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(s)) return s;
  }
  throw new UserError('部屋コードを作れませんでした。もう一度お試しください。');
}
const genId = () => crypto.randomBytes(6).toString('hex');
const genToken = () => crypto.randomBytes(18).toString('hex');
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function cleanName(name) {
  const s = Array.from(String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f<>]/g, '').trim())
    .slice(0, 12)
    .join('')
    .trim();
  if (!s) throw new UserError('名前を入力してください（12文字まで）。');
  return s;
}
function normCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}
const charById = (id) => scenario.characters.find((c) => c.id === id);
const phaseIdx = (p) => PHASES.indexOf(p);

// ---------- 送信 ----------
function send(player, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of player.conns) {
    try {
      res.write(payload);
    } catch (e) {
      /* 切断済み。close イベントで掃除される */
    }
  }
}
function broadcastState(room) {
  for (const p of room.players.values()) if (p.conns.size) send(p, 'state', viewFor(room, p));
}
function broadcastChatLog(room) {
  for (const p of room.players.values()) if (p.conns.size) send(p, 'chatlog', room.chat);
}
function pushChat(room, msg) {
  msg.id = ++room.chatSeq;
  msg.t = Date.now();
  room.chat.push(msg);
  if (room.chat.length > CHAT_MAX) room.chat.splice(0, room.chat.length - CHAT_MAX);
  for (const p of room.players.values()) if (p.conns.size) send(p, 'chat', msg);
}
const systemMsg = (room, text) => pushChat(room, { type: 'system', text });

// ---------- 部屋・プレイヤー ----------
function newPlayer(name) {
  return {
    id: genId(),
    token: genToken(),
    name,
    ready: false,
    connected: false,
    npc: false,
    left: false,
    charId: null,
    hand: [], // [{id, source}]
    used: { info: 0, extra: 0 },
    investigated: new Set(),
    conns: new Set(),
    disconnectedAt: Date.now(),
    lastChatAt: 0,
    actionTimes: []
  };
}

function createRoom(name) {
  if (rooms.size >= MAX_ROOMS) throw new UserError('現在、部屋が混み合っています。しばらくしてからお試しください。');
  const player = newPlayer(cleanName(name));
  const room = {
    code: genCode(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
    mode: 'auto',
    scenarioId: scenario.id,
    hostId: player.id,
    settings: { durations: Object.assign({}, DEFAULT_DURATIONS) },
    phase: 'lobby',
    phaseStartedAt: Date.now(),
    phaseEndsAt: null,
    players: new Map([[player.id, player]]),
    assign: null, // { charId: playerId|null }
    publicClues: [],
    votes: {}, // playerId -> charId
    skip: new Set(),
    result: null,
    chat: [],
    chatSeq: 0
  };
  player.ready = true;
  rooms.set(room.code, room);
  return { room, player };
}

function joinRoom(code, name) {
  const room = rooms.get(normCode(code));
  if (!room) throw new UserError('その部屋コードの部屋は見つかりませんでした。');
  if (room.phase !== 'lobby') throw new UserError('その部屋は、すでにゲームが始まっています。');
  const active = [...room.players.values()].filter((p) => !p.left);
  if (active.length >= scenario.maxPlayers) throw new UserError('この部屋は満員です。');
  const nm = cleanName(name);
  if (active.some((p) => p.name.toLowerCase() === nm.toLowerCase()))
    throw new UserError('その名前は、この部屋ですでに使われています。');
  const player = newPlayer(nm);
  room.players.set(player.id, player);
  room.lastActivity = Date.now();
  systemMsg(room, `${player.name}が参加しました`);
  broadcastState(room);
  return { room, player };
}

function auth(code, token) {
  const room = rooms.get(normCode(code));
  if (!room || !token) return null;
  for (const p of room.players.values()) if (p.token === token && !p.left) return { room, player: p };
  return null;
}

function attachConn(room, player, res) {
  player.conns.add(res);
  player.connected = true;
  player.disconnectedAt = null;
  room.lastActivity = Date.now();
  send(player, 'state', viewFor(room, player));
  send(player, 'chatlog', room.chat);
  broadcastState(room);
}
function detachConn(room, player, res) {
  player.conns.delete(res);
  if (room.players.get(player.id) !== player) return;
  if (player.conns.size === 0 && !player.left) {
    player.connected = false;
    player.disconnectedAt = Date.now();
    if (rooms.has(room.code)) {
      checkAutoAdvance(room);
      broadcastState(room);
    }
  }
}

function humans(room) {
  return [...room.players.values()].filter((p) => !p.npc && !p.left);
}
function reassignHost(room) {
  const cur = room.players.get(room.hostId);
  if (cur && !cur.left && !cur.npc) return;
  const list = humans(room);
  const next = list.find((p) => p.connected) || list[0];
  if (next) {
    room.hostId = next.id;
    if (room.phase === 'lobby') next.ready = true;
    systemMsg(room, `${next.name}が新しいホストになりました`);
  }
}

function closeConns(player, message) {
  send(player, 'fatal', { message });
  for (const res of player.conns) {
    try {
      res.end();
    } catch (e) {}
  }
  player.conns.clear();
}

function removeOrNpc(room, player) {
  const name = player.name;
  if (room.phase === 'lobby') {
    room.players.delete(player.id);
    closeConns(player, '部屋から退出しました。');
  } else {
    player.left = true;
    player.npc = true;
    player.connected = false;
    closeConns(player, '部屋から退出しました。');
    delete room.votes[player.id];
    room.skip.delete(player.id);
  }
  if (humans(room).length === 0) {
    rooms.delete(room.code);
    return;
  }
  systemMsg(room, `${name}が退出しました${room.phase !== 'lobby' && room.phase !== 'result' ? '（以降はNPCとして扱われます）' : ''}`);
  reassignHost(room);
  checkAutoAdvance(room);
  broadcastState(room);
}

// ---------- フェーズ進行 ----------
function publishClue(room, clue, meta) {
  if (room.publicClues.some((c) => c.id === clue.id)) return false;
  room.publicClues.push({
    id: clue.id,
    title: clue.title,
    text: clue.text,
    by: meta.by || null,
    byChar: meta.byChar || null,
    system: !!meta.system,
    phase: room.phase,
    at: Date.now()
  });
  return true;
}
function revealSystem(room, key) {
  const list = scenario.systemClues[key] || [];
  const added = list.filter((c) => publishClue(room, c, { system: true }));
  if (added.length) systemMsg(room, `新しい証拠が公開されました：${added.map((c) => `「${c.title}」`).join('、')}`);
}
function revealNpcClues(room) {
  for (const c of scenario.characters) {
    if (room.assign && room.assign[c.id] === null) {
      for (const k of c.clues.filter((x) => !x.secret)) {
        publishClue(room, k, { by: `${c.name}（NPC）`, byChar: c.name });
      }
    }
  }
}

function enterPhase(room, phase) {
  room.phase = phase;
  room.phaseStartedAt = Date.now();
  room.skip = new Set();
  const dur = room.settings.durations[phase];
  room.phaseEndsAt = dur ? Date.now() + dur * 1000 : null;
  if (phase === 'opening') revealSystem(room, 'opening');
  if (phase === 'info') {
    revealSystem(room, 'info');
    revealNpcClues(room);
  }
  if (phase === 'extra') revealSystem(room, 'extra');
  if (phase === 'result') room.result = computeResult(room);
  systemMsg(room, `【${PHASE_LABEL[phase]}】が始まりました`);
  broadcastState(room);
}
function nextPhase(room) {
  const i = phaseIdx(room.phase);
  if (i < 0 || i >= PHASES.length - 1) return;
  enterPhase(room, PHASES[i + 1]);
}

function connectedHumans(room) {
  return humans(room).filter((p) => p.connected);
}
function checkAutoAdvance(room) {
  if (room.mode !== 'auto') return;
  const ch = connectedHumans(room);
  if (!ch.length) return;
  if (SKIP_PHASES.includes(room.phase) && ch.every((p) => room.skip.has(p.id))) return nextPhase(room);
  if (room.phase === 'vote' && ch.every((p) => room.votes[p.id])) return nextPhase(room);
}

function tickRoom(room, now) {
  if (room.mode === 'auto' && room.phaseEndsAt && now >= room.phaseEndsAt) nextPhase(room);
  if (room.phase === 'lobby') {
    for (const p of [...room.players.values()]) {
      if (!p.connected && p.disconnectedAt && now - p.disconnectedAt > LOBBY_GRACE_MS && rooms.has(room.code)) {
        removeOrNpc(room, p);
      }
    }
  }
  if (rooms.has(room.code) && now - room.lastActivity > ROOM_TTL_MS && !connectedHumans(room).length) {
    rooms.delete(room.code);
  }
}
function startTimers() {
  const t = setInterval(() => {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      try {
        tickRoom(room, now);
      } catch (e) {
        console.error('tick error', e);
      }
    }
  }, 1000);
  t.unref();
  return t;
}

// ---------- ゲーム開始 ----------
function startGame(room) {
  const hs = humans(room);
  if (hs.length < scenario.minPlayers) throw new UserError(`ゲームを始めるには${scenario.minPlayers}人以上が必要です。`);
  const notReady = hs.filter((p) => p.id !== room.hostId && !p.ready);
  if (notReady.length) throw new UserError(`準備ができていません：${notReady.map((p) => p.name).join('、')}`);
  const culprit = charById(scenario.culpritId);
  const others = shuffle(scenario.characters.filter((c) => c.id !== culprit.id));
  const chosen = shuffle([culprit, ...others.slice(0, hs.length - 1)]);
  const order = shuffle(hs);
  room.assign = {};
  for (const c of scenario.characters) room.assign[c.id] = null;
  order.forEach((p, i) => {
    const c = chosen[i];
    room.assign[c.id] = p.id;
    p.charId = c.id;
    p.hand = c.clues.map((k) => ({ id: k.id, source: 'initial' }));
    p.used = { info: 0, extra: 0 };
    p.investigated = new Set();
  });
  room.publicClues = [];
  room.votes = {};
  room.result = null;
  enterPhase(room, 'character');
}

function resetToLobby(room) {
  for (const p of [...room.players.values()]) {
    if (p.left) room.players.delete(p.id);
  }
  for (const p of room.players.values()) {
    p.npc = false;
    p.charId = null;
    p.hand = [];
    p.used = { info: 0, extra: 0 };
    p.investigated = new Set();
    p.ready = p.id === room.hostId;
  }
  room.assign = null;
  room.publicClues = [];
  room.votes = {};
  room.result = null;
  room.skip = new Set();
  room.phase = 'lobby';
  room.phaseStartedAt = Date.now();
  room.phaseEndsAt = null;
  room.chat = [];
  broadcastChatLog(room);
  systemMsg(room, 'ロビーに戻りました。準備ができたらもう一度始められます');
  reassignHost(room);
  broadcastState(room);
}

// ---------- 結果 ----------
function computeResult(room) {
  const culpritId = scenario.culpritId;
  const tally = {};
  for (const v of Object.values(room.votes)) tally[v] = (tally[v] || 0) + 1;
  const counts = Object.values(tally);
  const max = counts.length ? Math.max(...counts) : 0;
  const top = max > 0 ? scenario.characters.filter((c) => tally[c.id] === max).map((c) => c.id) : [];
  const caught = top.length === 1 && top[0] === culpritId;
  const playerOfChar = (cid) => {
    const pid = room.assign && room.assign[cid];
    return pid ? room.players.get(pid) : null;
  };
  const characters = scenario.characters.map((c) => {
    const pl = playerOfChar(c.id);
    const goals = c.goals.map((g) => {
      let achieved;
      if (g.type === 'vote_culprit') achieved = pl ? room.votes[pl.id] === culpritId : null;
      else if (g.type === 'secret_hidden')
        achieved = !room.publicClues.some((pc) => (scenario.clueMap[pc.id].exposes || []).includes(c.id));
      else if (g.type === 'not_top') achieved = !top.includes(c.id);
      else if (g.type === 'escape') achieved = !caught;
      else achieved = null;
      return { text: g.text, type: g.type, achieved };
    });
    let key;
    if (c.id === culpritId) key = caught ? 'caught' : 'escaped';
    else if (!caught) key = 'unsolved';
    else key = goals.find((g) => g.type === 'secret_hidden').achieved ? 'victory' : 'costly';
    return {
      id: c.id,
      name: c.name,
      role: c.role,
      playerId: pl ? pl.id : null,
      playerName: pl ? pl.name : null,
      npc: !pl || pl.left,
      secret: c.secret,
      goals,
      endingKey: key,
      ending: c.endings[key]
    };
  });
  const votes = Object.keys(room.votes).map((pid) => {
    const voter = room.players.get(pid);
    return {
      voter: voter ? voter.name : '?',
      voterChar: voter && voter.charId ? charById(voter.charId).name : '',
      target: charById(room.votes[pid]).name,
      targetId: room.votes[pid]
    };
  });
  const culprit = charById(culpritId);
  const cp = playerOfChar(culpritId);
  return {
    culpritId,
    culpritName: culprit.name,
    culpritPlayer: cp ? cp.name : null,
    caught,
    top,
    tally: scenario.characters
      .map((c) => ({ charId: c.id, name: c.name, count: tally[c.id] || 0 }))
      .sort((a, b) => b.count - a.count),
    votes,
    truth: scenario.truth,
    characters
  };
}

// ---------- プレイヤーごとのビュー（ここが秘密情報の関所） ----------
function clueView(room, entry) {
  const k = scenario.clueMap[entry.id];
  return {
    id: k.id,
    title: k.title,
    text: k.text,
    secret: !!k.secret,
    hint: k.hint || null, // 本人の手元にだけ表示する助言（公開される text には含めない）
    source: entry.source,
    published: room.publicClues.some((c) => c.id === k.id)
  };
}

function viewFor(room, me) {
  const idx = phaseIdx(room.phase);
  const started = room.assign !== null;
  const hs = humans(room);
  const ch = connectedHumans(room);
  const myChar = me.charId ? charById(me.charId) : null;

  const view = {
    serverTime: Date.now(),
    code: room.code,
    phase: room.phase,
    phaseLabel: PHASE_LABEL[room.phase],
    phaseStartedAt: room.phaseStartedAt,
    phaseEndsAt: room.phaseEndsAt,
    settings: room.settings,
    limits: { min: MIN_SEC, max: MAX_SEC },
    mode: room.mode,
    scenario: {
      title: scenario.title,
      subtitle: scenario.subtitle,
      minPlayers: scenario.minPlayers,
      maxPlayers: scenario.maxPlayers
    },
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      isHost: p.id === room.hostId,
      connected: p.connected,
      npc: p.npc,
      left: p.left,
      charId: started && idx >= 1 ? p.charId : null
    })),
    me: {
      id: me.id,
      name: me.name,
      isHost: me.id === room.hostId,
      ready: me.ready,
      charId: me.charId,
      skipped: room.skip.has(me.id),
      vote: room.votes[me.id] || null,
      investigationsLeft: INVESTIGATE_PHASES.includes(room.phase)
        ? Math.max(0, INVESTIGATIONS_PER_PHASE - me.used[room.phase])
        : 0
    },
    skipCount: SKIP_PHASES.includes(room.phase) ? ch.filter((p) => room.skip.has(p.id)).length : 0,
    skipTotal: ch.length,
    votesCast: Object.keys(room.votes).length,
    votersTotal: hs.length,
    canPublish: PUBLISH_PHASES.includes(room.phase),
    canInvestigate: INVESTIGATE_PHASES.includes(room.phase),
    publicClues: room.publicClues
  };

  if (started && idx >= 1) {
    // 登場人物の公開プロフィール（全員が見てよい情報のみ）
    view.characters = scenario.characters.map((c) => {
      const pid = room.assign[c.id];
      const pl = pid ? room.players.get(pid) : null;
      return {
        id: c.id,
        name: c.name,
        kana: c.kana,
        age: c.age,
        role: c.role,
        publicProfile: c.publicProfile,
        playerId: pl && !pl.left ? pl.id : null,
        playerName: pl ? pl.name : null,
        npc: !pl || pl.left
      };
    });
    view.intro = idx >= phaseIdx('opening') ? scenario.intro : null;
    view.discussionPrompts = scenario.discussionPrompts;
    view.places = scenario.places.map((p) => ({
      id: p.id,
      name: p.name,
      desc: p.desc,
      done: me.investigated.has(p.id)
    }));
  }

  // 自分のキャラクターの詳細
  if (myChar && idx >= 1) {
    const sheet = {
      id: myChar.id,
      name: myChar.name,
      kana: myChar.kana,
      age: myChar.age,
      role: myChar.role,
      personality: myChar.personality,
      publicProfile: myChar.publicProfile,
      relationships: Object.keys(myChar.relationships).map((cid) => ({
        charId: cid,
        name: charById(cid).name,
        text: myChar.relationships[cid]
      }))
    };
    if (idx >= phaseIdx('personal')) {
      sheet.secret = myChar.secret;
      sheet.goals = myChar.goals.map((g) => ({ text: g.text }));
      sheet.isCulprit = myChar.id === scenario.culpritId;
      sheet.culpritNote = myChar.culpritNote || null;
      view.hand = me.hand.map((h) => clueView(room, h));
    } else {
      view.hand = me.hand.filter((h) => h.source !== 'initial').map((h) => clueView(room, h));
    }
    view.sheet = sheet;
  }

  if (room.phase === 'result' && room.result) {
    view.result = Object.assign({}, room.result, { youAreCulprit: !!(myChar && myChar.id === scenario.culpritId) });
  }
  return view;
}

// ---------- アクション ----------
function rateLimit(player) {
  const now = Date.now();
  player.actionTimes = player.actionTimes.filter((t) => now - t < 10000);
  if (player.actionTimes.length >= 40) throw new UserError('操作が多すぎます。少し待ってからお試しください。');
  player.actionTimes.push(now);
}

function handleAction(room, player, body) {
  rateLimit(player);
  room.lastActivity = Date.now();
  const type = String(body.type || '');
  switch (type) {
    case 'ready': {
      if (room.phase !== 'lobby') throw new UserError('ロビーでのみ変更できます。');
      if (player.id === room.hostId) return;
      player.ready = !!body.value;
      broadcastState(room);
      return;
    }
    case 'settings': {
      if (room.phase !== 'lobby') throw new UserError('ゲーム開始前にだけ変更できます。');
      if (player.id !== room.hostId) throw new UserError('設定を変えられるのはホストだけです。');
      const d = body.durations || {};
      const next = Object.assign({}, room.settings.durations);
      for (const k of Object.keys(DEFAULT_DURATIONS)) {
        if (d[k] === undefined) continue;
        const v = Number(d[k]);
        if (!Number.isFinite(v)) throw new UserError('時間は数字で入力してください。');
        next[k] = Math.min(MAX_SEC, Math.max(MIN_SEC, Math.round(v)));
      }
      room.settings.durations = next;
      broadcastState(room);
      return;
    }
    case 'kick': {
      if (room.phase !== 'lobby') throw new UserError('ロビーでのみ使えます。');
      if (player.id !== room.hostId) throw new UserError('ホストだけが退出させられます。');
      const target = room.players.get(String(body.playerId || ''));
      if (!target || target.id === player.id) throw new UserError('対象のプレイヤーが見つかりません。');
      const name = target.name;
      room.players.delete(target.id);
      closeConns(target, 'ホストにより退出させられました。');
      systemMsg(room, `${name}が退出させられました`);
      broadcastState(room);
      return;
    }
    case 'start': {
      if (room.phase !== 'lobby') throw new UserError('すでにゲームが始まっています。');
      if (player.id !== room.hostId) throw new UserError('ゲームを始められるのはホストだけです。');
      startGame(room);
      return;
    }
    case 'leave': {
      removeOrNpc(room, player);
      return;
    }
    case 'chat': {
      const text = String(body.text == null ? '' : body.text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
      if (!text) return;
      if (text.length > 300) throw new UserError('メッセージは300文字までです。');
      const now = Date.now();
      if (now - player.lastChatAt < 500) throw new UserError('送信が早すぎます。');
      player.lastChatAt = now;
      pushChat(room, {
        type: 'chat',
        playerId: player.id,
        name: player.name,
        charName: player.charId ? charById(player.charId).name : null,
        text
      });
      return;
    }
    case 'skip': {
      if (!SKIP_PHASES.includes(room.phase)) throw new UserError('いまは次へ進めません。');
      if (room.skip.has(player.id)) room.skip.delete(player.id);
      else room.skip.add(player.id);
      broadcastState(room);
      checkAutoAdvance(room);
      return;
    }
    case 'investigate': {
      if (!INVESTIGATE_PHASES.includes(room.phase)) throw new UserError('いまは調査できません。');
      const place = scenario.places.find((p) => p.id === body.placeId);
      if (!place) throw new UserError('その場所は見つかりません。');
      if (player.investigated.has(place.id)) throw new UserError('その場所はもう調べました。');
      if (player.used[room.phase] >= INVESTIGATIONS_PER_PHASE)
        throw new UserError(`このフェーズで調べられるのは${INVESTIGATIONS_PER_PHASE}回までです。`);
      player.used[room.phase]++;
      player.investigated.add(place.id);
      if (!player.hand.some((h) => h.id === place.clue.id)) player.hand.push({ id: place.clue.id, source: 'investigate' });
      send(player, 'state', viewFor(room, player));
      return;
    }
    case 'publish': {
      if (!PUBLISH_PHASES.includes(room.phase)) throw new UserError('いまは証拠を公開できません。');
      const entry = player.hand.find((h) => h.id === body.clueId);
      if (!entry) throw new UserError('その情報は持っていません。');
      const clue = scenario.clueMap[entry.id];
      const ch = player.charId ? charById(player.charId) : null;
      if (!publishClue(room, clue, { by: player.name, byChar: ch ? ch.name : null }))
        throw new UserError('その情報はすでに公開されています。');
      systemMsg(room, `${player.name}が「${clue.title.replace(/^【秘密】/, '')}」を公開しました`);
      broadcastState(room);
      return;
    }
    case 'vote': {
      if (room.phase !== 'vote') throw new UserError('いまは投票できません。');
      const target = charById(String(body.charId || ''));
      if (!target) throw new UserError('投票先が見つかりません。');
      if (target.id === player.charId) throw new UserError('自分には投票できません。');
      room.votes[player.id] = target.id;
      broadcastState(room);
      checkAutoAdvance(room);
      return;
    }
    case 'again':
    case 'lobby': {
      if (room.phase !== 'result') throw new UserError('ゲーム終了後に使えます。');
      resetToLobby(room);
      if (type === 'again' && player.id !== room.hostId) {
        player.ready = true;
        broadcastState(room);
      }
      return;
    }
    case 'gm_advance': {
      // 将来のGMモード用の入口。room.mode が 'gm' のとき、ホスト(GM)だけがフェーズを進められる。
      if (room.mode !== 'gm') throw new UserError('GMモードではありません。');
      if (player.id !== room.hostId) throw new UserError('GMだけが操作できます。');
      nextPhase(room);
      return;
    }
    default:
      throw new UserError('不明な操作です。');
  }
}

function stats() {
  return { rooms: rooms.size };
}

module.exports = {
  UserError,
  createRoom,
  joinRoom,
  auth,
  attachConn,
  detachConn,
  handleAction,
  startTimers,
  stats,
  _rooms: rooms
};
