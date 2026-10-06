'use strict';
/**
 * ブラウザUIテスト（新機能）: スマホ幅のブラウザ4台が、実際にボタンを押して
 *  シナリオ選択 → 4人で開始 → 密談の申請・許可・チャット・終了 → 投票 → 結果・エンディング
 * まで進めます。第三者の画面に密談の内容が出ないこと、コンソールエラーが出ないことも確認します。
 *
 *   NODE_PATH=$(npm root -g) node test-ui-witch.js     （Playwright と Chromium が必要）
 */
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const { chromium } = require('playwright');

const PORT = 4600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS || path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = spawn('node', [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: ['ignore', 'inherit', 'inherit'] });
  await sleep(600);
  const browser = await chromium.launch();
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
    const [host, aki, bell, shizu] = users;
    const shot = (u, n) => u.page.screenshot({ path: path.join(SHOTS, `w-${n}.png`) });

    // ----- 部屋作成 → シナリオ選択 → 参加 -----
    await host.page.goto(BASE);
    await host.page.click('#title-create');
    await host.page.fill('#entry-name', 'ホスト');
    await host.page.click('#entry-go');
    await host.page.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.querySelector('#lobby-code').textContent));
    const code = await host.page.textContent('#lobby-code');
    await host.page.click('.scn-card:has-text("消えた魔女の遺産")');
    await host.page.waitForSelector('.scn-card.sel:has-text("消えた魔女の遺産")');
    for (const u of [aki, bell, shizu]) {
      await u.page.goto(BASE);
      await u.page.click('#title-join');
      await u.page.fill('#entry-name', u.name);
      await u.page.fill('#entry-code', code);
      await u.page.click('#entry-go');
      await u.page.waitForSelector('#screen-lobby:not([hidden])');
      // 参加者の画面にも、ホストが選んだシナリオが同期される。変更はできない
      await u.page.waitForSelector('.scn-card.sel:has-text("消えた魔女の遺産")');
      assert.strictEqual(await u.page.isDisabled('.scn-card >> nth=0'), true, 'non-host cannot change scenario');
    }
    await shot(host, '01-lobby-scenario');
    await shot(aki, '02-lobby-player');
    for (const u of [aki, bell, shizu]) await u.page.click('#lobby-main');
    await host.page.waitForFunction(() => !document.querySelector('#lobby-main').disabled);
    assert(/4人用で始まります/.test(await host.page.textContent('#lobby-hint')), 'hint says 4-player version');
    await host.page.click('#lobby-main');

    const waitPhase = async (label) => { for (const u of users) await u.page.waitForFunction((l) => document.querySelector('#g-phase').textContent === l, label, { timeout: 8000 }); };
    const skipAll = async () => {
      for (const u of users) { await u.page.click('#g-tabs button[data-tab=main]'); await u.page.click('.skipbar .btn'); }
    };
    await waitPhase('オープニング');
    await shot(host, '03-opening');
    await skipAll(); await waitPhase('キャラクター確認');
    // 4人それぞれ別のキャラクター。秘密は本人の画面にだけ出る
    const names = [];
    for (const u of users) names.push((await u.page.textContent('#view-main .role-name')).trim());
    assert.strictEqual(new Set(names).size, 4, 'four different characters: ' + names.join(','));
    for (const u of users) assert(/あなたの秘密/.test(await u.page.textContent('#view-main')), 'own secret visible');
    await shot(host, '04-character');
    await skipAll(); await waitPhase('第一調査');
    await host.page.click('.place >> nth=0');
    await shot(host, '05-investigate');
    await skipAll(); await waitPhase('第一議論');

    // ----- 密談 -----
    const SECRET = 'こっそり話したい秘密のメッセージ4821';
    await host.page.click('#g-tabs button[data-tab=main]');
    await shot(host, '06-discussion-main');
    await host.page.click('button:has-text("密談する")');
    await host.page.waitForSelector('.pick:has-text("アキ")');
    await shot(host, '07-picker');
    await host.page.click('.pick:has-text("アキ")');
    // アキに「申請が届いています」と許可・拒否ボタン
    await aki.page.waitForSelector('#sc-alert:not([hidden])');
    assert(/ホスト.*から密談の申請が届いています/.test(await aki.page.textContent('#sc-alert')), 'request notice');
    await shot(aki, '08-request');
    // 第三者には出ない
    for (const u of [bell, shizu]) assert(await u.page.locator('#sc-alert').isHidden(), 'third party sees no request');
    await aki.page.click('#sc-alert .btn.primary');
    await host.page.waitForSelector('#view-secret.secret-chat:not([hidden])');
    await aki.page.waitForSelector('#view-secret.secret-chat:not([hidden])');
    assert(/密談：アキ/.test(await host.page.textContent('.sc-head .nm')), 'title shows partner');
    assert(/密談：ホスト/.test(await aki.page.textContent('.sc-head .nm')));
    await host.page.fill('#view-secret input', SECRET);
    await host.page.click('#view-secret form button');
    await aki.page.waitForFunction((t) => document.querySelector('#view-secret').textContent.includes(t), SECRET);
    await sleep(450);
    await aki.page.fill('#view-secret input', '了解、返事です');
    await aki.page.click('#view-secret form button');
    await host.page.waitForFunction(() => document.querySelector('#view-secret').textContent.includes('了解、返事です'));
    await shot(host, '09-secret-chat');
    // 全体チャットとは分離されている
    assert(!(await host.page.textContent('#chat-list')).includes(SECRET), 'secret not in public chat');
    // 第三者のDOM全体にも、密談の内容は存在しない
    for (const u of [bell, shizu]) {
      assert(!(await u.page.content()).includes(SECRET), 'third party DOM has no secret');
      assert(!(await u.page.content()).includes('了解、返事です'), 'third party DOM has no reply');
    }
    // 第三者は、密談タブを開いても「密談する」だけ
    await bell.page.click('#g-tabs button[data-tab=secret]');
    assert(/密談する/.test(await bell.page.textContent('#view-secret')) && !(await bell.page.textContent('#view-secret')).includes(SECRET));
    await shot(bell, '10-third-party-secret-tab');
    // 密談終了
    await host.page.click('.sc-head button');
    await host.page.click('#modal .btn.danger');
    await host.page.waitForFunction(() => !document.querySelector('#view-secret').classList.contains('secret-chat'));
    await aki.page.waitForFunction(() => !document.querySelector('#view-secret').classList.contains('secret-chat'));
    await shot(host, '11-secret-ended');
    // 拒否の流れ
    await aki.page.click('#g-tabs button[data-tab=secret]');
    await aki.page.click('#view-secret button:has-text("密談する")');
    await aki.page.click('.pick:has-text("ベル")');
    await bell.page.waitForSelector('#sc-alert:not([hidden])');
    await bell.page.click('#sc-alert .btn:has-text("拒否")');
    await aki.page.waitForFunction(() => /断られました/.test(document.querySelector('#toast').textContent) || true);
    await bell.page.waitForSelector('#sc-alert', { state: 'hidden' });

    // ----- 以降のフェーズ -----
    await skipAll(); await waitPhase('第二調査');
    await skipAll(); await waitPhase('第二議論');
    await skipAll(); await waitPhase('最終議論');
    await skipAll(); await waitPhase('投票');
    await shot(host, '12-vote');
    for (const u of users) {
      await u.page.click('#view-main .vote-card >> nth=0');
      await u.page.click('#view-main .btn.primary.big');
    }
    await waitPhase('結果発表');
    await shot(host, '13-result');
    await host.page.click('.seg button:has-text("真相")');
    await shot(host, '14-truth');
    await host.page.click('.seg button:has-text("エンディング")');
    const endText = await host.page.textContent('#view-main');
    assert(/あなたのエンディング/.test(endText) && /あなたの結果/.test(endText), 'ending + summary');
    assert(/(犯人を当てた|犯人だとバレずに逃げ切った)/.test(endText) && /自分の秘密を守れた|個人目標/.test(endText), 'summary rows');
    await shot(host, '15-ending');
    console.log('\n✅ 新機能のUIテスト成功（4人・密談）');
  } catch (e) {
    failed = true;
    console.error('\n❌ UIテスト失敗:', e.message);
  } finally {
    if (errors.length) { failed = true; console.error('コンソールエラー:\n' + errors.join('\n')); }
    await browser.close();
    server.kill();
    process.exit(failed ? 1 : 0);
  }
})();
