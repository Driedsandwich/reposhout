/*
 * 変異対照ランナー自身の対照 ①〜④
 *   第22回監査 R22-004 で新設（静的な文字列検査 → 実際に起動する対照へ）
 *   第23回監査 R23-001 / R23-002 で「落ちた理由」と「書き込む範囲」を足した
 *   第26回監査 R26-002 の作業中に、⑤〜⑧を mutation-evidence.test.mjs へ分けた
 *
 * ⚠️ **道具が壊れると、結果が読めなくなる。** ここはランナーを別プロセスとして
 * 実際に起動し、使い捨ての作業場に題材を並べて、証跡JSONに出る分類を突き合わせる。
 * 題材の道具は helpers/mutation-fixture.mjs にある。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync, mkdirSync, linkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './helpers/load.mjs';
import { RUNNER, GUARD, WANT, OTHER, makeFixture, mut, runRunner, of, outcomeOf, kindOf }
  from './helpers/mutation-fixture.mjs';

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
  assert.equal(kindOf(r, 'K2'), 'syntax_error', 'GXS_MARK.SHARED_12');
  assert.equal(outcomeOf(r, 'K3'), 'runner_error', 'import の失敗を検知にしている');
  assert.equal(kindOf(r, 'K3'), 'module_resolution_error', 'GXS_MARK.P04');
  assert.equal(outcomeOf(r, 'K4'), 'runner_error', '読み込み時の例外を検知にしている');
  assert.equal(kindOf(r, 'K4'), 'bootstrap_error');
  assert.equal(outcomeOf(r, 'K5'), 'runner_error', '別のテストだけの失敗を検知にしている');
  assert.equal(kindOf(r, 'K5'), 'wrong_test_failure', 'GXS_MARK.P01');
  assert.deepEqual(of(r, 'K5').failedTestNames, [OTHER],
    '実際に落ちたのが別のテストであることを記録していない');

  assert.equal(outcomeOf(r, 'K6'), 'applied_but_survived', '素通りを別の分類にしている');
  assert.equal(r.exitCode, 1, 'これだけ問題があるのに成功で終わっている');
});

test('名前が合っていても、assertion で落ちていなければ検知にしない（R24-001）', () => {
  /*
   * ⚠️ **第24回監査 R24-001。** 名前の一致だけを見ていたので、
   * 宣言したテストが「JSONが壊れて JSON.parse が投げた」「null を読んで TypeError」
   * 「unhandledRejection」で落ちても検知に数えていた——**守りたい assertion は
   * 一度も走っていない**のに。111件を1件ずつ測って、5件がこれだった。
   */
  const dir = makeFixture([
    mut('Q1', { test: 'test/throws.test.mjs', expectedFailure: { testName: '例外で落ちる検査' } }),
    mut('Q2')   /* 対照: ふつうに assertion で落ちる */
  ]).dir;
  const r = runRunner(dir);
  assert.ok(r.receipt, `証跡が残っていない:\n${r.stdout}`);
  assert.equal(outcomeOf(r, 'Q1'), 'runner_error',
    `例外で落ちただけなのに ${outcomeOf(r, 'Q1')} にしている`);
  assert.equal(kindOf(r, 'Q1'), 'unexpected_failure_kind', 'GXS_MARK.SHARED_13 TypeError を assertion の検知として数えている');
  assert.equal(of(r, 'Q1').actualFailureKind, 'TypeError',
    `落ち方を記録していない: ${JSON.stringify(of(r, 'Q1').actualFailureKind)}`);
  /* 対照が無いと、単に全部を落としているのか区別できない */
  assert.equal(outcomeOf(r, 'Q2'), 'applied_and_killed');
  assert.equal(of(r, 'Q2').actualFailureKind, 'assertion');
});

test('落ちた値が診断の YAML に見えても、落ち方を取り違えない（R26-002の作業中に発見）', () => {
  /*
   * ⚠️ **第26回監査 R26-002 の作業中に発見。** TAP の診断は
   *     code: 'ERR_ASSERTION'
   *     name: 'AssertionError'
   *     actual: |-
   *       …落ちた値…
   * の形で出る。`actual: |-` の本文が YAML やソースだと、中に `name:` や
   * `code:` の行が入る。字下げを見ずに拾っていたので、**本文の値が
   * 落ち方を上書き**していた。本番の189件で5件（N30・M32・W09・S27・W14）が
   * これを踏み、ランナーは「検知」、外の検証器は「証拠にならない」と読んだ。
   */
  const dir = makeFixture([
    mut('Y1', { test: 'test/yamlish.test.mjs',
      expectedFailure: { testName: '診断に見える本文で落ちる検査' } }),
    mut('Y2', { test: 'test/yamlish-code.test.mjs',
      expectedFailure: { testName: '診断の code に見える本文で落ちる検査' } }),
    mut('Y3')   /* 対照: 落ちた値が短い、ふつうの assertion */
  ]).dir;
  const r = runRunner(dir);
  assert.ok(r.receipt, `証跡が残っていない:\n${r.stdout}`);
  for (const id of ['Y1', 'Y2', 'Y3']) {
    const one = of(r, id);
    const det = one.expectedFailureDetail || {};
    assert.equal(det.errName, 'AssertionError',
      `GXS_MARK.TAPKEY_NAME ${id}: 落ちた値の本文で errName が上書きされている: ${JSON.stringify(det)}`);
    assert.equal(det.code, 'ERR_ASSERTION',
      `GXS_MARK.TAPKEY_CODE ${id}: 落ちた値の本文で code が上書きされている: ${JSON.stringify(det)}`);
    assert.equal(det.failureType, 'testCodeFailure',
      `${id}: failureType が上書きされている: ${JSON.stringify(det)}`);
    assert.equal(one.actualFailureKind, 'assertion', `${id}: 落ち方を assertion と読めていない`);
    assert.equal(one.outcome, 'applied_and_killed', `${id}: 検知になっていない`);
  }
});

test('assertion を名乗るだけの失敗を検知にしない（R26-002の作業中に発見）', () => {
  /*
   * `code` と `name` の**両方**が揃って初めて assertion と認める。
   * 以前は片方だけ（OR）で認めていたので、`e.code = 'ERR_ASSERTION'` を
   * 持たせた TypeError でも「守りたい assertion が落ちた」ことになっていた。
   * 外の検証器（verify-mutation-receipt.mjs）は両方を求めるので、揃えないと
   * 同じ証跡を片方が通し片方が拒む。
   */
  const dir = makeFixture([
    mut('F1', { test: 'test/fake-assertion.test.mjs',
      expectedFailure: { testName: '名前だけ AssertionError の検査' } }),
    mut('F2', { test: 'test/fake-assertion.test.mjs',
      expectedFailure: { testName: 'code だけ ERR_ASSERTION の検査' } }),
    mut('F3')   /* 対照: 本物の assertion */
  ]).dir;
  const r = runRunner(dir);
  assert.ok(r.receipt, `証跡が残っていない:\n${r.stdout}`);
  assert.equal(outcomeOf(r, 'F1'), 'runner_error',
    `GXS_MARK.TAPAND_NAME 名前だけ AssertionError を検知にしている: ${outcomeOf(r, 'F1')}`);
  assert.equal(of(r, 'F1').actualFailureKind, 'AssertionError');
  assert.equal(outcomeOf(r, 'F2'), 'runner_error',
    `GXS_MARK.TAPAND_CODE code だけ ERR_ASSERTION を検知にしている: ${outcomeOf(r, 'F2')}`);
  assert.equal(of(r, 'F2').actualFailureKind, 'TypeError');
  /* 対照が無いと、単に全部を落としているのか区別できない */
  assert.equal(outcomeOf(r, 'F3'), 'applied_and_killed');
  assert.equal(of(r, 'F3').actualFailureKind, 'assertion');
});

test('同じ名前のテストが2つ落ちたら、どれが落ちたか決まらない（R24-001）', () => {
  /*
   * 守りたい方は通り、**無関係な同名だけ**が落ちても、名前の一致は成立してしまう。
   */
  const dir = makeFixture([
    mut('D1', { test: 'test/dup.test.mjs', expectedFailure: { testName: '同じ名前' } })
  ]).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'D1'), 'runner_error', '同名の取り違えを検知にしている');
  assert.equal(kindOf(r, 'D1'), 'duplicate_test_name',
    `GXS_MARK.SHARED_16 想定と違う分類: ${kindOf(r, 'D1')}`);
  assert.match(of(r, 'D1').error, /2 件ある/);
});

test('変異IDが重複していたら、走る前に止まる（R24-001）', () => {
  /* 証跡のどの行がどの変異か決まらないので、測る前に止める */
  const dir = makeFixture([mut('Z1'), mut('Z1', { find: 'export const other = 2;',
    replace: 'export const other = 3;', expectedFailure: { testName: OTHER } })]).dir;
  const r = runRunner(dir);
  assert.notEqual(r.exitCode, 0, 'GXS_MARK.Q04 重複したIDで走り切っている');
  /*
   * 証跡は必ず残る（第24回監査 R24-002 の続き）。残るのは「測っていない」という記録で、
   * 結果ではない——`results` が空で、なぜ止まったかが書いてあること。
   */
  assert.ok(r.receipt, '証跡が1行も残っていない');
  assert.deepEqual(r.receipt.results, [], '重複したIDのまま測っている');
  assert.match(String(r.receipt.precondition), /aborted|failed/,
    `止まった理由が証跡に書かれていない: ${JSON.stringify(r.receipt).slice(0, 200)}`);
});

test('assertion 以外を検知にするなら、理由を書かせる（R24-001）', () => {
  const base = { test: 'test/throws.test.mjs' };
  const dir = makeFixture([
    mut('W1', { ...base, expectedFailure: { testName: '例外で落ちる検査', kind: 'unhandledRejection' } }),
    mut('W2', { ...base, expectedFailure: { testName: '例外で落ちる検査', kind: 'そんな種類は無い',
      /* ⚠️ 理由は十分に長くする——短いと「理由が無い」検査が先に止めてしまい、
         種類の検査を外しても何も起きなくなる（変異 Q06 が素通りした） */
      why: 'この理由は十分に長く書いてあるので、理由の検査では止まらない' } })
  ]).dir;
  const r = runRunner(dir);
  assert.equal(kindOf(r, 'W1'), 'expectation_invalid', 'GXS_MARK.Q05 理由なしの宣言を通している');
  assert.equal(kindOf(r, 'W2'), 'expectation_invalid', 'GXS_MARK.Q06 知らない種類の宣言を通している');
});

test('どのテストが落ちるはずかを宣言していない変異は、測れない（R23-001）', () => {
  const dir = makeFixture([{ id: 'E1', file: 'mod.mjs',
    find: 'export const value = 1;', replace: 'export const value = 99;',
    test: GUARD, desc: '宣言なし' }]).dir;
  const r = runRunner(dir);
  /* ⚠️ 証跡の有無を**先に**見る。宣言の検査を外すとランナーが落ちて証跡が残らず、
     証跡を索きに行った所で TypeError になっていた（assertion が走らない・R24-001） */
  assert.ok(r.receipt, `証跡が残っていない（ランナーが落ちた）:\n${r.stdout}`);
  assert.equal(outcomeOf(r, 'E1'), 'runner_error', 'GXS_MARK.P06 宣言が無いのに検知にしている');
  assert.equal(kindOf(r, 'E1'), 'expectation_missing');
});

test('証跡に、落ちた理由と落ちたテスト名が残る（R23-001）', () => {
  const { dir } = makeFixture([mut('P1')]);
  const r = runRunner(dir);
  const one = r.receipt.results[0];
  for (const k of ['failureKind', 'failedTestNames', 'expectedFailure',
    'expectedFailureMatched', 'sanitizedDiagnostic', 'stdoutSha256', 'stderrSha256']) {
    assert.ok(k in one, `GXS_MARK.P07 ${k}: 証跡の欄が欠けている（R23-001）`);
  }
  assert.equal(one.expectedFailure.testName, WANT);
  /* 診断は伏せてから残す（絶対パスと長い列を出さない） */
  assert.ok(typeof one.sanitizedDiagnostic === 'string' && one.sanitizedDiagnostic.length > 0);
  /*
   * ⚠️ **落ちた理由の本文まで入っていること。** 見出しの行だけを集めていた版では
   * 本文が1文字も入らず、下の「パスが残っていないか」が**当たるものが無いまま**
   * 通っていた（変異 P25 が素通りして分かった）。
   */
  assert.match(one.sanitizedDiagnostic, /を見よ/,
    `GXS_MARK.P05 落ちた理由の本文が入っていない: ${one.sanitizedDiagnostic.slice(0, 200)}`);
  /*
   * ⚠️ **どのOSでも、両方の形のパスを伏せる。**
   * Windows の CI で「バックスラッシュのパスが伏せられていない」と落ちた。
   * 動いているOSに現れる形だけを見ていると、片方は永久に検査されない。
   */
  assert.ok(!one.sanitizedDiagnostic.includes('D:\\a\\repo'),
    `GXS_MARK.P25 Windows形式のパスが残っている: ${one.sanitizedDiagnostic.slice(0, 160)}`);
  /*
   * POSIX 形式のパスは**2つの検体**で見る。どちらも同じ1つの規則が伏せる。
   *   ① 題材そのものの絶対パス（`location:` の行に出る）
   *      ⚠️ 「/private/ か /Users/ か /home/ で始まるか」で見ていた版は、使い捨ての
   *      作業場が /var/folders/… なので**一度も当たらなかった**（変異 P08 が素通り）。
   *   ② 失敗の文へわざと混ぜた `/var/tmp/repo`
   *
   * ⚠️ **同じ性質を2本の assertion に分けない。** 分けていたとき、目印を持たない①が
   * 先に落ちて、P08 は `marker_not_found`（＝結果が何も言えない）に化けた。しかも
   * どちらが先に落ちるかは**作業場のパスの形**で変わる:
   *   macOS の /var/folders/xx/<30字>/T/… は 24 文字以上の塊を含むので、別の規則
   *   （`[A-Za-z0-9_-]{24,}` → `<token>`）が先に潰して①が通り、②で落ちる＝検知できた。
   *   Linux の /tmp/reposhout-mut-xxxxxx/repo は 24 文字以上の塊が無いので潰れず、
   *   ①が先に落ちる＝目印が本文に無い。**macOS では再現せず、Ubuntu の CI だけ赤**
   *   になった（2026-09-14 に TMPDIR を短いパスへ振って両方を実測）。
   * 目印は1ファイルに1個しか置けない（2個あると「どの assertion か決まらない」で
   * ランナーが止まる）ので、**1本にまとめて**この1個に持たせる。
   */
  const posixLeaks = [['作業場の絶対パス', dir], ['失敗の文に混ぜたパス', '/var/tmp/repo']]
    .filter(([, path]) => one.sanitizedDiagnostic.includes(path)).map(([label]) => label);
  assert.ok(posixLeaks.length === 0,
    `GXS_MARK.P08 POSIX形式のパスが残っている（${posixLeaks.join('・')}）: `
    + one.sanitizedDiagnostic.slice(0, 160));
  /*
   * ⚠️ ここは**最後**に置く。伏字の規則はPOSIX用とWindows用の2つあり、どちらか
   * 1つでも生きていれば `<path>` は出るので、**どの変異もここでは落ちない**
   * （＝目印を付けても外しても落ちない）。手前に置くと、目印を持つ assertion より
   * 先に落ちて結果を読めなくする側にだけ回る——それが上の①で起きたこと。
   */
  assert.match(one.sanitizedDiagnostic, /<path>/,
    '伏せた印が無い＝そもそも伏せていない');
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
    'GXS_MARK.SHARED_14 リポジトリの外を書き換えたうえで検知にしている');
  assert.equal(kindOf(r, 'O1'), 'target_rejected');
  assert.match(of(r, 'O1').error, /リポジトリの外/, `別の理由で止めている: ${of(r, 'O1').error}`);
  assert.equal(after, before, '外のファイルが書き換わっている');
});

/*
 * 題材を作れるかを、OS の名前ではなく**実際に作って**確かめる（第27回監査 便B §5）。
 * 作れなかったときは理由を出して飛ばし、守りが効いたことには数えない。
 */
function canMake(kind) {
  const d = mkdtempSync(join(tmpdir(), 'reposhout-link-'));
  try {
    writeFileSync(join(d, 'a'), 'a');
    if (kind === 'symlink') symlinkSync(join(d, 'a'), join(d, 'b'));
    else linkSync(join(d, 'a'), join(d, 'b'));
    return false;
  } catch (e) {
    return `${kind} を作れない環境（${e && e.code}）。この題材は作れないので測らない`;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

test('リポジトリの中の symlink で外へ出られない（R23-002）', { skip: canMake('symlink') }, () => {
  const { outer, dir } = makeFixture([
    mut('L1', { file: 'link.txt', find: 'SAFE', replace: 'BROKEN' })
  ]);
  symlinkSync(join(outer, 'outside.txt'), join(dir, 'link.txt'));
  const before = readFileSync(join(outer, 'outside.txt'), 'utf8');
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'L1'), 'runner_error', 'symlink 越しに外を書き換えている');
  assert.match(of(r, 'L1').error, /symlink/, `GXS_MARK.P10 symlink の検査で止めていない: ${of(r, 'L1').error}`);
  assert.equal(readFileSync(join(outer, 'outside.txt'), 'utf8'), before);
});

test('hardlink で外のファイルを書き換えられない（R27-107）', { skip: canMake('hardlink') }, () => {
  /*
   * 第27回監査 R27-107。symlink と realpath は見ていたが、hardlink は字面でも realpath でも
   * 中に見えるので受け取り、変異中に外の outside.txt が書き換わっていた（復旧後に戻るだけ）。
   */
  const { outer, dir } = makeFixture([
    mut('L2', { file: 'hl.txt', find: 'SAFE', replace: 'BROKEN' })
  ]);
  linkSync(join(outer, 'outside.txt'), join(dir, 'hl.txt'));
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'L2'), 'runner_error', 'hardlink 越しに外を書き換えている');
  assert.match(String(of(r, 'L2').error), /hardlink/, `GXS_MARK.X25 hardlink の検査で止めていない: ${of(r, 'L2').error}`);
  assert.equal(readFileSync(join(outer, 'outside.txt'), 'utf8'), 'SAFE\n', '外のファイルが変わった');
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
    expectedFailure: { testName: '変異したときだけ、対象を消してディレクトリにする',
      diagnosticMarker: 'GXS_MARK.WRECK' } })], {
    'test/wreck.test.mjs': `
import test from 'node:test';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
const p = new URL('../mod.mjs', import.meta.url);
const mutated = readFileSync(p, 'utf8').includes('99');
test('変異したときだけ、対象を消してディレクトリにする', () => {
  if (!mutated) return;
  rmSync(p, { force: true });
  mkdirSync(p);
  throw new Error('GXS_MARK.WRECK: わざと落とす');
});
`
  }).dir;
  const r = runRunner(dir);
  assert.ok(r.receipt, `復旧が例外を投げると証跡が残らない:\n${r.stdout}`);
  assert.equal(outcomeOf(r, 'X1'), 'runner_error', '戻せていないのに検知にしている');
  assert.equal(kindOf(r, 'X1'), 'restore_failed', 'GXS_MARK.P12');
  assert.equal(of(r, 'X1').restored, false, 'GXS_MARK.P13');
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
  assert.equal(of(r, 'R1').restoredSha256, of(r, 'R1').beforeSha256, 'GXS_MARK.P11 戻したと言うが、実物が変異前と違う（R23-002）');
});

/* ============================================================
 * ③ 引数と由来（第24回監査 R24-002）
 * ============================================================ */

test('上限は有限の正整数だけ——0 や文字列や範囲外を受け取らない（R24-002）', () => {
  /*
   * ⚠️ Node の `timeout: 0` は「上限なし」（実測: 打ち切られない）。
   * 前は `--timeout 0` が通ったので、**上限を外したまま**走らせられた。
   */
  const dir = makeFixture([mut('T0')]).dir;
  for (const bad of ['0', '-1', 'abc', '1.5', '3600001']) {
    const r = runRunner(dir, { timeout: bad });
    assert.notEqual(r.exitCode, 0, `GXS_MARK.T01 --timeout ${bad} を受け取っている`);
    assert.deepEqual(r.receipt && r.receipt.results, [], `--timeout ${bad} で走ってしまっている`);
  }
  /* 対照: まっとうな値なら走る */
  const ok = runRunner(dir, { timeout: 8000, receipt: 'ok.json' });
  assert.equal(ok.exitCode, 0, `対照が落ちている:\n${ok.stdout}`);
  assert.equal(ok.receipt.provenance.timeoutMs, 8000);
});

test('知らない引数は受け取らない（R24-002）', () => {
  const dir = makeFixture([mut('T1')]).dir;
  const r = runRunner(dir, { extra: ['--bogus', 'x'] });
  assert.notEqual(r.exitCode, 0, 'GXS_MARK.T02 知らない引数を黙って無視している');
  /*
   * ⚠️ ここだけ証跡が**残らない**のが正しい。引数そのものを解釈できていないので、
   * どこへ書けばよいかも決まっていない（--receipt の値を信じてよい根拠が無い）。
   * 「引数は受け取ったが途中で止まった」＝証跡を残す、と分けている。
   */
  assert.equal(r.receipt, null, '解釈できない引数なのに、書き先を決めて証跡を書いている');
  /* 対照: その引数を外せば走る */
  const ok = runRunner(dir, { receipt: 'ok.json' });
  assert.equal(ok.exitCode, 0, `対照が落ちている:\n${ok.stdout}`);
});

test('git から由来を取れないなら走らない（R24-002）', () => {
  /*
   * ⚠️ `gitOut` は git の失敗を全部 null に変える。前はそのまま走り切り、
   * 最後の条件が **null を成功側**として扱っていた——何を測ったか言えない証跡になる。
   */
  const dir = makeFixture([mut('G0')], {}, { git: false }).dir;
  const r = runRunner(dir);
  assert.notEqual(r.exitCode, 0, '由来が取れないのに走り切っている');
  assert.ok(r.receipt, '前提で止まったのに、証跡を1行も残していない');
  assert.equal(r.receipt.precondition, 'failed', 'GXS_MARK.T03');
  assert.equal(r.receipt.total, 0);
  assert.match(r.receipt.error, /由来/);
});

test('作業ツリーが実行前と同じでなければ、成功にしない（R24-002）', () => {
  /*
   * ⚠️ `workspaceUnchanged` は true / false / **null**（実行中に git が使えなくなった）
   * の3値。`!== false` だと null を成功側として扱う——**確かめられなかった**のに
   * 「変わっていない」と同じ扱いになる。
   * 実行の途中で `.git` が消える題材で、その差を作る。
   */
  const dir = makeFixture([mut('G2', { test: 'test/nukegit.test.mjs',
    expectedFailure: { testName: '変異したら .git を消してから落ちる',
      diagnosticMarker: 'GXS_MARK.NUKEGIT' } })], {
    'test/nukegit.test.mjs': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
test('変異したら .git を消してから落ちる', () => {
  if (!body.includes('99')) return;
  rmSync(new URL('../.git', import.meta.url), { recursive: true, force: true });
  assert.fail('GXS_MARK.NUKEGIT: わざと落とす');
});
`
  }).dir;
  const r = runRunner(dir);
  assert.ok(r.receipt, `証跡が残っていない:\n${r.stdout}`);
  assert.equal(r.receipt.workspaceUnchanged, null,
    `題材が効いていない（git が生きたまま）: ${r.receipt.workspaceUnchanged}`);
  assert.equal(r.receipt.applied_and_killed, 1, '変異そのものは検知されているはず');
  assert.notEqual(r.exitCode, 0,
    'GXS_MARK.T04 作業ツリーを確かめられていないのに成功で終わっている');

  /* 対照: ふつうは true で成功する */
  const ok = runRunner(makeFixture([mut('G1')]).dir);
  assert.equal(ok.receipt.workspaceUnchanged, true);
  assert.equal(ok.exitCode, 0);
});

/* ============================================================
 * ④ 第22回までの分類（引き続き効いていること）
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
    `GXS_MARK.N19 存在しないテストを、パスの検査で止めていない: ${kindOf(r, 'A5')}`);
  assert.equal(kindOf(r, 'A6'), 'baseline_failed', 'GXS_MARK.N20 元から落ちるテストを、変異の検知に数えている');
  assert.equal(kindOf(r, 'A7'), 'baseline_failed');
  assert.equal(kindOf(r, 'A10'), 'timeout',
    `GXS_MARK.SHARED_15 上限打ち切りを、上限として分類していない: ${kindOf(r, 'A10')}`);
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
      'GXS_MARK.N36 Windows で signal が観測できている＝前提が変わったので、この分岐を見直す');
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
    'GXS_MARK.N26 変異前の対照が記録されていない');
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
  assert.equal(outcomeOf(r, 'C1'), 'applied_and_killed', 'GXS_MARK.N24 複数一致の変異を検知にしていない（R22-004）');
  assert.equal(of(r, 'C1').appliedReplacementCount, 2, '期待した数だけ置換していない');
  /*
   * ⚠️ 置換した数を「一致数」から計算すると、**1個しか置き換えていなくても
   * 2と書ける**（N24 がそれで素通りした）。置き換え残しを実測で見る。
   */
  assert.equal(of(r, 'C1').remainingAfter, 0,
    `置き換え残しがある: ${of(r, 'C1').remainingAfter}`);
  assert.equal(outcomeOf(r, 'C2'), 'applied_and_killed');
  assert.equal(of(r, 'C2').remainingAfter, 4,
    `GXS_MARK.P14 置き換え残しを数えていない（2箇所を「GAMMA GAMMA」にしたら4残るはず）: ${of(r, 'C2').remainingAfter}`);
  assert.match(readFileSync(join(dir, 'mod.mjs'), 'utf8'), /GAMMA/, '元へ戻していない');
});

test('証跡には、何をどの版で測ったかが入る（R22-004）', () => {
  const dir = makeFixture([mut('D1')]).dir;
  const r = runRunner(dir);
  const p = r.receipt.provenance;
  for (const k of ['runnerSha256', 'specSha256', 'nodeVersion', 'startedAt', 'completedAt', 'timeoutMs']) {
    assert.ok(p[k] !== undefined && p[k] !== null, `GXS_MARK.N25 ${k}: 由来が証跡に残っていない（R22-004）`);
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
  /*
   * ⚠️ 置き場が**最初から**無い場合は、第26回監査 R26-003 で入れた
   * 「走っている、を置けなければ1件も測らない」が先に止める（そちらの対照は
   * mutation-evidence 側にある）。ここで見たいのは**最後の1枚を書けなかったとき**
   * なので、最初は書けて、測っている途中で置き場が消える題材を使う。
   * ⚠️ そうしないと、この検査は前段のガードに覆われて**外しても落ちない行**になる。
   */
  const { dir } = makeFixture([mut('E2', { test: 'test/nukedir.test.mjs',
    expectedFailure: { testName: '変異したら証跡の置き場を消す',
      diagnosticMarker: 'GXS_MARK.NUKEDIR' } })], {
    'test/nukedir.test.mjs': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
test('変異したら証跡の置き場を消す', () => {
  if (body.includes('99')) {
    rmSync(new URL('../../evidence', import.meta.url), { recursive: true, force: true });
  }
  assert.ok(!body.includes('99'), 'GXS_MARK.NUKEDIR 変異が当たっている');
});
`
  });
  /*
   * ⚠️ 置き場は**題材のリポジトリの外**に作る。中に作ると、消したことが
   * `git status` の差になって「作業ツリーが変わった」で exit 1 になり、
   * 証跡を書けたかどうかに関わらず非0で終わる——**この検査が何も測らなくなる**
   *（実測でそうなっていた）。
   */
  mkdirSync(join(dir, '..', 'evidence'), { recursive: true });
  const r = runRunner(dir, { receipt: join('..', 'evidence', 'receipt.json') });
  assert.notEqual(r.exitCode, 0, 'GXS_MARK.N28 証跡を書けなかったのに成功で終わっている');
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
    'GXS_MARK.N27 呼び出し元の環境変数で、検知が素通りに化けている');
  assert.equal(outcomeOf(r, 'H2'), 'applied_but_survived');
});

test('普通に終わる限り、証跡を1行は残す（R24-002 / R25-003で範囲を限定）', () => {
  /*
   * ⚠️ N19（対象の存在検査を外す変異）で実測——ランナーが途中の例外で死に、
   * **証跡が1行も残らなかった**。受け取る側は null を読んで TypeError になり、
   * 「まだ走っていない」と「途中で死んだ」を区別できないまま、
   * 守りたい assertion は一度も走らなかった。
   */
  const dir = makeFixture([mut('X1')]).dir;
  /* 途中で必ず倒れる状態を作る: spec を JSON として壊す */
  writeFileSync(join(dir, 'test/mutations.json'), '{ これはJSONではない');
  const r = runRunner(dir);
  assert.notEqual(r.exitCode, 0, '壊れた指示で成功している');
  assert.ok(r.receipt, 'GXS_MARK.T05 倒れたときに証跡が1行も残っていない');
  assert.deepEqual(r.receipt.results, [], '測っていないのに結果が書かれている');
  assert.ok(r.receipt.precondition, '止まったことが証跡に書かれていない');
});

test('証跡が無いとき、補助関数は assertion で止まる（R24-001）', () => {
  /*
   * ⚠️ 「落ちる」だけでは足りない。**どう落ちるか**まで決める。
   * 補助関数が TypeError で倒れると、このランナー自身の分類では
   * `unexpected_failure_kind`（＝結果は何も言えない）になり、
   * 守りたい assertion は一度も走っていないのに「落ちた」ように見える。
   */
  assert.throws(() => of({ receipt: null, exitCode: 2, stdout: '' }, 'X1'),
    (e) => e instanceof assert.AssertionError,
    'GXS_MARK.T06 証跡が無いのに assertion 以外で倒れている（または止まらずに通している）');
  /* 対照: 証跡があれば素通りする */
  assert.deepEqual(of({ receipt: { results: [{ id: 'X1', outcome: 'ok' }] } }, 'X1'),
    { id: 'X1', outcome: 'ok' });
});
