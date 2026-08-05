/*
 * esc-close.js の単体テスト（ブラウザ無しで動く補助テスト）
 *
 * 実拡張での証明は test/extension.e2e.mjs が担当する。
 * ここでは「判定の分岐が意図どおりか」を、偽のwindow/chromeを与えて確かめる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers/load.mjs';

const SRC = readFileSync(join(ROOT, 'src/esc-close.js'), 'utf8');

/*
 * コメントを外してからコードだけを検査する。
 * 「なぜ window.name を使わないのか」は残しておきたい説明なので、
 * 説明文まで禁止すると、理由が消えるか、テストが常に落ちるかのどちらかになる。
 * 行コメントは「行頭が //」に限る（'https://x.com/...' のような文字列を壊さないため）。
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

function mount({ answer = undefined, lastError = false, throwOnSend = false, noRuntime = false } = {}) {
  const state = { closed: false, sent: [], listeners: [] };
  const win = {
    get closed() { return state.closed; },
    addEventListener(type, fn) { state.listeners.push({ type, fn }); },
    close() { state.closed = true; }
  };
  const chrome = noRuntime ? {} : {
    runtime: {
      lastError: undefined,
      sendMessage(msg, cb) {
        state.sent.push(msg);
        if (throwOnSend) throw new Error('Extension context invalidated');
        if (typeof cb === 'function') {
          chrome.runtime.lastError = lastError ? { message: 'no receiver' } : undefined;
          cb(answer);
          chrome.runtime.lastError = undefined;
        }
      }
    }
  };
  const ctx = vm.createContext({ window: win, chrome, setTimeout, clearTimeout, console });
  vm.runInContext(SRC, ctx, { filename: 'src/esc-close.js' });

  const press = (over = {}) => {
    const ev = {
      key: 'Escape', altKey: false, ctrlKey: false, metaKey: false,
      shiftKey: false, isComposing: false, keyCode: 27, ...over
    };
    for (const l of state.listeners) if (l.type === 'keydown') l.fn(ev);
  };
  return { state, press };
}

test('service worker が「自分の窓だ」と答えたら閉じる', () => {
  const { state, press } = mount({ answer: { isShareWindow: true } });
  press();
  assert.equal(state.closed, true);
});

test('service worker が否定したら閉じない', () => {
  const { state, press } = mount({ answer: { isShareWindow: false } });
  press();
  assert.equal(state.closed, false);
});

test('応答が無い（lastError）なら閉じない', () => {
  const { state, press } = mount({ answer: { isShareWindow: true }, lastError: true });
  press();
  assert.equal(state.closed, false);
});

test('sendMessage が例外を投げても閉じないし落ちない', () => {
  const { state, press } = mount({ throwOnSend: true });
  assert.doesNotThrow(() => press());
  assert.equal(state.closed, false);
});

test('拡張のコンテキストが無い環境では何もしない', () => {
  const { state, press } = mount({ noRuntime: true });
  press();
  assert.equal(state.closed, false);
  assert.equal(state.sent.length, 0);
});

test('修飾キーつきEscは照会すらしない', () => {
  for (const mod of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
    const { state, press } = mount({ answer: { isShareWindow: true } });
    press({ [mod]: true });
    assert.equal(state.closed, false, mod);
    assert.equal(state.sent.length, 0, `${mod} で照会が飛んだ`);
  }
});

test('IME変換中のEscは照会すらしない', () => {
  for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
    const { state, press } = mount({ answer: { isShareWindow: true } });
    press(ime);
    assert.equal(state.closed, false);
    assert.equal(state.sent.length, 0);
  }
});

test('Esc以外のキーには反応しない', () => {
  const { state, press } = mount({ answer: { isShareWindow: true } });
  press({ key: 'Enter' });
  press({ key: 'a' });
  assert.equal(state.sent.length, 0);
  assert.equal(state.closed, false);
});

/*
 * 回帰テスト（RS-MAJ-03）。
 * window.name は公開リポジトリに書かれた固定文字列で、どのページからでも
 * 同じ名前の窓を作れる。所有権の根拠に使ってはいけないので、
 * 「使っていないこと」をソースに対して直接確かめる。
 */
test('window.name を所有権の判断に使っていない', () => {
  const code = codeOnly(SRC);
  assert.ok(!/window\.name/.test(code), 'window.name への参照が残っている');
  assert.ok(!/gxs-share-window/.test(code), '固定ウィンドウ名が残っている');
  // 検査が本当に効いているかの対照（コメントを消しただけで素通りしていないか）
  assert.ok(/gxs-share-window/.test(SRC), 'コメントの説明ごと消えている');
});

test('固定ウィンドウ名はどのソースのコードにも残っていない', () => {
  for (const f of ['src/content.js', 'src/background.js', 'src/share.js']) {
    const code = codeOnly(readFileSync(join(ROOT, f), 'utf8'));
    assert.ok(!/'gxs-share-window'|"gxs-share-window"/.test(code), `${f} に固定名が残っている`);
    assert.ok(!/window\.name/.test(code), `${f} に window.name が残っている`);
  }
});
