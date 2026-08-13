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
  existsSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './helpers/load.mjs';

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
function makeFixture(mutations, files = {}) {
  const outer = mkdtempSync(join(tmpdir(), 'reposhout-mut-'));
  writeFileSync(join(outer, 'outside.txt'), 'SAFE\n');
  writeFileSync(join(outer, 'outside.test.mjs'), `
import test from 'node:test';
test('外にある、ふつうに通るテスト', () => {});
`);
  const dir = join(outer, 'repo');
  mkdirSync(dir);
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'test'));
  copyFileSync(RUNNER, join(dir, 'scripts/run-mutations.mjs'));

  writeFileSync(join(dir, 'mod.mjs'),
    'export const value = 1;\nexport const other = 2;\nexport const many = "GAMMA GAMMA";\n');

  writeFileSync(join(dir, GUARD), `
import test from 'node:test';
import assert from 'node:assert/strict';
import { value, other, many } from '../mod.mjs';
test(${JSON.stringify(WANT)}, () => {
  /* ⚠️ 失敗の文へ、わざと2種類のパスを混ぜる——伏字の検査を、動いているOSに
     関わらず効かせるため（Windows のパスは macOS では自然には現れない） */
  assert.equal(value, 1, 'D:\\\\a\\\\repo\\\\mod.mjs と /var/tmp/repo/mod.mjs を見よ');
});
test(${JSON.stringify(OTHER)}, () => { assert.equal(other, 2); });
test('数え上げ: GAMMA が2つ', () => { assert.equal(many.split('GAMMA').length - 1, 2); });
`);
  /* 題材を何も見ない＝変異しても落ちない */
  writeFileSync(join(dir, 'test/blind.test.mjs'), `
import test from 'node:test';
test('題材を何も見ない', () => {});
`);
  /* 変異と関係なく、最初から落ちる */
  writeFileSync(join(dir, 'test/fails.test.mjs'), `
import test from 'node:test';
test('もともと落ちる', () => { throw new Error('変異前から失敗している'); });
`);
  /* 上限まで終わらない */
  writeFileSync(join(dir, 'test/hangs.test.mjs'), `
import test from 'node:test';
test('終わらない', async () => { setInterval(() => {}, 100); await new Promise(() => {}); });
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
test('題材がふつうなら、ふつうに通る', () => {});
`);
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
  writeFileSync(join(dir, 'test/mutations.json'), JSON.stringify({ mutations }, null, 2));
  return { outer, dir };
}

/* 期待する失敗を省略しないための小さな作り手 */
function mut(id, over = {}) {
  return {
    id, file: 'mod.mjs', find: 'export const value = 1;', replace: 'export const value = 99;',
    test: GUARD, desc: id, expectedFailure: { testName: WANT }, ...over
  };
}

function runRunner(dir, { receipt = 'receipt.json', timeout = 8000, extra = [], env = null } = {}) {
  const receiptPath = receipt === null ? null : join(dir, receipt);
  const args = [join(dir, 'scripts/run-mutations.mjs'),
    '--spec', join(dir, 'test/mutations.json'), '--timeout', String(timeout), ...extra];
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
const of = (r, id) => (r.receipt.results.find((x) => x.id === id) || {});
const outcomeOf = (r, id) => of(r, id).outcome;
const kindOf = (r, id) => of(r, id).failureKind;

/* ============================================================
 * ① 落ち方を区別する（第23回監査 R23-001）
 * ============================================================ */

test('落ちた理由を区別する——構文・import・setup・別テストを検知にしない（R23-001）', () => {
  const dir = makeFixture([
    mut('K1'),                                     /* 意図した検査が落ちる */
    mut('K2', { replace: 'export const value = ;' }),
    mut('K3', { replace: "import missing from './does-not-exist.mjs';\nexport const value = 1;" }),
    mut('K4', { replace: "throw new Error('setup が壊れた');\nexport const value = 1;" }),
    mut('K5', { find: 'export const other = 2;', replace: 'export const other = 3;' }),
    mut('K6', { test: 'test/blind.test.mjs', expectedFailure: { testName: '題材を何も見ない' } })
  ]).dir;
  const r = runRunner(dir);
  assert.ok(r.receipt, `証跡が書かれていない:\n${r.stdout}`);

  assert.equal(outcomeOf(r, 'K1'), 'applied_and_killed', '意図した検査の失敗を検知にしていない');
  assert.equal(kindOf(r, 'K1'), 'expected_assertion_failure');
  assert.equal(of(r, 'K1').expectedFailureMatched, true);
  assert.deepEqual(of(r, 'K1').failedTestNames, [WANT], '落ちたテスト名を記録していない');

  /* ★ ここが第23回で見つかった穴。どれも「検知」に化けていた */
  assert.equal(outcomeOf(r, 'K2'), 'runner_error', '構文が壊れただけを検知にしている');
  assert.equal(kindOf(r, 'K2'), 'syntax_error');
  assert.equal(outcomeOf(r, 'K3'), 'runner_error', 'import の失敗を検知にしている');
  assert.equal(kindOf(r, 'K3'), 'module_resolution_error');
  assert.equal(outcomeOf(r, 'K4'), 'runner_error', '読み込み時の例外を検知にしている');
  assert.equal(kindOf(r, 'K4'), 'bootstrap_error');
  assert.equal(outcomeOf(r, 'K5'), 'runner_error', '別のテストだけの失敗を検知にしている');
  assert.equal(kindOf(r, 'K5'), 'wrong_test_failure');
  assert.deepEqual(of(r, 'K5').failedTestNames, [OTHER],
    '実際に落ちたのが別のテストであることを記録していない');

  assert.equal(outcomeOf(r, 'K6'), 'applied_but_survived', '素通りを別の分類にしている');
  assert.equal(r.exitCode, 1, 'これだけ問題があるのに成功で終わっている');
});

test('どのテストが落ちるはずかを宣言していない変異は、測れない（R23-001）', () => {
  const dir = makeFixture([{ id: 'E1', file: 'mod.mjs',
    find: 'export const value = 1;', replace: 'export const value = 99;',
    test: GUARD, desc: '宣言なし' }]).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'E1'), 'runner_error', '宣言が無いのに検知にしている');
  assert.equal(kindOf(r, 'E1'), 'expectation_missing');
});

test('証跡に、落ちた理由と落ちたテスト名が残る（R23-001）', () => {
  const { dir } = makeFixture([mut('P1')]);
  const r = runRunner(dir);
  const one = r.receipt.results[0];
  for (const k of ['failureKind', 'failedTestNames', 'expectedFailure',
    'expectedFailureMatched', 'sanitizedDiagnostic', 'stdoutSha256', 'stderrSha256']) {
    assert.ok(k in one, `証跡に ${k} が無い`);
  }
  assert.equal(one.expectedFailure.testName, WANT);
  /* 診断は伏せてから残す（絶対パスと長い列を出さない） */
  assert.ok(typeof one.sanitizedDiagnostic === 'string' && one.sanitizedDiagnostic.length > 0);
  /*
   * ⚠️ 「/private/ か /Users/ か /home/ で始まるか」で見ていたが、使い捨ての
   * 作業場は /var/folders/… なので**一度も当たらなかった**（変異 P08 が素通り）。
   * 題材そのもののパスで見る——これなら環境によらず必ず当たる。
   */
  assert.ok(!one.sanitizedDiagnostic.includes(dir),
    `診断に作業場の絶対パスが残っている: ${one.sanitizedDiagnostic.slice(0, 160)}`);
  assert.match(one.sanitizedDiagnostic, /<path>/,
    '伏せた印が無い＝そもそも伏せていない');
  /*
   * ⚠️ **落ちた理由の本文まで入っていること。** 見出しの行だけを集めていた版では
   * 本文が1文字も入らず、下の「パスが残っていないか」が**当たるものが無いまま**
   * 通っていた（変異 P25 が素通りして分かった）。
   */
  assert.match(one.sanitizedDiagnostic, /を見よ/,
    `落ちた理由の本文が入っていない: ${one.sanitizedDiagnostic.slice(0, 200)}`);
  /*
   * ⚠️ **どのOSでも、両方の形のパスを伏せる。**
   * Windows の CI で「バックスラッシュのパスが伏せられていない」と落ちた。
   * 動いているOSに現れる形だけを見ていると、片方は永久に検査されない。
   */
  assert.ok(!one.sanitizedDiagnostic.includes('D:\\a\\repo'),
    `Windows形式のパスが残っている: ${one.sanitizedDiagnostic.slice(0, 160)}`);
  assert.ok(!one.sanitizedDiagnostic.includes('/var/tmp/repo'),
    `POSIX形式のパスが残っている: ${one.sanitizedDiagnostic.slice(0, 160)}`);
});

/* ============================================================
 * ② 書き込む範囲と、必ず戻すこと（第23回監査 R23-002）
 * ============================================================ */

test('変異する対象が、リポジトリの外を指せない（R23-002）', () => {
  const { outer, dir } = makeFixture([
    mut('O1', { file: '../outside.txt', find: 'SAFE', replace: 'BROKEN' })
  ]);
  const before = readFileSync(join(outer, 'outside.txt'), 'utf8');
  const r = runRunner(dir);
  const after = readFileSync(join(outer, 'outside.txt'), 'utf8');
  assert.equal(outcomeOf(r, 'O1'), 'runner_error',
    'リポジトリの外を書き換えたうえで検知にしている');
  assert.equal(kindOf(r, 'O1'), 'target_rejected');
  assert.match(of(r, 'O1').error, /リポジトリの外/, `別の理由で止めている: ${of(r, 'O1').error}`);
  assert.equal(after, before, '外のファイルが書き換わっている');
});

test('リポジトリの中の symlink で外へ出られない（R23-002）', { skip: process.platform === 'win32'
  ? 'Windows では symlink の作成に権限が要るため、この題材を作れない' : false }, () => {
  const { outer, dir } = makeFixture([
    mut('L1', { file: 'link.txt', find: 'SAFE', replace: 'BROKEN' })
  ]);
  symlinkSync(join(outer, 'outside.txt'), join(dir, 'link.txt'));
  const before = readFileSync(join(outer, 'outside.txt'), 'utf8');
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'L1'), 'runner_error', 'symlink 越しに外を書き換えている');
  assert.match(of(r, 'L1').error, /symlink/, `別の理由で止めている: ${of(r, 'L1').error}`);
  assert.equal(readFileSync(join(outer, 'outside.txt'), 'utf8'), before);
});

test('対象テストがリポジトリの外を指せない（外に実在しても）（R23-002）', () => {
  const dir = makeFixture([mut('T1', { test: '../outside.test.mjs' })]).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'T1'), 'runner_error');
  assert.match(of(r, 'T1').error, /リポジトリの外/);
});

test('復旧が例外を投げても、証跡が残り、検知にはならない（R23-002）', () => {
  /*
   * ⚠️ 前はここでランナーごと落ち、**証跡が1行も書かれなかった**。
   * 何が起きたか誰にも分からないまま終わるのがいちばん困る。
   */
  const dir = makeFixture([mut('X1', { test: 'test/wreck.test.mjs',
    expectedFailure: { testName: '変異したときだけ、対象を消してディレクトリにする' } })], {
    'test/wreck.test.mjs': `
import test from 'node:test';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
const p = new URL('../mod.mjs', import.meta.url);
const mutated = readFileSync(p, 'utf8').includes('99');
test('変異したときだけ、対象を消してディレクトリにする', () => {
  if (!mutated) return;
  rmSync(p, { force: true });
  mkdirSync(p);
  throw new Error('わざと落とす');
});
`
  }).dir;
  const r = runRunner(dir);
  assert.ok(r.receipt, `復旧が例外を投げると証跡が残らない:\n${r.stdout}`);
  assert.equal(outcomeOf(r, 'X1'), 'runner_error', '戻せていないのに検知にしている');
  assert.equal(kindOf(r, 'X1'), 'restore_failed');
  assert.equal(of(r, 'X1').restored, false);
  assert.ok(of(r, 'X1').restoreError, '復旧の失敗理由が残っていない');
  assert.notEqual(r.exitCode, 0);
});

test('書いたのに読み戻せなければ、戻したうえでランナー失敗にする（R23-002）', () => {
  /*
   * 前は「当たらなかった（not_applied）」かつ「戻した（restored: true）」として
   * **復旧を呼ばずに**次へ進んでいた——ファイルは変異したまま、証跡は嘘をついていた。
   * 読み戻しの結果を変える題材は作れないので、**実装にその分岐が在ること**と、
   * ふつうの経路では確かに戻せていることを見る。
   */
  const src = readFileSync(RUNNER, 'utf8');
  assert.match(src, /readback_mismatch/, '読み戻し不一致の分類が無い');
  assert.match(src, /wrote: true[\s\S]{0,240}読み戻せない/,
    '読み戻せなかったとき「書いた」と記録していない');
  const dir = makeFixture([mut('R1')]).dir;
  const r = runRunner(dir);
  assert.equal(of(r, 'R1').restored, true, '対照: ふつうは戻せている');
  assert.equal(of(r, 'R1').restoredSha256, of(r, 'R1').beforeSha256);
});

/* ============================================================
 * ③ 第22回までの分類（引き続き効いていること）
 * ============================================================ */

test('前提が崩れている状態を、検知として数えない（R22-004）', () => {
  const dir = makeFixture([
    mut('A1'),
    mut('A3', { find: 'NOPE' }),
    mut('A4', { find: 'GAMMA', replace: 'DELTA', expectMatches: 1 }),
    mut('A5', { test: 'test/does-not-exist.test.mjs' }),
    mut('A6', { test: 'test/fails.test.mjs', expectedFailure: { testName: 'もともと落ちる' } }),
    mut('A7', { test: 'test/hangs.test.mjs', expectedFailure: { testName: '終わらない' } }),
    mut('A10', { replace: 'export const value = 1; // HANGNOW',
      test: 'test/breaks-after.test.mjs',
      expectedFailure: { testName: '題材がふつうなら、ふつうに通る' } }),
    mut('A11', { replace: 'export const value = 1; // BOOMNOW',
      test: 'test/breaks-after.test.mjs',
      expectedFailure: { testName: '題材がふつうなら、ふつうに通る' } })
  ]).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'A1'), 'applied_and_killed');
  assert.equal(outcomeOf(r, 'A3'), 'not_applied', '一致0を素通りに寄せている');
  assert.equal(outcomeOf(r, 'A4'), 'not_applied', '一致数の食い違いを見逃している');
  for (const [id, what] of [['A5', '存在しないテスト'], ['A6', 'もともと落ちるテスト'],
    ['A7', '終わらないテスト'], ['A10', '変異後に終わらなくなるテスト']]) {
    assert.equal(outcomeOf(r, id), 'runner_error',
      `${what}が ${outcomeOf(r, id)} になっている（検知として数えてはいけない）`);
  }
  /*
   * ⚠️ **「止まった」だけでなく「どの検査が止めたか」まで見る。**
   * outcome しか見ていなかったので、手前の検査を外しても後ろの検査が
   * 別の理由で止め、**外したことに気づけなかった**（N19・N21 が素通りした）。
   */
  assert.equal(kindOf(r, 'A5'), 'target_rejected',
    `存在しないテストを、パスの検査で止めていない: ${kindOf(r, 'A5')}`);
  assert.equal(kindOf(r, 'A6'), 'baseline_failed');
  assert.equal(kindOf(r, 'A7'), 'baseline_failed');
  assert.equal(kindOf(r, 'A10'), 'timeout',
    `上限打ち切りを、上限として分類していない: ${kindOf(r, 'A10')}`);
  assert.equal(of(r, 'A10').timedOut, true, '上限で打ち切ったのに、証跡へそう書いていない');

  /*
   * ⚠️ **A11（変異後に、外から signal で殺される）は POSIX でしか作れない。**
   * Windows に signal は無く、外からプロセスを終わらせても親へ届くのは終了コード
   * だけ——「外から殺された」と「テストがふつうに落ちた」を境界では区別できない。
   * 1つの環境の実測で期待値を反転させず、環境ごとに何が観測できるかで分ける。
   */
  const boom = of(r, 'A11');
  if (process.platform === 'win32') {
    assert.equal(boom.signal, null,
      'Windows で signal が観測できている＝前提が変わったので、この分岐を見直す');
  } else {
    assert.equal(outcomeOf(r, 'A11'), 'runner_error',
      `変異後に signal で死ぬテストが ${outcomeOf(r, 'A11')} になっている`);
    assert.equal(boom.signal, 'SIGKILL');
    assert.equal(boom.exitCode, null);
  }
});

test('変異前に対象テストを素で走らせ、その結果を証跡へ残す（R22-004）', () => {
  const dir = makeFixture([mut('B1')]).dir;
  const r = runRunner(dir);
  assert.equal(r.exitCode, 0, `正常な変異1件で失敗している:\n${r.stdout}`);
  const bl = r.receipt.baselines.find((b) => b.test === GUARD);
  assert.ok(bl && bl.passed === true && bl.exitCode === 0 && bl.stdoutSha256,
    '変異前の対照が記録されていない');
  const one = r.receipt.results[0];
  assert.equal(one.baseline.exitCode, 0);
  assert.notEqual(one.beforeSha256, one.afterSha256);
  assert.equal(one.restoredSha256, one.beforeSha256);
});

test('期待した数だけ置換し、置換した数を証跡へ残す（R22-004）', () => {
  const dir = makeFixture([
    mut('C1', { find: 'GAMMA', replace: 'DELTA', expectMatches: 2,
      expectedFailure: { testName: '数え上げ: GAMMA が2つ' } }),
    /*
     * ⚠️ 置き換え残しを「0 と決め打ち」しても C1 は通ってしまう（変異 P14 が素通りした）。
     * 置換後に `find` が残る形——`replace` が `find` を含む——を1つ入れて、
     * **数えた結果**でなければ合わない値を要求する。
     */
    mut('C2', { find: 'GAMMA', replace: 'GAMMA GAMMA', expectMatches: 2,
      expectedFailure: { testName: '数え上げ: GAMMA が2つ' } })
  ]).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'C1'), 'applied_and_killed');
  assert.equal(of(r, 'C1').appliedReplacementCount, 2, '期待した数だけ置換していない');
  /*
   * ⚠️ 置換した数を「一致数」から計算すると、**1個しか置き換えていなくても
   * 2と書ける**（N24 がそれで素通りした）。置き換え残しを実測で見る。
   */
  assert.equal(of(r, 'C1').remainingAfter, 0,
    `置き換え残しがある: ${of(r, 'C1').remainingAfter}`);
  assert.equal(outcomeOf(r, 'C2'), 'applied_and_killed');
  assert.equal(of(r, 'C2').remainingAfter, 4,
    `置き換え残しを数えていない（2箇所を「GAMMA GAMMA」にしたら4残るはず）: ${of(r, 'C2').remainingAfter}`);
  assert.match(readFileSync(join(dir, 'mod.mjs'), 'utf8'), /GAMMA/, '元へ戻していない');
});

test('証跡には、何をどの版で測ったかが入る（R22-004）', () => {
  const dir = makeFixture([mut('D1')]).dir;
  const r = runRunner(dir);
  const p = r.receipt.provenance;
  for (const k of ['runnerSha256', 'specSha256', 'nodeVersion', 'startedAt', 'completedAt', 'timeoutMs']) {
    assert.ok(p[k] !== undefined && p[k] !== null, `由来に ${k} が無い`);
  }
  assert.match(p.runnerSha256, /^[0-9a-f]{64}$/);
  const spec = JSON.parse(readFileSync(join(dir, 'test/mutations.json'), 'utf8'));
  spec.mutations[0].desc += '（変えた）';
  writeFileSync(join(dir, 'test/mutations.json'), JSON.stringify(spec, null, 2));
  const r2 = runRunner(dir, { receipt: 'receipt2.json' });
  assert.notEqual(r2.receipt.provenance.specSha256, p.specSha256,
    '定義を変えても証跡のハッシュが同じ＝測った対象を記録できていない');
});

test('証跡を書けなければ、成功で終わらない（R22-004）', () => {
  const dir = makeFixture([mut('E2')]).dir;
  const r = runRunner(dir, { receipt: join('no-such-dir', 'deep', 'receipt.json') });
  assert.notEqual(r.exitCode, 0, '証跡を書けなかったのに成功で終わっている');
});

test('分類の4値は、証跡の集計と1件ずつ一致する（R22-004）', () => {
  const dir = makeFixture([
    mut('G1'),
    mut('G2', { test: 'test/blind.test.mjs', expectedFailure: { testName: '題材を何も見ない' } }),
    mut('G3', { find: 'NOPE' }),
    mut('G4', { test: 'test/fails.test.mjs', expectedFailure: { testName: 'もともと落ちる' } })
  ]).dir;
  const r = runRunner(dir);
  const count = (o) => r.receipt.results.filter((x) => x.outcome === o).length;
  assert.equal(r.receipt.applied_and_killed, count('applied_and_killed'));
  assert.equal(r.receipt.applied_but_survived, count('applied_but_survived'));
  assert.equal(r.receipt.not_applied, count('not_applied'));
  assert.equal(r.receipt.runner_error, count('runner_error'));
  assert.deepEqual(
    [r.receipt.applied_and_killed, r.receipt.applied_but_survived,
      r.receipt.not_applied, r.receipt.runner_error], [1, 1, 1, 1],
    `4値がそれぞれ1件ずつにならない: ${JSON.stringify(r.receipt.results.map((x) => [x.id, x.outcome]))}`);
  assert.match(r.stdout, /素通り 1/);
  assert.match(r.stdout, /当たらなかった 1/);
  assert.match(r.stdout, /ランナー失敗 1/);
});

test('呼ばれ方（NODE_TEST_CONTEXT）で判定が変わらない（R22-004の作業中に発見）', () => {
  /*
   * ⚠️ `node --test` は、自分が別の test runner の子だと判断すると
   * **失敗しても終了コード 0 で終わる**。この変数が孫へ伝わると、
   * ランナーから見たテストは常に「通った」——**全件が素通りに化ける**。
   */
  const mutations = [mut('H1'),
    mut('H2', { test: 'test/blind.test.mjs', expectedFailure: { testName: '題材を何も見ない' } })];
  /* まず、この環境変数が本当に終了コードを変えることを確かめる（対照）。
     ⚠️ このテスト自身が `node --test` の中なので、**素の環境は自分で作る**。 */
  const probe = makeFixture(mutations).dir;
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_TEST_CONTEXT;
  delete cleanEnv.NODE_OPTIONS;
  let bare = 0, wrapped = 0;
  try { execFileSync(process.execPath, ['--test', 'test/fails.test.mjs'],
    { cwd: probe, stdio: 'pipe', env: cleanEnv }); } catch (e) { bare = e.status; }
  try { execFileSync(process.execPath, ['--test', 'test/fails.test.mjs'],
    { cwd: probe, stdio: 'pipe', env: { ...cleanEnv, NODE_TEST_CONTEXT: 'child-v8' } }); }
  catch (e) { wrapped = e.status; }
  assert.equal(bare, 1, '対照: 素で走らせれば落ちるテストは 1 で終わる');
  assert.equal(wrapped, 0,
    'この node では NODE_TEST_CONTEXT が終了コードを変えない＝以下の検査は空振り');

  const dir = makeFixture(mutations).dir;
  const r = runRunner(dir, { env: { NODE_TEST_CONTEXT: 'child-v8' } });
  assert.equal(outcomeOf(r, 'H1'), 'applied_and_killed',
    '呼び出し元の環境変数で、検知が素通りに化けている');
  assert.equal(outcomeOf(r, 'H2'), 'applied_but_survived');
});
