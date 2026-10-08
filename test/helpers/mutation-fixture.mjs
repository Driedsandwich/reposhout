/*
 * 変異対照ランナー自身の対照
 *   第22回監査 R22-004 で新設（静的な文字列検査 → 実際に起動する対照へ）
 *   第23回監査 R23-001 / R23-002 で「落ちた理由」と「書き込む範囲」を足した
 *
 * ⚠️ **道具が壊れると、結果が読めなくなる。**
 *
 * 第21回の自己検査は「4つの分類名がソースに書いてあるか」を見るだけだった。
 * 名前が書いてあることは、区別できることの証拠にならない——第22回に、
 * 変異と無関係な失敗（元から落ちる／存在しない／終わらないテスト）が
 * 全部「検知」に化けていた。
 *
 * ⚠️ **第23回で、さらにその裏返しが出た。**
 * 変異前に通っていても、**落ちた理由**を見ていなかったので:
 *
 *   構文が壊れただけ／import に失敗しただけ／読み込み時に例外／
 *   **別のテストだけ**が落ちた
 *
 * が全部「検知」だった。守りたい検査は無傷なのに、守られていることになる。
 *
 * そこでこのテストは、**ランナーを別プロセスとして実際に起動する**。
 * 使い捨てのディレクトリに題材とテストを並べ、状態を作って、
 * 証跡JSONに出る分類を1件ずつ突き合わせる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync,
  existsSync, symlinkSync, readdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './load.mjs';

const RUNNER = join(ROOT, 'scripts/run-mutations.mjs');
const GUARD = 'test/guard.test.mjs';
const WANT = '守りたい検査: value は 1';
const OTHER = '別の検査: other は 2';

/*
 * 題材とテストを並べた使い捨ての作業場を作り、そこへランナーを複製する。
 * root を1段深くして、**外側に実在するファイル**を置けるようにしてある
 * ——「リポジトリの外を指している」検査は、外のファイルが実在しないと、
 * 手前の「ファイルが無い」検査に先を越されて空振りする。
 */
/*
 * 題材を git リポジトリにする（第24回監査 R24-002）。
 * 由来（commit / tree / status）が取れないと走らない仕様にしたので、
 * 題材の側も**本物の由来を持つ**ようにする。
 */
function initGit(dir) {
  const id = ['-c', 'user.email=t@example.invalid', '-c', 'user.name=fixture'];
  const run = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  run('init', '-q');
  run(...id, 'add', '-A');
  run(...id, 'commit', '-qm', 'fixture');
}

function makeFixture(mutations, files = {}, { git = true } = {}) {
  const outer = mkdtempSync(join(tmpdir(), 'reposhout-mut-'));
  writeFileSync(join(outer, 'outside.txt'), 'SAFE\n');
  writeFileSync(join(outer, 'outside.test.mjs'), `
import test from 'node:test';
test('外にある、ふつうに通るテスト', () => {});  /* GXS_MARK.OUTSIDE */
`);
  const dir = join(outer, 'repo');
  mkdirSync(dir);
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'test'));
  copyFileSync(RUNNER, join(dir, 'scripts/run-mutations.mjs'));
  /*
   * ⚠️ ランナーが読み込む物も一緒に複製する（第26回監査 R26-001 で lib を分けた）。
   * 忘れると題材のランナーが**起動すらできず**、全部の分類が読めなくなる。
   */
  mkdirSync(join(dir, 'scripts/lib'));
  for (const f of readdirSync(join(ROOT, 'scripts/lib'))) {
    copyFileSync(join(ROOT, 'scripts/lib', f), join(dir, 'scripts/lib', f));
  }

  writeFileSync(join(dir, 'mod.mjs'),
    'export const value = 1;\nexport const other = 2;\nexport const many = "GAMMA GAMMA";\n');

  writeFileSync(join(dir, GUARD), `
import test from 'node:test';
import assert from 'node:assert/strict';
import { value, other, many } from '../mod.mjs';
test(${JSON.stringify(WANT)}, () => {
  /* ⚠️ 失敗の文へ、わざと2種類のパスを混ぜる——伏字の検査を、動いているOSに
     関わらず効かせるため（Windows のパスは macOS では自然には現れない） */
  assert.equal(value, 1, 'GXS_MARK.WANT D:\\\\a\\\\repo\\\\mod.mjs と /var/tmp/repo/mod.mjs を見よ');
});
/* 一意でない目印の題材（第26回監査 R26-001）。わざと2か所に置く: */
/* GXS_MARK.TWICE */
/* GXS_MARK.TWICE */
test(${JSON.stringify(OTHER)}, () => { assert.equal(other, 2, 'GXS_MARK.OTHER: other が 2 でない'); });
test('数え上げ: GAMMA が2つ', () => { assert.equal(many.split('GAMMA').length - 1, 2, 'GXS_MARK.COUNT: GAMMA の数が違う'); });
`);
  /* 題材を何も見ない＝変異しても落ちない */
  writeFileSync(join(dir, 'test/blind.test.mjs'), `
import test from 'node:test';
test('題材を何も見ない', () => {});  /* GXS_MARK.BLIND */
`);
  /* 変異と関係なく、最初から落ちる */
  writeFileSync(join(dir, 'test/fails.test.mjs'), `
import test from 'node:test';
test('もともと落ちる', () => { throw new Error('GXS_MARK.BASELINE: 変異前から失敗している'); });
`);
  /* 上限まで終わらない */
  writeFileSync(join(dir, 'test/hangs.test.mjs'), `
import test from 'node:test';
test('終わらない', async () => { setInterval(() => {}, 100); await new Promise(() => {}); });  /* GXS_MARK.HANG */
`);
  /*
   * 変異前は通り、**変異後に初めて**壊れる。
   * 変異前から壊れているものは対照の段階で止まるので、
   * 変異後の分類（上限打ち切り・signal）はこれでないと通らない。
   */
  writeFileSync(join(dir, 'test/breaks-after.test.mjs'), `
import test from 'node:test';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
if (body.includes('HANGNOW')) { setInterval(() => {}, 100); await new Promise(() => {}); }
if (body.includes('BOOMNOW')) {
  /*
   * ⚠️ 自分（分離された test プロセス）を殺しても、node --test の親が
   * 受け止めて**ふつうの失敗（exit 1）**にしてしまう。ランナーから見える
   * 境界は親のほうなので、外から殺された状況を作るには**親**を殺す。
   */
  process.kill(process.ppid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 3000));
}
test('題材がふつうなら、ふつうに通る', () => {});  /* GXS_MARK.BREAKS */
`);
  /*
   * 変異後に **assertion ではなく TypeError** で落ちる題材（第24回監査 R24-001）。
   * 名前が一致しても、守りたい assertion は一度も走っていない。
   */
  writeFileSync(join(dir, 'test/throws.test.mjs'), `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
test('例外で落ちる検査', () => {
  if (body.includes('99')) { const o = null; return o.missing.deep; }
  assert.ok(true, 'GXS_MARK.THROWS: ここまで来たら題材が壊れている');
});
`);
  /*
   * 落ちた値が **YAML の診断に見える** 題材（第26回監査 R26-002 の作業中に発見）。
   * `assert.match` が落ちると、Node は照合した文字列を `actual: |-` の
   * ブロックスカラーで出す。その本文に `name:` の行が入っていると、
   * 字下げを見ない解析は**それを診断の最上位のキーと取り違える**——
   * 落ち方が `AssertionError` から本文の値へ化ける。
   * ⚠️ 本番で実際にこれを踏んだ（N30・M32・W09・S27 は ci.yml、W14 は
   * ランナー自身の本文。189件のうち5件の証跡が「証拠にならない」になった）。
   */
  writeFileSync(join(dir, 'test/yamlish.test.mjs'), `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
const HAYSTACK = [
  'steps:',
  '  - uses: actions/upload-artifact@v4',
  '    with:',
  '      name: GXS_LIE_NAME',
  '      path: out.json'
].join('\\n');
test('診断に見える本文で落ちる検査', () => {
  assert.match(HAYSTACK, new RegExp(body.includes('99') ? 'NEVER_MATCHES_ANYTHING' : 'steps'),
    'GXS_MARK.YAMLISH 診断に見える本文');
});
`);
  /*
   * 落ちた値の中に `code:` の行が入る題材（第26回監査 R26-002 の作業中に発見）。
   * `name:` 側と `code:` 側は別々に化けるので、両方を題材で持つ。
   */
  writeFileSync(join(dir, 'test/yamlish-code.test.mjs'), `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
const HAYSTACK = [
  'const rec = {',
  '  code: hits[0].code, errName: hits[0].errName },',
  '};'
].join('\\n');
test('診断の code に見える本文で落ちる検査', () => {
  assert.match(HAYSTACK, new RegExp(body.includes('99') ? 'NEVER_MATCHES_ANYTHING' : 'const rec'),
    'GXS_MARK.YAMLISHCODE 診断の code に見える本文');
});
`);
  /*
   * **assertion を名乗るだけ**の失敗（第26回監査 R26-002 の作業中に発見）。
   * `code` と `name` の片方だけが assertion の値を持つ例外を投げる。
   * 守りたい assertion は一度も走っていないので、検知にしてはいけない。
   */
  writeFileSync(join(dir, 'test/fake-assertion.test.mjs'), `
import test from 'node:test';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
function pretend(errName, code, marker) {
  const e = new Error(marker + ' assertion を名乗るだけの失敗');
  e.name = errName; e.code = code;
  throw e;
}
test('名前だけ AssertionError の検査', () => {
  if (body.includes('99')) pretend('AssertionError', 'ERR_INVALID_STATE', 'GXS_MARK.FAKENAME');
});
test('code だけ ERR_ASSERTION の検査', () => {
  if (body.includes('99')) pretend('TypeError', 'ERR_ASSERTION', 'GXS_MARK.FAKECODE');
});
`);
  /* 同じ名前のテストが2つ——守りたい方は通り、無関係な同名だけが落ちる */
  writeFileSync(join(dir, 'test/dup.test.mjs'), `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
test('同じ名前', () => { assert.ok(true); });  /* GXS_MARK.DUP */
test('同じ名前', () => { assert.ok(!body.includes('99'), '無関係な同名が落ちた'); });
`);
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
  writeFileSync(join(dir, 'test/mutations.json'), JSON.stringify({ mutations }, null, 2));
  if (git) initGit(dir);
  return { outer, dir };
}

/* 期待する失敗を省略しないための小さな作り手 */
/*
 * 題材ごとの目印（第25回監査 R25-001）。
 * 「どの assertion が落ちたか」まで決めるので、宣言には必ず目印が要る。
 * ここに無い題材は、呼び出し側が `diagnosticMarker` を明示する。
 */
const FIXTURE_MARKERS = {
  [WANT]: 'GXS_MARK.WANT',
  [OTHER]: 'GXS_MARK.OTHER',
  '数え上げ: GAMMA が2つ': 'GXS_MARK.COUNT',
  '題材を何も見ない': 'GXS_MARK.BLIND',
  'もともと落ちる': 'GXS_MARK.BASELINE',
  '終わらない': 'GXS_MARK.HANG',
  '題材がふつうなら、ふつうに通る': 'GXS_MARK.BREAKS',
  '例外で落ちる検査': 'GXS_MARK.THROWS',
  '同じ名前': 'GXS_MARK.DUP',
  '診断に見える本文で落ちる検査': 'GXS_MARK.YAMLISH',
  '診断の code に見える本文で落ちる検査': 'GXS_MARK.YAMLISHCODE',
  '名前だけ AssertionError の検査': 'GXS_MARK.FAKENAME',
  'code だけ ERR_ASSERTION の検査': 'GXS_MARK.FAKECODE',
  '外にある、ふつうに通るテスト': 'GXS_MARK.OUTSIDE'
};

function mut(id, over = {}) {
  const m = {
    id, file: 'mod.mjs', find: 'export const value = 1;', replace: 'export const value = 99;',
    test: GUARD, desc: id, expectedFailure: { testName: WANT }, ...over
  };
  const ef = m.expectedFailure;
  if (ef && ef.testName && !ef.diagnosticMarker && FIXTURE_MARKERS[ef.testName]) {
    ef.diagnosticMarker = FIXTURE_MARKERS[ef.testName];
  }
  return m;
}

/*
 * ⚠️ 題材は**証拠ではない**ので、既定で `--allow-dirty` を付ける
 *（第25回監査 R25-002）。題材はテストの途中で書き換えるものが多く、
 * そこで「汚れているから走らない」と止まると、測りたいものが測れない。
 * 汚れた木を拒む挙動そのものは、専用の検査が `allowDirty: false` で見る。
 */
function runRunner(dir, { receipt = 'receipt.json', timeout = 8000, extra = [],
                          env = null, allowDirty = true } = {}) {
  const receiptPath = receipt === null ? null : join(dir, receipt);
  const args = [join(dir, 'scripts/run-mutations.mjs'),
    '--spec', join(dir, 'test/mutations.json'), '--timeout', String(timeout),
    ...(allowDirty ? ['--allow-dirty'] : []), ...extra];
  if (receiptPath) args.push('--receipt', receiptPath);
  let exitCode = 0, stdout = '';
  try {
    stdout = execFileSync(process.execPath, args,
      { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 120000,
        env: env ? { ...process.env, ...env } : process.env });
  } catch (e) {
    exitCode = typeof e.status === 'number' ? e.status : -1;
    stdout = String(e.stdout || '');
  }
  const json = receiptPath && existsSync(receiptPath)
    ? JSON.parse(readFileSync(receiptPath, 'utf8')) : null;
  return { exitCode, stdout, receipt: json, dir, receiptPath };
}
/*
 * ⚠️ 証跡が無いときに **TypeError で落ちない**（第24回監査 R24-001 の趣旨）。
 * 補助関数が先に倒れると、守りたい assertion は一度も走らないのに
 * 「落ちた＝検知」に見えてしまう（N19 で実測）。
 */
const of = (r, id) => {
  assert.ok(r.receipt, `証跡が無い（exit=${r.exitCode}）。何を測ったか言えない:\n${r.stdout}`);
  assert.ok(Array.isArray(r.receipt.results),
    `証跡に results が無い: ${JSON.stringify(r.receipt).slice(0, 300)}`);
  return r.receipt.results.find((x) => x.id === id) || {};
};
const outcomeOf = (r, id) => of(r, id).outcome;
const kindOf = (r, id) => of(r, id).failureKind;
/* ------------------------------------------------------------------
 * 第26回監査 R26-002 の作業中に、ここへ切り出した。
 * ⚠️ **1つのファイルに自己検査を積み上げると、1変異あたりの実行が長くなる。**
 * 実測: 44件まで増えたところで1回およそ 90 秒、守りたい検査を壊す変異では
 * 300 秒の上限を超えて打ち切られた（4件）。**検知できたはずのものが
 * 「結果は何も言えない」に化ける。** 題材の道具をここへ出し、検査は
 * mutation-runner.test.mjs（①〜④）と mutation-evidence.test.mjs（⑤〜⑧）へ分ける。
 * ------------------------------------------------------------------ */
export { RUNNER, GUARD, WANT, OTHER, initGit, makeFixture, mut, runRunner, of, outcomeOf, kindOf };
