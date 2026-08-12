/*
 * content.js の実挙動（ブラウザ無しで動く補助テスト・第22回監査 R22-001）
 *
 * 実拡張での証明は test/extension.e2e.mjs が担当する。ただし
 * **「GitHubが操作列を描かないページ」で何が起きるか**は、実拡張では作りにくい
 * ——E2Eが読み込むのは操作列のあるページなので。そこで偽のDOMを与えて、
 * 「目印が1つも見つからない状態で、拒否の案内が来たらどうなるか」を見る。
 *
 * 文書は長らく「目印が無ければ何もしない」「足す要素は `<style>` と入れ物だけ」と
 * 書いていたが、実際には**操作列が無くても body へ案内をもう1つ足す**。
 * 説明のほうが実挙動より狭かった（第22回監査 R22-001）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers/load.mjs';

const CONTENT = readFileSync(join(ROOT, 'src/content.js'), 'utf8');

/*
 * ごく小さな偽DOM。**必要な物だけ**を持たせ、読まれた場所を記録する。
 * 記録できるのは「この harness が用意した経路」だけなので、
 * 何を読んでいるかの網羅は docs テスト側（正本↔コードの突合）が担当する。
 */
function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(), children: [], style: {}, attrs: {}, _text: '',
    id: '', className: '',
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') this.id = v; },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c) { this.children.unshift(c); c.parentNode = this; return c; },
    prepend(c) { this.children.unshift(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    /* タグ名だけの単純なセレクタを、子を辿って解く（この harness に要るのはそれだけ） */
    querySelector(sel) {
      const want = String(sel).toUpperCase();
      const walk = (n) => {
        for (const c of n.children) {
          if (c.tagName === want) return c;
          const r = walk(c); if (r) return r;
        }
        return null;
      };
      return walk(this);
    },
    querySelectorAll() { return []; },
    addEventListener() {}, focus() {}, contains() { return false; },
    getBoundingClientRect() { return { height: 28, width: 80 }; },
    get textContent() { return this._text; }, set textContent(v) { this._text = v; },
    get innerHTML() { return this._html || ''; },
    /* 文字列を本物に解釈はしない。**出てくるタグ名の分だけ**子を作る（span を引けるように） */
    set innerHTML(v) {
      this._html = v;
      this.children = [];
      for (const m of String(v).matchAll(/<([a-zA-Z][\w-]*)/g)) this.appendChild(makeEl(m[1]));
    }
  };
}

/* container=null なら「操作列がどこにも無いページ」 */
function mountContent({ container = null } = {}) {
  const selectorsAsked = [];
  const body = makeEl('body'), head = makeEl('head');
  const timers = new Map(); let seq = 0, now = 0;
  const document = {
    body, head, documentElement: makeEl('html'), readyState: 'complete',
    createElement: (t) => makeEl(t),
    getElementById(id) {
      const walk = (n) => {
        if (n.id === id) return n;
        for (const c of n.children) { const r = walk(c); if (r) return r; }
        return null;
      };
      return walk(body) || walk(head);
    },
    querySelector(sel) { selectorsAsked.push(sel); return container; },
    querySelectorAll() { return []; },
    addEventListener() {}, hasFocus: () => true
  };
  const win = {
    document, location: { href: 'https://github.com/o/r', hostname: 'github.com' },
    getComputedStyle: () => ({ display: 'block', cssFloat: 'none', marginRight: '8px', height: '28px' }),
    addEventListener() {},
    setTimeout: (fn, ms) => { timers.set(++seq, { fn, at: now + ms }); return seq; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: (f) => f(),
    MutationObserver: class { observe() {} disconnect() {} },
    navigator: { language: 'en' }, console
  };
  win.window = win; win.self = win; win.globalThis = win;

  let onMessage = null;
  const sent = [];
  win.chrome = {
    runtime: {
      id: 'test', lastError: null,
      onMessage: { addListener(fn) { onMessage = fn; } },
      sendMessage(msg, cb) { sent.push(msg); if (cb) cb({ ok: false, reason: 'unsupported', notified: false }); },
      getURL: (p) => `chrome-extension://test/${p}`
    },
    i18n: { getMessage: () => '' }
  };
  vm.createContext(win);
  vm.runInContext(CONTENT, win, { filename: 'content.js' });

  const advance = (ms) => {
    now += ms;
    for (const [id, t] of [...timers.entries()]) {
      if (t.at <= now) { timers.delete(id); t.fn(); }
    }
  };
  return {
    win, body, head, sent, selectorsAsked, advance,
    notify: (reason) => { if (!onMessage) throw new Error('メッセージの受け口が無い'); onMessage({ type: 'gxs-notice', reason }, {}, () => {}); },
    hasListener: () => onMessage !== null,
    noticeEls: () => body.children.filter((c) => c.id === 'gxs-notice')
  };
}

test('操作列が無いページでも、拒否の案内は body へ出る（R22-001）', () => {
  const m = mountContent({ container: null });
  assert.ok(m.hasListener(), 'メッセージの受け口が登録されていない＝この検査は空振りする');
  assert.ok(m.selectorsAsked.length >= 3,
    `目印を探していない: ${JSON.stringify(m.selectorsAsked)}`);
  assert.equal(m.body.children.length, 0, '目印が無いのにボタンを置いている');

  /* ★対照: 知らない種類のメッセージでは何も足さない（＝常に足すわけではない） */
  m.win.chrome.runtime.onMessage;
  assert.equal(m.noticeEls().length, 0);

  m.notify('unsupported');
  const notices = m.noticeEls();
  assert.equal(notices.length, 1,
    `操作列が無いページで案内が出ていない（または複数出ている）: ${notices.length}`);
  assert.equal(notices[0].tagName, 'DIV');
  assert.equal(notices[0].attrs.role, 'status', '読み上げに乗る形になっていない');
  assert.ok(notices[0]._text.length > 0, '案内の文が空');
});

test('案内には、URL・パラメータ名・値を出さない（R22-001）', () => {
  const m = mountContent({ container: null });
  for (const reason of ['unsupported', 'credential_like', 'open_failed', 'reload_required']) {
    m.notify(reason);
  }
  const text = m.noticeEls().map((e) => e._text).join(' | ');
  for (const leak of ['http', 'github.com', 'access_token', '?', '=']) {
    assert.ok(!text.includes(leak), `案内に ${leak} が出ている: ${text}`);
  }
  assert.equal(m.noticeEls().length, 1, '案内が積み上がっている（1つを使い回すはず）');
});

test('案内は数秒で自分から消える（R22-001）', () => {
  const m = mountContent({ container: null });
  m.notify('unsupported');
  assert.equal(m.noticeEls().length, 1);
  m.advance(5999);
  assert.equal(m.noticeEls().length, 1, '早く消えすぎている');
  m.advance(1);
  assert.equal(m.noticeEls().length, 0, '案内が消えずに残る');
});

test('目印があるページでは、ボタンの入れ物を1つだけ足す（対照）', () => {
  /*
   * 対照が無いと、上の「案内だけ出る」が
   * **content.js が丸ごと動いていないから**なのか区別できない。
   */
  const row = makeEl('ul');
  const m = mountContent({ container: row });
  assert.equal(row.children.length, 1, `入れ物を1つだけ足していない: ${row.children.length}`);
  assert.equal(m.head.children.length, 1, '<style> を1つだけ足していない');
  assert.equal(m.noticeEls().length, 0, 'まだ何も断っていないのに案内が出ている');
});
