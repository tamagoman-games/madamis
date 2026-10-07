'use strict';
/**
 * ブラウザUIテスト（Playwright）: スマホサイズの3つのブラウザが、実際にボタンを押して
 * ロビー → 全フェーズ → 投票 → 結果 まで進めます。コンソールエラーが出ないことも確認します。
 *
 *   NODE_PATH=$(npm root -g) node test/ui.js        （Playwright と Chromium が必要）
 */
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const { chromium } = require('playwright');

const PORT = 3700 + Math.floor(Math.random() * 200);
const BASE = process.env.TEST_BASE_URL || `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS || path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = process.env.TEST_BASE_URL ? null : spawn('node', [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'inherit', 'inherit']
  });
  if (server) await sleep(600);
  const chromiumPath = process.env.CHROMIUM_PATH ||
    (fs.existsSync('/repl/tools/bin/chromium') ? '/repl/tools/bin/chromium' : undefined);
  const browser = await chromium.launch({
    ...(chromiumPath ? { executablePath: chromiumPath } : {})
  });
  const errors = [];
  let failed = false;
  try {
    const mk = async (name) => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP' });
      const page = await ctx.newPage();
      page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|ERR_(NAME|INTERNET|CONNECTION|FAILED)|Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
      page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
      return { name, ctx, page };
    };
    const users = [await mk('ホスト'), await mk('アキ'), await mk('ベル'), await mk('シズ')];
    const [host, p2, p3, p4] = users;
    const shot = (u, n) => u.page.screenshot({ path: path.join(SHOTS, `${n}.png`) });

    // タイトル → 部屋作成
    await host.page.goto(BASE);
    await host.page.waitForSelector('#title-create');
    await shot(host, '01-title');
    await host.page.click('#title-create');
    await host.page.fill('#entry-name', 'ホスト');
    await shot(host, '02-entry');
    await host.page.click('#entry-go');
    await host.page.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.querySelector('#lobby-code').textContent));
    const code = await host.page.textContent('#lobby-code');
    console.log('room code:', code);

    // 参加
    for (const u of [p2, p3, p4]) {
      await u.page.goto(BASE);
      await u.page.click('#title-join');
      await u.page.fill('#entry-name', u.name);
      await u.page.fill('#entry-code', code.toLowerCase()); // 小文字でもOK
      await u.page.click('#entry-go');
      await u.page.waitForSelector('#screen-lobby:not([hidden])');
    }
    await host.page.waitForFunction(() => document.querySelectorAll('#lobby-players li').length === 4);
    assert.strictEqual(await host.page.isDisabled('#lobby-main'), true, 'host cannot start before ready');
    await shot(host, '03-lobby-host');
    for (const u of [p2, p3, p4]) await u.page.click('#lobby-main');
    await host.page.waitForFunction(() => !document.querySelector('#lobby-main').disabled);
    await shot(p2, '04-lobby-player');
    await host.page.click('#lobby-main');

    const phaseOf = (u) => u.page.textContent('#g-phase');
    const waitPhase = async (label) => {
      for (const u of users) await u.page.waitForFunction((l) => document.querySelector('#g-phase').textContent === l, label, { timeout: 8000 });
    };
    const skipAll = async () => {
      for (const u of users) {
        await u.page.click('#g-tabs button[data-tab=main]'); // 議論中はチャットが開いているので「進行」タブへ
        await u.page.click('.skipbar .btn');
      }
    };
    await waitPhase('キャラクター決定');
    await shot(host, '05-character');

    await skipAll(); await waitPhase('オープニング');
    await shot(host, '06-opening');
    await skipAll(); await waitPhase('個人情報確認');
    await shot(host, '07-personal');
    // 資料タブ
    await host.page.click('#g-tabs button[data-tab=sheet]');
    await shot(host, '08-sheet');
    await host.page.click('#g-tabs button[data-tab=main]');
    await skipAll(); await waitPhase('情報公開');

    // 調査 → 公開
    await host.page.click('.place:has-text("ホール")');
    await host.page.waitForFunction(() => /残り1回/.test(document.querySelector('#view-main').textContent));
    await host.page.click('.clue:has-text("暖炉の灰の中の写真") button:has-text("全員に公開")');
    await p2.page.waitForFunction(() => !document.querySelector('#badge-board').hidden);
    await shot(host, '09-info');
    await p2.page.click('#g-tabs button[data-tab=board]');
    await p2.page.waitForFunction(() => /暖炉の灰の中の写真/.test(document.querySelector('#view-board').textContent));
    await shot(p2, '10-board');
    await p2.page.click('#g-tabs button[data-tab=main]');

    await skipAll(); await waitPhase('議論');
    // 議論: 自動でチャットタブ。メッセージ送信
    await host.page.waitForSelector('#view-chat:not([hidden])');
    await host.page.fill('#chat-input', '0時の鐘のとき、みんなどこにいた？');
    await host.page.click('#chat-form button');
    await p3.page.waitForFunction(() => /0時の鐘のとき/.test(document.querySelector('#chat-list').textContent));
    await p3.page.click('#g-tabs button[data-tab=chat]');
    await p3.page.fill('#chat-input', '<img src=x onerror=alert(1)> 私は廊下にいました');
    await p3.page.click('#chat-form button');
    await host.page.waitForFunction(() => /廊下にいました/.test(document.querySelector('#chat-list').textContent));
    assert.strictEqual(await host.page.locator('#chat-list img').count(), 0, 'no HTML injection');
    await shot(host, '11-chat');

    // ページ更新で復帰（スマホのブラウザ復帰相当）
    await p2.page.reload();
    await p2.page.waitForSelector('#screen-game:not([hidden])');
    assert.strictEqual(await phaseOf(p2), '議論', 'restored to same phase after reload');
    await p2.page.waitForFunction(() => /廊下にいました/.test(document.querySelector('#chat-list').textContent));

    // 通信断 → 復帰
    await p3.ctx.setOffline(true);
    await sleep(500);
    await p3.ctx.setOffline(false);

    await skipAll(); await waitPhase('追加情報');
    await shot(host, '12-extra');
    await skipAll(); await waitPhase('最終議論');
    await skipAll(); await waitPhase('投票');
    await shot(host, '13-vote');
    // 投票: 各自、いちばん上の候補を選んで確定
    for (const u of users) {
      await u.page.click('#view-main .vote-card >> nth=0');
      await u.page.click('#view-main .btn.primary.big');
    }
    await waitPhase('結果発表');
    await shot(host, '14-result');
    await host.page.click('.seg button:has-text("真相")');
    await shot(host, '15-truth');
    await host.page.click('.seg button:has-text("エンディング")');
    await shot(host, '16-ending');
    assert(/あなたのエンディング/.test(await host.page.textContent('#view-main')), 'ending shown');

    // ロビーに戻る
    await host.page.click('button:has-text("ロビーに戻る")');
    for (const u of users) await u.page.waitForSelector('#screen-lobby:not([hidden])');
    console.log('\n✅ UIテスト成功');
  } catch (e) {
    failed = true;
    console.error('\n❌ UIテスト失敗:', e.message);
  } finally {
    if (errors.length) {
      failed = true;
      console.error('コンソールエラー:\n' + errors.join('\n'));
    }
    await browser.close();
    if (server) server.kill();
    process.exit(failed ? 1 : 0);
  }
})();
