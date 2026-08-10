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
import { ROOT } from './helpers/load.mjs';

const SHARE = readFileSync(join(ROOT, 'src/share.js'), 'utf8');
const BG = readFileSync(join(ROOT, 'src/background.js'), 'utf8');

/* Chrome を丸ごと偽物にして service worker を読み込む */
function mount({ queryResult = null, contentScript = true,
                openFails = false, fakeTimers = false } = {}) {
  const log = { opened: [], notified: [], badges: [], titles: [], created: [] };
  /*
   * 偽のタイマー（第15回監査 R15-005）。
   * 「6000ms 後に消える」ことは、実時間を待たずに**予約を実行して**確かめる。
   * 前のテストは予約が入ったことしか見ておらず、消えることを何も確かめていなかった。
   */
  const listeners = [];
  const timers = new Map();
  let seq = 0, now = 0;
  const fakeSetTimeout = (fn, ms) => { timers.set(++seq, { fn, at: now + ms }); return seq; };
  const fakeClearTimeout = (id) => { timers.delete(id); };
  const advance = (ms) => {
    now += ms;
    for (const [id, t] of [...timers.entries()]) {
      if (t.at <= now) { timers.delete(id); t.fn(); }
    }
  };
  const chrome = {
    action: {
      onClicked: { addListener() {} },
      async setBadgeText(o) { log.badges.push(o); },
      async setBadgeBackgroundColor() {},
      async setTitle(o) { log.titles.push(o); }
    },
    commands: { onCommand: { addListener() {} } },
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
        return { id: 99, tabs: [{ id: 100 }] };
      },
      async remove() {}, onRemoved: { addListener() {} }
    },
    storage: { session: { async get() { return {}; }, async set() {} } },
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
  return { bg: ctx.GXS_BG, log, advance, send, pending: () => timers.size };
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
  const how = await bg.announceRefusal(7, 'credential_like');
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
  const how = await bg.announceRefusal(7, 'credential_like');
  assert.equal(how, 'badge', '届かないのにバッジを出していない');
  const set = log.badges.filter((b) => b.text);
  assert.equal(set.length, 1);
  /* vm の中で作られた物なので、プロトタイプごとの比較はしない */
  assert.equal(set[0].tabId, 7, '対象のタブに付いていない');
  assert.equal(set[0].text, '!');
});

test('バッジにも見出しにも、URLや値を出さない（R14-003）', async () => {
  const { bg, log } = mount({ contentScript: false });
  await bg.announceRefusal(7, 'credential_like');
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
  assert.equal(await bg.announceRefusal(undefined, 'unsupported'), 'none');
  assert.deepEqual(log.notified, []);
  assert.deepEqual(log.badges, []);
});

/* ---- 出て行くものを決めるのは service worker だけ（第16回監査 R16-003） ---- */

const GH_SENDER = { tab: { id: 11, url: 'https://github.com/a/repo', title: 'GitHub - a/repo · GitHub' } };

/*
 * 「もう書いていない」を確かめる検査は、**コードだけ**に当てる。
 * 注釈まで見ると「以前は window.open で開いていた」と経緯を書いた行で落ちる——
 * 落ちる理由が実装と関係なくなり、経緯を書けなくなる。
 * 消しすぎ・消せなさすぎに気づけるよう、この関数自身も下で検査する。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

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
