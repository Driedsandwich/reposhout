/*
 * 公式コーパスとの突き合わせ — twitter-text の conformance fixture を実際に走らせる
 *
 * 実行: node --test test/conformance.test.mjs（npm test に含まれる）
 *
 * これまでは「公式実装を判定器として使った比較」（test/oracle.test.mjs）だけで、
 * 公式が配っている **期待値つきコーパス** は走らせていなかった。それなのに文書には
 * 「少なく数えないことを証明している」と書いてあり、第5回監査で名指しされた。
 * ここで実物を固定して走らせる。
 *
 *   出所     : https://github.com/twitter/twitter-text
 *   コミット : 65e7e00da383fb77f5ab7fe3c0dc26b724e14035（タグ v3.1.0 と同一と実測）
 *   ファイル : conformance/validate.yml
 *   ライセンス: Apache-2.0（test/vendor/twitter-text-conformance/LICENSE に同梱）
 *
 * 置き場所は test/vendor/ で、**配布ZIPには入らない**
 * （scripts/package-files.mjs の収録一覧に無く、test/manifest.test.mjs が見張っている）。
 *
 * ⚠️ YAMLの読み手を自作している。自作の読み手は黙って壊れるので、
 * 「読み取った文字列を公式実装へ渡すと、コーパスの期待値と一致する」ことを
 * 全件で確かめている（§パーサの自己検査）。ここが通らなければ、読み違えている。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import twitterText from 'twitter-text';
import { ROOT } from './helpers/load.mjs';
import { loadShare } from './helpers/load.mjs';

const { GXS } = loadShare();

const CORPUS = 'test/vendor/twitter-text-conformance/validate.yml';

/* 上流のファイルが差し替わったら気づけるように、バイト列を固定する */
const CORPUS_SHA256 = '29fa1be663676f3d0bb0a67f393b32c15d92c5dd10db9be401bf7708d7c5b703';
const LICENSE_SHA256 = '08a9320abaf2636dc747b0caff52cd1638850e440d285e80dde662a5c84883a9';

/* 走らせる節と、その節が想定している設定 */
const V3 = twitterText.configs.version3;
const NO_EMOJI = { ...V3, emojiParsingEnabled: false };
const SECTIONS = {
  // 絵文字を1つ2としてまとめて数える。**RepoShout はこの設定に合わせている**
  WeightedTweetsWithDiscountedEmojiCounterTest: { config: V3, appliesToUs: true, cases: 22 },
  UnicodeDirectionalMarkerCounterTest: { config: V3, appliesToUs: true, cases: 2 },
  // 絵文字をコードポイントごとに数える旧設定。RepoShout の設定ではないので
  // 期待値の突き合わせ対象にはしない（それでも読み取りの自己検査には使う）
  WeightedTweetsCounterTest: { config: NO_EMOJI, appliesToUs: false, cases: 20 }
};

/*
 * このコーパスに出てくる構文だけを読む、意図的に狭い読み手。
 * 実測した構文は「二重引用符の文字列」と「素の数値・真偽値」、
 * エスケープは \uXXXX と \UXXXXXXXX の2種だけ（他の構文が出たら例外を投げる）。
 */
function unquote(raw, where) {
  if (!raw.startsWith('"') || !raw.endsWith('"')) {
    throw new Error(`二重引用符の文字列ではない (${where}): ${raw.slice(0, 40)}`);
  }
  const body = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { out += ch; continue; }
    const kind = body[i + 1];
    if (kind === 'u' || kind === 'U') {
      const len = kind === 'u' ? 4 : 8;
      const hex = body.slice(i + 2, i + 2 + len);
      if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) {
        throw new Error(`\\${kind} の桁が読めない (${where}): ${hex}`);
      }
      out += String.fromCodePoint(parseInt(hex, 16));
      i += 1 + len;
    } else if (kind === '\\' || kind === '"') {
      out += kind;
      i += 1;
    } else {
      throw new Error(`知らないエスケープ \\${kind} (${where})`);
    }
  }
  return out;
}

function parseCorpus(text) {
  const lines = text.split('\n');
  const out = new Map();
  let section = null;
  let current = null;
  let inExpected = false;

  for (const line of lines) {
    if (/^\s*$/.test(line)) continue;

    /*
     * 節が変わったら読み込み対象かどうかを判定し直す。
     * このファイルには文字数以外の節（tweets / urls など）もあり、そちらは
     * ここで読む必要がないうえ、別の構文（\n エスケープ等）を含む。
     */
    const sec = /^  (\w+):\s*$/.exec(line);
    if (sec) {
      section = Object.hasOwn(SECTIONS, sec[1]) ? sec[1] : null;
      if (section) out.set(section, []);
      current = null;
      inExpected = false;
      continue;
    }
    if (!section) continue;

    const desc = /^    - description: (.*)$/.exec(line);
    if (desc) {
      current = { description: unquote(desc[1].trim(), section), text: null, weightedLength: null };
      out.get(section).push(current);
      inExpected = false;
      continue;
    }
    if (!current) continue;

    const t = /^      text: (.*)$/.exec(line);
    if (t) { current.text = unquote(t[1].trim(), current.description); inExpected = false; continue; }

    if (/^      expected:\s*$/.test(line)) { inExpected = true; continue; }

    const kv = /^        (\w+): (.*)$/.exec(line);
    if (kv && inExpected) {
      if (kv[1] === 'weightedLength') current.weightedLength = Number(kv[2].trim());
      continue;
    }
  }
  return out;
}

const raw = readFileSync(join(ROOT, CORPUS));
const corpus = parseCorpus(raw.toString('utf8'));

test('借りてきた公式コーパスが、固定したバイト列のままである', () => {
  assert.equal(createHash('sha256').update(raw).digest('hex'), CORPUS_SHA256,
    `${CORPUS} が上流と違う。差し替えるなら出所・コミット・SHA-256を書き換えること`);
  const lic = readFileSync(join(ROOT, 'test/vendor/twitter-text-conformance/LICENSE'));
  assert.equal(createHash('sha256').update(lic).digest('hex'), LICENSE_SHA256,
    'ライセンス文が上流と違う');
});

test('コーパスから期待した件数を読み取れている', () => {
  for (const [name, meta] of Object.entries(SECTIONS)) {
    const got = corpus.get(name);
    assert.ok(got, `節が見つからない: ${name}`);
    assert.equal(got.length, meta.cases, `${name} の件数が変わった: ${got.length}`);
    for (const c of got) {
      assert.equal(typeof c.text, 'string', `text を読めていない: ${c.description}`);
      assert.equal(typeof c.weightedLength, 'number', `weightedLength を読めていない: ${c.description}`);
    }
  }
  // 読み落としがないか。節は3つで、それ以外を拾っていたら気づけるようにする
  const counted = Object.values(SECTIONS).reduce((n, m) => n + m.cases, 0);
  assert.equal(counted, 44, '節の合計件数が想定と違う');
});

/*
 * パーサの自己検査。
 * 自作の読み手が文字列を壊していないかを、**公式実装そのものに判定させる**。
 * 読み違えていれば、公式へ渡した結果がコーパスの期待値とずれる。
 */
test('読み取った文字列を公式実装へ渡すと、コーパスの期待値と一致する', () => {
  let checked = 0;
  for (const [name, meta] of Object.entries(SECTIONS)) {
    for (const c of corpus.get(name)) {
      const off = twitterText.parseTweet(c.text, meta.config).weightedLength;
      assert.equal(off, c.weightedLength,
        `${name} / ${c.description}: 公式=${off} コーパス=${c.weightedLength}（読み取りが壊れている疑い）`);
      checked++;
    }
  }
  assert.equal(checked, 44);
});

test('自己検査が効いているかの対照', () => {
  // 1文字落とした文字列を渡せば、同じ検査が必ず食い違いを出す
  const c = corpus.get('WeightedTweetsWithDiscountedEmojiCounterTest').find((x) => x.text.length > 4);
  const broken = c.text.slice(0, -1);
  const off = twitterText.parseTweet(broken, V3).weightedLength;
  assert.notEqual(off, c.weightedLength, '対照が成立していない＝読み違えを捕まえられない');
});

test('公式コーパスの期待値より少なく数えない', () => {
  let checked = 0;
  for (const [name, meta] of Object.entries(SECTIONS)) {
    if (!meta.appliesToUs) continue;
    for (const c of corpus.get(name)) {
      const mine = GXS.weightedLength(c.text);
      assert.ok(mine >= c.weightedLength,
        `少なく数えた: ${name} / ${c.description} 自前=${mine} 公式=${c.weightedLength}`);
      checked++;
    }
  }
  assert.equal(checked, 24, '対象件数が想定と違う');
});

/*
 * 旧設定（絵文字をコードポイントごとに数える）の節は期待値の対象にしない。
 * ただし文面そのものは有効な入力なので、**RepoShout が合わせている設定の公式値**
 * とは全件で突き合わせる。44件すべてが検査を通る。
 */
test('コーパス全44件の文面を、RepoShoutが合わせている設定の公式値と突き合わせる', () => {
  let checked = 0;
  for (const name of Object.keys(SECTIONS)) {
    for (const c of corpus.get(name)) {
      const mine = GXS.weightedLength(c.text);
      const off = twitterText.parseTweet(c.text, V3).weightedLength;
      assert.ok(mine >= off,
        `少なく数えた: ${name} / ${c.description} 自前=${mine} 公式=${off}`);
      checked++;
    }
  }
  assert.equal(checked, 44);
});

test('コーパス検査が本当に効いているか（対照）', () => {
  const cases = [
    ...corpus.get('WeightedTweetsWithDiscountedEmojiCounterTest'),
    ...corpus.get('UnicodeDirectionalMarkerCounterTest')
  ];
  const broken = (s) => Math.max(0, GXS.weightedLength(s) - 1);
  const caught = cases.some((c) => broken(c.text) < c.weightedLength);
  assert.ok(caught, '1減らしても捕まらない＝この検査は緩い');

  // URLを素の長さで数えていた旧実装相当も捕まる
  const naive = (s) => [...s].length;
  const caughtUrl = cases.some((c) => naive(c.text) < c.weightedLength);
  assert.ok(caughtUrl, 'URLを素で数えても捕まらない＝この検査は緩い');
});
