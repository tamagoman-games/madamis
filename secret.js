'use strict';
/**
 * 密談（2人だけの専用チャット）
 *
 * セキュリティ方針:
 *  - 密談の状態・メッセージは room.sc（サーバーのメモリ）だけが持つ
 *  - 送信は「その密談の参加者2人」の接続にだけ行う（deps.send を参加者にだけ呼ぶ）
 *  - 全体の state には、本人が参加している密談の「メタ情報」だけを入れる（メッセージ本文は入れない）
 *  - 第三者には、密談の存在もメッセージも一切送らない
 *
 * ルール（RULES を書き換えるだけで調整可能）:
 *  - 人数2人 / 同時に参加できるのは1人1組 / 回数は無制限（maxStartedPerPlayer で制限可能）
 *  - 使えるフェーズは議論系のみ
 */

const RULES = {
  phases: ['discussion', 'discussion2', 'final'],
  maxMembers: 2, // 将来、人数を増やすときの目印（現バージョンは2人固定）
  maxActivePerPlayer: 1, // 同時に参加できる密談の数
  maxStartedPerPlayer: Number(process.env.SECRET_MAX_PER_PLAYER) > 0 ? Number(process.env.SECRET_MAX_PER_PLAYER) : Infinity, // 1ゲームで始められる回数
  requestTtlMs: 60 * 1000, // 申請の有効時間
  maxMessageLen: 300,
  minIntervalMs: 400
};

function create(deps) {
  const { send, UserError, touch } = deps;

  const store = (room) => room.sc || (room.sc = { seq: 0, chats: new Map() });
  const allowedPhase = (room) => RULES.phases.includes(room.phase);
  const other = (chat, pid) => (chat.a === pid ? chat.b : chat.a);
  const isMember = (chat, pid) => chat.a === pid || chat.b === pid;
  const activeOf = (room, pid) => [...store(room).chats.values()].find((c) => c.status === 'active' && isMember(c, pid));
  const countActive = (room, pid) => [...store(room).chats.values()].filter((c) => c.status === 'active' && isMember(c, pid)).length;

  function meta(room, chat, forPid) {
    const o = room.players.get(other(chat, forPid));
    const ch = o && o.charId && room.scn ? room.scn.characters.find((c) => c.id === o.charId) : null;
    return {
      id: chat.id,
      status: chat.status, // pending | active | declined | cancelled | expired | ended
      mine: chat.requester === forPid, // 自分が申請した側
      other: { id: o ? o.id : null, name: o ? o.name : '?', charName: ch ? ch.name : null },
      createdAt: chat.createdAt,
      expiresAt: chat.status === 'pending' ? chat.expiresAt : null,
      reason: chat.reason || null
    };
  }

  /** 参加者2人にだけ、最新のメタ情報を送る */
  function notify(room, chat) {
    for (const pid of [chat.a, chat.b]) {
      const p = room.players.get(pid);
      if (p && p.conns.size) send(p, 'sc_meta', meta(room, chat, pid));
    }
    // 全体のstateにも、参加者2人の分だけ反映する（第三者には送らない）
    if (touch) touch(room, [chat.a, chat.b]);
  }
  function deliver(room, chat, msg) {
    for (const pid of [chat.a, chat.b]) {
      const p = room.players.get(pid);
      if (p && p.conns.size) send(p, 'sc_msg', { chatId: chat.id, msg });
    }
  }
  function sys(room, chat, text) {
    const msg = { id: chat.msgs.length + 1, t: Date.now(), from: null, text };
    chat.msgs.push(msg);
    deliver(room, chat, msg);
  }
  function close(room, chat, status, reason, noticeText) {
    if (chat.status === 'ended' || chat.status === 'declined' || chat.status === 'cancelled' || chat.status === 'expired') return;
    chat.status = status;
    chat.reason = reason || null;
    if (noticeText && status === 'ended') sys(room, chat, noticeText);
    notify(room, chat);
  }

  function request(room, player, toId) {
    if (!allowedPhase(room)) throw new UserError('密談できるのは、議論のフェーズ中だけです。');
    const target = room.players.get(String(toId || ''));
    if (!target || target.left || target.npc) throw new UserError('その相手とは密談できません。');
    if (target.id === player.id) throw new UserError('自分とは密談できません。');
    if (!target.connected) throw new UserError('相手は接続が切れています。');
    if (countActive(room, player.id) >= RULES.maxActivePerPlayer) throw new UserError('あなたは、すでに密談中です。先に終了してください。');
    if (countActive(room, target.id) >= RULES.maxActivePerPlayer) throw new UserError('相手は、別の密談中です。あとでもう一度お試しください。');
    if ((player.scStarted || 0) >= RULES.maxStartedPerPlayer) throw new UserError('密談できる回数の上限に達しました。');
    const st = store(room);
    for (const c of st.chats.values()) {
      if (c.status === 'pending' && c.requester === player.id) throw new UserError('すでに申請中です。返事を待つか、取り消してください。');
      if (c.status === 'pending' && isMember(c, player.id) && isMember(c, target.id)) throw new UserError('その相手から、すでに申請が届いています。');
    }
    const chat = {
      id: 'sc' + ++st.seq,
      a: player.id,
      b: target.id,
      requester: player.id,
      status: 'pending',
      msgs: [],
      createdAt: Date.now(),
      expiresAt: Date.now() + RULES.requestTtlMs,
      reason: null
    };
    st.chats.set(chat.id, chat);
    notify(room, chat);
    return chat;
  }

  function respond(room, player, chatId, accept) {
    const chat = store(room).chats.get(String(chatId || ''));
    // 参加者以外が操作しようとしても、存在を悟らせない
    if (!chat || !isMember(chat, player.id)) throw new UserError('その密談は見つかりません。');
    if (chat.status !== 'pending') throw new UserError('その申請は、すでに終了しています。');
    if (chat.requester === player.id) throw new UserError('申請した本人は、許可・拒否できません。');
    if (!accept) {
      close(room, chat, 'declined', '拒否されました');
      return chat;
    }
    if (!allowedPhase(room)) throw new UserError('密談できるのは、議論のフェーズ中だけです。');
    if (countActive(room, player.id) >= RULES.maxActivePerPlayer) throw new UserError('あなたは、すでに密談中です。');
    if (countActive(room, chat.requester) >= RULES.maxActivePerPlayer) {
      close(room, chat, 'declined', '相手が別の密談を始めました');
      throw new UserError('相手は、すでに別の密談を始めていました。');
    }
    if ((player.scStarted || 0) >= RULES.maxStartedPerPlayer) throw new UserError('密談できる回数の上限に達しました。');
    chat.status = 'active';
    player.scStarted = (player.scStarted || 0) + 1;
    const req = room.players.get(chat.requester);
    if (req) req.scStarted = (req.scStarted || 0) + 1;
    notify(room, chat);
    // この2人宛の、ほかの未回答の申請は自動で終了
    for (const c of store(room).chats.values()) {
      if (c !== chat && c.status === 'pending' && (isMember(c, chat.a) || isMember(c, chat.b))) close(room, c, 'declined', '相手が別の密談を始めました');
    }
    return chat;
  }

  function cancel(room, player, chatId) {
    const chat = store(room).chats.get(String(chatId || ''));
    if (!chat || !isMember(chat, player.id)) throw new UserError('その密談は見つかりません。');
    if (chat.status !== 'pending' || chat.requester !== player.id) throw new UserError('取り消せる申請ではありません。');
    close(room, chat, 'cancelled', '申請が取り消されました');
  }

  function message(room, player, chatId, text) {
    const chat = store(room).chats.get(String(chatId || ''));
    if (!chat || !isMember(chat, player.id)) throw new UserError('その密談は見つかりません。');
    if (chat.status !== 'active') throw new UserError('その密談は、すでに終了しています。');
    if (!allowedPhase(room)) throw new UserError('密談できるのは、議論のフェーズ中だけです。');
    const t = String(text == null ? '' : text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    if (!t) return;
    if (t.length > RULES.maxMessageLen) throw new UserError(`メッセージは${RULES.maxMessageLen}文字までです。`);
    const now = Date.now();
    if (now - (player.scLastAt || 0) < RULES.minIntervalMs) throw new UserError('送信が早すぎます。');
    player.scLastAt = now;
    const msg = { id: chat.msgs.length + 1, t: now, from: player.id, text: t };
    chat.msgs.push(msg);
    deliver(room, chat, msg);
  }

  function end(room, player, chatId) {
    const chat = store(room).chats.get(String(chatId || ''));
    if (!chat || !isMember(chat, player.id)) throw new UserError('その密談は見つかりません。');
    if (chat.status !== 'active') throw new UserError('その密談は、すでに終了しています。');
    close(room, chat, 'ended', `${player.name}が密談を終了しました`, `${player.name}が密談を終了しました`);
  }

  /** フェーズが変わったとき: 議論以外のフェーズでは、すべての密談を終了する */
  function onPhaseChange(room) {
    if (!room.sc || allowedPhase(room)) return;
    for (const c of room.sc.chats.values()) {
      if (c.status === 'active') close(room, c, 'ended', '議論フェーズが終わりました', '議論フェーズが終わったため、密談は終了しました');
      else if (c.status === 'pending') close(room, c, 'expired', '議論フェーズが終わりました');
    }
  }
  /** プレイヤーが退出したとき */
  function onPlayerGone(room, player) {
    if (!room.sc) return;
    for (const c of room.sc.chats.values()) {
      if (!isMember(c, player.id)) continue;
      if (c.status === 'active') close(room, c, 'ended', '相手が退出しました', `${player.name}が退出したため、密談は終了しました`);
      else if (c.status === 'pending') close(room, c, 'cancelled', '相手が退出しました');
    }
  }
  /** 期限切れの申請を閉じる（1秒ごとに呼ばれる） */
  function tick(room, now) {
    if (!room.sc) return;
    for (const c of room.sc.chats.values()) if (c.status === 'pending' && now >= c.expiresAt) close(room, c, 'expired', '時間切れになりました');
  }

  /** 自分が参加している密談のメタ情報だけ（本文は含まない） */
  function viewFor(room, player) {
    const list = [];
    if (room.sc) for (const c of room.sc.chats.values()) if (isMember(c, player.id)) list.push(meta(room, c, player.id));
    return {
      enabled: allowedPhase(room),
      chats: list.slice(-12),
      rules: { maxMembers: RULES.maxMembers, maxActive: RULES.maxActivePerPlayer, maxStarted: RULES.maxStartedPerPlayer === Infinity ? null : RULES.maxStartedPerPlayer }
    };
  }
  /** 再接続時に、自分が参加している密談のメッセージだけを返す */
  function logsFor(room, player) {
    const out = {};
    if (room.sc) for (const c of room.sc.chats.values()) if (isMember(c, player.id)) out[c.id] = c.msgs;
    return out;
  }

  return { RULES, request, respond, cancel, message, end, onPhaseChange, onPlayerGone, tick, viewFor, logsFor };
}

module.exports = { create, RULES };
