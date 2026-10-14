/*
 * 3つの入口（画面内ボタン・ツールバー・ショートカット）× 開いた結果5つを、service worker と画面の部品を
 * **メッセージでつないだまま**通す（ブラウザ無しで動く接続試験・第28回監査 R28-007）。
 *
 * それまでは部品ごとに確かめていた: 画面の部品の試験は、手で作った応答（reply）を受け取って
 * 案内の数を見る。service worker の試験は、`tabs.sendMessage` を「届いた」と記録するだけで、
 * 画面に何が出たかまでは動かさない。**正解の応答を手で作る側と、応答を作る側を別々に合格させていた**ので、
 * 2つを組み合わせたときに案内が二重になる・どこにも出ない、を捕まえられなかった。
 *
 * ここでは Chrome の API の成功・失敗だけを細工し、応答と案内は本物の background.js と content.js に
 * 作らせる。数えるのは**利用者に見えたもの**——画面の案内（文字が入った回数）とバッジの「!」。
 * 期待は正本（store/DATA_FLOW_CLAIMS.json の openOutcomes の userNotice）から取る。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers/load.mjs';

const SHARE = readFileSync(join(ROOT, 'src/share.js'), 'utf8');
const BG = readFileSync(join(ROOT, 'src/background.js'), 'utf8');
const CONTENT = readFileSync(join(ROOT, 'src/content.js'), 'utf8');
const OUTCOMES = JSON.parse(readFileSync(join(ROOT, 'store/DATA_FLOW_CLAIMS.json'), 'utf8')).openOutcomes;
const TAB = { id: 5, url: 'https://github.com/o/r' };
/* 案内の理由 → 言語ファイルの鍵（両方の部品が同じ鍵を引く） */
const KEY = { esc_unavailable: 'noticeEscUnavailable', open_unknown: 'noticeOpenUnknown',
  open_failed: 'noticeOpenFailed' };

/* 画面の部品のための、ごく小さな偽 DOM。案内（id=gxs-notice）に文字が入った回数を数える */
function makeEl(tag, seen) {
  return {
    tagName: String(tag).toUpperCase(), children: [], style: {}, attrs: {}, _text: '', id: '',
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') this.id = v; },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c) { this.children.unshift(c); c.parentNode = this; return c; },
    prepend(c) { this.children.unshift(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    querySelector(sel) {
      const want = String(sel).toUpperCase();
      const walk = (n) => { for (const c of n.children) { if (c.tagName === want) return c; const r = walk(c); if (r) return r; } return null; };
      return walk(this);
    },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { (this._ls || (this._ls = {}))[type] = fn; }, focus() {}, contains() { return false; },
    getBoundingClientRect() { return { height: 28, width: 80 }; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; this.children = []; if (this.id === 'gxs-notice') seen.push(String(v)); },
    get innerHTML() { return this._html || ''; },
    set innerHTML(v) {
      this._html = v; this.children = [];
      for (const m of String(v).matchAll(/<([a-zA-Z][\w-]*)/g)) this.appendChild(makeEl(m[1], seen));
    }
  };
}

/*
 * 2つの部品を組み立ててつなぐ。細工できるのは Chrome の API の成否だけ:
 *   outcome       … 開いた結果を作る細工（正本の probeMountOption）
 *   contentReachable … service worker から画面の部品へ案内を届けられるか（tabs.sendMessage）
 *   badgeFails    … バッジの「!」を出せるか（setBadgeText）
 */
function wire({ outcome = {}, contentReachable = true, badgeFails = false } = {}) {
  const notices = [];
  const badges = [];
  const store = {};
  const swListeners = [];
  let onClicked = null, onCommand = null, contentOnMessage = null;
  const i18n = { getMessage: (k) => `[${k}]` };
  const noTimer = () => 0;

  /* ---- service worker ---- */
  const swChrome = {
    action: {
      onClicked: { addListener(fn) { onClicked = fn; } },
      async setBadgeText(o) { if (badgeFails && o.text) throw new Error('setBadgeText 不可'); if (o.text) badges.push(o); },
      async setBadgeBackgroundColor() {}, async setTitle() {}
    },
    commands: { onCommand: { addListener(fn) { onCommand = fn; } } },
    runtime: { onMessage: { addListener(fn) { swListeners.push(fn); } }, onInstalled: { addListener() {} },
      onStartup: { addListener() {} }, lastError: null, getURL: (p) => `chrome-extension://test/${p}` },
    tabs: {
      async query() { return [TAB]; },
      async sendMessage(tabId, msg) {
        if (!contentReachable || tabId !== TAB.id || !contentOnMessage) throw new Error('Could not establish connection');
        contentOnMessage(msg, {}, () => {});
        return undefined;
      },
      async create() { if (outcome.openFails) throw new Error('cannot open tab'); return { id: 1000 }; }
    },
    windows: {
      async create() {
        if (outcome.openFails || outcome.createResult === 'throws') throw new Error('cannot open window');
        if (outcome.createResult === 'undefined') return undefined;
        return { id: 99, tabs: [{ id: 100 }] };
      },
      async remove() {}, onRemoved: { addListener() {} }
    },
    storage: { session: {
      async get(k) { return { [k]: store[k] }; },
      async set(o) { if (outcome.setFails) throw new Error('書き込みに失敗'); Object.assign(store, JSON.parse(JSON.stringify(o))); }
    } },
    i18n
  };
  const sw = { console, chrome: swChrome, URL, URLSearchParams, decodeURIComponent, encodeURIComponent,
    JSON, Math, String, Number, Array, Object, RegExp, Error, Promise, Date,
    setTimeout: noTimer, clearTimeout() {}, importScripts() {} };
  sw.globalThis = sw; sw.self = sw;
  vm.createContext(sw);
  vm.runInContext(SHARE, sw, { filename: 'share.js' });
  vm.runInContext(BG, sw, { filename: 'background.js' });

  /* ---- 画面の部品（GitHub のページ） ---- */
  const body = makeEl('body', notices), head = makeEl('head', notices);
  const row = makeEl('ul', notices);
  const document = {
    body, head, documentElement: makeEl('html', notices), readyState: 'complete',
    createElement: (t) => makeEl(t, notices),
    getElementById() { return null; },
    querySelector() { return row; }, querySelectorAll() { return []; },
    addEventListener() {}, hasFocus: () => true
  };
  const page = {
    document, location: { href: TAB.url, hostname: 'github.com' },
    getComputedStyle: () => ({ display: 'block', cssFloat: 'none', marginRight: '8px', height: '28px' }),
    addEventListener() {}, setTimeout: noTimer, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: (f) => f(), MutationObserver: class { observe() {} disconnect() {} },
    navigator: { language: 'en' }, console
  };
  page.window = page; page.self = page; page.globalThis = page;
  page.chrome = {
    runtime: {
      id: 'test', lastError: null,
      onMessage: { addListener(fn) { contentOnMessage = fn; } },
      /* 画面の部品 → service worker。本物の listener に渡し、本物の応答を返す */
      sendMessage(msg, cb) {
        let answered = false;
        const respond = (r) => { if (!answered) { answered = true; if (cb) cb(r); } };
        let isAsync = false;
        for (const fn of swListeners) if (fn(msg, { tab: TAB }, respond) === true) isAsync = true;
        if (!isAsync) respond(undefined);
      },
      getURL: (p) => `chrome-extension://test/${p}`
    },
    i18n
  };
  vm.createContext(page);
  vm.runInContext(CONTENT, page, { filename: 'content.js' });

  const clickButton = () => {
    const walk = (n) => { if (n._ls && n._ls.click) return n; for (const c of n.children || []) { const r = walk(c); if (r) return r; } return null; };
    const btn = walk(row);
    if (!btn) throw new Error('押せるボタンが無い（画面の部品が入れ物を作っていない）');
    btn._ls.click({ isTrusted: true, preventDefault() {}, stopPropagation() {} });
  };
  const entrances = {
    button: clickButton,
    toolbar: () => onClicked(TAB),
    shortcut: () => onCommand('share-to-x', TAB)
  };
  return { notices, badges, entrances };
}

/* 非同期の処理（Promise の連鎖）が落ち着くまで待つ */
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

async function shareOnce(entrance, opts) {
  const w = wire(opts);
  w.entrances[entrance]();
  await settle();
  return { notices: w.notices, badges: w.badges, total: w.notices.length + w.badges.length };
}

test('3つの入口×開いた結果5つで、利用者に見える案内が正本どおり1回か0回（R28-007）', async () => {
  assert.equal(OUTCOMES.length, 5, `正本の状態数が変わっている: ${OUTCOMES.length}`);
  const wrong = [];
  for (const o of OUTCOMES) {
    for (const entrance of ['button', 'toolbar', 'shortcut']) {
      const r = await shareOnce(entrance, { outcome: o.probeMountOption });
      const want = o.userNotice ? 1 : 0;
      if (r.total !== want) wrong.push(`${entrance}×${o.state}: 案内 ${r.notices.length}・バッジ ${r.badges.length}（期待 ${want}）`);
      else if (want && r.notices[0] !== `[${KEY[o.userNotice]}]`) wrong.push(`${entrance}×${o.state}: 案内の文が違う ${r.notices[0]}`);
    }
  }
  assert.deepEqual(wrong, [], `GXS_MARK.X64 利用者に見える案内の数か理由が正本と違う:\n${wrong.join('\n')}`);
  /* 対照: 正本の 5 状態に、案内を出す物と出さない物が両方あること（何も数えない試験になっていない） */
  assert.ok(OUTCOMES.some((o) => o.userNotice) && OUTCOMES.some((o) => !o.userNotice), '正本の状態が片寄っている');
});

test('画面へ案内を届けられないときはバッジで補い、バッジも出せないときは画面の部品が補う（R28-007）', async () => {
  const untracked = OUTCOMES.find((o) => o.state === 'popup_confirmed_untracked').probeMountOption;
  /* 画面へ届かない: どの入口でもバッジ1回（画面の案内 0）。二重にしない */
  for (const entrance of ['button', 'toolbar', 'shortcut']) {
    const r = await shareOnce(entrance, { outcome: untracked, contentReachable: false });
    assert.equal(r.badges.length, 1, `GXS_MARK.X65 ${entrance}: 画面へ届かないのにバッジで補っていない（案内 ${r.notices.length}・バッジ ${r.badges.length}）`);
    assert.equal(r.total, 1, `${entrance}: 二重に知らせている（案内 ${r.notices.length}・バッジ ${r.badges.length}）`);
  }
  /* 画面へ届かず、バッジも出せない: 画面内ボタンは応答を受けた画面の部品が自分で1回出す */
  const b = await shareOnce('button', { outcome: untracked, contentReachable: false, badgeFails: true });
  assert.deepEqual(b.notices, ['[noticeEscUnavailable]'],
    `GXS_MARK.X66 service worker が知らせられなかったのに、画面の部品が補っていない: ${JSON.stringify(b)}`);
  /* ツールバー・ショートカットには補う画面の部品の経路が無い（何も出せない）。出たことにしない */
  for (const entrance of ['toolbar', 'shortcut']) {
    const r = await shareOnce(entrance, { outcome: untracked, contentReachable: false, badgeFails: true });
    assert.equal(r.total, 0, `${entrance}: 出せないはずの案内が数えられている`);
  }
});
