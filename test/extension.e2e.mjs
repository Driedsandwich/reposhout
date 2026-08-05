/*
 * 実拡張のE2Eテスト
 *
 * 出荷する9ファイルだけを別ディレクトリへ並べ、それを本物のChromeへ
 * Extensions.loadUnpacked で読み込む。manifest・service worker・
 * runtime message・chrome.windows を通した状態で挙動を確かめる。
 *
 * x.com と github.com はローカルのHTTPSサーバへ向けているので、
 * 外部ネットワークにも実アカウントにも依存しない。
 *
 * 実行: node --test test/extension.e2e.mjs  （npm test に含まれる）
 * 必要: Node 22+ / Chrome または Chromium / openssl
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, startTestServer, stageExtension, waitFor, sleep } from './helpers/chrome.mjs';
import { ROOT } from './helpers/load.mjs';

const INTENT = 'https://x.com/intent/post?text=hello&url=https%3A%2F%2Fgithub.com%2Fo%2Fr';

describe('実拡張E2E', { concurrency: 1 }, () => {
  let srv, chrome, cdp, extId;

  before(async () => {
    srv = await startTestServer();
    chrome = await launchChrome({ port: srv.port });
    cdp = chrome.cdp;
    const loaded = await cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
    extId = loaded.id;
  });

  after(async () => {
    if (chrome) chrome.kill();
    if (srv) await srv.close();
  });

  /* ---- 小道具 ---- */
  const targets = async () => (await cdp.send('Target.getTargets')).targetInfos;

  const findTarget = async (pred) => (await targets()).find(pred);

  async function swSession() {
    const t = await waitFor('service worker が起きる', async () =>
      (await targets()).find((x) => x.type === 'service_worker' && x.url.includes(extId)));
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    return sessionId;
  }

  async function evalInSw(expression) {
    const s = await swSession();
    const r = await cdp.send('Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true }, s);
    if (r.exceptionDetails) throw new Error(`SW評価で例外: ${JSON.stringify(r.exceptionDetails.exception)}`);
    return r.result.value;
  }

  /*
   * ターゲットごとにセッションを1つだけ張って使い回す。
   * 押すたびに attach し直すと、窓が閉じた直後に
   * 「Session with given id not found」で落ちる（実際にフレークになった）。
   */
  const sessions = new Map();
  async function attach(targetId) {
    if (sessions.has(targetId)) return sessions.get(targetId);
    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      sessions.set(targetId, sessionId);
      return sessionId;
    } catch (e) {
      return null;                       // 既に閉じている
    }
  }

  async function pressEscape(targetId, modifiers = 0) {
    const sessionId = await attach(targetId);
    if (!sessionId) return false;
    const base = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, modifiers };
    try {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, sessionId);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId);
      return true;
    } catch (e) {
      sessions.delete(targetId);         // 押している最中に閉じた
      return false;
    }
  }

  const stillOpen = async (targetId) => !!(await findTarget((t) => t.targetId === targetId));

  /* 読み込みが終わるまで待つ。content script が入る前に押すと当然何も起きない */
  async function waitLoaded(targetId) {
    const sessionId = await attach(targetId);
    if (!sessionId) return;
    await waitFor('ページの読み込みが終わる', async () => {
      try {
        await cdp.send('Runtime.enable', {}, sessionId);
        const r = await cdp.send('Runtime.evaluate',
          { expression: 'document.readyState', returnByValue: true }, sessionId);
        return r.result && r.result.value === 'complete';
      } catch (e) {
        return !(await stillOpen(targetId));   // 閉じたなら待つ理由が無い
      }
    }, { timeout: 10000, interval: 150 });
  }

  /*
   * 閉じるまで Esc を押す。
   * 1回きりだと、押した瞬間にまだ content script が動いていない環境で
   * 「閉じない」と誤判定する（CIで実際に起きた）。
   * 閉じないことを確かめる側のテストは1回きりのままにしてある。
   */
  async function escapeUntilClosed(targetId, { attempts = 10, interval = 900 } = {}) {
    for (let i = 0; i < attempts; i++) {
      if (!(await stillOpen(targetId))) return true;
      await pressEscape(targetId);
      await sleep(interval);
    }
    return !(await stillOpen(targetId));
  }

  async function openShareWindowFromSw(url = INTENT) {
    const r = await evalInSw(`self.GXS_BG.openShareWindow(${JSON.stringify(url)})`);
    assert.equal(r.opened, 'popup', 'ポップアップとして開かなかった');
    const t = await waitFor('共有ウィンドウのタブが出る', async () =>
      (await targets()).find((x) => x.type === 'page' && x.url.startsWith('https://x.com/intent/')));
    return { windowId: r.windowId, targetId: t.targetId };
  }

  /* ---- テスト ---- */

  it('出荷する9ファイルだけで拡張として読み込める', async () => {
    assert.match(extId, /^[a-p]{32}$/);
  });

  it('service worker が起動し、実装が読めている', async () => {
    const keys = await evalInSw('Object.keys(self.GXS_BG).sort().join(",")');
    assert.ok(keys.includes('openShareWindow'), keys);
    assert.equal(await evalInSw('typeof self.GXS.buildShare'), 'function');
  });

  it('共有ウィンドウを開くと windowId が session storage に記録される', async () => {
    const { windowId, targetId } = await openShareWindowFromSw();
    const rec = await evalInSw('self.GXS_BG.readRecords()');
    assert.ok(Object.prototype.hasOwnProperty.call(rec, String(windowId)),
      `記録が無い: ${JSON.stringify(rec)}`);
    assert.equal(await evalInSw(`self.GXS_BG.isShareWindow(${windowId})`), true);
    // 覚えの無いIDには false を返す
    assert.equal(await evalInSw(`self.GXS_BG.isShareWindow(${windowId + 9999})`), false);
    await waitLoaded(targetId);
    assert.ok(await escapeUntilClosed(targetId), '共有ウィンドウが閉じない');
  });

  it('service worker を止めた後でも、正規の共有ウィンドウは Esc で閉じる', async () => {
    const { targetId } = await openShareWindowFromSw();

    // MV3 の停止を再現する。止まったことを実測してから次へ進む。
    const sw = await findTarget((t) => t.type === 'service_worker' && t.url.includes(extId));
    assert.ok(sw, 'service worker のターゲットが見つからない');
    await cdp.send('Target.closeTarget', { targetId: sw.targetId });
    await waitFor('service worker が実際に止まる', async () =>
      !(await findTarget((t) => t.type === 'service_worker' && t.url.includes(extId))));

    await waitLoaded(targetId);
    assert.ok(await escapeUntilClosed(targetId), 'service worker 再起動後に閉じない');
  });

  it('利用者が自分で開いた x.com のタブは Esc で閉じない', async () => {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'https://x.com/home' });
    await sleep(800);
    await pressEscape(targetId);
    await sleep(1500);
    assert.equal(await stillOpen(targetId), true, '利用者のタブが閉じてしまった');
    await cdp.send('Target.closeTarget', { targetId });
  });

  it('window.name を偽装した窓は Esc で閉じない（RS-MAJ-03の回帰）', async () => {
    const { targetId: openerId } = await cdp.send('Target.createTarget', { url: 'https://x.com/opener' });
    const sessionId = await attach(openerId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Runtime.evaluate', {
      expression: "window.open('https://x.com/intent/post?forged=1','gxs-share-window','width=560,height=640')",
      userGesture: true
    }, sessionId);

    const forged = await waitFor('偽装ウィンドウが開く', async () =>
      (await targets()).find((t) => t.type === 'page' && t.url.includes('forged=1')));

    // 名前が本当に偽装できていることを先に確かめる（偽陰性を避ける）
    const fs = await attach(forged.targetId);
    await cdp.send('Runtime.enable', {}, fs);
    const nameRes = await cdp.send('Runtime.evaluate', { expression: 'window.name', returnByValue: true }, fs);
    assert.equal(nameRes.result.value, 'gxs-share-window', '偽装できておらず、テストが意味をなさない');

    await pressEscape(forged.targetId);
    await sleep(1500);
    assert.equal(await stillOpen(forged.targetId), true, '偽装した名前で閉じてしまった');

    await cdp.send('Target.closeTarget', { targetId: forged.targetId });
    await cdp.send('Target.closeTarget', { targetId: openerId });
  });

  it('修飾キーつきの Esc では閉じない', async () => {
    const { targetId } = await openShareWindowFromSw();
    await waitLoaded(targetId);
    await pressEscape(targetId, 8); // Shift
    await sleep(1200);
    assert.equal(await stillOpen(targetId), true, 'Shift+Esc で閉じてしまった');
    assert.ok(await escapeUntilClosed(targetId), '修飾なしのEscでも閉じない');
  });

  it('画面内Shareボタンから開いた窓も記録される（content script 経路）', async () => {
    // クリック前のターゲットと記録を控える。前のテストの残りを拾って誤判定しないため
    const before = new Set((await targets()).map((t) => t.targetId));
    const recBefore = await evalInSw('(async () => Object.keys(await self.GXS_BG.readRecords()))()');

    const { targetId: ghId } = await cdp.send('Target.createTarget', { url: 'https://github.com/octocat/Hello-World' });
    const sessionId = await attach(ghId);
    await cdp.send('Runtime.enable', {}, sessionId);

    await waitFor('Shareボタンが差し込まれる', async () => {
      const r = await cdp.send('Runtime.evaluate',
        { expression: '!!document.getElementById("gxs-share-btn")', returnByValue: true }, sessionId);
      return r.result.value === true;
    });

    /*
     * 表示文字が、ブラウザの表示言語に対応する言語ファイルと一致すること。
     *
     * 「英語で出るか」を直接書くと、テストを走らせた端末の言語で結果が変わる
     * （macOS では --lang=en-US を渡しても拡張の言語はシステム側が決めた・実測）。
     * 言語を固定する代わりに「選ばれた言語の表と一致するか」を見る。
     * ツールチップを日本語で直書きしていた状態は、英語環境で必ず落ちる。
     */
    const shownRes = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const b = document.getElementById('gxs-share-btn');
        return JSON.stringify({ text: b.textContent.trim(), title: b.title,
                                aria: b.getAttribute('aria-label') }); })()`,
      returnByValue: true
    }, sessionId);
    const shown = JSON.parse(shownRes.result.value);
    // chrome.i18n はページ側の世界に無いので、表示言語は service worker から取る
    const ui = await evalInSw('chrome.i18n.getUILanguage()');
    const locale = String(ui).toLowerCase().startsWith('ja') ? 'ja' : 'en';
    const messages = JSON.parse(readFileSync(join(ROOT, `_locales/${locale}/messages.json`), 'utf8'));
    assert.equal(shown.text, messages.shareButtonLabel.message, JSON.stringify(shown));
    assert.equal(shown.title, messages.shareButtonTooltip.message, JSON.stringify(shown));
    assert.equal(shown.aria, messages.shareButtonAria.message, JSON.stringify(shown));
    // 表示言語が英語なら、英語の文字列で出ていることまで言える
    if (locale === 'en') assert.equal(shown.title, 'Post this page to X');

    await cdp.send('Runtime.evaluate',
      { expression: 'document.getElementById("gxs-share-btn").click()', userGesture: true }, sessionId);

    const isNewShareWindow = (t) =>
      t.type === 'page' && t.url.startsWith('https://x.com/intent/') && !before.has(t.targetId);

    const win = await waitFor('共有ウィンドウが開く', async () => (await targets()).find(isNewShareWindow));

    // 文面が組み立てられていること（URLだけのフォールバックに落ちていないこと）
    assert.ok(decodeURIComponent(win.url).includes('octocat/Hello-World'), win.url);

    /*
     * ここから2つは、失敗したときに原因が分かるようにするための検査。
     * 「Escが効かない」には ①窓が二重に開いた ②窓が記録されていない
     * ③Escの経路が壊れた の3通りがあり、切り分けないと直せない。
     */
    const opened = (await targets()).filter(isNewShareWindow);
    assert.equal(opened.length, 1,
      `共有ウィンドウが ${opened.length} 個開いた（1個のはず）: ${opened.map((t) => t.url).join(' | ')}`);

    const recAfter = await evalInSw('(async () => Object.keys(await self.GXS_BG.readRecords()))()');
    const added = recAfter.filter((id) => !recBefore.includes(id));
    assert.equal(added.length, 1,
      `service worker に記録された窓が ${added.length} 個（1個のはず）。0なら content script の`
      + ` フォールバックで開いており、依頼が service worker に届いていない: ${JSON.stringify({ recBefore, recAfter })}`);

    await waitLoaded(win.targetId);
    assert.ok(await escapeUntilClosed(win.targetId), 'この窓が Esc で閉じない');
    await cdp.send('Target.closeTarget', { targetId: ghId });
  });

  it('ウィンドウを閉じると記録が消える（ID再利用への備え）', async () => {
    const { windowId } = await openShareWindowFromSw();
    assert.equal(await evalInSw(`self.GXS_BG.isShareWindow(${windowId})`), true);
    await evalInSw(`chrome.windows.remove(${windowId})`);
    await waitFor('記録が消える', async () =>
      (await evalInSw(`self.GXS_BG.isShareWindow(${windowId})`)) === false);
  });

  it('期限切れの記録は無効になる', async () => {
    const fakeId = 987654;
    await evalInSw(`chrome.storage.session.set({ shareWindows: { "${fakeId}": Date.now() - (13*60*60*1000) } })`);
    assert.equal(await evalInSw(`self.GXS_BG.isShareWindow(${fakeId})`), false);
  });
});
