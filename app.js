(function () {
  'use strict';

  // =====================================================================
  //  設定・ユーティリティ
  // =====================================================================
  const CFG = window.APP_CONFIG || {};
  const API = (CFG.API_BASE || '').replace(/\/$/, '');
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  // 画面に出すテキストはすべて textContent で入れる（XSS対策）
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach((x) => append(el, x));
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  const fmtTime = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), isErr ? 4200 : 2400);
  }

  function showModal(body, actions) {
    const m = $('#modal');
    const b = $('#modal-body');
    const a = $('#modal-actions');
    b.replaceChildren();
    a.replaceChildren();
    append(b, body);
    (actions || [{ label: '閉じる' }]).forEach((x) =>
      a.appendChild(
        h('button', {
          class: 'btn ' + (x.cls || ''),
          onclick: () => { m.hidden = true; if (x.onClick) x.onClick(); }
        }, x.label)
      )
    );
    m.hidden = false;
  }
  function confirmDialog(message, okLabel, danger) {
    return new Promise((resolve) => {
      showModal(h('p', { class: 'pre' }, message), [
        { label: 'やめる', onClick: () => resolve(false) },
        { label: okLabel || 'OK', cls: danger ? 'danger' : 'primary', onClick: () => resolve(true) }
      ]);
    });
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try {
        const ta = h('textarea', { style: 'position:fixed;opacity:0' });
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e2) { return false; }
    }
  }

  // =====================================================================
  //  通信（SSEで受信 / POSTで送信）
  // =====================================================================
  let session = null; // {code, token}
  let es = null;
  let lastEventAt = 0;
  let S = null; // サーバーから届いた自分用ビュー
  let chat = [];
  let offset = 0; // サーバー時刻 - 端末時刻
  let reconnectTimer = null;

  try { session = JSON.parse(LS.get('mm_session') || 'null'); } catch (e) { session = null; }
  const saveSession = (s) => { session = s; if (s) LS.set('mm_session', JSON.stringify(s)); else LS.del('mm_session'); };

  async function api(path, body) {
    let res;
    try {
      res = await fetch(API + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
    } catch (e) {
      throw new Error('サーバーに接続できません。電波の良い場所でもう一度お試しください。');
    }
    let j = {};
    try { j = await res.json(); } catch (e) {}
    if (!res.ok) {
      if (j.fatal) handleFatal(j.error);
      throw new Error(j.error || 'エラーが発生しました。');
    }
    return j;
  }
  async function act(type, extra) {
    if (!session) return false;
    try {
      await api('/api/action', Object.assign({ code: session.code, token: session.token, type }, extra || {}));
      return true;
    } catch (e) {
      toast(e.message, true);
      return false;
    }
  }

  function connect() {
    if (!session) return;
    if (es) { try { es.close(); } catch (e) {} es = null; }
    const url = `${API}/api/events?code=${encodeURIComponent(session.code)}&token=${encodeURIComponent(session.token)}`;
    es = new EventSource(url);
    lastEventAt = Date.now();
    es.onopen = () => { lastEventAt = Date.now(); setBanner(false); };
    es.onerror = () => { setBanner(true); };
    es.addEventListener('state', (e) => { lastEventAt = Date.now(); setBanner(false); onState(JSON.parse(e.data)); });
    es.addEventListener('chatlog', (e) => { lastEventAt = Date.now(); chat = JSON.parse(e.data); rebuildChat(); });
    es.addEventListener('chat', (e) => { lastEventAt = Date.now(); onChat(JSON.parse(e.data)); });
    // 密談: サーバーは、参加している2人にだけ送ってくる
    es.addEventListener('sc_log', (e) => { lastEventAt = Date.now(); scMsgs = JSON.parse(e.data) || {}; if (S && S.phase !== 'lobby') renderSecret(); });
    es.addEventListener('sc_meta', (e) => { lastEventAt = Date.now(); onScMeta(JSON.parse(e.data)); });
    es.addEventListener('sc_msg', (e) => { lastEventAt = Date.now(); onScMsg(JSON.parse(e.data)); });
    es.addEventListener('tick', (e) => {
      lastEventAt = Date.now();
      try { offset = JSON.parse(e.data).t - Date.now(); } catch (x) {}
    });
    es.addEventListener('fatal', (e) => {
      let m = '';
      try { m = JSON.parse(e.data).message; } catch (x) {}
      handleFatal(m);
    });
  }
  function ensureConnected(force) {
    if (!session) return;
    const stale = Date.now() - lastEventAt > (force ? 12000 : 30000);
    if (!es || es.readyState === 2 || stale) connect();
  }
  function setBanner(on) { $('#banner').hidden = !on; $('#lobby-net').textContent = on ? '再接続中…' : ''; }

  function handleFatal(msg) {
    if (es) { try { es.close(); } catch (e) {} es = null; }
    saveSession(null);
    S = null;
    chat = [];
    scMsgs = {};
    scSeen = {};
    scReady = false;
    setBanner(false);
    if (msg) toast(msg, true);
    show('title');
  }

  setInterval(() => ensureConnected(false), 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { ensureConnected(true); requestWake(); } });
  window.addEventListener('online', () => ensureConnected(true));
  window.addEventListener('pageshow', () => ensureConnected(true));

  let wake = null;
  async function requestWake() {
    try {
      if (S && S.phase !== 'lobby' && S.phase !== 'result' && 'wakeLock' in navigator && !wake) {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => { wake = null; });
      }
    } catch (e) { wake = null; }
  }

  // =====================================================================
  //  画面の切り替え
  // =====================================================================
  function show(name) {
    ['title', 'entry', 'lobby', 'game'].forEach((n) => ($('#screen-' + n).hidden = n !== name));
  }

  // ---- タイトル ----
  (function buildClock() {
    const g = $('.clock-ticks');
    if (!g) return;
    const ns = 'http://www.w3.org/2000/svg';
    for (let i = 0; i < 12; i++) {
      const major = i % 3 === 0;
      const a = (i * 30 * Math.PI) / 180;
      const r1 = major ? 66 : 72;
      const ln = document.createElementNS(ns, 'line');
      ln.setAttribute('x1', 100 + Math.sin(a) * r1);
      ln.setAttribute('y1', 100 - Math.cos(a) * r1);
      ln.setAttribute('x2', 100 + Math.sin(a) * 80);
      ln.setAttribute('y2', 100 - Math.cos(a) * 80);
      if (major) ln.setAttribute('class', 'major');
      g.appendChild(ln);
    }
  })();

  let entryMode = 'create';
  function openEntry(mode, code) {
    entryMode = mode;
    $('#entry-title').textContent = mode === 'create' ? '部屋を作る' : '部屋に参加する';
    $('#entry-go').textContent = mode === 'create' ? '部屋を作る' : '参加する';
    $('#entry-code-wrap').hidden = mode !== 'join';
    $('#entry-hint').textContent =
      mode === 'create' ? 'ホストになります。作成後に表示される部屋コードを友達に伝えてください。' : 'ホストから教えてもらった6文字の部屋コードを入力してください。';
    $('#entry-name').value = LS.get('mm_name') || '';
    if (code) $('#entry-code').value = code;
    show('entry');
  }
  $('#title-create').onclick = () => openEntry('create');
  $('#title-join').onclick = () => openEntry('join');
  $('#entry-back').onclick = () => show('title');
  $('#entry-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
  ['entry-name', 'entry-code'].forEach((id) =>
    $('#' + id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#entry-go').click(); })
  );
  $('#entry-go').onclick = async () => {
    const name = $('#entry-name').value.trim();
    const code = $('#entry-code').value.trim();
    if (!name) return toast('名前を入力してください', true);
    if (entryMode === 'join' && code.length !== 6) return toast('部屋コードは6文字です', true);
    const btn = $('#entry-go');
    btn.disabled = true;
    try {
      LS.set('mm_name', name);
      const r = await api(entryMode === 'create' ? '/api/create' : '/api/join', { name, code });
      saveSession({ code: r.code, token: r.token });
      chat = [];
      S = null;
      connect();
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  };
  $('#title-howto').onclick = () =>
    showModal(
      h('div', { class: 'prose' },
        h('h3', null, '遊び方'),
        h('p', null, '1. 誰か1人が「部屋を作る」を押し、表示された6文字の部屋コード（またはURL）を友達に伝えます。'),
        h('p', null, '2. 友達は「部屋コードで参加する」から入室し、準備完了を押します。'),
        h('p', null, '3. ホストがゲームを開始すると、全員にそれぞれ別のキャラクターが配られます。あなたの秘密は、あなたにしか見えません。'),
        h('p', null, '4. 場所を調べ、持っている情報を公開し、チャットで議論して、犯人を推理しましょう。'),
        h('p', null, '5. 最後に犯人だと思う人に投票します。結果発表で、真相と全員のエンディングが明かされます。'),
        h('p', { class: 'muted small' }, '画面を他の人に見せないでください。ページを更新しても、同じ部屋・同じ進行状況に戻れます。')
      ),
      [{ label: '閉じる', cls: 'primary' }]
    );

  // =====================================================================
  //  状態受信
  // =====================================================================
  let prevPhase = null;
  let tab = 'main';
  let unreadChat = 0;
  let boardSeen = 0;
  let boardFrom = 0;
  let resultTab = 'result';
  let voteSel = null;
  const DISCUSS = ['discussion', 'discussion2', 'final']; // 議論系フェーズ（初期表示は全体チャット）
  let scMsgs = {}; // 密談メッセージ（自分が参加している密談だけ）
  let scSeen = {};
  let scReady = false;
  let unreadSecret = 0;

  function onState(v) {
    offset = v.serverTime - Date.now();
    const phaseChanged = prevPhase !== v.phase;
    S = v;
    if (phaseChanged) {
      const first = prevPhase === null;
      prevPhase = v.phase;
      voteSel = null;
      resultTab = 'result';
      if (v.phase === 'lobby') { tab = 'main'; boardSeen = 0; boardFrom = 0; unreadChat = 0; }
      else {
        tab = DISCUSS.includes(v.phase) ? 'chat' : 'main';
        if (first) tab = 'main';
        if (!first) {
          toast(`【${v.phaseLabel}】が始まりました`);
          try { navigator.vibrate && navigator.vibrate(80); } catch (e) {}
        }
      }
      if (tab === 'chat') unreadChat = 0;
      requestWake();
    }
    if (v.me.vote && voteSel === null) voteSel = v.me.vote;
    checkScTransitions();
    render();
  }

  function render() {
    if (!S) return;
    if (S.phase === 'lobby') { show('lobby'); renderLobby(); }
    else { show('game'); renderGame(); }
  }

  // =====================================================================
  //  ロビー
  // =====================================================================
  let settingInputs = {};
  let settingSig = '';
  function ensureSettings() {
    const phases = S.settingsPhases || [];
    const sig = phases.map((p) => p.key + ':' + p.label).join(',');
    if (sig === settingSig) return;
    settingSig = sig;
    settingInputs = {};
    const grid = $('#settings-grid');
    grid.replaceChildren();
    phases.forEach(({ key, label }) => {
      const inp = h('input', { type: 'number', inputmode: 'decimal', step: '0.5', min: '0.5', max: '60', 'aria-label': label });
      inp.addEventListener('change', async () => {
        const mins = Number(inp.value);
        if (!isFinite(mins) || mins <= 0) { renderLobby(true); return toast('時間は0より大きい数字で入力してください', true); }
        const ok = await act('settings', { durations: { [key]: Math.round(mins * 60) } });
        if (!ok) renderLobby(true);
      });
      settingInputs[key] = inp;
      grid.appendChild(h('label', null, label));
      grid.appendChild(inp);
    });
  }

  function renderScenarioList() {
    const host = S.me.isHost;
    $('#scenario-list').replaceChildren(
      ...S.catalog.map((s) =>
        h('button', {
          class: 'scn-card' + (S.scenarioId === s.id ? ' sel' : ''),
          disabled: !host,
          'aria-pressed': S.scenarioId === s.id ? 'true' : 'false',
          onclick: () => { if (host && S.scenarioId !== s.id) act('scenario', { scenarioId: s.id }); }
        },
          h('span', { class: 'radio' }),
          h('span', null,
            h('div', { class: 'st' }, s.title),
            h('div', { class: 'muted small' }, `${s.genre} ／ ${s.minPlayers === s.maxPlayers ? s.minPlayers : s.minPlayers + '〜' + s.maxPlayers}人`),
            h('div', { class: 'small' }, s.description)
          )
        )
      )
    );
    $('#scenario-hint').textContent = host ? 'ホストがシナリオを選びます。選んだシナリオは、全員の画面に反映されます。' : 'シナリオはホストが選びます。';
  }

  function renderLobby(forceSettings) {
    const me = S.me;
    $('#lobby-code').textContent = S.code;
    const players = S.players.filter((p) => !p.left);
    $('#lobby-count').textContent = `${players.length} / ${S.scenario.maxPlayers}人`;
    const ul = $('#lobby-players');
    ul.replaceChildren(
      ...players.map((p) =>
        h('li', null,
          h('span', { class: 'dot' + (p.connected ? '' : ' off') }),
          h('span', { class: 'nm' }, p.name + (p.id === me.id ? '（あなた）' : '')),
          p.isHost ? h('span', { class: 'tag host' }, 'ホスト') : null,
          !p.connected ? h('span', { class: 'tag off' }, '接続切れ') : null,
          !p.isHost ? h('span', { class: 'tag' + (p.ready ? ' ready' : '') }, p.ready ? '準備完了' : '準備中') : null,
          me.isHost && p.id !== me.id
            ? h('button', {
                class: 'btn small',
                'aria-label': p.name + 'を退出させる',
                onclick: async () => { if (await confirmDialog(`${p.name}を退出させますか？`, '退出させる', true)) act('kick', { playerId: p.id }); }
              }, '退出')
            : null
        )
      )
    );
    // シナリオ・設定
    renderScenarioList();
    ensureSettings();
    const d = S.settings.durations;
    Object.keys(settingInputs).forEach((key) => {
      const inp = settingInputs[key];
      inp.disabled = !me.isHost;
      if (forceSettings || document.activeElement !== inp) inp.value = String(Math.round((d[key] / 60) * 10) / 10);
    });
    $('#settings-hint').textContent = me.isHost ? 'ここで決めた時間が全員に反映されます。各フェーズは、全員が「次へ」を押すと早く進めます。' : 'ホストが設定します。';
    // ボタン
    const main = $('#lobby-main');
    const others = players.filter((p) => !p.isHost);
    const notReady = others.filter((p) => !p.ready);
    const hint = $('#lobby-hint');
    if (me.isHost) {
      const need = S.scenario.minPlayers - players.length;
      const tooMany = players.length > S.scenario.maxPlayers;
      const can = need <= 0 && !tooMany && notReady.length === 0;
      main.textContent = 'ゲームを開始する';
      main.disabled = !can;
      main.onclick = () => act('start');
      const isWitch = S.scenarioId !== 'midnight-mansion';
      hint.textContent =
        need > 0 ? `「${S.scenario.title}」は${S.scenario.minPlayers}〜${S.scenario.maxPlayers}人用です。あと${need}人必要です。部屋コードを友達に伝えましょう。`
        : tooMany ? `「${S.scenario.title}」は最大${S.scenario.maxPlayers}人までです。`
        : notReady.length ? `準備待ち：${notReady.map((p) => p.name).join('、')}`
        : isWitch ? `全員準備完了です。${players.length}人用で始まります。`
        : players.length < S.scenario.maxPlayers ? `全員準備完了です。${players.length}人で始められます（足りない役はNPCになります）。` : '全員準備完了です。始められます。';
    } else {
      main.textContent = me.ready ? '準備を取り消す' : '準備完了';
      main.disabled = false;
      main.classList.toggle('primary', !me.ready);
      main.onclick = () => act('ready', { value: !me.ready });
      hint.textContent = me.ready ? 'ホストが開始するのを待っています。' : '準備ができたら「準備完了」を押してください。';
    }
    if (me.isHost) main.classList.add('primary');
  }
  $('#lobby-copy').onclick = async () => toast((await copyText(S.code)) ? '部屋コードをコピーしました' : 'コピーできませんでした', false);
  $('#lobby-share').onclick = async () => {
    const url = location.origin + location.pathname + '?room=' + S.code;
    const text = `オンライン・マーダーミステリーで一緒に遊びましょう！部屋コード：${S.code}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'マーダーミステリー', text, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    toast((await copyText(`${text}\n${url}`)) ? '招待文をコピーしました' : 'コピーできませんでした');
  };
  async function leaveRoom() {
    const inGame = S && S.phase !== 'lobby' && S.phase !== 'result';
    const ok = await confirmDialog(
      inGame ? '退出すると、あなたのキャラクターはNPCになり、戻れません。退出しますか？' : '部屋から退出しますか？',
      '退出する', true
    );
    if (!ok) return;
    await act('leave');
    handleFatal('');
  }
  $('#lobby-leave').onclick = leaveRoom;

  // =====================================================================
  //  ゲーム画面
  // =====================================================================
  const PHASE_GUIDE = {
    character: 'あなたの役を確認しましょう。画面を他の人に見せないでください。',
    opening: '事件の概要です。全員で状況を共有します。',
    personal: 'あなただけの秘密・目的・知っている情報を確認します。',
    info: '場所を調べ、持っている情報から「公開するもの」を選びます。公開した情報は全員に見えます。',
    discussion: 'チャットで推理を話し合いましょう。「証拠」タブで公開済みの情報を確認できます。2人だけで話したいときは「密談」を使えます。',
    discussion2: '新しい証拠も踏まえて、もう一度話し合いましょう。「密談」で、確かめたい相手と2人だけで話すこともできます。',
    extra: '新しい証拠が公開されました。もう一度、場所を調べられます。',
    final: '投票前の最後の議論です。持っている情報を出し切りましょう。',
    vote: '犯人だと思う人物を1人選んでください。結果発表まで、誰が誰に入れたかは見えません。',
    result: ''
  };

  function charName(id) {
    const c = (S.characters || []).find((x) => x.id === id);
    return c ? c.name : '';
  }

  function renderGame() {
    $('#g-phase').textContent = S.phaseLabel;
    $$('#g-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    ['main', 'sheet', 'board', 'chat', 'secret'].forEach((t) => ($('#view-' + t).hidden = t !== tab));
    if (tab === 'secret') unreadSecret = 0;
    if (tab === 'board') boardSeen = S.publicClues.length;
    renderInto($('#view-main'), buildMain);
    renderInto($('#view-sheet'), buildSheetView);
    renderInto($('#view-board'), buildBoard);
    renderSecret();
    renderScAlert();
    const nb = Math.max(0, S.publicClues.length - boardSeen);
    const bb = $('#badge-board');
    bb.hidden = nb === 0 || tab === 'board';
    bb.textContent = nb;
    const bc = $('#badge-chat');
    bc.hidden = unreadChat === 0 || tab === 'chat';
    bc.textContent = unreadChat > 99 ? '99+' : unreadChat;
    const bs = $('#badge-secret');
    const sn = pendingIncoming().length + (tab === 'secret' ? 0 : unreadSecret);
    bs.hidden = sn === 0 || tab === 'secret';
    bs.textContent = sn;
    updateTimer();
  }
  function renderInto(el, builder) {
    const st = el.scrollTop;
    el.replaceChildren(...builder().filter(Boolean));
    el.scrollTop = st;
  }

  $$('#g-tabs button').forEach((b) => {
    b.onclick = () => setTab(b.dataset.tab);
  });
  function setTab(t) {
    if (t === 'board') { boardFrom = boardSeen; boardSeen = S ? S.publicClues.length : 0; }
    tab = t;
    if (t === 'chat') { unreadChat = 0; }
    if (t === 'secret') { unreadSecret = 0; }
    if (S) renderGame();
    if (t === 'chat') scrollChat(true);
    if (t === 'secret') scrollSecret();
  }

  $('#g-menu').onclick = () =>
    showModal(
      h('div', null,
        h('h3', null, 'メニュー'),
        h('p', { class: 'muted' }, '部屋コード'),
        h('p', { class: 'lead' }, S ? S.code : ''),
        h('p', { class: 'hint' }, 'ページを更新したり、一時的に通信が切れたりしても、同じ部屋に自動で戻ります。')
      ),
      [
        { label: 'コードをコピー', onClick: async () => toast((await copyText(S.code)) ? 'コピーしました' : 'コピーできませんでした') },
        { label: '退出する', cls: 'danger', onClick: leaveRoom },
        { label: '閉じる' }
      ]
    );

  // ---- タイマー（サーバー時刻基準） ----
  function updateTimer() {
    const t = $('#g-timer');
    const p = $('#g-progress');
    if (!S || !S.phaseEndsAt) {
      t.textContent = '';
      p.style.width = '0%';
      return;
    }
    const now = Date.now() + offset;
    const remain = Math.max(0, S.phaseEndsAt - now);
    const total = Math.max(1, S.phaseEndsAt - S.phaseStartedAt);
    t.textContent = fmtTime(remain);
    p.style.width = Math.min(100, (remain / total) * 100) + '%';
    const warn = remain <= 10000;
    t.classList.toggle('warn', warn);
    p.classList.toggle('warn', warn);
  }
  setInterval(() => { if (S && S.phase !== 'lobby') updateTimer(); }, 250);

  // ---- 共通部品 ----
  function skipBar() {
    const m = S.me;
    return h('div', { class: 'skipbar' },
      h('button', { class: 'btn big' + (m.skipped ? '' : ' primary'), onclick: () => act('skip') },
        m.skipped ? `待っています…（${S.skipCount}/${S.skipTotal}）　取り消す` : `次へ進む（${S.skipCount}/${S.skipTotal}）`),
      h('p', { class: 'hint center' }, '全員が押すと、制限時間を待たずに次へ進みます。')
    );
  }
  function guideCard() {
    const g = PHASE_GUIDE[S.phase];
    return g ? h('p', { class: 'hint' }, g) : null;
  }
  function clueCard(k, opts) {
    opts = opts || {};
    return h('div', { class: 'clue' + (k.secret ? ' secret' : '') + (opts.isNew ? ' new' : '') },
      h('div', { class: 'ct' }, k.title),
      h('div', { class: 'pre' }, k.text),
      k.hint ? h('div', { class: 'by' }, '助言：' + k.hint) : null,
      opts.by ? h('div', { class: 'by' }, opts.by) : null,
      opts.publishable
        ? h('div', { class: 'acts' },
            k.published
              ? h('span', { class: 'tag ready' }, '公開済み')
              : h('button', { class: 'btn small', onclick: () => publishClue(k) }, '全員に公開する'),
            k.secret && !k.published ? h('span', { class: 'tag off' }, '秘密') : null
          )
        : null
    );
  }
  async function publishClue(k) {
    if (k.secret) {
      const ok = await confirmDialog('これは公開すると、あなたにとって不利になる可能性が高い情報です。本当に全員に公開しますか？', '公開する', true);
      if (!ok) return;
    }
    await act('publish', { clueId: k.id });
  }

  // ---- 進行タブ ----
  function buildMain() {
    const out = [];
    const p = S.phase;
    if (p === 'character') {
      out.push(guideCard(), ...buildSheetNodes(), charactersList(), skipBar());
    } else if (p === 'opening') {
      out.push(
        guideCard(),
        h('div', { class: 'card accent prose' },
          h('h3', null, '事件の概要'),
          ...S.intro.paragraphs.map((t) => h('p', null, t))
        ),
        ...S.publicClues.filter((c) => c.phase === 'opening').map((c) => clueCard(c, { isNew: true })),
        charactersList(),
        skipBar()
      );
    } else if (p === 'personal') {
      out.push(guideCard(), ...buildSheetNodes(), skipBar());
    } else if (['info', 'discussion', 'extra', 'discussion2', 'final'].includes(p)) {
      out.push(guideCard(), ...buildWork());
    } else if (p === 'vote') {
      out.push(...buildVote());
    } else if (p === 'result') {
      out.push(...buildResult());
    }
    return out;
  }

  function charactersList() {
    return h('div', { class: 'stack' },
      h('h3', null, '登場人物'),
      ...(S.characters || []).map((c) =>
        h('div', { class: 'char-card' + (c.id === S.me.charId ? ' me' : '') },
          h('div', { class: 'row between' },
            h('span', { class: 'cn' }, c.name),
            h('span', { class: 'tag' + (c.id === S.me.charId ? ' host' : '') }, c.id === S.me.charId ? 'あなた' : c.npc ? 'NPC' : c.playerName)
          ),
          h('div', { class: 'muted small' }, [c.kana, `${c.age}歳`, c.role].filter(Boolean).join('　')),
          h('p', { class: 'small', style: 'margin-top:6px' }, c.publicProfile)
        )
      )
    );
  }

  // ---- 資料（自分のキャラクター） ----
  function buildSheetNodes() {
    const sh = S.sheet;
    if (!sh) return [h('p', { class: 'muted' }, 'ゲーム開始後に表示されます。')];
    const out = [];
    out.push(
      h('div', { class: 'card accent' },
        h('div', { class: 'muted small' }, 'あなたは'),
        h('div', { class: 'role-name' }, sh.name),
        h('div', { class: 'role-kana' }, [sh.kana, `${sh.age}歳`, sh.role].filter(Boolean).join('　')),
        h('dl', { class: 'kv', style: 'margin-top:12px' },
          h('dt', null, '性格'), h('dd', null, sh.personality),
          h('dt', null, '公開プロフィール'), h('dd', null, sh.publicProfile),
          sh.witchRelation ? h('dt', null, '魔女との関係') : null, sh.witchRelation ? h('dd', null, sh.witchRelation) : null
        )
      )
    );
    if (sh.isCulprit) {
      out.push(
        h('div', { class: 'card danger' },
          h('h3', null, 'あなたが犯人です'),
          h('p', { class: 'pre' }, sh.culpritNote || ''),
          h('p', { class: 'small muted', style: 'margin-top:8px' }, 'この情報は、あなた以外には送信されていません。')
        )
      );
    }
    if (sh.secret) {
      out.push(
        h('div', { class: 'secret-box' }, h('h3', null, 'あなたの秘密'), h('p', { class: 'pre' }, sh.secret)),
        h('div', { class: 'card' }, h('h3', null, '個人的な目的（最終目標）'), ...sh.goals.map((g) => h('div', { class: 'goal' }, g.text))),
        sh.suspicious ? h('div', { class: 'card' }, h('h3', null, '疑われやすい行動'), h('p', { class: 'pre' }, sh.suspicious)) : null
      );
    }
    out.push(
      h('div', { class: 'card' },
        h('h3', null, '他の登場人物との関係'),
        ...sh.relationships.map((r) => h('dl', { class: 'kv' }, h('dt', null, r.name), h('dd', null, r.text)))
      )
    );
    const hand = S.hand || [];
    if (hand.length) {
      out.push(h('h3', null, '知っている情報'));
      hand.forEach((k) => out.push(clueCard(k, { publishable: S.canPublish })));
    }
    return out;
  }
  function buildSheetView() {
    return [h('p', { class: 'hint' }, 'ここはあなたにしか見えません。'), ...buildSheetNodes()];
  }

  // ---- 作業パネル（調査・情報公開） ----
  function buildWork() {
    const out = [];
    if (DISCUSS.includes(S.phase)) {
      out.push(
        h('div', { class: 'card' },
          h('h3', null, '話し合いのヒント'),
          ...S.discussionPrompts.map((t) => h('div', { class: 'goal' }, t)),
          h('div', { class: 'row gap', style: 'margin-top:10px' },
            h('button', { class: 'btn primary', style: 'flex:1', onclick: () => setTab('chat') }, '全体チャット'),
            activeChat()
              ? h('button', { class: 'btn danger', style: 'flex:1', onclick: () => setTab('secret') }, `密談中：${activeChat().other.name}`)
              : h('button', { class: 'btn', style: 'flex:1', onclick: openPicker }, '密談する')
          )
        )
      );
    }
    const fresh = S.publicClues.filter((c) => c.system && c.phase === S.phase);
    if (fresh.length) {
      out.push(h('h3', null, S.phase === 'extra' ? '新たに判明したこと' : '現場の状況'));
      fresh.forEach((c) => out.push(clueCard(c, { isNew: true })));
    }
    if (S.canInvestigate) {
      const left = S.me.investigationsLeft;
      out.push(
        h('div', { class: 'row between' }, h('h3', null, '場所を調べる'), h('span', { class: 'tag' + (left ? ' host' : '') }, `残り${left}回`)),
        h('div', { class: 'place-grid' },
          ...S.places.map((pl) =>
            h('button', {
              class: 'place' + (pl.done ? ' done' : ''),
              disabled: pl.done || left === 0,
              onclick: async () => { if (await act('investigate', { placeId: pl.id })) toast(`「${pl.name}」を調べました。資料に追加されました`); }
            }, h('b', null, pl.name), h('small', null, pl.done ? '調査済み' : pl.desc))
          )
        )
      );
    }
    const hand = S.hand || [];
    out.push(h('div', { class: 'row between' }, h('h3', null, 'あなたが持つ情報'), h('span', { class: 'muted small' }, '公開するものを選べます')));
    if (!hand.length) out.push(h('p', { class: 'muted' }, 'まだありません。場所を調べると増えます。'));
    hand.forEach((k) => out.push(clueCard(k, { publishable: S.canPublish })));
    out.push(
      h('button', { class: 'btn', onclick: () => setTab('board') }, `公開された証拠を見る（${S.publicClues.length}件）`),
      skipBar()
    );
    return out;
  }

  // ---- 証拠タブ ----
  function buildBoard() {
    const list = S.publicClues;
    if (!list.length) return [h('p', { class: 'muted center', style: 'padding:40px 0' }, 'まだ公開された証拠はありません。')];
    return [
      h('p', { class: 'hint' }, `公開済みの証拠（${list.length}件）。全員に同じものが見えています。`),
      ...list.map((c, i) =>
        clueCard(c, { isNew: i >= boardFrom && tab === 'board' && boardFrom < list.length, by: c.system ? '捜査で判明' : `${c.by} が公開` })
      )
    ];
  }

  // ---- 投票 ----
  function buildVote() {
    const out = [guideCard()];
    const mine = S.me.charId;
    const chars = (S.characters || []).filter((c) => c.id !== mine);
    out.push(
      h('div', { class: 'stack' },
        ...chars.map((c) =>
          h('button', {
            class: 'vote-card' + (voteSel === c.id ? ' sel' : ''),
            onclick: () => { voteSel = c.id; render(); }
          },
            h('span', { class: 'radio' }),
            h('span', null,
              h('span', { class: 'cn' }, c.name),
              h('div', { class: 'muted small' }, `${c.role}　${c.npc ? 'NPC' : c.playerName}`)
            )
          )
        )
      )
    );
    const voted = S.me.vote;
    out.push(
      h('button', {
        class: 'btn primary big',
        disabled: !voteSel || voteSel === voted,
        onclick: async () => { if (await act('vote', { charId: voteSel })) toast('投票しました'); }
      }, voted ? (voteSel === voted ? `投票済み：${charName(voted)}` : '投票先を変更する') : '投票を確定する'),
      h('p', { class: 'hint center' }, `${S.votesCast} / ${S.votersTotal}人が投票済み。全員が投票すると結果発表へ進みます。`)
    );
    return out;
  }

  // ---- 結果 ----
  function buildResult() {
    const R = S.result;
    if (!R) return [h('p', { class: 'muted' }, '集計中…')];
    const out = [
      h('div', { class: 'seg' },
        ...[['result', '結果'], ['truth', '真相'], ['ending', 'エンディング']].map(([k, label]) =>
          h('button', { class: resultTab === k ? 'on' : '', onclick: () => { resultTab = k; render(); } }, label)
        )
      )
    ];
    if (resultTab === 'result') {
      out.push(h('p', { class: 'hint center' }, `${R.scenarioTitle || ''}${R.variant ? '（' + R.variant + '）' : ''}`));
      const maxC = Math.max(1, ...R.tally.map((t) => t.count));
      out.push(
        h('div', { class: 'card danger center' },
          h('div', { class: 'muted small' }, '真犯人は'),
          h('div', { class: 'role-name' }, R.culpritName),
          h('div', { class: 'muted' }, R.culpritPlayer ? `担当：${R.culpritPlayer}` : 'NPC')
        ),
        h('div', { class: 'verdict ' + (R.caught ? 'ok' : 'bad') }, R.caught ? '犯人は捕らえられた' : '犯人は逃げ切った'),
        h('div', { class: 'card' },
          h('h3', null, '得票数'),
          ...R.tally.map((t) =>
            h('div', { class: 'bar-row' + (R.top.includes(t.charId) ? ' top' : '') },
              h('span', null, t.name),
              h('span', { class: 'track' }, h('i', { style: `width:${(t.count / maxC) * 100}%` })),
              h('b', null, String(t.count))
            )
          ),
          R.top.length > 1 ? h('p', { class: 'hint' }, '同数で最多票が分かれたため、犯人は特定されませんでした。') : null
        ),
        h('div', { class: 'card' },
          h('h3', null, '誰が誰に投票したか'),
          ...R.votes.map((v) => h('div', { class: 'small', style: 'padding:3px 0' }, `${v.voter}（${v.voterChar}）→ ${v.target}`))
        ),
        h('button', { class: 'btn primary big', onclick: () => { resultTab = 'truth'; render(); } }, '事件の真相を見る')
      );
    } else if (resultTab === 'truth') {
      out.push(
        h('div', { class: 'card accent' },
          h('h3', null, R.truth.title),
          ...R.truth.steps.map((t, i) => h('div', { class: 'step' }, h('b', null, String(i + 1)), h('span', null, t))),
          h('p', { class: 'pre', style: 'margin-top:10px' }, '動機：' + R.truth.motive)
        ),
        h('h3', null, '全員の秘密と目的'),
        ...R.characters.map((c) =>
          h('div', { class: 'card' },
            h('div', { class: 'row between' }, h('b', { class: 'cn' }, c.name), h('span', { class: 'tag' }, c.playerName || 'NPC')),
            h('p', { class: 'pre small', style: 'margin:6px 0' }, c.secret.replace('【あなたが犯人です】', '【犯人】')),
            ...c.goals.map((g) => h('div', { class: 'goal ' + (g.achieved === true ? 'done' : g.achieved === false ? 'fail' : '') }, g.text))
          )
        ),
        h('button', { class: 'btn primary big', onclick: () => { resultTab = 'ending'; render(); } }, 'エンディングを見る')
      );
    } else {
      const mine = R.characters.find((c) => c.playerId === S.me.id) || R.characters.find((c) => c.id === S.me.charId);
      if (mine) {
        out.push(
          h('div', { class: 'card accent' },
            h('div', { class: 'muted small' }, 'あなたのエンディング'),
            h('div', { class: 'role-name', style: 'margin-bottom:8px' }, mine.name),
            h('p', { class: 'ending' }, mine.ending),
            h('div', { style: 'margin-top:12px' }, h('h3', null, 'あなたの結果'), ...summaryRows(mine, R)),
            h('div', { style: 'margin-top:12px' }, h('h3', null, '個人目標'),
              ...mine.goals.map((g) => h('div', { class: 'goal ' + (g.achieved === true ? 'done' : g.achieved === false ? 'fail' : '') }, g.text))
            )
          )
        );
      }
      out.push(
        h('h3', null, 'みんなのエンディング'),
        ...R.characters.filter((c) => !mine || c.id !== mine.id).map((c) =>
          h('details', { class: 'card' },
            h('summary', null, `${c.name}（${c.playerName || 'NPC'}）`),
            h('p', { class: 'ending', style: 'margin-top:8px' }, c.ending)
          )
        ),
        h('div', { class: 'stack', style: 'margin-top:8px' },
          h('button', { class: 'btn primary big', onclick: () => act('again') }, 'もう一度遊ぶ'),
          h('button', { class: 'btn big', onclick: () => act('lobby') }, 'ロビーに戻る')
        ),
        h('p', { class: 'hint center' }, 'どちらも、全員がロビーに戻ります（結果はここで消えます）。')
      );
    }
    return out;
  }


  // =====================================================================
  //  密談（2人だけの専用チャット）
  // =====================================================================
  const scList = () => (S && S.secretChat && S.secretChat.chats) || [];
  const activeChat = () => scList().find((c) => c.status === 'active') || null;
  const pendingIncoming = () => scList().filter((c) => c.status === 'pending' && !c.mine);
  const pendingOutgoing = () => scList().filter((c) => c.status === 'pending' && c.mine);

  function onScMeta(m) {
    if (!S) return;
    const arr = S.secretChat.chats;
    const i = arr.findIndex((c) => c.id === m.id);
    if (i >= 0) arr[i] = m; else arr.push(m);
    checkScTransitions();
    if (S.phase !== 'lobby') renderGame();
  }
  function checkScTransitions() {
    for (const c of scList()) {
      const prev = scSeen[c.id];
      if (scReady && prev !== c.status) {
        if (c.status === 'pending' && !c.mine) { toast(`${c.other.name}から密談の申請が届いています`); try { navigator.vibrate && navigator.vibrate([60, 40, 60]); } catch (e) {} }
        else if (c.status === 'active') { toast(`${c.other.name}との密談が始まりました`); tab = 'secret'; unreadSecret = 0; }
        else if (c.status === 'declined' && c.mine) toast(`${c.other.name}に密談を断られました`, true);
        else if (c.status === 'expired' && c.mine) toast('密談の申請が時間切れになりました', true);
        else if (c.status === 'ended') toast(c.reason || '密談が終了しました');
      }
      scSeen[c.id] = c.status;
    }
    scReady = true;
  }
  function onScMsg(d) {
    (scMsgs[d.chatId] = scMsgs[d.chatId] || []).push(d.msg);
    if (S && d.msg.from && d.msg.from !== S.me.id && tab !== 'secret') {
      unreadSecret++;
      const bs = $('#badge-secret');
      bs.hidden = false;
      bs.textContent = pendingIncoming().length + unreadSecret;
    }
    if (S && S.phase !== 'lobby') renderSecret();
  }

  function renderScAlert() {
    const box = $('#sc-alert');
    const inc = pendingIncoming()[0];
    if (!inc || !S || S.phase === 'lobby') { box.hidden = true; box.replaceChildren(); return; }
    box.hidden = false;
    box.replaceChildren(
      h('div', { class: 't' }, `${inc.other.name}${inc.other.charName ? `（${inc.other.charName}）` : ''}から密談の申請が届いています`),
      h('button', { class: 'btn primary', onclick: () => act('sc_respond', { chatId: inc.id, accept: true }) }, '許可'),
      h('button', { class: 'btn', onclick: () => act('sc_respond', { chatId: inc.id, accept: false }) }, '拒否')
    );
  }

  function openPicker() {
    if (!S.secretChat.enabled) return toast('密談できるのは、議論のフェーズ中だけです', true);
    if (activeChat()) return toast('いま密談中です。先に終了してください', true);
    const cand = S.players.filter((p) => p.id !== S.me.id && !p.npc && !p.left);
    const body = h('div', null,
      h('h3', null, '誰と密談しますか？'),
      h('p', { class: 'hint' }, '相手が許可すると、あなたと相手だけの専用チャットが開きます。他の人には、内容も申請も見えません。'),
      ...cand.map((p) => {
        const ch = (S.characters || []).find((c) => c.playerId === p.id);
        return h('button', {
          class: 'pick',
          disabled: !p.connected,
          onclick: async () => {
            $('#modal').hidden = true;
            if (await act('sc_request', { toId: p.id })) toast(`${p.name}に密談を申請しました`);
          }
        }, h('b', null, p.name), h('small', null, [ch ? ch.name : '', !p.connected ? '接続切れ' : ''].filter(Boolean).join('　')));
      })
    );
    showModal(body, [{ label: 'やめる' }]);
  }

  // 密談画面（相手の名前 / 密談チャット / メッセージ入力 / 送信 / 密談終了）
  const scView = { activeId: null, list: null, title: null, form: null, input: null };
  function scMsgEl(m, otherName) {
    if (!m.from) return h('li', { class: 'msg sys' }, m.text);
    const mine = m.from === S.me.id;
    return h('li', { class: 'msg' + (mine ? ' mine' : '') },
      h('span', { class: 'who' }, mine ? 'あなた' : otherName),
      h('span', { class: 'bubble' }, m.text)
    );
  }
  function scrollSecret() {
    requestAnimationFrame(() => { if (scView.list) scView.list.scrollTop = scView.list.scrollHeight; });
  }
  function renderSecret() {
    const el = $('#view-secret');
    const ac = S ? activeChat() : null;
    if (ac) {
      if (scView.activeId !== ac.id) {
        scView.activeId = ac.id;
        el.className = 'view secret-chat';
        scView.title = h('span', { class: 'nm' });
        const endBtn = h('button', { class: 'btn danger small', onclick: async () => { if (await confirmDialog('この密談を終了しますか？', '終了する', true)) act('sc_end', { chatId: scView.activeId }); } }, '密談終了');
        scView.list = h('ul', { class: 'chat-list' });
        scView.input = h('input', { maxlength: '300', placeholder: 'ここは2人だけの会話です', enterkeyhint: 'send', autocomplete: 'off', 'aria-label': '密談メッセージ' });
        scView.form = h('form', { class: 'chat-form', autocomplete: 'off' }, scView.input, h('button', { class: 'btn primary', type: 'submit' }, '送信'));
        scView.form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const text = scView.input.value.trim();
          if (!text) return;
          scView.input.value = '';
          const ok = await act('sc_send', { chatId: scView.activeId, text });
          if (!ok) scView.input.value = text;
          scView.input.focus();
        });
        el.replaceChildren(
          h('div', { class: 'sc-head' }, scView.title, endBtn),
          h('div', { class: 'sc-note' }, 'この会話は、あなたと相手の2人にしか見えません。'),
          scView.list,
          scView.form
        );
      }
      scView.title.textContent = `密談：${ac.other.name}`;
      const near = scView.list.scrollHeight - scView.list.scrollTop - scView.list.clientHeight < 90;
      const msgs = scMsgs[ac.id] || [];
      scView.list.replaceChildren(...msgs.map((m) => scMsgEl(m, ac.other.name)));
      if (near || scView.list.scrollTop === 0) scrollSecret();
      return;
    }
    scView.activeId = null;
    el.className = 'view scroll';
    renderInto(el, buildSecretIdle);
  }

  function buildSecretIdle() {
    const out = [];
    const enabled = S.secretChat.enabled;
    out.push(
      h('div', { class: 'card accent' },
        h('h3', null, '密談'),
        h('p', { class: 'small' }, '気になる相手と、2人だけで話せます。相手が許可すると、専用のチャットが開きます。他の人には、内容も、申請したことも見えません。'),
        h('button', { class: 'btn primary big', style: 'margin-top:10px', disabled: !enabled, onclick: openPicker }, '密談する'),
        !enabled ? h('p', { class: 'hint', style: 'margin-top:8px' }, '密談できるのは、議論のフェーズ中だけです。') : null
      )
    );
    const inc = pendingIncoming();
    if (inc.length) {
      out.push(h('h3', null, '届いている申請'));
      inc.forEach((c) =>
        out.push(
          h('div', { class: 'card' },
            h('p', null, `${c.other.name}${c.other.charName ? `（${c.other.charName}）` : ''}から密談の申請`),
            h('div', { class: 'row gap', style: 'margin-top:10px' },
              h('button', { class: 'btn primary', style: 'flex:1', onclick: () => act('sc_respond', { chatId: c.id, accept: true }) }, '許可'),
              h('button', { class: 'btn', style: 'flex:1', onclick: () => act('sc_respond', { chatId: c.id, accept: false }) }, '拒否')
            )
          )
        )
      );
    }
    pendingOutgoing().forEach((c) =>
      out.push(
        h('div', { class: 'card' },
          h('p', null, `${c.other.name}の返事を待っています…`),
          h('button', { class: 'btn small', style: 'margin-top:10px', onclick: () => act('sc_cancel', { chatId: c.id }) }, '申請を取り消す')
        )
      )
    );
    const past = scList().filter((c) => c.status === 'ended' && (scMsgs[c.id] || []).some((m) => m.from));
    if (past.length) {
      out.push(h('h3', null, 'これまでの密談'));
      past.slice().reverse().forEach((c) =>
        out.push(
          h('details', { class: 'sc-hist' },
            h('summary', null, `${c.other.name}との密談`),
            h('ul', { class: 'chat-list', style: 'padding:8px 0 0' }, ...(scMsgs[c.id] || []).map((m) => scMsgEl(m, c.other.name)))
          )
        )
      );
    }
    return out;
  }

  // ---- 結果: 犯人を当てたか / 個人目標 / 秘密を守れたか ----
  function summaryRows(mine, R) {
    const mark = (v) => (v === true ? '○ 達成' : v === false ? '× 未達成' : '－');
    const row = (label, v) => h('div', { class: 'goal ' + (v === true ? 'done' : v === false ? 'fail' : '') }, `${label}：${mark(v)}`);
    const rows = [];
    const byType = (t) => mine.goals.find((g) => g.type === t);
    if (mine.id === R.culpritId) {
      rows.push(row('犯人だとバレずに逃げ切った', byType('escape') ? byType('escape').achieved : null));
    } else {
      rows.push(row('犯人を当てた', byType('vote_culprit') ? byType('vote_culprit').achieved : null));
    }
    if (byType('secret_hidden')) rows.push(row('自分の秘密を守れた', byType('secret_hidden').achieved));
    mine.goals.filter((g) => ['caught', 'caught_clue', 'not_top'].includes(g.type)).forEach((g) => rows.push(row(g.text, g.achieved)));
    return rows;
  }

  // =====================================================================
  //  チャット
  // =====================================================================
  const chatList = $('#chat-list');
  function chatEl(m) {
    if (m.type === 'system') return h('li', { class: 'msg sys' }, m.text);
    const mine = S && m.playerId === S.me.id;
    return h('li', { class: 'msg' + (mine ? ' mine' : '') },
      h('span', { class: 'who' }, m.name + (m.charName ? `（${m.charName}）` : '')),
      h('span', { class: 'bubble' }, m.text)
    );
  }
  function nearBottom() { return chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 90; }
  function scrollChat(force) {
    requestAnimationFrame(() => { chatList.scrollTop = chatList.scrollHeight; });
    void force;
  }
  function rebuildChat() {
    chatList.replaceChildren(...chat.map(chatEl));
    scrollChat(true);
  }
  function onChat(m) {
    chat.push(m);
    const stick = nearBottom() || (S && m.playerId === S.me.id);
    chatList.appendChild(chatEl(m));
    if (stick) scrollChat();
    if (m.type === 'chat' && S && m.playerId !== S.me.id && tab !== 'chat' && S.phase !== 'lobby') {
      unreadChat++;
      const bc = $('#badge-chat');
      bc.hidden = false;
      bc.textContent = unreadChat > 99 ? '99+' : unreadChat;
    }
  }
  $('#chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = $('#chat-input');
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    const ok = await act('chat', { text });
    if (!ok) inp.value = text;
    inp.focus();
  });

  // =====================================================================
  //  起動
  // =====================================================================
  (function init() {
    const params = new URLSearchParams(location.search);
    const room = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (session) {
      show('title');
      connect(); // ページ更新・ブラウザ復帰でも同じ部屋へ自動復帰
    } else if (room.length === 6) {
      openEntry('join', room);
    } else {
      show('title');
    }
    if (window.history && room) history.replaceState(null, '', location.pathname);
  })();
})();
