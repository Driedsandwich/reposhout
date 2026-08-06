/*
 * 公式実装との突き合わせ — 「Xより少なく数えない」ことの機械証明
 *
 * 実行: node --test test/oracle.test.mjs（npm test に含まれる）
 *
 * ここだけ第三者コードを使う。**配布物には入らない**（開発時だけの依存で、
 * scripts/package-files.mjs の収録一覧にも入っていない）。
 *
 *   パッケージ : twitter-text
 *   バージョン : 3.1.0（package.json で完全固定・integrity は package-lock.json）
 *   出所       : https://github.com/twitter/twitter-text
 *   ライセンス : Apache-2.0（node_modules/twitter-text/LICENSE）
 *
 * ⚠️ 公式リポジトリの conformance コーパス（YAML）は npm パッケージに
 * 同梱されていない（実測: *.yml が0件）。したがってここで走らせているのは
 * 「公式コーパス」ではなく、**公式実装そのものを判定器として使った比較**である。
 * 文書で「conformance を実行した」とは書かないこと。
 *
 * 判定は1つだけ。すべての入力について
 *
 *     自前の weightedLength >= 公式の parseTweet().weightedLength
 *
 * 少なく数える方向にだけ実害がある（Xに弾かれる文面を作る）。
 * 多く数えるのは、切り詰めが早まるだけで害にならない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import twitterText from 'twitter-text';
import { loadShare } from './helpers/load.mjs';

const { GXS, FIX } = loadShare();
const official = (s) => twitterText.parseTweet(s).weightedLength;

/* 決定論的な擬似乱数（実行ごとに結果が変わると、落ちたケースを追えない） */
function lcg(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

function adversarialCorpus() {
  const schemes = ['', 'http://', 'https://', 'HTTP://'];
  const hosts = [
    'example.com', 'a.co', 'foo.co.jp', 'foobar.みんな', 'twitter.みんな',
    'foo_bar.com', 'xn--r8jz45g.jp', '日本.jp', 'a.b.c.example.io',
    'UPPER.COM', 'x.y', 'ex-ample.dev', 'a1.io', '.com', 'example.',
    // IPホスト。第4回監査で「過少計算するのでは」と指摘された領域（実測では公式も素で数える）
    '1.1.1.1', '192.168.0.1', '[::1]', '[2001:db8::1]', '255.255.255.255', '1.1.1.1.1'
  ];
  const paths = ['', '/', '/path', '/a/b?c=d#e', '/' + 'x'.repeat(40), '/日本語', '?q=1'];
  const prefixes = ['', 'text:', 'see', '（', 'あ', '@', 'mailto:', 'ver.', '1.', 'コード:'];
  const suffixes = ['', '。', 'です', ')', '.', ',', '…', 'テスト', '！', '”'];
  const joiners = [' ', '', '　', '\n', '\t'];
  const noise = ['', '👍', '👨‍👩‍👧‍👦', '✊🏽', 'ｱ', '→', '★', '日本語', 'ASCII text', '©️'];

  const out = [];
  for (const s of schemes) {
    for (const h of hosts) {
      for (const p of paths) out.push(s + h + p);
    }
  }
  for (const pre of prefixes) {
    for (const h of hosts) {
      for (const suf of suffixes) out.push(pre + h + suf);
    }
  }
  const rnd = lcg(20260805);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  for (let i = 0; i < 4000; i++) {
    const parts = [];
    const n = 1 + Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      parts.push(pick(prefixes) + pick(schemes) + pick(hosts) + pick(paths) + pick(suffixes));
      parts.push(pick(noise));
    }
    out.push(parts.join(pick(joiners)));
  }
  // 繰り返しは差が線形に積み上がるので、まとめて確かめる
  for (const unit of ['a.co', 'foobar.みんな/', 'text:http://example.com', 'http://foo_bar.com/abcdefghij',
                      'http://1.1.1.1', 'http://[::1]', 'https://192.168.0.1/path']) {
    for (const times of [2, 5, 15, 50]) out.push(Array(times).fill(unit).join(' '));
  }
  return out;
}

test('手書きfixtureのすべてで、公式より少なく数えない', () => {
  const inputs = [
    ...FIX.WEIGHT.map((r) => r[1]),
    ...FIX.WEIGHT_MIN.map((r) => r[1]),
    ...FIX.TITLES.map((r) => r[1]),
    ...FIX.BUILD.map((r) => r[2]).filter((t) => typeof t === 'string')
  ];
  let checked = 0;
  for (const s of inputs) {
    const mine = GXS.weightedLength(s);
    const off = official(s);
    assert.ok(mine >= off, `少なく数えた: ${JSON.stringify(s).slice(0, 80)} 自前=${mine} 公式=${off}`);
    checked++;
  }
  assert.ok(checked > 60, `検査した件数が少なすぎる: ${checked}`);
});

test('生成した敵対的コーパスでも、公式より少なく数えない', () => {
  const corpus = adversarialCorpus();
  assert.ok(corpus.length > 4000, `コーパスが小さすぎる: ${corpus.length}`);
  let worst = null;
  for (const s of corpus) {
    const mine = GXS.weightedLength(s);
    const off = official(s);
    if (mine < off && (!worst || off - mine > worst.diff)) worst = { s, mine, off, diff: off - mine };
  }
  assert.equal(worst, null,
    worst ? `少なく数えた: ${JSON.stringify(worst.s).slice(0, 120)} 自前=${worst.mine} 公式=${worst.off}` : '');
});

/* 与えた計数関数が公式を下回る最初のケースを返す。無ければ null */
function findUndercount(counter, inputs) {
  for (const s of inputs) {
    const mine = counter(s);
    const off = official(s);
    if (mine < off) return { s, mine, off };
  }
  return null;
}

test('検査が本当に効いているか（対照）', () => {
  const inputs = [...FIX.WEIGHT.map((r) => r[1]), ...FIX.WEIGHT_MIN.map((r) => r[1])];

  // 本物は1件も下回らない
  assert.equal(findUndercount((s) => GXS.weightedLength(s), inputs), null);

  // わざと少なく数える計数器を通すと、同じ検査が必ず捕まえる
  const brokenByOne = findUndercount((s) => Math.max(0, GXS.weightedLength(s) - 1), inputs);
  assert.ok(brokenByOne, '1減らしても捕まらない＝検査が緩い');

  // URLを素の長さで数えていた旧実装相当も捕まえる
  const brokenUrl = findUndercount((s) => [...s].length, inputs);
  assert.ok(brokenUrl, 'URLを素で数えても捕まらない＝検査が緩い');
});

test('組み立てた投稿全体を、公式の判定器で280以下と確認する', () => {
  const cases = [
    ['https://github.com/o/r', 'GitHub - o/r: ' + '日'.repeat(400) + ' · GitHub'],
    ['https://github.com/o/r/issues/1', 'あ'.repeat(400) + ' · Issue #1 · o/r'],
    ['https://github.com/o/r/pull/1', '\u{1F44D}'.repeat(300) + ' by me · Pull Request #1 · o/r'],
    ['https://github.com/o/r', 'GitHub - o/r: ' + Array(50).fill('a.co').join(' ') + ' · GitHub'],
    ['https://github.com/o/r', 'GitHub - o/r: ' + Array(15).fill('foobar.みんな/').join(' ') + ' · GitHub'],
    ['https://github.com/o/r', 'GitHub - o/r: ' + Array(9).fill('text:http://example.com').join(' ') + ' · GitHub'],
    ['https://github.com/o/r', 'GitHub - o/r: ' + 'ｱ'.repeat(400) + ' · GitHub'],
    ['https://github.com/o/r/discussions/3', '✊🏽'.repeat(200) + ' · Discussion #3 · o/r']
  ];
  for (const [url, title] of cases) {
    const s = GXS.buildShare(url, title);
    assert.ok(s, `共有できなかった: ${url}`);
    // Xの投稿画面は「本文 + 半角空白 + URL」で構成される
    const draft = `${s.text} ${s.url}`;
    const off = official(draft);
    assert.ok(off <= 280, `公式判定で ${off} > 280: ${JSON.stringify(draft).slice(0, 100)}`);
    assert.equal(twitterText.parseTweet(draft).valid, true, `公式判定で invalid: ${off}`);
  }
});
