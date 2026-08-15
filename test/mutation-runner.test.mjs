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
test('外にある、ふつうに通るテスト', () => {});  /* MARK-OUTSIDE */
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
test(${JSON.stringify(OTHER)}, () => { assert.equal(other, 2, 'MARK-OTHER: other が 2 でない'); });
test('数え上げ: GAMMA が2つ', () => { assert.equal(many.split('GAMMA').length - 1, 2, 'MARK-COUNT: GAMMA の数が違う'); });
`);
  /* 題材を何も見ない＝変異しても落ちない */
  writeFileSync(join(dir, 'test/blind.test.mjs'), `
import test from 'node:test';
test('題材を何も見ない', () => {});  /* MARK-BLIND */
`);
  /* 変異と関係なく、最初から落ちる */
  writeFileSync(join(dir, 'test/fails.test.mjs'), `
import test from 'node:test';
test('もともと落ちる', () => { throw new Error('MARK-BASELINE: 変異前から失敗している'); });
`);
  /* 上限まで終わらない */
  writeFileSync(join(dir, 'test/hangs.test.mjs'), `
import test from 'node:test';
test('終わらない', async () => { setInterval(() => {}, 100); await new Promise(() => {}); });  /* MARK-HANG */
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
test('題材がふつうなら、ふつうに通る', () => {});  /* MARK-BREAKS */
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
  assert.ok(true, 'MARK-THROWS: ここまで来たら題材が壊れている');
});
`);
  /* 同じ名前のテストが2つ——守りたい方は通り、無関係な同名だけが落ちる */
  writeFileSync(join(dir, 'test/dup.test.mjs'), `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
test('同じ名前', () => { assert.ok(true); });  /* MARK-DUP */
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
  [WANT]: '/var/tmp/repo/mod.mjs を見よ',
  [OTHER]: 'MARK-OTHER',
  '数え上げ: GAMMA が2つ': 'MARK-COUNT',
  '題材を何も見ない': 'MARK-BLIND',
  'もともと落ちる': 'MARK-BASELINE',
  '終わらない': 'MARK-HANG',
  '題材がふつうなら、ふつうに通る': 'MARK-BREAKS',
  '例外で落ちる検査': 'MARK-THROWS',
  '同じ名前': 'MARK-DUP',
  '外にある、ふつうに通るテスト': 'MARK-OUTSIDE'
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
  assert.equal(kindOf(r, 'Q1'), 'unexpected_failure_kind', 'TypeError を assertion の検知として数えている');
  assert.equal(of(r, 'Q1').actualFailureKind, 'TypeError',
    `落ち方を記録していない: ${JSON.stringify(of(r, 'Q1').actualFailureKind)}`);
  /* 対照が無いと、単に全部を落としているのか区別できない */
  assert.equal(outcomeOf(r, 'Q2'), 'applied_and_killed');
  assert.equal(of(r, 'Q2').actualFailureKind, 'assertion');
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
    `想定と違う分類: ${kindOf(r, 'D1')}`);
  assert.match(of(r, 'D1').error, /2 件ある/);
});

test('変異IDが重複していたら、走る前に止まる（R24-001）', () => {
  /* 証跡のどの行がどの変異か決まらないので、測る前に止める */
  const dir = makeFixture([mut('Z1'), mut('Z1', { find: 'export const other = 2;',
    replace: 'export const other = 3;', expectedFailure: { testName: OTHER } })]).dir;
  const r = runRunner(dir);
  assert.notEqual(r.exitCode, 0, '重複したIDで走り切っている');
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
  assert.equal(kindOf(r, 'W1'), 'expectation_invalid', '理由なしの宣言を通している');
  assert.equal(kindOf(r, 'W2'), 'expectation_invalid', '知らない種類の宣言を通している');
});

test('どのテストが落ちるはずかを宣言していない変異は、測れない（R23-001）', () => {
  const dir = makeFixture([{ id: 'E1', file: 'mod.mjs',
    find: 'export const value = 1;', replace: 'export const value = 99;',
    test: GUARD, desc: '宣言なし' }]).dir;
  const r = runRunner(dir);
  /* ⚠️ 証跡の有無を**先に**見る。宣言の検査を外すとランナーが落ちて証跡が残らず、
     証跡を索きに行った所で TypeError になっていた（assertion が走らない・R24-001） */
  assert.ok(r.receipt, `証跡が残っていない（ランナーが落ちた）:\n${r.stdout}`);
  assert.equal(outcomeOf(r, 'E1'), 'runner_error', '宣言が無いのに検知にしている');
  assert.equal(kindOf(r, 'E1'), 'expectation_missing');
});

test('証跡に、落ちた理由と落ちたテスト名が残る（R23-001）', () => {
  const { dir } = makeFixture([mut('P1')]);
  const r = runRunner(dir);
  const one = r.receipt.results[0];
  for (const k of ['failureKind', 'failedTestNames', 'expectedFailure',
    'expectedFailureMatched', 'sanitizedDiagnostic', 'stdoutSha256', 'stderrSha256']) {
    assert.ok(k in one, `${k}: 証跡の欄が欠けている（R23-001）`);
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
  assert.match(of(r, 'L1').error, /symlink/, `symlink の検査で止めていない: ${of(r, 'L1').error}`);
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
    expectedFailure: { testName: '変異したときだけ、対象を消してディレクトリにする',
      diagnosticMarker: 'MARK-WRECK' } })], {
    'test/wreck.test.mjs': `
import test from 'node:test';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
const p = new URL('../mod.mjs', import.meta.url);
const mutated = readFileSync(p, 'utf8').includes('99');
test('変異したときだけ、対象を消してディレクトリにする', () => {
  if (!mutated) return;
  rmSync(p, { force: true });
  mkdirSync(p);
  throw new Error('MARK-WRECK: わざと落とす');
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
  assert.equal(of(r, 'R1').restoredSha256, of(r, 'R1').beforeSha256, '戻したと言うが、実物が変異前と違う（R23-002）');
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
    assert.notEqual(r.exitCode, 0, `--timeout ${bad} を受け取っている`);
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
  assert.notEqual(r.exitCode, 0, '知らない引数を黙って無視している');
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
  assert.equal(r.receipt.precondition, 'failed');
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
      diagnosticMarker: 'MARK-NUKEGIT' } })], {
    'test/nukegit.test.mjs': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
test('変異したら .git を消してから落ちる', () => {
  if (!body.includes('99')) return;
  rmSync(new URL('../.git', import.meta.url), { recursive: true, force: true });
  assert.fail('MARK-NUKEGIT: わざと落とす');
});
`
  }).dir;
  const r = runRunner(dir);
  assert.ok(r.receipt, `証跡が残っていない:\n${r.stdout}`);
  assert.equal(r.receipt.workspaceUnchanged, null,
    `題材が効いていない（git が生きたまま）: ${r.receipt.workspaceUnchanged}`);
  assert.equal(r.receipt.applied_and_killed, 1, '変異そのものは検知されているはず');
  assert.notEqual(r.exitCode, 0,
    '作業ツリーを確かめられていないのに成功で終わっている');

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
    `存在しないテストを、パスの検査で止めていない: ${kindOf(r, 'A5')}`);
  assert.equal(kindOf(r, 'A6'), 'baseline_failed', '元から落ちるテストを、変異の検知に数えている');
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
  assert.equal(outcomeOf(r, 'C1'), 'applied_and_killed', '複数一致の変異を検知にしていない（R22-004）');
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
    assert.ok(p[k] !== undefined && p[k] !== null, `${k}: 由来が証跡に残っていない（R22-004）`);
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
  assert.ok(r.receipt, '倒れたときに証跡が1行も残っていない');
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
    '証跡が無いのに assertion 以外で倒れている（または止まらずに通している）');
  /* 対照: 証跡があれば素通りする */
  assert.deepEqual(of({ receipt: { results: [{ id: 'X1', outcome: 'ok' }] } }, 'X1'),
    { id: 'X1', outcome: 'ok' });
});

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
  assert.notEqual(r.exitCode, 0, '汚れた木で走り切っている');
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
    '--allow-dirty で走らせたのに、証拠として使えることになっている');
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
  assert.equal(midway.state, 'running', `走っている最中の state が違う: ${midway.state}`);
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
    expectedFailure: { testName: '遅れて落ちる', diagnosticMarker: 'MARK-LATE' } })], {
    'test/late.test.mjs': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
test('遅れて落ちる', async () => {
  if (body.includes('99')) {
    Promise.resolve().then(() => assert.equal(1, 2, 'MARK-LATE: 後から落ちる'));
  }
  await new Promise((r) => setTimeout(r, 30));
});
`
  }).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'U1'), 'runner_error',
    `未処理の rejection を assertion として検知にしている: ${of(r, 'U1').actualFailureKind}`);
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
    expectedFailure: { testName: '2つの性質を見る', diagnosticMarker: 'MARK-TARGET' } })], {
    'test/two.test.mjs': `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../mod.mjs', import.meta.url), 'utf8');
test('2つの性質を見る', () => {
  assert.ok(true, 'MARK-TARGET: 守りたい性質');
  assert.ok(!body.includes('99'), 'MARK-UNRELATED: 無関係な性質');
});
`
  }).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'U2'), 'runner_error',
    '守りたい assertion は通っているのに検知にしている');
  assert.equal(kindOf(r, 'U2'), 'marker_not_found');

  /* 対照: 守りたい側が落ちる目印なら検知になる */
  const dir2 = makeFixture([mut('U3', { test: 'test/two.test.mjs',
    expectedFailure: { testName: '2つの性質を見る', diagnosticMarker: 'MARK-UNRELATED' } })], {
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
  assert.equal(outcomeOf(r, 'U4'), 'runner_error', '目印が無いのに測っている');
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
    diagnosticMarker: 'assert' } })]).dir;   // 題材の中に何度も出る語
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'U5'), 'runner_error', '一意でない目印で測っている');
  assert.equal(kindOf(r, 'U5'), 'expectation_invalid', '一意でない目印を受け取っている');
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
  assert.ok(true, 'MARK-KEEP: 守りたい性質');
  assert.ok(!body.includes('99'), 'MARK-UNRELATED2: 無関係な性質');
});
test('別のテストも落ちる', () => {
  assert.ok(!body.includes('99'), 'MARK-ELSEWHERE: 別のテストが出す');
});
`
  };
  const dir = makeFixture([mut('U6', { test: 'test/three.test.mjs',
    expectedFailure: { testName: '2つの性質を見る', diagnosticMarker: 'MARK-ELSEWHERE' } })],
    files).dir;
  const r = runRunner(dir);
  assert.equal(outcomeOf(r, 'U6'), 'runner_error',
    '別のテストが出した目印で検知にしている');
  assert.equal(kindOf(r, 'U6'), 'marker_not_found');

  /* ★対照: そのテスト自身の目印なら検知になる */
  const dir2 = makeFixture([mut('U7', { test: 'test/three.test.mjs',
    expectedFailure: { testName: '2つの性質を見る', diagnosticMarker: 'MARK-UNRELATED2' } })],
    files).dir;
  assert.equal(outcomeOf(runRunner(dir2), 'U7'), 'applied_and_killed',
    '対照が成立していない＝この検査は何でも落とす');
});

test('証跡は一時ファイル経由で置き換える（R25-003）', () => {
  /*
   * ⚠️ 直接上書きすると、書いている途中の JSON を読み手が拾いうる。
   * 一時ファイルへ書いて rename する（同じファイルシステム上では不可分）。
   * 走り終えたあとに一時ファイルが残っていないことも見る。
   */
  const runner = readFileSync(join(ROOT, 'scripts/run-mutations.mjs'), 'utf8');
  assert.match(runner, /renameSync\(tmp, receiptPath\)/,
    '証跡を直接上書きしている（途中の状態が読まれうる）');
  const dir = makeFixture([mut('A9')]).dir;
  const r = runRunner(dir);
  assert.equal(r.exitCode, 0, `走れていない:\n${r.stdout}`);
  const left = readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(left, [], `一時ファイルが残っている: ${left.join(' ')}`);
});
