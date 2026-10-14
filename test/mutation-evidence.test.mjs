/*
 * 変異対照の証跡が「証拠として使える形か」の対照 ⑤〜⑧
 *   第25回監査 R25-001 / R25-002 / R25-003
 *   第26回監査 R26-001 / R26-003 / R26-004
 *
 * ⚠️ もとは mutation-runner.test.mjs にあった。1変異あたりの実行が 90 秒を超え、
 * 守りたい検査を壊す変異が 300 秒の上限に当たるようになったので分けた
 *（打ち切られると「検知できたはず」が「結果は何も言えない」に化ける）。
 * 題材の道具は helpers/mutation-fixture.mjs にある。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, rmSync, mkdtempSync,
  symlinkSync, linkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers/load.mjs';
import { GUARD, WANT, makeFixture, mut, runRunner, of, outcomeOf, kindOf }
  from './helpers/mutation-fixture.mjs';
import { testSpanText } from '../scripts/lib/test-decls.mjs';
/* 証跡の書き込みに障害を差し込む前置き（第28回監査 R28-001 / R28-004 / R28-011） */
const FAULT = pathToFileURL(join(ROOT, 'test/helpers/receipt-fault.mjs')).href;

/* ============================================================
 * ⑤ 証拠として使える形か（第25回監査 R25-002 / R25-003）
 * ============================================================ */

test('測る前から汚れている木では、証跡を作らない（R25-002）', () => {
  /*
   * ⚠️ 前は `workingTreeDirty` を記録するだけで、成功条件は「実行前後で同じか」
   * だけを見ていた。**汚れたまま戻れば成功**なので、`sourceCommit` が指すバイト列と
   * 実際に測ったバイト列が違う。第三者はそのコミットから証跡を再現できない。
   */
  const dir = makeFixture([mut('W1')]).dir;
  writeFileSync(join(dir, 'mod.mjs'),
    readFileSync(join(dir, 'mod.mjs'), 'utf8') + '\n/* 手で汚した */\n');
  const r = runRunner(dir, { allowDirty: false });
  assert.notEqual(r.exitCode, 0, 'GXS_MARK.W06 汚れた木で走り切っている');
  assert.ok(r.receipt, '止まったのに証跡が1行も残っていない');
  assert.deepEqual(r.receipt.results, [], '汚れた木で測っている');
  assert.equal(r.receipt.evidenceEligible, false, '証拠として使えないと書いていない');
  assert.match(String(r.receipt.error), /汚れ/, '止まった理由が書かれていない');

  /* 対照: 汚れを取れば走る */
  const clean = makeFixture([mut('W2')]).dir;
  const ok = runRunner(clean, { allowDirty: false });
  assert.equal(ok.exitCode, 0, `対照が落ちている:\n${ok.stdout}`);
  assert.equal(ok.receipt.evidenceEligible, true, '綺麗な木なのに証拠にならないと言っている');
});

test('--allow-dirty で走らせた証跡は、証拠にしない（R25-002）', () => {
  const dir = makeFixture([mut('W3')]).dir;
  const r = runRunner(dir, { allowDirty: true });
  assert.equal(r.exitCode, 0, `走れていない:\n${r.stdout}`);
  assert.equal(r.receipt.evidenceEligible, false,
    'GXS_MARK.W07 --allow-dirty で走らせたのに、証拠として使えることになっている');
});

test('測り始める前に「走っている」と書く（R25-003）', () => {
  /*
   * ⚠️ SIGKILL では `process.on('exit')` が動かない（Node 公式仕様・実測でも
   * 証跡は1つも残らなかった）。だから「どんな終わり方でも残す」とは言えない。
   * 代わりに**始まったことを先に書き**、正常に終わったときだけ complete へ置き換える。
   * 途中で殺されれば running のまま残り、外の検証器がそれを拒む。
   */
  const dir = makeFixture([mut('S1')]).dir;
  const r = runRunner(dir);
  assert.equal(r.receipt.state, 'complete', `終わったのに complete でない: ${r.receipt.state}`);

  /* 走っている最中の形を、ランナーを止めて実際に作る */
  const dir2 = makeFixture([mut('S2', { test: 'test/hangs.test.mjs',
    expectedFailure: { testName: '終わらない' } })]).dir;
  const child = spawn(process.execPath,
    [join(dir2, 'scripts/run-mutations.mjs'), '--spec', join(dir2, 'test/mutations.json'),
     '--timeout', '60000', '--allow-dirty', '--receipt', join(dir2, 'receipt.json')],
    { cwd: dir2, stdio: 'ignore' });
  const started = Date.now();
  while (!existsSync(join(dir2, 'receipt.json')) && Date.now() - started < 20000) {
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},120)']);
  }
  const midway = existsSync(join(dir2, 'receipt.json'))
    ? JSON.parse(readFileSync(join(dir2, 'receipt.json'), 'utf8')) : null;
  child.kill('SIGKILL');
  assert.ok(midway, '走っている最中に証跡が無い');
  assert.equal(midway.state, 'running', `GXS_MARK.W08 走っている最中の state が違う: ${midway.state}`);
  assert.deepEqual(midway.results, [], '走っている最中に結果が入っている');
});

test('SIGKILL では証跡を保証できない——だから外側の受け皿を残す（R25-003）', () => {
  /*
   * ⚠️ こちらの主張を実測で確かめる。**残らないことが正しい**（listener を
   * 登録できないので、Node にできることが無い）。CI の
   * `if-no-files-found: error` は、その穴を外から塞ぐために今も要る。
   */
  const wf = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(wf, /if-no-files-found:\s*error/,
    'ハード停止を捕まえる外側の受け皿（if-no-files-found: error）が消えている');
  const runner = readFileSync(join(ROOT, 'scripts/run-mutations.mjs'), 'utf8');
  assert.match(runner, /SIGKILL/,
    '保証できない範囲（SIGKILL）を、ランナーの注釈が言っていない');
  assert.ok(!/どんな終わり方でも、最後に必ず何か書く/.test(runner),
    '「どんな終わり方でも残す」という過大な主張が残っている');
});

test('未処理の rejection の中の assertion を、assertion と数えない（R25-001）', () => {
  /*
   * ⚠️ Node 22 の TAP は、未処理の rejection の中で assertion が落ちると
   *   failureType: unhandledRejection / code: ERR_ASSERTION / name: AssertionError
   * を**同時に**出す（実測）。error 名や code を先に見ると、テスト本体では
   * 一度も assertion を通っていないのに「assertion で落ちた」と分類できてしまう。
   */
  const dir = makeFixture([mut('U1', { test: 'test/late.test.mjs',
    expectedFailure: { testName: '遅れて落ちる', diagnosticMarker: 'GXS_MARK.LATE' } })], {
    'test/late.test.mjs': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
test('遅れて落ちる', async () => {
  if (body.includes('99')) {
    Promise.resolve().then(() => assert.equal(1, 2, 'GXS_MARK.LATE: 後から落ちる'));
  }
  await new Promise((r) => setTimeout(r, 30));
});
`
  }).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'U1'), 'runner_error',
    `GXS_MARK.W01 未処理の rejection を assertion として検知にしている: ${of(r, 'U1').actualFailureKind}`);
  assert.equal(of(r, 'U1').actualFailureKind, 'unhandledRejection');
  assert.equal(kindOf(r, 'U1'), 'unexpected_failure_kind', '未処理の rejection を assertion として数えている');
});

test('同じテストの別の assertion が落ちただけなら、検知にしない（R25-001）', () => {
  /*
   * ⚠️ 一意なテスト名の中に独立した assertion が2つあると、**守りたい方が通って
   * 無関係な方だけが落ちても**、名前と種類は一致してしまう。
   * どの assertion が落ちたかまで見る。
   */
  const dir = makeFixture([mut('U2', { test: 'test/two.test.mjs',
    expectedFailure: { testName: '2つの性質を見る', diagnosticMarker: 'GXS_MARK.TARGET' } })], {
    'test/two.test.mjs': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
test('2つの性質を見る', () => {
  assert.ok(true, 'GXS_MARK.TARGET: 守りたい性質');
  assert.ok(!body.includes('99'), 'GXS_MARK.UNRELATED: 無関係な性質');
});
`
  }).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'U2'), 'runner_error',
    '守りたい assertion は通っているのに検知にしている');
  /*
   * ⚠️ 「止まった」だけでは足りない。**目印の照合で**止めたのかまで見る。
   * 照合そのものを外すと、後段の「証跡に目印が残っているか」が別の理由で
   * 止めるので、outcome だけでは素通りする（第26回監査の作業中に実測）。
   */
  assert.equal(kindOf(r, 'U2'), 'marker_not_found', 'GXS_MARK.W02');

  /* 対照: 守りたい側が落ちる目印なら検知になる */
  const dir2 = makeFixture([mut('U3', { test: 'test/two.test.mjs',
    expectedFailure: { testName: '2つの性質を見る', diagnosticMarker: 'GXS_MARK.UNRELATED' } })], {
    'test/two.test.mjs': readFileSync(join(dir, 'test/two.test.mjs'), 'utf8')
  }).dir;
  assert.equal(outcomeOf(runRunner(dir2), 'U3'), 'applied_and_killed',
    '対照が成立していない＝この検査は何でも落とす');
});

test('目印を宣言していない変異は、測れない（R25-001）', () => {
  const dir = makeFixture([{ id: 'U4', file: 'mod.mjs',
    find: 'export const value = 1;', replace: 'export const value = 99;',
    test: GUARD, desc: 'U4', expectedFailure: { testName: WANT } }]).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'U4'), 'runner_error', 'GXS_MARK.W04 目印が無いのに測っている');
  assert.equal(kindOf(r, 'U4'), 'expectation_invalid');
  /*
   * ⚠️ 「止まった」だけでは足りない。**目印が宣言されていないから止めた**のか、
   * 別の理由で偶然止まったのかを区別する（必須の検査を外すと、
   * 次の一意性検査が undefined を相手にして別の理由で止まり、素通りする）。
   */
  assert.match(of(r, 'U4').error, /diagnosticMarker/,
    `目印の宣言が無いことで止めていない: ${of(r, 'U4').error}`);
});

test('目印がテスト内で一意でなければ、測れない（R25-001）', () => {
  /* 「どの assertion か」を決められない目印は受け取らない */
  const dir = makeFixture([mut('U5', { expectedFailure: { testName: WANT,
    diagnosticMarker: 'GXS_MARK.TWICE' } })]).dir;   // 題材の中に2回出る目印
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'U5'), 'runner_error', '一意でない目印で測っている');
  assert.equal(kindOf(r, 'U5'), 'expectation_invalid', 'GXS_MARK.SHARED_18 一意でない目印を受け取っている');
});

test('目印が比べた値に出ているだけなら、検知にしない（R27-104 の内側の題材）', () => {
  /*
   * 第27回監査 R27-104。守りたい assertion（目印つき）は通り、別の assertion が
   * **目印を比べる値として**出して落ちた。Node が自動で作る差分と actual 欄に目印が載るので、
   * 目印の照合が成り立ち、applied_and_killed になっていた（監査で実測）。
   */
  const files = {
    'test/inner.test.mjs': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { value } from '../mod.mjs';
test('比べる値に目印が出る', () => {
  const mark = 'GXS_MARK.INNER';
  assert.ok(true, mark);
  assert.equal(value === 1 ? 'ok' : mark, 'ok');
});
`
  };
  const dir = makeFixture([mut('U7', { test: 'test/inner.test.mjs',
    expectedFailure: { testName: '比べる値に目印が出る', diagnosticMarker: 'GXS_MARK.INNER' } })], files).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'U7'), 'runner_error', '比べた値に出た目印で検知にしている');
  /* ⚠️ 目印は「止まった理由」の側に置く（R28-106 の自動の差分の検査が先に止めても、この検査を外したことが分かるように） */
  assert.equal(kindOf(r, 'U7'), 'marker_in_compared_value', `GXS_MARK.X27 止まった理由が違う（比べた値の検査が効いていない）: ${kindOf(r, 'U7')}`);
});

test('目印が入れ子の比べた値（オブジェクト・配列・Map・Set）に出ているだけでも、検知にしない（R28-002・R28-106）', () => {
  /*
   * 第28回監査 R28-002。Node は入れ子の値を `actual:` の後ろを空にして次の行から出すので、
   * 第27回の読み方では比べた値に入らず、目印の照合が通っていた。オブジェクトと配列の両方を見る。
   */
  const files = {
    'test/nested.test.mjs': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { value } from '../mod.mjs';
test('入れ子の比べる値に目印が出る（オブジェクト）', () => {
  const mark = 'GXS_MARK.NESTED_OBJ';
  assert.ok(true, mark);
  assert.deepEqual({ value: value === 1 ? 'ok' : mark }, { value: 'ok' });
});
test('入れ子の比べる値に目印が出る（配列）', () => {
  const mark = 'GXS_MARK.NESTED_ARR';
  assert.ok(true, mark);
  assert.deepEqual([value === 1 ? 'ok' : mark, 1], ['ok', 1]);
});
test('目印のある assertion そのものが落ちる', () => {
  assert.equal(value, 1, 'GXS_MARK.NESTED_SELF');
});
test('Map の比べる値に目印が出る', () => {
  const mark = 'GXS_MARK.NESTED_MAP';
  assert.ok(true, mark);
  assert.deepEqual(new Map([['v', value === 1 ? 'ok' : mark]]), new Map([['v', 'ok']]));
});
test('Set の比べる値に目印が出る', () => {
  const mark = 'GXS_MARK.NESTED_SET';
  assert.ok(true, mark);
  assert.deepEqual(new Set([value === 1 ? 'ok' : mark]), new Set(['ok']));
});
test('メッセージつきの Map の比較で、目印を持つ assertion そのものが落ちる', () => {
  assert.deepEqual(new Map([['v', value]]), new Map([['v', 1]]), 'GXS_MARK.MAPMSG_OWN');
});
`
  };
  const dir = makeFixture([
    mut('U9', { test: 'test/nested.test.mjs',
      expectedFailure: { testName: '入れ子の比べる値に目印が出る（オブジェクト）', diagnosticMarker: 'GXS_MARK.NESTED_OBJ' } }),
    mut('U10', { test: 'test/nested.test.mjs',
      expectedFailure: { testName: '入れ子の比べる値に目印が出る（配列）', diagnosticMarker: 'GXS_MARK.NESTED_ARR' } }),
    mut('U11', { test: 'test/nested.test.mjs',
      expectedFailure: { testName: '目印のある assertion そのものが落ちる', diagnosticMarker: 'GXS_MARK.NESTED_SELF' } }),
    mut('U13', { test: 'test/nested.test.mjs',
      expectedFailure: { testName: 'Map の比べる値に目印が出る', diagnosticMarker: 'GXS_MARK.NESTED_MAP' } }),
    mut('U14', { test: 'test/nested.test.mjs',
      expectedFailure: { testName: 'Set の比べる値に目印が出る', diagnosticMarker: 'GXS_MARK.NESTED_SET' } }),
    mut('U15', { test: 'test/nested.test.mjs',
      expectedFailure: { testName: 'メッセージつきの Map の比較で、目印を持つ assertion そのものが落ちる', diagnosticMarker: 'GXS_MARK.MAPMSG_OWN' } })
  ], files).dir;
  const r = runRunner(dir);
  assert.equal(kindOf(r, 'U9'), 'marker_in_compared_value',
    `GXS_MARK.X48 オブジェクトの比べた値に出た目印で検知にしている: ${outcomeOf(r, 'U9')} / ${kindOf(r, 'U9')}`);
  assert.equal(kindOf(r, 'U10'), 'marker_in_compared_value',
    `配列の比べた値に出た目印で検知にしている: ${outcomeOf(r, 'U10')} / ${kindOf(r, 'U10')}`);
  /* 対照: 目印を持つ assertion 自身が落ちたなら検知する（何でも断る読み手になっていない） */
  assert.equal(outcomeOf(r, 'U11'), 'applied_and_killed', `目印のある assertion が落ちたのに検知にしない: ${kindOf(r, 'U11')}`);
  /* 第28回監査 R28-106: Map・Set の要素は actual／expected の欄に出ず、自動の差分の中にだけ出る */
  assert.equal(kindOf(r, 'U13'), 'marker_in_generated_message',
    `GXS_MARK.X69 Map の比べた値の差分に出た目印で検知にしている: ${outcomeOf(r, 'U13')} / ${kindOf(r, 'U13')}`);
  assert.equal(kindOf(r, 'U14'), 'marker_in_generated_message',
    `Set の比べた値の差分に出た目印で検知にしている: ${outcomeOf(r, 'U14')} / ${kindOf(r, 'U14')}`);
  /* 対照: メッセージに目印があれば、後ろに差分が付いていても検知する */
  assert.equal(outcomeOf(r, 'U15'), 'applied_and_killed', `メッセージつきの assertion が落ちたのに検知にしない: ${kindOf(r, 'U15')}`);
});

test('目印がテストの呼び出しの外にあれば、測る前に断る（R27-104 の外側の題材）', () => {
  /*
   * 第27回監査 R27-104。範囲を「次の宣言の手前まで」にしていたので、テストの閉じ括弧の
   * 後ろ（モジュール直下の定数）に置いた目印も「範囲の中」に見えた。
   */
  const files = {
    'test/outer.test.mjs': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { value } from '../mod.mjs';
test('外に目印を置いた', () => {
  assert.equal(value, 1);
});
const mark = 'GXS_MARK.OUTER';
`
  };
  const dir = makeFixture([mut('U8', { test: 'test/outer.test.mjs',
    expectedFailure: { testName: '外に目印を置いた', diagnosticMarker: 'GXS_MARK.OUTER' } })], files).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'U8'), 'runner_error', 'テストの外の目印で検知にしている');
  /* ⚠️ 走らせたあとの「本文に目印が無い」でも runner_error になるので、測る前に断ったかを理由で見る */
  assert.match(String(of(r, 'U8').error), /対象テストの外/, `GXS_MARK.X28 測る前に断っていない: ${of(r, 'U8').error}`);
});

test('正規表現の中の括弧で、テストの範囲が次のテストまで延びない（R28-003）', () => {
  /*
   * 第28回監査 R28-003。`return /\(/` の `/` を割り算と読み、正規表現の中の `(` を呼び出しの括弧として
   * 数えたので、`guard` の範囲がモジュール直下の目印と次のテストまで延びた（監査で実測）。
   */
  const src = [
    "test('guard', () => {",
    '  function f() { return /\\(/; }',
    '  assert.equal(value, 1, mark);',
    '});',
    "const mark = 'GXS_MARK.OUTSIDE';",
    '',
    "test('other', () => {",
    '  function g() { return /\\)/; }',
    '  assert.ok(true);',
    '});',
    ''
  ].join('\n');
  const want = src.slice(0, src.indexOf('});') + 2);   /* 呼び出しの閉じ括弧まで（`;` は含まない） */
  assert.equal(testSpanText(src, 'guard'), want,
    'GXS_MARK.X49 return の後の正規表現を割り算と読み、範囲がずれた');
  /*
   * 読み手が見分けられない形（`)` の後の正規表現）では、範囲が次の宣言を越える。
   * そのときは推測した範囲を使わず、決められない（null）で止める。
   */
  const misread = [
    "test('a', () => {",
    '  if (s) /\\(/.test(s);',
    '});',
    "test('b', () => {",
    '  if (s) /\\)/.test(s);',
    '});',
    ''
  ].join('\n');
  assert.equal(testSpanText(misread, 'a'), null,
    'GXS_MARK.X50 範囲が次のテストの宣言を越えたのに、その範囲を使った');
  /* 対照: ふつうの割り算は正規表現と読まない（範囲が途中で切れたり延びたりしない） */
  const div = "test('d', () => { const x = a.return / 2; const y = (b) / 3; assert.ok(x / y); });\nconst z = 1;";
  assert.equal(testSpanText(div, 'd'), div.split('\n')[0].replace(/;$/, ''), '割り算を正規表現と読んだ');
});

test('後ろにテストの宣言が無くても、範囲を外の文まで延ばさない（R28-107）', () => {
  /*
   * 第28回監査 R28-107。「次の宣言を越えたら止める」は、後ろに宣言が無い最後のテストでは働かず、
   * 読み違えた範囲がモジュール直下の目印と後ろの文まで延びた（監査で実測）。
   */
  const src = [
    "test('guard', () => {",
    "  if (false) /\\(/.test('');",
    '  assert.equal(value, 1, mark);',
    '});',
    "const mark = 'GXS_MARK.OUTSIDE';",
    "if (false) /\\)/.test('');",
    ''
  ].join('\n');
  const span = testSpanText(src, 'guard');
  assert.ok(span === null || (!span.includes('OUTSIDE') && span.endsWith('})')),
    `GXS_MARK.X70 最後のテストの範囲を外の文まで延ばした: ${JSON.stringify(span)}`);
  /* 対照: import.meta や入れ子の t.test を含む正しい試験は、範囲を取れる（何でも断る読み手でない） */
  const ok = "test('a', async (t) => { const u = new URL('x', import.meta.url); await t.test('b', () => {}); });\nconst z = 1;";
  assert.equal(testSpanText(ok, 'a'), ok.split('\n')[0].replace(/;$/, ''), '正しい試験の範囲を取れない');
});

test('正規表現の中の括弧があっても、テストの外の目印を中と見なさない（R28-003・ランナーを通す）', () => {
  const files = {
    'test/regex.test.mjs': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { value } from '../mod.mjs';
test('正規表現を含む検査', () => {
  function f() { return /\\(/; }
  assert.equal(value, 1, mark);
});
const mark = 'GXS_MARK.REGEXOUT';
test('正規表現を含む別の検査', () => {
  function g() { return /\\)/; }
  assert.ok(true);
});
`
  };
  const dir = makeFixture([mut('U12', { test: 'test/regex.test.mjs',
    expectedFailure: { testName: '正規表現を含む検査', diagnosticMarker: 'GXS_MARK.REGEXOUT' } })], files).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'U12'), 'runner_error', `テストの外の目印で検知にしている: ${kindOf(r, 'U12')}`);
  assert.match(String(of(r, 'U12').error), /対象テストの外/, `測る前に断っていない: ${of(r, 'U12').error}`);
});

test('目印は、そのテストの本文の中だけで探す（R25-001）', () => {
  /*
   * ⚠️ 出力全体から探すと、**別のテストが出した同じ文字列**で満たされてしまう。
   * 宣言したテストは落ちているので、名前も種類も一致する——それでも
   * 守りたい assertion は走っていない。
   */
  const files = {
    'test/three.test.mjs': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
test('2つの性質を見る', () => {
  assert.ok(true, 'GXS_MARK.KEEP: 守りたい性質');
  assert.ok(!body.includes('99'), 'GXS_MARK.UNRELATED2: 無関係な性質');
});
test('別のテストも落ちる', () => {
  assert.ok(!body.includes('99'), 'GXS_MARK.ELSEWHERE: 別のテストが出す');
});
`
  };
  const dir = makeFixture([mut('U6', { test: 'test/three.test.mjs',
    expectedFailure: { testName: '2つの性質を見る', diagnosticMarker: 'GXS_MARK.ELSEWHERE' } })],
    files).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'U6'), 'runner_error',
    'GXS_MARK.W03 別のテストが出した目印で検知にしている');
  /*
   * ⚠️ 第26回監査 R26-001 で、この判定は**走らせる前**に移った。
   * 「対象テストの範囲の中にあるか」を静的に見るので、走らせてから
   * `marker_not_found` になるのではなく、宣言の時点で止まる。
   * 止まった理由まで確かめる（別の理由で偶然止まっても通ってしまうため）。
   */
  assert.equal(kindOf(r, 'U6'), 'expectation_invalid', 'GXS_MARK.Y04');
  assert.match(of(r, 'U6').error, /対象テストの外/,
    `別のテストの目印だと気づいて止めていない: ${of(r, 'U6').error}`);

  /* ★対照: そのテスト自身の目印なら検知になる */
  const dir2 = makeFixture([mut('U7', { test: 'test/three.test.mjs',
    expectedFailure: { testName: '2つの性質を見る', diagnosticMarker: 'GXS_MARK.UNRELATED2' } })],
    files).dir;
  assert.equal(outcomeOf(runRunner(dir2), 'U7'), 'applied_and_killed',
    '対照が成立していない＝この検査は何でも落とす');

  /*
   * ⚠️ **静的な検査だけでは足りない。**（第26回監査の作業中に実測）
   * 目印がソースに1回しか書かれていなくても、**別のテストが実行時に
   * 同じ文字列を組み立てて出す**ことはできる。そのときに出力全体から探すと、
   * 守りたい assertion は通っているのに検知になる。
   * ここは `not ok` の本文の中だけを見ているかを、実行時の側から確かめる。
   */
  const spill = {
    'test/spill.test.mjs': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
test('守りたい性質と、無関係な性質', () => {
  assert.ok(true, 'GXS_MARK.SPILL 守りたい性質');
  assert.ok(!body.includes('99'), '無関係な性質');
});
test('別のテストが、目印を組み立てて出す', () => {
  /* ソースには目印の literal を書かない——組み立てて出す */
  const built = ['GXS', 'MARK'].join('_') + '.' + 'SPILL';
  assert.ok(!body.includes('99'), built + ' 別のテストが出した');
});
`
  };
  const dir3 = makeFixture([mut('U8', { test: 'test/spill.test.mjs',
    expectedFailure: { testName: '守りたい性質と、無関係な性質',
      diagnosticMarker: 'GXS_MARK.SPILL' } })], spill).dir;
  const r3 = runRunner(dir3);
  assert.equal(outcomeOf(r3, 'U8'), 'runner_error',
    '別のテストが実行時に出した目印で検知にしている');
  /*
   * ⚠️ 止まった理由まで見る。出力全体から探す形へ戻すと、目印は「見つかる」ので
   * ここを通り、**次の段（証跡に残る本文に目印があるか）が別の理由で**止める。
   * outcome だけ見ていると素通りする（実測）。
   */
  assert.equal(kindOf(r3, 'U8'), 'marker_not_found',
    `GXS_MARK.SPILL_GUARD 止まった理由が違う: ${of(r3, 'U8').failureKind} / ${of(r3, 'U8').error}`);
});

test('証跡は一時ファイル経由で置き換える（R25-003）', () => {
  /*
   * ⚠️ 直接上書きすると、書いている途中の JSON を読み手が拾いうる。
   * 一時ファイルへ書いて rename する（同じファイルシステム上では不可分）。
   * 走り終えたあとに一時ファイルが残っていないことも見る。
   */
  const runner = readFileSync(join(ROOT, 'scripts/run-mutations.mjs'), 'utf8');
  assert.match(runner, /renameSync\(tmp, receiptPath\)/,
    'GXS_MARK.W14 証跡を直接上書きしている（途中の状態が読まれうる）');
  const dir = makeFixture([mut('A9')]).dir;
  const r = runRunner(dir);
  assert.equal(r.exitCode, 0, `走れていない:\n${r.stdout}`);
  const left = readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(left, [], `一時ファイルが残っている: ${left.join(' ')}`);
});

/* ============================================================
 * ⑥ 目印が「どの assertion か」を本当に決めているか（第26回監査 R26-001）
 * ============================================================ */

test('Node が自動で出す文言は、目印にできない（R26-001）', () => {
  /*
   * ⚠️ 第25回の目印は「対象ファイルの中で一意な部分文字列」だった。実測すると
   * P18／P19 の `xpected ` は、**対象テストに1文字も無く**、無関係な別テストの
   * `throw new Error('unexpected internal error')` で一意性を満たし、
   * Node が出す `Expected values to be strictly equal:` に偶然一致していた。
   * 予約形だけを受け取れば、この偶然一致は形の上で起こりえない。
   */
  const dir = makeFixture([mut('Y1', { expectedFailure: { testName: WANT,
    diagnosticMarker: 'xpected ' } })]).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'Y1'), 'runner_error',
    'GXS_MARK.FMT_OUTCOME 一般的な文言を目印として受け取っている');
  assert.equal(kindOf(r, 'Y1'), 'expectation_invalid');
  /*
   * ⚠️ 「止まった」だけでは足りない。**形が理由で**止めたのかまで見る
   *（形の検査を外しても、後ろの一意性検査が別の理由で止めるので、素通りする）。
   */
  assert.match(of(r, 'Y1').error, /予約形/,
    `GXS_MARK.SHARED_19 形が理由で止めていない: ${of(r, 'Y1').error}`);

  /* ★対照: 予約形なら受け取る（この検査が何でも拒むわけではない） */
  const dir2 = makeFixture([mut('Y2')]).dir;
  assert.equal(outcomeOf(runRunner(dir2), 'Y2'), 'applied_and_killed',
    '対照が成立していない＝この検査は何でも拒む');
});

test('伏字で消える目印は、証拠にならないので検知にしない（R26-001）', () => {
  /*
   * ⚠️ 生の本文で照合できても、証跡へ残すときの伏字（長い英数の連なりや
   * パスを潰す）と 600 字の打ち切りで、目印が消えることがある。実測で 10 件あった。
   * 消えていると**外の検証器が再照合できない**——証跡としては
   * 「どの assertion が落ちたか」を言えていない。
   */
  const filler = 'あ'.repeat(900);
  const dir = makeFixture([mut('Y3', { test: 'test/tail.test.mjs',
    expectedFailure: { testName: '長い文の最後に目印を置く',
      diagnosticMarker: 'GXS_MARK.TAILONLY' } })], {
    'test/tail.test.mjs': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
test('長い文の最後に目印を置く', () => {
  assert.ok(!body.includes('99'), '${filler} GXS_MARK.TAILONLY');
});
`
  }).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'Y3'), 'runner_error',
    'GXS_MARK.SHARED_20 証跡に残らない目印で検知にしている');
  assert.equal(kindOf(r, 'Y3'), 'marker_not_in_receipt');
  assert.ok(!String(of(r, 'Y3').matchedBody || '').includes('GXS_MARK.TAILONLY'),
    '前提が崩れている（証跡に目印が残っている）＝この題材は何も測っていない');
});

test('伏字で消える形の目印は、走らせる前に断る（R26-001）', () => {
  /*
   * ⚠️ 伏字は `[A-Za-z0-9_-]{24,}` を `<token>` に潰す。長い1語の目印は、
   * 走らせれば結局 `marker_not_in_receipt` で止まるが、**それでは対象テストを
   * 1回無駄に走らせる**うえ、診断が「証跡に残らない」になって、
   * 直すべき場所（宣言そのもの）を指さない。宣言の時点で断る。
   *
   * ここで見分けるのは `failureKind`——走らせる前に断ったか（expectation_invalid）、
   * 走らせてから気づいたか（marker_not_in_receipt）の差。
   */
  const long = `GXS_MARK.${'A'.repeat(26)}`;
  const dir = makeFixture([mut('Y8', { test: 'test/longmark.test.mjs',
    expectedFailure: { testName: '長い1語の目印', diagnosticMarker: long } })], {
    'test/longmark.test.mjs': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
test('長い1語の目印', () => {
  assert.ok(!body.includes('99'), '${long} 守りたい性質');
});
`
  }).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'Y8'), 'runner_error',
    '伏字で消える目印を受け取っている');
  assert.equal(kindOf(r, 'Y8'), 'expectation_invalid',
    'GXS_MARK.MASK_BEFORE_RUN 走らせる前に断っていない（走らせてから気づいている）');
  assert.match(of(r, 'Y8').error, /伏字/,
    `伏字が理由で止めていない: ${of(r, 'Y8').error}`);
});

test('題材として書いたテスト宣言を、本物と数えない（R26-001）', () => {
  /*
   * ⚠️ このファイル自身がそうであるように、テストの中には**テストのソースを
   * テンプレート文字列で書いた題材**がある。素の正規表現で宣言を数えると
   * 題材の中の宣言まで本物として数え、対象テストの範囲が題材の位置で切れる
   * （実測: このファイルで 50 対 35）。目印が「テストの外」に見えてしまう。
   */
  const dir = makeFixture([mut('Y4', { test: 'test/embeds.test.mjs',
    expectedFailure: { testName: '本物のテスト', diagnosticMarker: 'GXS_MARK.REALONE' } })], {
    'test/embeds.test.mjs': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
/* ↓ 題材として持っているだけのソース（本物の宣言ではない） */
const FIXTURE_SOURCE = \`
test('本物のテスト', () => { assert.ok(true); });
\`;
test('本物のテスト', () => {
  assert.ok(FIXTURE_SOURCE.length > 0);
  assert.ok(!body.includes('99'), 'GXS_MARK.REALONE 守りたい性質');
});
`
  }).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'Y4'), 'applied_and_killed',
    `GXS_MARK.DECL_REAL 題材の中の宣言を本物と数えている: ${JSON.stringify(of(r, 'Y4').error || '')}`);
});

/* ============================================================
 * ⑦ 証跡の一生（第26回監査 R26-003）
 * ============================================================ */

test('「走っている」を置けなければ、1件も測らない（R26-003）', () => {
  /*
   * ⚠️ 前は書き込みの成否を見ずに測り始めていた。証跡を置けない場所を指したまま
   * 全部走り、最後に「書けなかった」とだけ言う——**測る前に残す**という設計が
   * 成り立っていない。書けないと分かった時点で、対象へ手を付けずに止まる。
   */
  const dir = makeFixture([mut('Z1')]).dir;
  const before = readFileSync(join(dir, 'mod.mjs'), 'utf8');
  const r = runRunner(dir, { receipt: 'no-such-dir/receipt.json' });
  assert.equal(r.exitCode, 2, `書けない置き場なのに走っている:\n${r.stdout}`);
  assert.equal(readFileSync(join(dir, 'mod.mjs'), 'utf8'), before,
    'GXS_MARK.SAVERUN_RESTORED 証跡を置けないのに、変異を当てている');
  /*
   * ⚠️ 第27回（R27-105）でループの中にも同じ書き込みの検査を入れたので、ここを外しても
   * 「1件も当てない」は変わらない。違うのは**集計まで進まずに止まる**こと（測る前の失敗）。
   * 重複した守りは残し、この試験はその違い（診断）を見る。
   */
  assert.ok(!/^変異 \d+ 件/m.test(r.stdout),
    `GXS_MARK.SAVERUN_FIRST 測る前に止まらず、集計まで進んでいる:\n${r.stdout}`);
  assert.ok(!existsSync(join(dir, 'no-such-dir')),
    '置けない場所にディレクトリを作っている');
});

test('普通の例外では、state=aborted を一時ファイル経由で残す（R26-003）', () => {
  /*
   * ⚠️ 第25回の exit 側は `saveReceipt` を通さず直接上書きしていて、
   * `state` も持っていなかった（`precondition` だけ）。running / complete /
   * aborted という説明と、実際の証跡の形が食い違っていた。
   */
  const dir = makeFixture([mut('Z2')]).dir;
  writeFileSync(join(dir, 'test/mutations.json'), '{ これはJSONではない');
  const r = runRunner(dir);
  assert.notEqual(r.exitCode, 0, '壊れた指示で成功している');
  assert.equal(r.receipt.state, 'aborted',
    `GXS_MARK.ABORTED_STATE 倒れたのに state=aborted になっていない: ${r.receipt && r.receipt.state}`);
  assert.ok(r.receipt.errorKind, '何で倒れたのかが証跡に無い');
  const left = readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(left, [], `一時ファイルが残っている: ${left.join(' ')}`);
});

test('どこまで進んだかを、走っている最中の証跡が名指しする（R26-003）', () => {
  /*
   * ⚠️ 強制終了されたとき、**どのファイルが変異したまま残っているか**を
   * 証跡から言えるようにする。第25回は running を1回書くだけで、
   * `currentMutationId` は null のまま更新していなかった。
   */
  const dir = makeFixture([mut('Z3', { test: 'test/hangs.test.mjs',
    expectedFailure: { testName: '終わらない' } })]).dir;
  const child = spawn(process.execPath,
    [join(dir, 'scripts/run-mutations.mjs'), '--spec', join(dir, 'test/mutations.json'),
     '--timeout', '60000', '--allow-dirty', '--receipt', join(dir, 'receipt.json')],
    { cwd: dir, stdio: 'ignore' });
  const started = Date.now();
  let midway = null;
  while (Date.now() - started < 20000) {
    if (existsSync(join(dir, 'receipt.json'))) {
      midway = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
      if (midway.currentMutationId) break;
    }
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},120)']);
  }
  child.kill('SIGKILL');
  assert.ok(midway, '走っている最中に証跡が無い');
  assert.equal(midway.currentMutationId, 'Z3',
    `GXS_MARK.PROGRESS_CURRENT いま測っている変異が証跡に無い: ${JSON.stringify(midway.currentMutationId)}`);
  assert.equal(midway.lastCompletedMutationId, null,
    `1件も終えていないのに終えたことになっている: ${midway.lastCompletedMutationId}`);
  assert.notEqual(midway.state, 'complete', '走っている最中に complete と書いている');
});

test('終わった証跡は、最後に終えた変異まで書いてある（R26-003）', () => {
  const dir = makeFixture([mut('Z4'), mut('Z5')]).dir;
  const r = runRunner(dir);
  assert.equal(r.receipt.state, 'complete', `完了していない:\n${r.stdout}`);
  assert.equal(r.receipt.currentMutationId, null,
    'GXS_MARK.PROGRESS_DONE 終わったのに「いま測っている」が残っている');
  assert.equal(r.receipt.lastCompletedMutationId, 'Z5',
    `最後に終えた変異が違う: ${r.receipt.lastCompletedMutationId}`);
});

test('途中で証跡を書けなくなったら、次の変異を当てずに止まり、成功の証跡に化けない（R27-105）', () => {
  /*
   * 第27回監査 R27-105。2件目からは進み具合の書き込みの成否を見ていなかったので、
   * 置き場が一時的に書けなくなっても次の変異を当て、置き場が戻ると complete・証拠に使える、で終わった。
   * ⚠️ 第28回監査 R28-011: 前は読み取り専用のディレクトリで置き場を塞いでいたので、それを作れない環境
   *（Windows・管理者権限）では何も測らずに通っていた（ログに SKIP と書くだけで pass に数えた）。
   * 書き込みに障害を差し込む前置きで、変異の途中の書き込みだけを失敗させる（どの環境でも測る）。
   */
  const fx = makeFixture([
    mut('Q7'),
    mut('Q8', { find: 'export const other = 2;', replace: 'export const other = 98;',
      expectedFailure: { testName: '別の検査: other は 2' } })
  ]);
  const log = join(fx.outer, 'fault-between.log');
  const r = runRunner(fx.dir, { receipt: 'out-receipt.json', allowDirty: false, nodeArgs: ['--import', FAULT],
    env: { RS_FAULT: 'fail:between', RS_FAULT_LOG: log } });
  assert.match(existsSync(log) ? readFileSync(log, 'utf8') : '', /failed between/,
    `題材が成立していない（変異の途中の書き込みを失敗させられていない）:\n${r.stdout.slice(-300)}`);
  const mod = readFileSync(join(fx.dir, 'mod.mjs'), 'utf8');
  assert.ok(mod.includes('export const value = 1;') && mod.includes('export const other = 2;'), '変異が戻っていない');
  assert.notEqual(r.exitCode, 0, `GXS_MARK.X23 途中で書けなかったのに exit 0:\n${r.stdout.slice(-300)}`);
  assert.ok(!(r.receipt && r.receipt.state === 'complete' && r.receipt.evidenceEligible === true),
    '途中で書けなかったのに、証拠に使える complete の証跡に化けた');
  assert.deepEqual((r.receipt && r.receipt.results || []).map((x) => x.id), [],
    '進み具合を書けなかったのに、変異を当てた');
});

test('証跡の保存の失敗は、置き場が戻っても成功の証跡に化けない（初回・終端・最後）（R28-004）', () => {
  /*
   * 第28回監査 R28-004。変異の途中の書き込み（上の R27-105）は直したが、終わりの「走っている」の
   * 書き込みは戻り値を見ていなかった。失敗しても最後の1枚が書ければ complete・証拠に使える、になった。
   * 書き込みの種類ごとに1回ずつ失敗させ、ほかの書き込みは通す（＝置き場が戻った状態）。
   */
  const runWith = (kind) => {
    const fx = makeFixture([mut('Q14')]);
    const log = join(fx.outer, `fault-${kind}.log`);
    const r = runRunner(fx.dir, { receipt: 'out-receipt.json', allowDirty: false, nodeArgs: ['--import', FAULT],
      env: { RS_FAULT: `fail:${kind}`, RS_FAULT_LOG: log } });
    assert.match(existsSync(log) ? readFileSync(log, 'utf8') : '', new RegExp(`failed ${kind}`),
      `題材が成立していない（${kind} の書き込みを失敗させられていない）:\n${r.stdout.slice(-300)}`);
    return { ...r, eligible: Boolean(r.receipt && r.receipt.state === 'complete' && r.receipt.evidenceEligible === true) };
  };
  const initial = runWith('initial');
  assert.ok(initial.exitCode !== 0 && !initial.eligible, '初回の書き込みに失敗したのに成功の証跡になった');
  const terminal = runWith('terminal');
  assert.ok(!terminal.eligible,
    `GXS_MARK.X54 終わりの進み具合を書けなかったのに、証拠に使える complete の証跡に化けた（state=${terminal.receipt && terminal.receipt.state}）`);
  assert.notEqual(terminal.exitCode, 0, '終わりの進み具合を書けなかったのに exit 0');
  const final = runWith('final');
  assert.notEqual(final.exitCode, 0, `GXS_MARK.X55 最後の1枚を書けなかったのに exit 0:\n${final.stdout.slice(-300)}`);
  assert.ok(!final.eligible, '最後の1枚を書けなかったのに、成功の証跡が残った');
  /* 対照: 何も失敗させなければ、証拠に使える complete になる（この題材は何でも落とすわけではない） */
  const fx = makeFixture([mut('Q15')]);
  const ok = runRunner(fx.dir, { receipt: 'out-receipt.json', allowDirty: false, nodeArgs: ['--import', FAULT],
    env: { RS_FAULT: '' } });
  assert.ok(ok.exitCode === 0 && ok.receipt && ok.receipt.state === 'complete' && ok.receipt.evidenceEligible === true,
    `対照が成立していない（前置きだけで成功しなくなる）:\n${ok.stdout.slice(-300)}`);
});

test('戻せなかったら次の変異へ進まず、その変異を「終えた」と書かない（R27-105）', () => {
  const fx = makeFixture([
    mut('Q9', { test: 'test/wreck2.test.mjs',
      expectedFailure: { testName: '変異したときだけ、対象を消してディレクトリにする（2）',
        diagnosticMarker: 'GXS_MARK.WRECK2' } }),
    mut('Q10', { find: 'export const other = 2;', replace: 'export const other = 97;',
      test: GUARD, expectedFailure: { testName: '別の検査: other は 2' } })
  ], {
    'test/wreck2.test.mjs': `
import test from 'node:test';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
const p = new URL('../mod.mjs', import.meta.url);
const mutated = readFileSync(p, 'utf8').includes('99');
test('変異したときだけ、対象を消してディレクトリにする（2）', () => {
  if (!mutated) return;
  rmSync(p, { force: true });
  mkdirSync(p);
  throw new Error('GXS_MARK.WRECK2: わざと落とす');
});
`
  });
  const r = runRunner(fx.dir);
  assert.ok(r.receipt, `証跡が無い:\n${r.stdout}`);
  const ids = r.receipt.results.map((x) => x.id);
  assert.deepEqual(ids, ['Q9'], `GXS_MARK.X24 戻せなかったのに次の変異へ進んだ: ${ids.join(' ')}`);
  assert.notEqual(r.receipt.lastCompletedMutationId, 'Q9', '戻せなかった変異を「終えた」と書いている');
  assert.equal(r.receipt.currentMutationId, 'Q9', '戻せなかった変異を証跡が名指ししていない');
  assert.equal(r.receipt.evidenceEligible, false, '止まった証跡を証拠に使えると書いている');
  assert.notEqual(r.exitCode, 0);
});

test('証跡の出力先が入力を指していたら、1バイトも書かずに止まる（R27-106）', () => {
  /*
   * 第27回監査 R27-106。`--receipt notes.md`（追跡中の文書）を指すと、その文書を証跡の JSON で
   * 上書きしたうえで exit 0・証拠に使える、と報告していた（比較の基準を書いた後に取っていた）。
   */
  const fx = makeFixture([mut('Q11')], { 'notes.md': '# 大事なメモ\n' });
  const notes = readFileSync(join(fx.dir, 'notes.md'), 'utf8');
  const spec = readFileSync(join(fx.dir, 'test/mutations.json'), 'utf8');
  /* runRunner は出力先を証跡として読むので使わない（出力先は文書そのもの） */
  const run = (receipt) => {
    try {
      execFileSync(process.execPath, [join(fx.dir, 'scripts/run-mutations.mjs'),
        '--spec', join(fx.dir, 'test/mutations.json'), '--allow-dirty', '--receipt', join(fx.dir, receipt)],
      { cwd: fx.dir, encoding: 'utf8', stdio: 'pipe', timeout: 120000 });
      return 0;
    } catch (e) { return typeof e.status === 'number' ? e.status : -1; }
  };
  for (const receipt of ['notes.md', 'sub/../notes.md', 'test/mutations.json', 'mod.mjs']) {
    const code = run(receipt);
    assert.equal(code, 2, `GXS_MARK.X26 出力先が入力（${receipt}）なのに走った（exit ${code}）`);
  }
  assert.equal(readFileSync(join(fx.dir, 'notes.md'), 'utf8'), notes, '追跡中の文書を上書きした');
  assert.equal(readFileSync(join(fx.dir, 'test/mutations.json'), 'utf8'), spec, '正本を上書きした');
  assert.ok(readFileSync(join(fx.dir, 'mod.mjs'), 'utf8').startsWith('export const value = 1;'), '変異の対象を上書きした');
  /* 対照: ふつうの出力先なら走る */
  const ok = runRunner(fx.dir, { receipt: 'out-receipt.json' });
  assert.equal(ok.exitCode, 0, `対照が成立していない:\n${ok.stdout.slice(-300)}`);
  assert.equal(ok.receipt.workspaceUnchanged, true, '証跡そのものを「作業ツリーの変化」に数えている');
});

test('証跡の出力先が git の管理先なら、1バイトも書かずに止まる（R28-001）', () => {
  /*
   * 第28回監査 R28-001。追跡中のファイルは拒んでいたが、`.git` の中は事前検査を通り、
   * `--receipt .git/config` で git の設定を証跡の JSON に書き換えた。
   */
  const fx = makeFixture([mut('Q12')]);
  const run = (receipt) => {
    try {
      execFileSync(process.execPath, [join(fx.dir, 'scripts/run-mutations.mjs'),
        '--spec', join(fx.dir, 'test/mutations.json'), '--allow-dirty', '--receipt', join(fx.dir, receipt)],
      { cwd: fx.dir, encoding: 'utf8', stdio: 'pipe', timeout: 120000 });
      return 0;
    } catch (e) { return typeof e.status === 'number' ? e.status : -1; }
  };
  for (const receipt of ['.git/config', '.git/description', 'sub/../.git/info/exclude']) {
    const abs = join(fx.dir, receipt);
    const before = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    const code = run(receipt);
    assert.equal(code, 2, `GXS_MARK.X51 出力先が git の管理先（${receipt}）なのに走った（exit ${code}）`);
    assert.equal(existsSync(abs) ? readFileSync(abs, 'utf8') : null, before, `${receipt} を書き換えた`);
  }
  /* 対照: ふつうの出力先なら走る */
  const ok = runRunner(fx.dir, { receipt: 'out-receipt.json' });
  assert.equal(ok.exitCode, 0, `対照が成立していない:\n${ok.stdout.slice(-300)}`);
});

test('証跡の出力先の内外を、名前の頭の .. で取り違えない（R28-105）', () => {
  /*
   * 第28回監査 R28-105。内外を `startsWith('..')` で見ていたので、同じディレクトリの `..notes.md`
   *（追跡中の文書）や git の管理先の中の `..audit-state` を「外」と読み、保護を抜けて書き換えた。
   */
  const fx = makeFixture([mut('Q16')], { '..notes.md': '# 頭に .. の付いた大事なメモ\n' });
  writeFileSync(join(fx.dir, '.git', '..audit-state'), 'GIT-ADMIN-STATE\n');
  const run = (receipt) => {
    try {
      execFileSync(process.execPath, [join(fx.dir, 'scripts/run-mutations.mjs'),
        '--spec', join(fx.dir, 'test/mutations.json'), '--allow-dirty', '--receipt', join(fx.dir, receipt)],
      { cwd: fx.dir, encoding: 'utf8', stdio: 'pipe', timeout: 120000 });
      return 0;
    } catch (e) { return typeof e.status === 'number' ? e.status : -1; }
  };
  const notes = readFileSync(join(fx.dir, '..notes.md'), 'utf8');
  assert.equal(run('..notes.md'), 2, 'GXS_MARK.X68 追跡中の ..notes.md を出力先にできた');
  assert.equal(readFileSync(join(fx.dir, '..notes.md'), 'utf8'), notes, '..notes.md を書き換えた');
  assert.equal(run('.git/..audit-state'), 2, 'git の管理先の中の ..audit-state を出力先にできた');
  assert.equal(readFileSync(join(fx.dir, '.git', '..audit-state'), 'utf8'), 'GIT-ADMIN-STATE\n', '管理先の中を書き換えた');
  /* 対照: 本当に外（親）を指す出力先は、外として扱われ書ける（この判定が何でも拒むわけではない） */
  const ok = runRunner(fx.dir, { receipt: join('..', 'outside-receipt.json') });
  assert.equal(ok.exitCode, 0, `外の出力先で走れない:\n${ok.stdout.slice(-300)}`);
});

const canLink = (kind) => {
  const d = mkdtempSync(join(tmpdir(), 'reposhout-link-'));
  try {
    writeFileSync(join(d, 'a'), 'a');
    if (kind === 'symlink') symlinkSync(join(d, 'a'), join(d, 'b')); else linkSync(join(d, 'a'), join(d, 'b'));
    return false;
  } catch (e) {
    return `${kind} を作れない環境（${e && e.code}）。この題材は作れないので測らない`;
  } finally { rmSync(d, { recursive: true, force: true }); }
};
/*
 * 第28回監査 R28-001。一時ファイル（<証跡>.tmp-<pid>）へ普通に書いていたので、その名前に
 * リンクを置かれると、リンク先（追跡中の文書）を書き換えた。書き込みの直前にリンクを置く
 * 前置き（test/helpers/receipt-fault.mjs）で、外から置かれた状況を作る。
 * ⚠️ 試験名はテンプレートで組み立てない（変異のランナーが宣言を見つけられなくなる）。
 */
function plantedLinkCase(kind, marker) {
  const fx = makeFixture([mut('Q13')], { 'notes.md': '# 大事なメモ\n' });
  const notes = join(fx.dir, 'notes.md');
  const before = readFileSync(notes, 'utf8');
  const log = join(fx.outer, 'fault.log');
  const r = runRunner(fx.dir, { receipt: 'out-receipt.json', nodeArgs: ['--import', FAULT],
    env: { RS_FAULT: `plant-${kind}:${notes}`, RS_FAULT_LOG: log } });
  /* 細工が本当に起きたか（起きていないのに通った、を合格にしない） */
  assert.match(existsSync(log) ? readFileSync(log, 'utf8') : '', new RegExp(`planted ${kind}`),
    `題材が成立していない（リンクを置けていない）:\n${r.stdout.slice(-300)}`);
  return { changed: readFileSync(notes, 'utf8') !== before, exitCode: r.exitCode, marker };
}
test('証跡の一時ファイルの名前に置かれた symlink を辿らない（R28-001）', { skip: canLink('symlink') }, () => {
  const c = plantedLinkCase('symlink');
  assert.equal(c.changed, false, 'GXS_MARK.X52 一時ファイルの名前の symlink を辿って、追跡中の文書を書き換えた');
  assert.notEqual(c.exitCode, 0, '一時ファイルを作れなかったのに成功で終わった');
});
test('証跡の一時ファイルの名前に置かれた hardlink を辿らない（R28-001）', { skip: canLink('hardlink') }, () => {
  const c = plantedLinkCase('hardlink');
  assert.equal(c.changed, false, 'GXS_MARK.X53 一時ファイルの名前の hardlink を通して、追跡中の文書を書き換えた');
  assert.notEqual(c.exitCode, 0, '一時ファイルを作れなかったのに成功で終わった');
});

/* ============================================================
 * ⑧ 引数（第26回監査 R26-004）
 * ============================================================ */

test('別の引数の名前を、値として受け取らない（R26-004）', () => {
  /*
   * ⚠️ 実測（直す前）: `--receipt --allow-dirty` は
   *   ・値なしの `--receipt` を拒まず、`--allow-dirty` という**名前のファイル**を作り、
   *   ・`--allow-dirty` は消費されるので、**汚れた木を許す指定も効かない**。
   * 「引数を厳格に読む」という第24回の説明に反していた。
   */
  const dir = makeFixture([mut('Z6')]).dir;
  const runner = join(dir, 'scripts/run-mutations.mjs');
  const spec = join(dir, 'test/mutations.json');
  const run = (args) => {
    try {
      execFileSync(process.execPath, [runner, ...args],
        { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
      return { code: 0, out: '' };
    } catch (e) {
      return { code: typeof e.status === 'number' ? e.status : -1,
        out: `${String(e.stdout || '')}${String(e.stderr || '')}` };
    }
  };
  for (const flag of ['--receipt', '--id', '--spec', '--timeout']) {
    const r = run([flag, '--allow-dirty']);
    assert.equal(r.code, 2, `GXS_MARK.SWITCH_AS_VALUE ${flag} が別の引数の名前を値にしている`);
    assert.match(r.out, /に値が無い/, `${flag}: 止まった理由が違う: ${r.out.slice(0, 120)}`);
  }
  /* 同じ引数が2回来たら、どちらを使うか決まらないので受け取らない */
  for (const args of [['--receipt', 'a.json', '--receipt', 'b.json'],
    ['--allow-dirty', '--allow-dirty']]) {
    const r = run(args);
    assert.equal(r.code, 2, `GXS_MARK.DUP_ARG 同じ引数を2回受け取っている: ${args.join(' ')}`);
    assert.match(r.out, /が2回ある/, `止まった理由が違う: ${r.out.slice(0, 120)}`);
  }
  /* 意図しない名前のファイルを作っていないこと */
  for (const bad of ['--allow-dirty', 'a.json', 'b.json']) {
    assert.ok(!existsSync(join(dir, bad)), `意図しないファイルを作っている: ${bad}`);
  }
  /* ★対照: 正しい形はいまも通る */
  const ok = run(['--spec', spec, '--timeout', '8000', '--allow-dirty',
    '--receipt', join(dir, 'ok.json')]);
  assert.equal(ok.code, 0, `対照が成立していない＝この検査は何でも拒む: ${ok.out.slice(0, 200)}`);
});

test('知らない引数の名前も空の値も、値として受け取らない（R27-110）', () => {
  /*
   * 第27回監査 R27-110。R26-004 は「知っている引数の名前」だけを値から外していたので、
   * `--receipt --bogus` は `--bogus` という名前の証跡ファイルを作って exit 0 だった。
   * `--id ""` は全件、`--receipt ""` は証跡なし、`--spec ""` は既定の正本へ黙って戻っていた
   * （空の環境変数が展開されたときに、測る範囲や証跡の有無が意図と変わる）。
   */
  const dir = makeFixture([mut('Z7')]).dir;
  const runner = join(dir, 'scripts/run-mutations.mjs');
  const run = (args) => {
    try {
      execFileSync(process.execPath, [runner, ...args],
        { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
      return { code: 0, out: '' };
    } catch (e) {
      return { code: typeof e.status === 'number' ? e.status : -1,
        out: `${String(e.stdout || '')}${String(e.stderr || '')}` };
    }
  };
  for (const args of [['--receipt', '--bogus'], ['--id', ''], ['--receipt', ''], ['--spec', ''],
    ['--timeout', ''], ['--shard', ''], ['--id', '--zzz', '--allow-dirty']]) {
    const r = run(args);
    assert.equal(r.code, 2, `GXS_MARK.X12 ${JSON.stringify(args)} を受け取って走った（exit ${r.code}）`);
    assert.match(r.out, /値が無い|値が空/, `${JSON.stringify(args)}: 止まった理由が違う: ${r.out.slice(0, 120)}`);
  }
  assert.ok(!existsSync(join(dir, '--bogus')), '意図しない名前のファイルを作っている');
  /* 対照: 「--」で始まる名前のファイルは ./ を付ければ使える */
  const ok = run(['--allow-dirty', '--receipt', './--named.json']);
  assert.equal(ok.code, 0, `対照が成立していない: ${ok.out.slice(0, 200)}`);
  assert.ok(existsSync(join(dir, '--named.json')), '明示したパスに証跡を書いていない');
});
