/*
 * 実拡張のE2Eテスト
 *
 * 出荷するファイル（scripts/package-files.mjs の一覧）だけを別ディレクトリへ並べ、それを本物のChromeへ
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

  it('出荷する一覧のファイルだけで拡張として読み込める', async () => {
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
    /*
     * 表示言語が英語なら、英語の文字列で出ていることまで言える。
     * ここはわざと直書きする（言語ファイルから取ると「ファイルとファイルを
     * 比べているだけ」になる）。文言を変えたらここも直す——実際、第12回監査
     * R12-002 で変えたときに直し忘れ、日本語環境の手元では通り、英語環境の
     * CI でだけ落ちた。
     */
    if (locale === 'en') {
      assert.equal(shown.title, "Send this page's title and URL to X's composer");
    }

    const isNewShareWindow = (t) =>
      t.type === 'page' && t.url.startsWith('https://x.com/intent/') && !before.has(t.targetId);

    /*
     * まず合成クリック（ページ側スクリプトからの .click()）では動かないことを確かめる。
     * ここが動いてしまうと、利用者の操作を起点にする設計が崩れる。
     */
    await cdp.send('Runtime.evaluate',
      { expression: 'document.getElementById("gxs-share-btn").click()', userGesture: true }, sessionId);
    await sleep(1500);
    assert.equal((await targets()).filter(isNewShareWindow).length, 0,
      '合成クリックで投稿画面が開いた');

    // 本物のマウス入力で押す（isTrusted が true になる経路）
    const boxRes = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const r = document.getElementById('gxs-share-btn').getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`,
      returnByValue: true
    }, sessionId);
    const at = JSON.parse(boxRes.result.value);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent',
        { type, x: at.x, y: at.y, button: 'left', clickCount: 1 }, sessionId);
    }

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

  /*
   * 第11回監査 R11-001。許可したクエリの値に資格情報の形が入っていたら、
   * 実際の拡張でも投稿画面を開かないこと。
   *
   * ツールバー経路は activeTab 権限が実際のツールバー操作でしか付かず、
   * service worker から shareActiveTab() を呼んでも tab.url が取れない
   * （この harness で実測。tab.url = null）。そこで画面内ボタンを
   * **本物のマウス入力**で押す経路で見る。
   *
   * 「開かない」だけでは経路が壊れていても通るので、同じ経路・同じ押し方で
   * 普通のクエリなら1つ開くことを対照として必ず見る。
   */
  const clickShareOn = async (pageUrl) => {
    const before = new Set((await targets()).map((t) => t.targetId));
    const { targetId: pageId } = await cdp.send('Target.createTarget', { url: pageUrl });
    const sessionId = await attach(pageId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await waitFor('Shareボタンが差し込まれる', async () => {
      const r = await cdp.send('Runtime.evaluate',
        { expression: '!!document.getElementById("gxs-share-btn")', returnByValue: true }, sessionId);
      return r.result.value === true;
    });
    const boxRes = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const r = document.getElementById('gxs-share-btn').getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`,
      returnByValue: true
    }, sessionId);
    const at = JSON.parse(boxRes.result.value);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent',
        { type, x: at.x, y: at.y, button: 'left', clickCount: 1 }, sessionId);
    }
    const isNew = (t) =>
      t.type === 'page' && t.url.startsWith('https://x.com/intent/') && !before.has(t.targetId);
    let opened = [];
    for (let i = 0; i < 20; i++) {
      opened = (await targets()).filter(isNew);
      if (opened.length) break;
      await sleep(200);
    }
    return { pageId, opened };
  };

  it('資格情報の形をしたパスでは投稿画面を開かず、理由を表示する（R12-001・R12-002）', async () => {
    const bad = await clickShareOn('https://github.com/o/r/blob/main/access_token=dummy-secret');
    assert.equal(bad.opened.length, 0,
      `投稿画面が開いた: ${bad.opened.map((t) => t.url).join(' | ')}`);

    /* 黙って何も起きないのではなく、値を出さない案内が出ること */
    const sid = await attach(bad.pageId);
    await cdp.send('Runtime.enable', {}, sid);
    const noticeRes = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const el = document.getElementById('gxs-notice');
        return JSON.stringify(el ? { text: el.textContent, role: el.getAttribute('role') } : null); })()`,
      returnByValue: true
    }, sid);
    const notice = JSON.parse(noticeRes.result.value);
    assert.ok(notice, '案内が表示されていない');
    assert.equal(notice.role, 'status', '読み上げ用の role が付いていない');
    assert.ok(notice.text.length > 0, '案内が空');
    assert.ok(!notice.text.includes('dummy-secret'), '案内に値が出ている');
    assert.ok(!notice.text.includes('github.com'), '案内にURLが出ている');
    await cdp.send('Target.closeTarget', { targetId: bad.pageId });

    // 対照: 同じ経路・同じ押し方で、普通のページなら開く
    const ok = await clickShareOn('https://github.com/o/r/issues?state=open');
    assert.equal(ok.opened.length, 1,
      `対照が成立していない（この経路自体が動いていない）: ${ok.opened.length} 個`);
    assert.ok(!decodeURIComponent(ok.opened[0].url).includes('dummy-secret'),
      '対照側に資格情報が混ざっている');
    await waitLoaded(ok.opened[0].targetId);
    assert.ok(await escapeUntilClosed(ok.opened[0].targetId), '対照の窓が閉じない');
    await cdp.send('Target.closeTarget', { targetId: ok.pageId });
  });

  it('自由文の検索語は、共有URLに残らない（R12-001）', async () => {
    const r = await clickShareOn('https://github.com/o/r/issues?q=hello+world&state=open');
    assert.equal(r.opened.length, 1, '共有できなくなっている');
    const shared = decodeURIComponent(r.opened[0].url);
    assert.ok(!shared.includes('hello'), `検索語が共有された: ${shared}`);
    assert.ok(shared.includes('state=open'), `型に合う値まで落ちている: ${shared}`);
    await waitLoaded(r.opened[0].targetId);
    assert.ok(await escapeUntilClosed(r.opened[0].targetId), '窓が閉じない');
    await cdp.send('Target.closeTarget', { targetId: r.pageId });
  });

  /*
   * 第13回監査 R13-003。ツールバーとショートカットは、Chrome が
   * **そのとき対象になったタブ**を渡してくる。以前はそれを捨てて
   * chrome.tabs.query で引き直していたので、渡されたタブと違うタブを
   * 共有しうる状態だった。
   *
   * 実物のツールバー押下は CDP から駆動できない（activeTab が付かない）ので、
   * service worker の shareTab(tab) に**Chromeが渡すのと同じ形のタブ**を
   * 渡して、渡した側のURLで開くことを見る。対照として、資格情報の形の
   * タブでは開かないことも見る。
   */
  const shareViaSw = async (tab) => {
    const before = new Set((await targets()).map((t) => t.targetId));
    await evalInSw(`self.GXS_BG.shareTab(${JSON.stringify(tab)})`);
    const isNew = (t) =>
      t.type === 'page' && t.url.startsWith('https://x.com/intent/') && !before.has(t.targetId);
    let opened = [];
    for (let i = 0; i < 15; i++) {
      opened = (await targets()).filter(isNew);
      if (opened.length) break;
      await sleep(200);
    }
    return opened;
  };

  it('渡されたタブのURLで共有する（R13-003）', async () => {
    const passed = { id: 999999, url: 'https://github.com/o/r/issues?state=open', title: 'Issues · o/r' };
    const opened = await shareViaSw(passed);
    assert.equal(opened.length, 1, `渡したタブで開かなかった: ${opened.length} 個`);
    const shared = decodeURIComponent(opened[0].url);
    assert.ok(shared.includes('github.com/o/r/issues'), `別のURLを共有した: ${shared}`);
    assert.ok(shared.includes('state=open'), `型に合う値が落ちている: ${shared}`);
    await waitLoaded(opened[0].targetId);
    assert.ok(await escapeUntilClosed(opened[0].targetId), '窓が閉じない');
  });

  it('渡されたタブが資格情報の形なら開かない（R13-003の対照）', async () => {
    const opened = await shareViaSw({
      id: 999999,
      url: 'https://github.com/o/r/blob/main/access_token=dummy-secret',
      title: 'access_token=dummy-secret'
    });
    assert.equal(opened.length, 0, `投稿画面が開いた: ${opened.map((t) => t.url).join(' | ')}`);
  });

  it('渡されたタブにURLが無ければ、そのタブに理由を出して終わる（R14-002 / R14-003）', async () => {
    /*
     * 第14回監査 R14-002。1.1.8 は `!tab || !tab.url` で引き直していたので、
     * **タブは渡されているのに url だけ無い**とき、別のタブを共有しえた。
     *
     * 「別のタブへ移らない」ことそのものは、引き直しが**別のURLを返す**状況を
     * 作れないとこの環境では見えない（activeTab はツールバー操作でしか付かず、
     * ここでは引き直しても url の無いタブしか返らない）。その形は
     * test/background.test.mjs が偽の chrome を与えて見ている。
     *
     * ここでは実拡張で見えるほうを見る——**渡されたタブに** `!` が出ること。
     * 1.1.8 の実装はこの場合そのまま return するので、どこにも `!` は出ない。
     * x.com 側には content script がいないので、案内はバッジへ回る（R14-003）。
     */
    const { targetId: otherId } = await cdp.send('Target.createTarget', { url: 'https://x.com/home' });
    await waitLoaded(otherId);
    const tabId = await evalInSw(
      `(async () => { const ts = await chrome.tabs.query({}); ` +
      `const t = ts.find((x) => x.id !== undefined); return t && t.id; })()`);
    assert.equal(typeof tabId, 'number', `タブIDが取れない: ${tabId}`);
    await evalInSw(`chrome.action.setBadgeText({ tabId: ${tabId}, text: '' })`);

    const before = new Set((await targets()).map((t) => t.targetId));
    await evalInSw(`self.GXS_BG.shareTab({ id: ${tabId}, title: 'x' })`);

    let badge = '';
    for (let i = 0; i < 15; i++) {
      badge = await evalInSw(`chrome.action.getBadgeText({ tabId: ${tabId} })`);
      if (badge) break;
      await sleep(200);
    }
    assert.equal(badge, '!', `渡されたタブに理由が出ていない: ${JSON.stringify(badge)}`);

    const opened = (await targets()).filter((t) =>
      t.type === 'page' && t.url.startsWith('https://x.com/intent/') && !before.has(t.targetId));
    assert.equal(opened.length, 0, `投稿画面が開いた: ${opened.map((t) => t.url).join(' | ')}`);

    /* 見出しにもURLや値を出さない */
    const title = await evalInSw(`chrome.action.getTitle({ tabId: ${tabId} })`);
    for (const leak of ['http', 'github.com']) {
      assert.ok(!String(title).includes(leak), `見出しに ${leak} が出ている: ${title}`);
    }
    await evalInSw(`chrome.action.setBadgeText({ tabId: ${tabId}, text: '' })`);
    await cdp.send('Target.closeTarget', { targetId: otherId });
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
