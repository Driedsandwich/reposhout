/*
 * background.js の単体テスト（ブラウザ無しで動く補助テスト）
 *
 * 実拡張での証明は test/extension.e2e.mjs が担当する。ただし
 * **引き直し（chrome.tabs.query）が別のタブを返す状況は、実拡張では作れない**
 * ——activeTab はツールバー操作でしか付かず、この harness では引き直しても
 * url の無いタブしか返らないため。そこで偽の chrome を与えて、
 * 「渡されたタブ A と引き直しの結果 B が食い違うとき、どちらを使うか」を見る。
 *
 * 第14回監査 R14-002。1.1.8 では `!tab || !tab.url` で引き直していたので、
 * **タブは渡されているのに url だけ無い**とき B を共有し、B へ案内を送っていた。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT, stripComments } from './helpers/load.mjs';

const SHARE = readFileSync(join(ROOT, 'src/share.js'), 'utf8');
const BG = readFileSync(join(ROOT, 'src/background.js'), 'utf8');

/* Chrome を丸ごと偽物にして service worker を読み込む */
function mount({ queryResult = null, contentScript = true,
                openFails = false, fakeTimers = false, fault = null,
                badgeFault = null, createResult = 'ok', setFails = false,
                getFailsOnce = false, initialRecords = null } = {}) {
  const log = { opened: [], notified: [], badges: [], titles: [], colors: [], created: [] };
  const store = initialRecords ? { shareWindows: { ...initialRecords } } : {};
  let storeGetCalls = 0;
  /*
   * 偽のタイマー（第15回監査 R15-005）。
   * 「6000ms 後に消える」ことは、実時間を待たずに**予約を実行して**確かめる。
   * 前のテストは予約が入ったことしか見ておらず、消えることを何も確かめていなかった。
   */
  const listeners = [];
  const timers = new Map();
  let seq = 0, now = 0;
  /*
   * 第22回監査 R22-005。**走り終えた予約を消し忘れていないか**を見るために、
   * 「もう走った予約」を覚えておき、それを clearTimeout しに来たら記録する。
   * 登録簿に古い世代が残っていると、次の付け直しが**存在しない予約**を
   * 消そうとする——実害が出るのは、環境がIDを再利用したときだけなので、
   * 挙動の比較では捕まらない（変異が素通りした）。
   */
  const fired = new Set();
  const staleClears = [];
  const fakeSetTimeout = (fn, ms) => { timers.set(++seq, { fn, at: now + ms }); return seq; };
  const fakeClearTimeout = (id) => {
    if (fired.has(id)) staleClears.push(id);
    timers.delete(id);
  };
  const advance = (ms) => {
    now += ms;
    for (const [id, t] of [...timers.entries()]) {
      if (t.at <= now) { timers.delete(id); fired.add(id); t.fn(); }
    }
  };
  const chrome = {
    action: {
      /* 第20回監査 R20-005。ツールバーのリスナーを実際に呼べるようにする
         （それまで捨てていたので、リスナーが例外を握り潰す経路を試せなかった） */
      onClicked: { addListener(fn) { log.onClicked = fn; } },
      /*
       * 第22回監査 R22-005。バッジの3つのAPIを**個別に**失敗させられるようにする。
       * 「文字は出たが色だけ失敗」という重なりは通常入力では作れないので、
       * ここでその状態そのものを作って観測する。
       */
      async setBadgeText(o) {
        if (badgeFault === 'badge') throw new Error('setBadgeText 不可');
        log.badges.push(o);
      },
      async setBadgeBackgroundColor(o) {
        if (badgeFault === 'color') throw new Error('setBadgeBackgroundColor 不可');
        log.colors.push(o);
      },
      async setTitle(o) {
        if (badgeFault === 'title') throw new Error('setTitle 不可');
        log.titles.push(o);
      }
    },
    commands: { onCommand: { addListener(fn) { log.onCommand = fn; } } },
    runtime: {
      /* 第16回監査 R16-003。メッセージの入口を実際に呼べるようにする */
      onMessage: { addListener(fn) { listeners.push(fn); } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} }, lastError: null,
      getURL: (p) => `chrome-extension://test/${p}`
    },
    tabs: {
      async query() { return queryResult ? [queryResult] : []; },
      async sendMessage(tabId, msg) {
        if (!contentScript) throw new Error('Could not establish connection');
        log.notified.push({ tabId, reason: msg && msg.reason });
        return true;
      },
      async create(o) {
        if (openFails) throw new Error('cannot open tab');
        log.created.push(o.url);
        return { id: 1000 };
      }
    },
    windows: {
      async create(o) {
        if (openFails) throw new Error('cannot open window');
        log.opened.push(o.url);
        /*
         * 第23回監査 R23-003。`windows.create` は Window | undefined を返しうる
         * （公式仕様）。ID が返らない形を、ここで実際に作れるようにする。
         */
        if (createResult === 'undefined') return undefined;
        if (createResult === 'empty') return {};
        /* 窓だけ作れない（タブへは回れる）状態。openFails は両方失敗させる */
        if (createResult === 'throws') throw new Error('cannot open window');
        return { id: 99, tabs: [{ id: 100 }] };
      },
      async remove() {}, onRemoved: { addListener() {} }
    },
    /*
     * 第23回監査 R23-003。読み書きを**個別に**失敗させられるようにする。
     * 「読めなかったのに書く」形は、実ブラウザでは狙って作れない。
     */
    storage: {
      session: {
        async get(k) {
          storeGetCalls++;
          if (getFailsOnce && storeGetCalls === 1) throw new Error('読み出しに失敗');
          return { [k]: store[k] };
        },
        async set(o) {
          if (setFails) throw new Error('書き込みに失敗');
          Object.assign(store, JSON.parse(JSON.stringify(o)));
        }
      }
    },
    i18n: { getMessage: (k) => `[${k}]` }
  };
  const ctx = {
    console, chrome, URL, URLSearchParams, decodeURIComponent, encodeURIComponent,
    JSON, Math, String, Number, Array, Object, RegExp, Error, Promise,
    setTimeout: fakeTimers ? fakeSetTimeout : setTimeout,
    clearTimeout: fakeTimers ? fakeClearTimeout : clearTimeout,
    Date,
    importScripts() { /* share.js は先に読み込んである */ }
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(SHARE, ctx, { filename: 'share.js' });
  /*
   * 第19回監査 R19-004。share.js の関数を壊してから service worker を読み込む。
   * 「組み立てが例外を投げ、かつフォールバックも取れない」という重なりは
   * 通常入力では作れないので、ここで**その状態そのもの**を作って観測する。
   */
  if (fault) fault(ctx.GXS);
  vm.runInContext(BG, ctx, { filename: 'background.js' });

  /*
   * メッセージを実際に流す。返事は Promise で受ける
   * （非同期の応答は listener が true を返して後から sendResponse を呼ぶ形）。
   */
  function send(msg, sender) {
    return new Promise((resolve) => {
      let answered = false;
      const respond = (r) => { if (!answered) { answered = true; resolve(r); } };
      let async = false;
      for (const fn of listeners) {
        if (fn(msg, sender, respond) === true) async = true;
      }
      /* 応答が来ないまま終わる形も、待ち続けずに拾えるようにする */
      if (!async) setImmediate(() => respond(undefined));
      else { const t = setTimeout(() => respond(undefined), 200); if (t.unref) t.unref(); }
    });
  }
  return { bg: ctx.GXS_BG, log, advance, send, pending: () => timers.size,
    staleClears: () => staleClears.slice(), records: () => store.shareWindows };
}

const TAB_A_NO_URL = { id: 1, title: 'A' };
const TAB_B = { id: 2, url: 'https://github.com/b/repo', title: 'GitHub - b/repo: B · GitHub' };
const TAB_A = { id: 1, url: 'https://github.com/a/repo', title: 'GitHub - a/repo: A · GitHub' };

test('渡されたタブにURLが無くても、引き直したタブを共有しない（R14-002）', async () => {
  const { bg, log } = mount({ queryResult: TAB_B });
  await bg.shareTab(TAB_A_NO_URL);
  assert.deepEqual(log.opened, [], `別のタブを共有した: ${log.opened.join(' | ')}`);
  /* 案内も、引き直した B ではなく渡された A へ行く */
  assert.equal(log.notified.length, 1, `案内が1つでない: ${JSON.stringify(log.notified)}`);
  assert.equal(log.notified[0].tabId, 1,
    `案内先が渡されたタブでない: ${JSON.stringify(log.notified)}`);
  assert.equal(log.notified[0].reason, 'unsupported');
});

test('引き直した先が機微なページでも、そちらへ案内を送らない（R14-002）', async () => {
  const sensitive = {
    id: 2, url: 'https://github.com/b/repo/blob/main/access_token=dummy-secret', title: 'x'
  };
  const { bg, log } = mount({ queryResult: sensitive });
  await bg.shareTab(TAB_A_NO_URL);
  assert.ok(!log.notified.some((n) => n.tabId === 2),
    `引き直した先へ案内を送った: ${JSON.stringify(log.notified)}`);
});

test('URLのあるタブが渡されたら、そのタブだけを使う（R14-002の対照）', async () => {
  const { bg, log } = mount({ queryResult: TAB_B });
  await bg.shareTab(TAB_A);
  assert.equal(log.opened.length, 1, '共有できていない');
  assert.ok(decodeURIComponent(log.opened[0]).includes('github.com/a/repo'),
    `渡したタブと違うものを共有した: ${log.opened[0]}`);
});

test('タブが渡されないときだけ引き直す（R14-002の対照）', async () => {
  const { bg, log } = mount({ queryResult: TAB_B });
  await bg.shareTab();
  assert.equal(log.opened.length, 1, '引き直しの経路が死んでいる');
  assert.ok(decodeURIComponent(log.opened[0]).includes('github.com/b/repo'),
    `引き直したタブと違うものを共有した: ${log.opened[0]}`);
});

test('タブも引き直しの結果も無ければ、何もしない（R14-002）', async () => {
  const { bg, log } = mount({ queryResult: null });
  await bg.shareTab();
  assert.deepEqual(log.opened, []);
  assert.deepEqual(log.notified, []);
});

/* ---- 案内が届かないときのバッジ（第14回監査 R14-003） ------------------ */

test('画面へ案内が届けば、バッジは出さない（R14-003）', async () => {
  const { bg, log } = mount({ contentScript: true });
  const how = await bg.announceOnce(7, 'credential_like');
  assert.equal(how, 'notice');
  assert.equal(log.notified.length, 1);
  assert.equal(log.notified[0].tabId, 7);
  assert.equal(log.notified[0].reason, 'credential_like');
  assert.deepEqual(log.badges.filter((b) => b.text), [], 'バッジまで出している');
});

test('content script がいなければ、バッジで伝える（R14-003）', async () => {
  /*
   * GitHub 以外のページや、拡張を更新した直後の未再読込タブでは案内が届かない。
   * 1.1.8 はここで黙って終わっていたので、利用者には壊れたようにしか見えなかった。
   */
  const { bg, log } = mount({ contentScript: false });
  const how = await bg.announceOnce(7, 'credential_like');
  assert.equal(how, 'badge', '届かないのにバッジを出していない');
  const set = log.badges.filter((b) => b.text);
  assert.equal(set.length, 1);
  /* vm の中で作られた物なので、プロトタイプごとの比較はしない */
  assert.equal(set[0].tabId, 7, '対象のタブに付いていない');
  assert.equal(set[0].text, '!');
});

test('バッジにも見出しにも、URLや値を出さない（R14-003）', async () => {
  const { bg, log } = mount({ contentScript: false });
  await bg.announceOnce(7, 'credential_like');
  const shown = JSON.stringify(log.badges) + JSON.stringify(log.titles);
  for (const leak of ['http', 'github.com', 'access_token', 'dummy']) {
    assert.ok(!shown.includes(leak), `バッジに ${leak} が出ている: ${shown}`);
  }
  /* 出しているのは、翻訳ファイルの決まった語だけ */
  assert.ok(log.titles.some((t) => t.title === '[noticeCredential]'),
    `見出しが定型文でない: ${JSON.stringify(log.titles)}`);
});

test('バッジは 6000ms で消える（R15-005: 予約を実際に走らせて見る）', async () => {
  /*
   * 前のテストは「予約が入ったこと」と「0ms 後にまだ消えていないこと」しか
   * 見ておらず、**消えること自体を何も確かめていなかった**（第15回監査 R15-005）。
   */
  const { bg, log, advance, pending } = mount({ contentScript: false, fakeTimers: true });
  await bg.flagTab(7, 'unsupported');
  assert.ok(log.badges.some((b) => b.text === '!'), 'そもそも付いていない');
  assert.equal(pending(), 1, '消す予約が入っていない');

  advance(5999);
  assert.ok(!log.badges.some((b) => b.text === ''), '早く消えすぎている');

  advance(1);
  await new Promise((r) => setImmediate(r));
  const cleared = log.badges.filter((b) => b.text === '');
  assert.equal(cleared.length, 1, '6000ms 経っても消えていない');
  assert.equal(cleared[0].tabId, 7, '別のタブのバッジを消している');
});

test('バッジを付け直すと、前の予約は新しいバッジを消さない（R15-005）', async () => {
  const { bg, log, advance, pending } = mount({ contentScript: false, fakeTimers: true });
  await bg.flagTab(7, 'unsupported');
  advance(5000);
  await bg.flagTab(7, 'credential_like');      // 付け直す
  assert.equal(pending(), 1, '古い予約が残っている');
  advance(1000);                                // 最初の予約なら、ここで消える
  await new Promise((r) => setImmediate(r));
  assert.ok(!log.badges.some((b) => b.text === ''), '付け直したのに古い予約で消えた');
  advance(5000);
  await new Promise((r) => setImmediate(r));
  assert.ok(log.badges.some((b) => b.text === ''), '付け直したぶんが消えない');
});

test('バッジを消すとき、見出しは空文字でなく既定の説明へ戻す（R15-005）', async () => {
  const { bg, log, advance } = mount({ contentScript: false, fakeTimers: true });
  await bg.flagTab(7, 'unsupported');
  advance(6000);
  await new Promise((r) => setImmediate(r));
  const restored = log.titles[log.titles.length - 1];
  assert.equal(restored.title, '[actionTitle]',
    `見出しが既定へ戻っていない: ${JSON.stringify(restored)}`);
});

test('投稿画面をどちらの方法でも開けなければ、黙って終わらない（R15-005）', async () => {
  /*
   * chrome.windows.create も chrome.tabs.create も失敗すると、
   * 1.1.8 は何も出さずに終わっていた（利用者には壊れたようにしか見えない）。
   */
  const { bg, log } = mount({ openFails: true, contentScript: true });
  await bg.shareTab({ id: 5, url: 'https://github.com/a/repo', title: 'GitHub - a/repo: A · GitHub' });
  assert.deepEqual(log.opened, [], '開けているなら前提が違う');
  assert.equal(log.notified.length, 1, `理由を伝えていない: ${JSON.stringify(log.notified)}`);
  assert.equal(log.notified[0].tabId, 5, '別のタブへ伝えている');
  assert.equal(log.notified[0].reason, 'open_failed');
});

test('開けなかった案内が届かなければ、バッジで伝える（R15-005）', async () => {
  const { bg, log } = mount({ openFails: true, contentScript: false });
  await bg.shareTab({ id: 5, url: 'https://github.com/a/repo', title: 'GitHub - a/repo: A · GitHub' });
  const set = log.badges.filter((b) => b.text);
  assert.equal(set.length, 1, 'バッジも出ていない');
  assert.equal(set[0].tabId, 5);
  assert.equal(bg.titleFor('open_failed'), '[noticeOpenFailed]', '理由ごとの定型文が無い');
});

test('タブIDが数でなければ、案内もバッジも試さない（R14-003）', async () => {
  const { bg, log } = mount({ contentScript: true });
  assert.equal(await bg.announceOnce(undefined, 'unsupported'), 'none');
  assert.deepEqual(log.notified, []);
  assert.deepEqual(log.badges, []);
});

/* ---- 出て行くものを決めるのは service worker だけ（第16回監査 R16-003） ---- */

const GH_SENDER = { tab: { id: 11, url: 'https://github.com/a/repo', title: 'GitHub - a/repo · GitHub' } };

/* stripComments は test/helpers/load.mjs が唯一の定義（第19回監査で共通化）。
   消しすぎ・消せなさすぎは、すぐ下の検査が実物で確かめる */

test('注釈を外す処理そのものが、正しく動いている（上の検査の土台）', () => {
  const sample = [
    '/* window.open( を注釈で書いた行 */',
    'var a = 1;   // document.title と注釈で書いた行',
    'var keep = "https://x.com/intent/post";'
  ].join('\n');
  const out = stripComments(sample);
  assert.ok(!/window\.open\s*\(/.test(out), '注釈が残っている');
  assert.ok(!/document\.title/.test(out), '行末の注釈が残っている');
  assert.ok(/x\.com\/intent/.test(out), 'コードまで消している');
  assert.ok(/var a = 1;/.test(out), 'コードまで消している');
  /* 実物にも当てて、何かは必ず消えていること（空振りで通らない） */
  const real = readFileSync(join(ROOT, 'src/content.js'), 'utf8');
  assert.ok(stripComments(real).length < real.length, '実物から何も消えていない');
  assert.ok(/function requestShare/.test(stripComments(real)), '実物のコードまで消している');
});

test('完成済みのXのURLを渡されても、それは開かない（R16-003）', async () => {
  /*
   * 第16回監査 R16-003。以前は「送信元が github.com」「x.com/intent で始まる」
   * だけを見て、渡されたURLをそのまま開いていた。中身は見ていないので、
   * 古い content script が古い方針で作ったURL（タイトル入り・任意のパス）も開けた。
   * 監査は実配布ZIPで、資格情報を載せた完成品が popup として開くことを再現している。
   */
  const { log, send } = mount({ contentScript: true });
  const evil = 'https://x.com/intent/post?text=access_token%3Ddummy-secret-value' +
               '&url=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fblob%2Fmain%2Fprivate';
  await send({ type: 'gxs:open-share', url: evil }, GH_SENDER);
  const all = JSON.stringify(log.opened) + JSON.stringify(log.created);
  assert.ok(!all.includes('dummy-secret-value'), `渡されたURLを開いた: ${all}`);
  assert.ok(!all.includes('blob'), `渡されたパスを開いた: ${all}`);
  assert.deepEqual(log.opened, [], `何かを開いている: ${log.opened.join(' | ')}`);
});

test('古い形の依頼には、再読み込みの案内を出す（R16-003）', async () => {
  const { log, send } = mount({ contentScript: true });
  const res = await send({ type: 'gxs:open-share', url: 'https://x.com/intent/post?url=x' }, GH_SENDER);
  assert.equal(log.notified.length, 1, `案内していない: ${JSON.stringify(log.notified)}`);
  assert.equal(log.notified[0].tabId, 11);
  assert.equal(log.notified[0].reason, 'reload_required');
  /*
   * 返事は ok:true。これは「開いた」ではなく「こちらで処理したので
   * そちらで window.open するな」の意味。古い content script は
   * !res.ok で直接 window.open へ倒れるため、false を返すと
   * **古い方針のURLがそのまま開いてしまう**。
   */
  assert.equal(res.ok, true, `古い呼び出し元が直接開く形の返事になっている: ${JSON.stringify(res)}`);
  assert.equal(res.opened, 'none', '開いたことにしている');
});

test('新しい依頼は、送信元のタブのURLから組み直して開く（R16-003）', async () => {
  const { log, send } = mount({ contentScript: true });
  const res = await send({ type: 'gxs:request-share' }, GH_SENDER);
  assert.equal(res.ok, true, `共有できていない: ${JSON.stringify(res)}`);
  assert.equal(log.opened.length, 1, `開いた数が違う: ${JSON.stringify(log.opened)}`);
  const opened = decodeURIComponent(log.opened[0]);
  assert.ok(opened.startsWith('https://x.com/intent/'), opened);
  assert.ok(opened.includes('https://github.com/a/repo'), `送信元のURLで組んでいない: ${opened}`);
  assert.ok(opened.includes('a/repo'), opened);
  /* タイトルは送らない（第15回監査 R15-001 が service worker 経路でも効いている） */
  assert.ok(!opened.includes('GitHub - '), `タイトルが混ざっている: ${opened}`);
});

test('依頼でも、いまの方針で共有できないページは開かない（R16-003の核心）', async () => {
  /*
   * 「service worker が組み直している」ことの証拠。呼び出し元は何も指定していないので、
   * ここで断れるのは **いまの方針をこの場で当てているから**。
   */
  const cases = [
    ['https://github.com/o/r/blob/main/secret.env', 'unsupported'],
    ['https://github.com/enterprises/acme', 'sensitive_route'],      // R16-001（認証・組織管理側）
    ['https://github.com/topics/rust', 'unsupported'],               // R16-001（機能ページ側）
    ['https://github.com/o/r/issues?state=open&state=closed', 'ambiguous_query'] // R16-002
  ];
  for (const [url, want] of cases) {
    const { log, send } = mount({ contentScript: true });
    const res = await send({ type: 'gxs:request-share' }, { tab: { id: 12, url: url } });
    assert.equal(res.ok, false, `開いてしまった: ${url}`);
    assert.deepEqual(log.opened, [], `開いてしまった: ${url}`);
    assert.equal(log.notified.length, 1, `理由を伝えていない: ${url}`);
    assert.equal(log.notified[0].reason, want, `理由が違う（${url}）`);
  }
});

test('github.com のタブ以外からの依頼には応じない（R16-003）', async () => {
  for (const sender of [{ tab: { id: 13, url: 'https://example.com/a/b' } },
                        { tab: { id: 13 } },
                        {}]) {
    const { log, send } = mount({ contentScript: true });
    const res = await send({ type: 'gxs:request-share' }, sender);
    assert.equal(res && res.ok, false, `応じてしまった: ${JSON.stringify(sender)}`);
    assert.deepEqual(log.opened, [], `開いてしまった: ${JSON.stringify(sender)}`);
  }
});

test('content script 側に、Xを直接開く道が残っていない（R16-003）', () => {
  /*
   * 拡張を更新した直後、開きっぱなしのタブには古い content script が残る。
   * そこに window.open が残っていると、service worker の方針を通らずに
   * 古い方針のURLが開く。**次に更新するときのために、いま消しておく。**
   */
  const src = stripComments(readFileSync(join(ROOT, 'src/content.js'), 'utf8'));
  assert.ok(!/window\.open\s*\(/.test(src), 'content.js に window.open が残っている');
  assert.ok(!/x\.com\/intent/.test(src), 'content.js がXのURLを組み立てている');
  assert.ok(!/document\.title/.test(src), 'content.js がページのタイトルを読んでいる');
  assert.ok(/gxs:request-share/.test(src), '新しい依頼の形になっていない');
  assert.ok(!/gxs:open-share/.test(src), 'content.js が古い形で送っている');
  /* service worker 側も、渡されたURLを使っていない */
  const bg = stripComments(readFileSync(join(ROOT, 'src/background.js'), 'utf8'));
  assert.ok(!/openShareWindow\(\s*msg\.url\s*\)/.test(bg), '渡されたURLを開いている');
  assert.ok(!/tab\.title/.test(bg), 'service worker がタイトルを読んでいる');
  assert.ok(!/\bmsg\.url\b/.test(bg), 'service worker が渡されたURLを見ている');
});

/* ============================================================
 * 第19回監査 R19-004 — 押しても何も起きない経路を無くす
 * ============================================================
 *
 * それまでは、拒否の理由を言える経路だけが案内を出していた。
 * 組み立てが例外を投げ、かつフォールバックのURLも取れないときは、
 * **案内もバッジも出さずに終わって**いた（実測: notice=0 / badge=0）。
 * 利用者からは「押しても何も起きない」と見える。
 *
 * 通常入力からこの重なりへ到達する経路は見つかっていない。
 * だが share.js を読み込めていない・将来の改修で例外が増える、という形で
 * 起こりうるので、**理由を言えないときこそ**案内を出す側へ倒す。
 */
const THROWS = (G) => { G.buildShareResult = () => { throw new Error('boom'); }; };
const TAB_OK = { id: 7, url: 'https://github.com/o/r' };

/* 「1回だけ案内が出た」を1か所で判定する（notice と badge を足して数える） */
function announced(log) {
  return log.notified.length + log.badges.filter((b) => b.text).length;
}

test('組み立てが例外＋フォールバックも取れないとき、黙って終わらない（R19-004）', async () => {
  const { bg, log } = mount({
    fault: (G) => { THROWS(G); G.fallbackUrl = () => null; }
  });
  const ret = await bg.shareTab(TAB_OK);
  assert.equal(log.opened.length, 0, '開いてはいけない');
  assert.equal(announced(log), 1,
    `案内が1回でない（0なら黙って終わっている）: notice=${log.notified.length} badge=${log.badges.length}`);
  assert.equal(ret.opened, false);
  assert.equal(ret.notified, true, '通知したことを戻り値で名乗っていない');
});

test('フォールバック自体が例外を投げても、黙って終わらない（R19-004）', async () => {
  /* GXS が読み込めていない等。以前は例外が shareTab の外へ抜けていた */
  const { bg, log } = mount({
    fault: (G) => { THROWS(G); G.fallbackUrl = () => { throw new Error('no GXS'); }; }
  });
  let ret, threw = null;
  try { ret = await bg.shareTab(TAB_OK); } catch (e) { threw = e.message; }
  assert.equal(threw, null, `例外が外へ抜けた: ${threw}`);
  assert.equal(announced(log), 1, `案内が1回でない: ${JSON.stringify(log.notified)}`);
  assert.equal(ret.opened, false);
});

test('案内が届かない相手には、バッジで1回だけ伝える（R19-004）', async () => {
  const { bg, log } = mount({
    contentScript: false,                       // content script がいない
    fault: (G) => { THROWS(G); G.fallbackUrl = () => null; }
  });
  const ret = await bg.shareTab(TAB_OK);
  assert.equal(log.notified.length, 0, '届かないはずの画面へ送ったことになっている');
  assert.equal(log.badges.filter((b) => b.text).length, 1,
    `バッジが1回でない: ${JSON.stringify(log.badges)}`);
  assert.equal(ret.notified, true);
});

test('案内は1回だけ——画面にもバッジにも二重に出さない（R19-004）', async () => {
  /* 届く相手には notice だけ。バッジは出さない */
  const { bg, log } = mount({ fault: (G) => { THROWS(G); G.fallbackUrl = () => null; } });
  await bg.shareTab(TAB_OK);
  assert.equal(log.notified.length, 1, '画面への案内が1回でない');
  assert.equal(log.badges.filter((b) => b.text).length, 0,
    '画面へ届いたのにバッジも出している（二重）');
});

test('開かずに終わる出口が、すべて refuse を通っている（R19-004）', () => {
  /*
   * 経路を1つずつ試すのではなく、**出口の数を数える**。
   * refuse を通らない `opened: false` を書けば、ここで落ちる。
   * （第18回で学んだ形——直す場所を並べず、通るべき所を1つに縛る）
   */
  const src = stripComments(readFileSync(join(ROOT, 'src/background.js'), 'utf8'));
  const falseExits = src.match(/opened:\s*false/g) || [];
  assert.equal(falseExits.length, 1,
    `opened:false が ${falseExits.length} か所ある。refuse() の中の1つだけにする`);
  /* その1つが refuse の中にあること */
  const refuseBody = src.match(/async function refuse\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(refuseBody, 'refuse() が見つからない');
  assert.match(refuseBody[0], /opened:\s*false/, 'refuse() が opened:false を返していない');
  assert.match(refuseBody[0], /announceOnce/, 'refuse() が案内を出していない');
  /*
   * 案内を出してよい関数は**名指しの2つだけ**で、それぞれ**1回だけ**呼ぶ。
   *
   * 第24回監査 R24-003 まで、出口は refuse ひとつだったので「refuse の外なら
   * 全部だめ」で足りた。開いたが Esc が効かないときも伝えるようになったので、
   * 「refuse 以外は禁止」を単に緩めると、**どこからでも呼べる**ことになる。
   * 許す先を数え上げ、増えたらここで落ちる形にする。
   */
  const lines = src.split('\n');
  const ALLOWED = ['refuse', 'shareResolvedTab'];
  const spans = ALLOWED.map((name) => {
    const defLine = lines.findIndex((l) =>
      new RegExp(`^async function ${name}\\s*\\(`).test(l));
    assert.ok(defLine >= 0, `${name}() の定義が見つからない`);
    let depth = 0, endLine = -1;
    for (let i = defLine; i < lines.length; i++) {
      depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
      if (depth === 0 && i > defLine) { endLine = i; break; }
    }
    assert.ok(endLine > defLine, `${name}() の終わりが見つからない`);
    return { name, defLine, endLine };
  });
  const strays = [], counts = Object.fromEntries(ALLOWED.map((n) => [n, 0]));
  lines.forEach((l, i) => {
    if (!/announceOnce\s*\(/.test(l)) return;          // 呼び出しだけを見る
    if (/^async function announceOnce/.test(l)) return;  // 定義そのもの
    if (/^\s*announceOnce:\s*announceOnce,?\s*$/.test(l)) return; // 公開一覧
    const own = spans.find((s) => i >= s.defLine && i <= s.endLine);
    if (own) { counts[own.name] += 1; return; }
    strays.push(`${i + 1}: ${l.trim()}`);
  });
  assert.deepEqual(strays, [],
    `${ALLOWED.join(' / ')} の外から announceOnce を呼んでいる（二重通知と数え漏れの元）:\n`
    + strays.join('\n'));
  for (const n of ALLOWED) {
    assert.equal(counts[n], 1, `${n}() が announceOnce を ${counts[n]} 回呼んでいる（1回にする）`);
  }
});

/* ============================================================
 * 第20回監査 R20-005 — 内部例外でも「押しても何も起きない」にしない
 * ============================================================
 *
 * 第19回で fallback の null と例外は塞いだが、**Xのアドレスを組み立てる
 * ところ（intentUrlFor）は try の外**に残っていた。さらに、ツールバーと
 * ショートカットのリスナーは shareTab の Promise を捨てていたので、
 * そこまで漏れた例外は未処理の rejection になって消えていた（実測）。
 */

test('アドレスの組み立てが例外を投げても、黙って終わらない（R20-005）', async () => {
  const { bg, log } = mount({
    fault: (G) => {
      G.buildShareResult = () => { throw new Error('boom'); };   // フォールバックへ倒す
      G.intentUrlFor = () => { throw new Error('intent boom'); }; // その先で投げる
    }
  });
  let ret, threw = null;
  try { ret = await bg.shareTab(TAB_OK); } catch (e) { threw = e.message; }
  assert.equal(threw, null, `例外が外へ抜けた: ${threw}`);
  assert.equal(log.opened.length, 0, '開いてはいけない');
  assert.equal(announced(log), 1, `案内が1回でない: ${JSON.stringify(log.notified)}`);
  assert.equal(ret.opened, false);
});

test('ツールバーの押下でも、予期しない例外を握り潰さない（R20-005）', async () => {
  /*
   * `tab.url` を読むだけで投げるタブを渡し、shareTab の中で拒否へ倒せない
   * 状態を作る。リスナーが Promise を捨てていると、ここで無反応になる。
   */
  const { log } = mount({});
  const hostile = { id: 9, get url() { throw new Error('unexpected internal error'); } };
  assert.ok(log.onClicked, 'ツールバーのリスナーが登録されていない');
  log.onClicked(hostile);
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(announced(log) >= 1,
    `例外がリスナーで消えている（無反応）: notice=${log.notified.length} badge=${log.badges.length}`);
});

test('ツールバーの押下が、ふつうのタブでは普通に開く（R20-005の対照）', async () => {
  const { log } = mount({});
  log.onClicked({ id: 9, url: 'https://github.com/o/r' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(log.opened.length, 1, '対照が成立していない＝この検査は何でも通る');
  assert.equal(announced(log), 0, '普通に開いたのに案内を出している');
});

test('画面内ボタンの応答が、案内を出せたかどうかを伝える（R20-005）', async () => {
  /* service worker が案内を出せたなら notified:true。画面側は二重に出さない */
  const { log, send } = mount({ contentScript: true });
  const res = await send({ type: 'gxs:request-share' },
    { tab: { id: 5, url: 'https://github.com/search?q=a' } });   // 共有できないルート
  assert.equal(res.ok, false);
  assert.equal(res.notified, true, '案内を出せたことを応答で伝えていない');
  assert.equal(log.notified.length, 1, '案内が1回でない');
});

test('画面側は、service worker が案内を出せたときは黙る（R20-005・二重通知の防止）', () => {
  /*
   * content script の分岐そのものを見る。`notified !== true` のときだけ出す形で
   * なければ、service worker の案内と画面側の案内が二重になる。
   */
  const src = stripComments(readFileSync(join(ROOT, 'src/content.js'), 'utf8'));
  assert.match(src, /res\.ok === false && res\.notified !== true/,
    '画面側が notified を見ずに案内を出している（二重通知）');
});

/* ---- バッジの部分成功（第22回監査 R22-005） ---------------------------- */

test('色や説明文だけ失敗しても、バッジは出て消す予約も入る（R22-005）', async () => {
  /*
   * 第22回監査 R22-005。以前は `setBadgeText` / 色 / `setTitle` を同じ try に入れ、
   * 消す予約をその**後ろ**に置いていた。すると色か説明文だけが失敗したとき、
   *   ・`!` は画面に出ている
   *   ・消す予約は入らない（永久に残る）
   *   ・呼び出し元には false ＝「通知できなかった」と返る（別の案内が二重に出る）
   * という三重の不具合になった。本体は「!」の文字だけ、色と説明文は補助。
   */
  for (const fault of ['color', 'title']) {
    const { bg, log, pending } = mount({ contentScript: false, fakeTimers: true, badgeFault: fault });
    const ok = await bg.flagTab(7, 'unsupported');
    assert.equal(ok, true, `${fault} が失敗しただけで通知を失敗扱いにしている`);
    assert.ok(log.badges.some((b) => b.text === '!'), `${fault}: バッジが出ていない`);
    assert.equal(pending(), 1, `${fault}: 出したバッジを消す予約が入っていない`);
  }
});

test('出したバッジは、色が失敗した後でもちゃんと消える（R22-005）', async () => {
  /* 予約が「入る」だけでなく、走らせて**消えること**まで見る（R15-005 と同じ理由） */
  const { bg, log, advance, pending } = mount({ contentScript: false, fakeTimers: true, badgeFault: 'color' });
  await bg.flagTab(7, 'unsupported');
  assert.equal(pending(), 1);
  advance(6000);
  await new Promise((r) => setImmediate(r));
  const cleared = log.badges.filter((b) => b.text === '');
  assert.equal(cleared.length, 1, '色が失敗するとバッジが消えないまま残る');
  assert.equal(cleared[0].tabId, 7);
});

test('バッジ本体が失敗したときだけ、通知の失敗として扱う（R22-005）', async () => {
  const { bg, log, pending } = mount({ contentScript: false, fakeTimers: true, badgeFault: 'badge' });
  const ok = await bg.flagTab(7, 'unsupported');
  assert.equal(ok, false, 'バッジ本体が出せないのに成功を返している');
  assert.deepEqual(log.badges.filter((b) => b.text === '!'), [], 'バッジが出ている');
  assert.equal(pending(), 0, '出していないバッジの消去を予約している');
});

test('色が失敗しても案内は1回だけ（二重に出さない・R22-005）', async () => {
  /*
   * announceOnce は「画面の案内 → 届かなければバッジ」の順。バッジが
   * 成立しているのに false を返すと、呼び出し元は**まだ誰も知らせていない**と
   * 判断して別の経路をもう一度たどる。出口が1つであることを確かめる。
   */
  const { bg, log } = mount({ contentScript: false, fakeTimers: true, badgeFault: 'color' });
  const how = await bg.announceOnce(7, 'unsupported');
  assert.equal(how, 'badge', `色の失敗で案内なし扱いになっている: ${how}`);
  assert.equal(log.badges.filter((b) => b.text === '!').length, 1, 'バッジが2回出ている');
  assert.deepEqual(log.notified, [], '画面の案内とバッジが二重に出ている');
});

test('付け直しの世代管理は、消去APIの失敗に巻き込まれない（R22-005）', async () => {
  /*
   * 消去の予約が走るとき、先に登録簿から消してから API を呼ぶ。逆順だと
   * 消去APIが失敗した回だけ古い世代が残り、次の付け直しが前の予約を
   * 消し損ねる。**API が全部失敗する状態**で、それでも世代が壊れないことを見る。
   */
  const { bg, log, advance, pending, staleClears } = mount({ contentScript: false, fakeTimers: true });
  await bg.flagTab(7, 'unsupported');
  assert.equal(pending(), 1);
  advance(6000);
  await new Promise((r) => setImmediate(r));
  assert.equal(pending(), 0, '走り終えた予約が登録簿に残っている');
  await bg.flagTab(7, 'credential_like');       // 付け直す
  assert.equal(pending(), 1, '付け直しで予約が入っていない');
  const marks = log.badges.filter((b) => b.text === '!');
  assert.equal(marks.length, 2, `付け直しでバッジが出ていない: ${JSON.stringify(log.badges)}`);
  /*
   * ★ ここが要点。走り終えた予約を登録簿から消していないと、付け直しのときに
   * **もう存在しない予約**を消しに行く。実害はIDが再利用される環境でしか
   * 出ないので、見えている挙動を比べても分からない——だから直接見る。
   */
  assert.deepEqual(staleClears(), [],
    `走り終えた予約を消しに行っている（登録簿に古い世代が残る）: ${JSON.stringify(staleClears())}`);
});

/* ---- Chrome API の部分成功（第23回監査 R23-003） ---------------------- */

test('窓のIDが返らなければ、開いたことにしない（R23-003）', async () => {
  /*
   * 第23回監査 R23-003。`chrome.windows.create` は `Window | undefined` を
   * 返しうる（公式仕様）。前は ID が無くても `opened: 'popup'` ＝成功として返し、
   * 呼び出し元は `{opened:true}` を受け取っていた——**開いたかどうか分からない**のに。
   */
  for (const createResult of ['undefined', 'empty']) {
    const { bg } = mount({ createResult });
    /*
     * ⚠️ **投げても、assertion で受け止める。**（第24回監査 R24-001）
     * 検査を外すと `win.id` を undefined から読んで TypeError になり、
     * テストは「例外で落ちた」扱いになっていた——守りたい assertion は走らないまま。
     * 例外を値へ畳んでから見れば、落ちるのは必ずこの assertion になる。
     */
    const r = await bg.openShareWindow('https://x.com/intent/post?text=a')
      .catch((e) => ({ state: `★例外: ${e && e.message}`, windowOpened: null, escAvailable: null, windowId: null }));
    assert.equal(r.state, 'creation_unknown', `${createResult}: 状態が違う: ${JSON.stringify(r)}`);
    assert.equal(r.windowOpened, null, '開いたかどうかを断定している');
    assert.equal(r.escAvailable, false);
    assert.equal(r.windowId, null);
  }
});

test('開いたか分からないときは、タブで開き直さず案内を1回出す（R23-003）', async () => {
  /*
   * ここでタブを開くと、窓が実際には開いていた場合に**二重に開く**。
   * 開けなかったのではなく「分からない」ので、その通りに伝える。
   */
  const { bg, log } = mount({ createResult: 'undefined' });
  const res = await bg.shareTab({ id: 7, url: 'https://github.com/o/r' });
  assert.equal(res.opened, false);
  assert.equal(res.reason, 'open_unknown');
  assert.equal(res.notified, true, '何も伝えずに終わっている');
  assert.deepEqual(log.created, [], 'タブで開き直して二重に開いている');
  assert.equal(log.notified.length, 1, `案内が1回でない: ${JSON.stringify(log.notified)}`);
  assert.equal(log.notified[0].reason, 'open_unknown');
});

test('記録できなければ、開いたことは認めてもEscは使えないと返す（R23-003）', async () => {
  /*
   * 窓は開いた（それは事実）。しかし記録できていないので Esc では閉じられない。
   * 前は成功として畳んでいたので、**文書が説明しているEscが使えない**ことに
   * 誰も気づけなかった（実測: isShareWindow が false）。
   */
  const { bg } = mount({ setFails: true });
  const r = await bg.openShareWindow('https://x.com/intent/post?text=a');
  assert.equal(r.state, 'popup_confirmed_untracked');
  assert.equal(r.windowOpened, true, '開いたことまで否定している');
  assert.equal(r.escAvailable, false, 'Escが使えると偽っている');
  assert.equal(r.errorKind, 'write_failed');
  assert.equal(await bg.isShareWindow(99), false, '記録できていないのに所有を認めている');
});

test('台帳を読めなかったときは、書かない（既にある記録を消さない）（R23-003）', async () => {
  /*
   * ⚠️ 前は読み取り失敗を「空の台帳」に変えていたので、直後の書き込みが
   * **他の共有ウィンドウの記録を丸ごと消して**いた。消えた窓は Esc で閉じられない。
   */
  const { bg, records } = mount({ getFailsOnce: true, initialRecords: { 10: Date.now() } });
  const r = await bg.rememberShareWindow(20);
  assert.equal(r.ok, false, '読めていないのに成功を返している');
  assert.equal(r.errorKind, 'read_failed');
  const rec = records();
  assert.ok(Object.prototype.hasOwnProperty.call(rec, '10'), '既にあった記録を消している');
  assert.ok(!Object.prototype.hasOwnProperty.call(rec, '20'), '読めていないのに書いている');
});

test('台帳を読めなければ、所有を認めない（R23-003）', async () => {
  const { bg } = mount({ getFailsOnce: true, initialRecords: { 99: Date.now() } });
  /* ⚠️ 例外を値へ畳んでから見る（投げると assertion が走らない・R24-001） */
  const got = await bg.isShareWindow(99).catch((e) => `★例外: ${e && e.message}`);
  assert.equal(got, false, '読めていないのに「拡張が開いた窓だ」と認めている');
  /* 対照: 読めるようになれば認める */
  const { bg: bg2 } = mount({ initialRecords: { 99: Date.now() } });
  assert.equal(await bg2.isShareWindow(99), true, '対照が壊れている（読めても認めない）');
});

test('すべて正常なら、開いて記録できたと返す（対照・R23-003）', async () => {
  const { bg } = mount({});
  const r = await bg.openShareWindow('https://x.com/intent/post?text=a');
  assert.equal(r.state, 'popup_confirmed_tracked');
  assert.equal(r.windowOpened, true);
  assert.equal(r.escAvailable, true);
  assert.equal(r.windowId, 99);
  assert.equal(await bg.isShareWindow(99), true);
});

test('ポップアップを作れなければタブで開き、Escの対象にはしない（対照・R23-003）', async () => {
  const { bg, log } = mount({ createResult: 'throws' });
  const r = await bg.openShareWindow('https://x.com/intent/post?text=a');
  assert.equal(r.state, 'tab_confirmed');
  assert.equal(r.windowOpened, true);
  assert.equal(r.escAvailable, false, 'タブをEscの対象にしている');
  assert.equal(log.created.length, 1);
  /* 対照: どちらも開けなければ failed */
  const { bg: bg2 } = mount({ openFails: true });
  assert.equal((await bg2.openShareWindow('https://x.com/intent/post?text=a')).state, 'failed');
});

/* ============================================================
 * 第24回監査 R24-003 — 開いたが Esc が効かないことを、3入口とも1回だけ伝える
 * ============================================================
 *
 * 第23回で `popup_confirmed_untracked`（窓は開いたが記録できず、Esc が効かない）を
 * **内部的には**分けた。だが利用者へは何も出ていなかった——実測で
 * notice 0 / badge 0 / 応答 `{ok:true, notified:false}`。
 * 画面の上では「Esc で閉じられる窓」と区別がつかない。
 */

const UNTRACKED = { setFails: true };          // 窓は開くが session への記録が失敗する
const GH_TAB = (id) => ({ id: id, url: 'https://github.com/o/r' });

test('ツールバーから開いたとき、Escが効かないことを1回だけ伝える（R24-003）', async () => {
  const { log } = mount(UNTRACKED);
  log.onClicked(GH_TAB(9));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(log.opened.length, 1, '窓が開いていない＝前提が違う');
  assert.equal(announced(log), 1,
    `案内が1回でない: notice=${JSON.stringify(log.notified)} badge=${JSON.stringify(log.badges)}`);
  assert.equal(log.notified[0].reason, 'esc_unavailable',
    `理由が違う: ${JSON.stringify(log.notified)}`);
  assert.equal(log.notified[0].tabId, 9, '別のタブへ伝えている');
});

test('ショートカットから開いたときも、同じく1回だけ伝える（R24-003）', async () => {
  const { log } = mount(UNTRACKED);
  assert.ok(log.onCommand, 'ショートカットのリスナーが登録されていない');
  log.onCommand('share-to-x', GH_TAB(9));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(log.opened.length, 1, '窓が開いていない＝前提が違う');
  assert.equal(announced(log), 1, `案内が1回でない: ${JSON.stringify(log.notified)}`);
  assert.equal(log.notified[0].reason, 'esc_unavailable');
});

test('画面内ボタンからも1回だけ伝え、応答に状態を載せる（R24-003）', async () => {
  const { log, send } = mount(UNTRACKED);
  const res = await send({ type: 'gxs:request-share' }, { tab: GH_TAB(5) });
  assert.equal(log.opened.length, 1, '窓が開いていない＝前提が違う');
  assert.equal(res.ok, true, '開いたのに失敗として返している');
  assert.equal(res.state, 'popup_confirmed_untracked', `状態を返していない: ${JSON.stringify(res)}`);
  assert.equal(res.escAvailable, false, 'Escが効かないことを応答で伝えていない');
  assert.equal(res.notified, true, '案内を出したことを応答で伝えていない');
  assert.equal(announced(log), 1, `案内が1回でない: ${JSON.stringify(log.notified)}`);
  assert.equal(log.notified[0].reason, 'esc_unavailable');
});

test('画面内の案内が届かないときはバッジへ回す（R24-003）', async () => {
  /* content script が居ない画面。notice は届かないので badge がちょうど1つ */
  const { log, send } = mount({ setFails: true, contentScript: false });
  const res = await send({ type: 'gxs:request-share' }, { tab: GH_TAB(5) });
  assert.equal(log.opened.length, 1, '窓が開いていない＝前提が違う');
  assert.deepEqual(log.notified, [], '届かないはずの notice が記録されている');
  assert.equal(announced(log), 1, `バッジが1つでない: ${JSON.stringify(log.badges)}`);
  assert.ok(log.titles.some((x) => x.title === '[noticeEscUnavailable]'),
    `見出しが専用の定型文でない: ${JSON.stringify(log.titles)}`);
  assert.equal(res.notified, true, 'バッジで伝えたのに notified が false');
});

test('記録できた窓では、案内を出さない（R24-003の対照）', async () => {
  /*
   * ⚠️ この対照が無いと、上の4件は「常に案内を出す」実装でも全部通る。
   */
  const { log, send } = mount({});
  const res = await send({ type: 'gxs:request-share' }, { tab: GH_TAB(5) });
  assert.equal(log.opened.length, 1, '窓が開いていない＝前提が違う');
  assert.equal(res.state, 'popup_confirmed_tracked');
  assert.equal(res.escAvailable, true);
  assert.equal(res.notified, false, '記録できているのに案内を出している');
  assert.equal(announced(log), 0, `案内を出している: ${JSON.stringify(log.notified)}`);
});

test('記録できなかった窓を、持ち物の記録へ入れない（R24-003）', async () => {
  /*
   * 伝えるようになったからといって、記録へ入れてはいけない。
   * 入れると `isShareWindow` が true を返し、**利用者のふつうの窓を閉じうる**。
   */
  const { bg, log, send } = mount(UNTRACKED);
  await send({ type: 'gxs:request-share' }, { tab: GH_TAB(5) });
  assert.equal(log.opened.length, 1);
  const owned = await bg.isShareWindow(99).catch((e) => `★例外: ${e && e.message}`);
  assert.equal(owned, false, `記録できなかった窓を持ち物にしている: ${owned}`);
});

test('英日の定型文がそろっていて、値を含まない（R24-003）', () => {
  const en = JSON.parse(readFileSync(join(ROOT, '_locales/en/messages.json'), 'utf8'));
  const ja = JSON.parse(readFileSync(join(ROOT, '_locales/ja/messages.json'), 'utf8'));
  for (const [name, m] of [['en', en], ['ja', ja]]) {
    assert.ok(m.noticeEscUnavailable, `${name} に noticeEscUnavailable が無い`);
    const s = m.noticeEscUnavailable.message;
    assert.ok(s.length > 10, `${name} の文が短すぎる`);
    assert.ok(!/https?:|\?|=|github\.com|x\.com/.test(s),
      `${name} の文に値やアドレスが混ざっている: ${s}`);
  }
});

test('画面側にも、Escが効かないときの受け皿がある（R24-003）', () => {
  /*
   * service worker が案内を出せなかったときの最後の受け皿。
   * `notified !== true` を見ていなければ、二重に出る。
   */
  const src = stripComments(readFileSync(join(ROOT, 'src/content.js'), 'utf8'));
  assert.match(src, /res\.escAvailable === false && res\.notified !== true/,
    '画面側に Esc 不能の受け皿が無い（service worker が倒れたら誰も伝えない）');
  assert.match(src, /reason === 'esc_unavailable'/, '画面側に専用の定型文が無い');
});

test('開いた結果の一覧（正本）が、実際の挙動と一致している（R24-003）', async () => {
  /*
   * ⚠️ `store/DATA_FLOW_CLAIMS.json` の openOutcomes は、第23回まで
   * **どの検査からも読まれていなかった**（名前があるだけで、誰も当てていない）。
   * 5つの状態を1つずつ実際に作り、状態・Escの可否・利用者へ出す案内を突き合わせる。
   */
  const C = JSON.parse(readFileSync(join(ROOT, 'store/DATA_FLOW_CLAIMS.json'), 'utf8'));
  const outcomes = C.openOutcomes;
  assert.equal(outcomes.length, 5, `正本の状態数が変わっている: ${outcomes.length}`);
  const seen = [];
  for (const o of outcomes) {
    assert.ok(o.probeMountOption, `${o.state}: 作り方が正本に書かれていない`);
    const { log, send } = mount(o.probeMountOption);
    const res = await send({ type: 'gxs:request-share' }, { tab: GH_TAB(5) });
    const got = {
      state: res.ok ? res.state : (res.reason === 'open_failed' ? 'failed' :
             res.reason === 'open_unknown' ? 'creation_unknown' : res.reason),
      notice: log.notified.length ? log.notified[0].reason : null,
      count: announced(log)
    };
    assert.equal(got.state, o.state, `${o.state}: 作れていない（できたのは ${got.state}）`);
    assert.equal(got.notice, o.userNotice,
      `${o.state}: 正本は案内 ${o.userNotice} と言うが、実物は ${got.notice}`);
    assert.equal(got.count, o.userNotice ? 1 : 0,
      `${o.state}: 案内の回数が違う（${got.count}）`);
    if (o.state !== 'tab_confirmed') {
      assert.equal(res.escAvailable === true, o.escAvailable,
        `${o.state}: 正本は Esc ${o.escAvailable} と言うが、実物は ${res.escAvailable}`);
    }
    seen.push(o.state);
  }
  /* ★対照: 案内を出す状態と出さない状態が、両方この一覧に入っていること */
  assert.ok(outcomes.some((o) => o.userNotice), '案内を出す状態が1つも無い');
  assert.ok(outcomes.some((o) => !o.userNotice), '案内を出さない状態が1つも無い');
  assert.equal(new Set(seen).size, 5, '同じ状態を2回数えている');
});

test('Escが効かないことの主張が、挙げた文書に実際に載っている（R24-003）', () => {
  const C = JSON.parse(readFileSync(join(ROOT, 'store/DATA_FLOW_CLAIMS.json'), 'utf8'));
  const o = C.openOutcomes.find((x) => x.state === 'popup_confirmed_untracked');
  assert.ok(o.docToken, '文書に載せる形（docToken）が正本に無い');
  assert.ok(Array.isArray(o.appearsIn) && o.appearsIn.length >= 3,
    `載せる文書が少なすぎる: ${o.appearsIn && o.appearsIn.length}`);
  for (const f of o.appearsIn) {
    assert.ok(readFileSync(join(ROOT, f), 'utf8').includes(o.docToken),
      `${f} に「${o.docToken}」が無い（正本だけ直して文書を直し忘れている）`);
  }
});
