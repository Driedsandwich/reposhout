/*
 * 変異対照ランナー自身の対照（第22回監査 R22-004）
 *
 * ⚠️ **道具が壊れると、結果が読めなくなる。**
 *
 * 第21回でランナーをリポジトリへ入れたとき、自己検査は
 * 「4つの分類名がソースに書いてあるか」を見るだけの**静的な**ものだった。
 * これは「書いてある」ことしか言えない——第22回監査で、実際に走らせると
 *
 *   ・もともと落ちるテストを指した変異     → applied_and_killed（＝検知）
 *   ・存在しないテストを指した変異         → applied_and_killed
 *   ・終わらないテストを指した変異         → applied_and_killed
 *
 * になっていた。**変異と何の関係もない失敗が、全部「検査が効いた」に化けていた。**
 * 名前が書いてあることは、区別できることの証拠にならない。
 *
 * そこでこのテストは、**ランナーを別プロセスとして実際に起動する**。
 * 使い捨てのディレクトリに小さな題材とテストを並べ、9通りの状態を作って、
 * 証跡JSONに出る分類を1件ずつ突き合わせる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './helpers/load.mjs';

const RUNNER = join(ROOT, 'scripts/run-mutations.mjs');

/* 題材とテストを並べた使い捨ての作業場を作り、そこへランナーを複製する */
function makeFixture(mutations, files = {}) {
  /*
   * root を1段深くする。**外側に実在するテストファイル**を置けるようにするため
   * ——「リポジトリの外を指している」検査は、外のファイルが**実在しないと
   * 空振りする**（存在検査のほうが先に落ちるので、外していても同じ結果になる）。
   */
  const outer = mkdtempSync(join(tmpdir(), 'reposhout-mut-'));
  writeFileSync(join(outer, 'outside.test.mjs'), `
import test from 'node:test';
test('外にある、ふつうに通るテスト', () => {});
`);
  const dir = join(outer, 'repo');
  mkdirSync(dir);
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'test'));
  copyFileSync(RUNNER, join(dir, 'scripts/run-mutations.mjs'));

  writeFileSync(join(dir, 'target.txt'), 'ALPHA\nBETA\nGAMMA\nGAMMA\n');

  /* 題材の中身を見る、ふつうに通るテスト */
  writeFileSync(join(dir, 'test/passes.test.mjs'), `
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = () => readFileSync(new URL('../target.txt', import.meta.url), 'utf8');
test('ALPHA がある', () => { assert.ok(read().includes('ALPHA')); });
test('GAMMA が2つある', () => { assert.equal(read().split('GAMMA').length - 1, 2); });
`);
  /* 題材を見ない（＝変異しても落ちない）テスト */
  writeFileSync(join(dir, 'test/blind.test.mjs'), `
import test from 'node:test';
test('題材を何も見ない', () => {});
`);
  /* 変異と関係なく、最初から落ちるテスト */
  writeFileSync(join(dir, 'test/fails.test.mjs'), `
import test from 'node:test';
test('もともと落ちる', () => { throw new Error('変異前から失敗している'); });
`);
  /* 上限まで終わらないテスト（handle を持って居座る） */
  writeFileSync(join(dir, 'test/hangs.test.mjs'), `
import test from 'node:test';
test('終わらない', async () => {
  const t = setInterval(() => {}, 100);
  await new Promise(() => {});
});
`);
  /* 自分から signal で死ぬテスト */
  writeFileSync(join(dir, 'test/signal.test.mjs'), `
import test from 'node:test';
test('signal で死ぬ', () => { process.kill(process.pid, 'SIGKILL'); });
`);
  /*
   * ⚠️ **変異前は通り、変異後に初めて壊れる**テスト。
   * 変異前から壊れているものは対照の段階で止まるので、
   * **変異後の分類**（上限打ち切り・signal）はこれでないと通らない。
   */
  writeFileSync(join(dir, 'test/breaks-after.test.mjs'), `
import test from 'node:test';
import { readFileSync } from 'node:fs';
const body = readFileSync(new URL('../target.txt', import.meta.url), 'utf8');
if (body.includes('HANGNOW')) { setInterval(() => {}, 50); await new Promise(() => {}); }
/*
 * ⚠️ 自分（分離された test プロセス）を殺しても、\`node --test\` の親が
 * それを受け止めて**ふつうの失敗（exit 1）**にしてしまう。
 * ランナーから見える境界は親のほうなので、外から signal で殺された状況を
 * 作るには**親**を殺す（OOM killer に殺される形と同じ見え方になる）。
 */
if (body.includes('BOOMNOW')) {
  process.kill(process.ppid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 3000));
}
test('題材がふつうなら、ふつうに通る', () => {});
`);

  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
  writeFileSync(join(dir, 'test/mutations.json'), JSON.stringify({ mutations }, null, 2));
  return dir;
}

/* ランナーを別プロセスで走らせ、終了コードと証跡を返す */
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

const outcomeOf = (r, id) => (r.receipt.results.find((x) => x.id === id) || {}).outcome;

test('9通りの状態を、ランナーが実際に走って区別する（R22-004）', () => {
  const dir = makeFixture([
    /* ① ふつうに検知できる */
    { id: 'A1', file: 'target.txt', find: 'ALPHA', replace: 'XXXXX',
      test: 'test/passes.test.mjs', desc: '当たって落ちる' },
    /* ② 当たったのに通る＝検査の穴 */
    { id: 'A2', file: 'target.txt', find: 'BETA', replace: 'YYYYY',
      test: 'test/blind.test.mjs', desc: '当たったが誰も見ていない' },
    /* ③ 一致0 */
    { id: 'A3', file: 'target.txt', find: 'NOPE', replace: 'ZZZZZ',
      test: 'test/passes.test.mjs', desc: '一致しない' },
    /* ④ 一致数が期待と違う */
    { id: 'A4', file: 'target.txt', find: 'GAMMA', replace: 'ZZZZZ', expectMatches: 1,
      test: 'test/passes.test.mjs', desc: '2つあるのに1つのつもり' },
    /* ⑤ 対象テストが無い */
    { id: 'A5', file: 'target.txt', find: 'BETA', replace: 'QQQQQ',
      test: 'test/does-not-exist.test.mjs', desc: '存在しないテスト' },
    /* ⑥ 対象テストが変異前から落ちている */
    { id: 'A6', file: 'target.txt', find: 'BETA', replace: 'RRRRR',
      test: 'test/fails.test.mjs', desc: 'もともと落ちるテスト' },
    /* ⑦ 対象テストが終わらない */
    { id: 'A7', file: 'target.txt', find: 'BETA', replace: 'SSSSS',
      test: 'test/hangs.test.mjs', desc: '終わらないテスト' },
    /* ⑧ 対象テストが signal で死ぬ */
    { id: 'A8', file: 'target.txt', find: 'BETA', replace: 'TTTTT',
      test: 'test/signal.test.mjs', desc: 'signal で死ぬテスト' },
    /* ⑨ リポジトリの外を指している（★外のファイルは実在する） */
    { id: 'A9', file: 'target.txt', find: 'BETA', replace: 'UUUUU',
      test: '../outside.test.mjs', desc: '外を指すテスト' },
    /* ⑩ 変異前は通るが、変異後に終わらなくなる */
    { id: 'A10', file: 'target.txt', find: 'ALPHA', replace: 'HANGNOW',
      test: 'test/breaks-after.test.mjs', desc: '変異後に終わらなくなる' },
    /* ⑪ 変異前は通るが、変異後に signal で死ぬ */
    { id: 'A11', file: 'target.txt', find: 'BETA', replace: 'BOOMNOW',
      test: 'test/breaks-after.test.mjs', desc: '変異後に signal で死ぬ' }
  ]);
  const r = runRunner(dir);
  assert.ok(r.receipt, `証跡が書かれていない:\n${r.stdout}`);

  assert.equal(outcomeOf(r, 'A1'), 'applied_and_killed', '当たって落ちたものを検知にしていない');
  assert.equal(outcomeOf(r, 'A2'), 'applied_but_survived', '素通りを検知に寄せている');
  assert.equal(outcomeOf(r, 'A3'), 'not_applied', '一致0を素通りに寄せている');
  assert.equal(outcomeOf(r, 'A4'), 'not_applied', '一致数の食い違いを見逃している');

  /* ★ ここが第22回で見つかった穴。どれも「検知」に化けていた */
  for (const [id, what] of [['A5', '存在しないテスト'], ['A6', 'もともと落ちるテスト'],
    ['A7', '終わらないテスト'], ['A8', 'signal で死ぬテスト'], ['A9', '外を指すテスト'],
    ['A10', '変異後に終わらなくなるテスト']]) {
    assert.equal(outcomeOf(r, id), 'runner_error',
      `${what}が ${outcomeOf(r, id)} になっている（検知として数えてはいけない）`);
  }
  /* 上限で打ち切ったことが、証跡に記録されていること */
  const hung = r.receipt.results.find((x) => x.id === 'A10');
  assert.equal(hung.timedOut, true, '上限で打ち切ったのに、証跡へそう書いていない');

  /*
   * ⚠️ **A11（変異後に、外から signal で殺される）は POSIX でしか作れない。**
   *
   * Windows に signal は無く、プロセスを終わらせても親へ届くのは終了コードだけ
   * ——「外から殺された」と「テストがふつうに落ちた」が**境界では区別できない**。
   * ここで期待値を `applied_and_killed` に書き換えると、POSIX で効いている分類まで
   * 弱まる。1つの環境の実測で期待値を反転させず、**環境ごとに何が観測できるか**で分ける。
   *
   * つまりランナーの保証は環境で違う: POSIX では「外から殺された」を検知として
   * 数えないが、**Windows ではそれができない**（この非対称は報告にも書く）。
   */
  const boom = r.receipt.results.find((x) => x.id === 'A11');
  if (process.platform === 'win32') {
    assert.equal(boom.signal, null,
      'Windows で signal が観測できている＝前提が変わったので、この分岐を見直す');
    assert.equal(typeof boom.exitCode, 'number', '終了コードすら記録されていない');
  } else {
    assert.equal(outcomeOf(r, 'A11'), 'runner_error',
      `変異後に signal で死ぬテストが ${outcomeOf(r, 'A11')} になっている`);
    assert.equal(boom.signal, 'SIGKILL', `signal を記録していない: ${JSON.stringify(boom.signal)}`);
    assert.equal(boom.exitCode, null, '終了コードが無いのに数字を記録している');
  }
  /* 外を指す件は「外だから」止めたのであって、「無いから」ではないこと */
  const outside = r.receipt.results.find((x) => x.id === 'A9');
  assert.match(outside.error, /リポジトリの外/,
    `外を指す対象を、別の理由で止めている: ${outside.error}`);
  assert.equal(r.exitCode, 1, 'これだけ問題があるのに成功で終わっている');
});

test('変異前に対象テストを素で走らせ、その結果を証跡へ残す（R22-004）', () => {
  const dir = makeFixture([
    { id: 'B1', file: 'target.txt', find: 'ALPHA', replace: 'XXXXX',
      test: 'test/passes.test.mjs', desc: '正常' }
  ]);
  const r = runRunner(dir);
  assert.equal(r.exitCode, 0, `正常な変異1件で失敗している:\n${r.stdout}`);
  assert.ok(Array.isArray(r.receipt.baselines), '変異前の対照が証跡に無い');
  const bl = r.receipt.baselines.find((b) => b.test === 'test/passes.test.mjs');
  assert.ok(bl, '対象テストの変異前の結果が記録されていない');
  assert.equal(bl.passed, true);
  assert.equal(bl.exitCode, 0);
  assert.ok(bl.stdoutSha256, '変異前の出力のハッシュが無い');
  /* 変異後の結果にも、変異前の結果が並んでいる（後から突き合わせられる） */
  const one = r.receipt.results[0];
  assert.equal(one.baseline.exitCode, 0, '結果の側に変異前の記録が無い');
  assert.notEqual(one.beforeSha256, one.afterSha256, '当たったのに中身が変わっていない');
  assert.equal(one.restoredSha256, one.beforeSha256, '元へ戻せていない');
});

test('期待した数だけ置換し、置換した数を証跡へ残す（R22-004）', () => {
  /*
   * 以前は `String.replace` に文字列を渡していたので、`expectMatches: 2` と
   * 書いても**最初の1個しか**置換しなかった。「2箇所とも検査されている」ことの
   * 対照になっていなかった。
   */
  const dir = makeFixture([
    { id: 'C1', file: 'target.txt', find: 'GAMMA', replace: 'DELTA', expectMatches: 2,
      test: 'test/passes.test.mjs', desc: '2箇所を両方置換する' }
  ]);
  const r = runRunner(dir);
  const one = r.receipt.results[0];
  assert.equal(one.outcome, 'applied_and_killed');
  assert.equal(one.appliedReplacementCount, 2, '期待した数だけ置換していない');
  const after = readFileSync(join(dir, 'target.txt'), 'utf8');
  assert.equal(after.includes('GAMMA'), true, '元へ戻していない');
});

test('証跡には、何をどの版で測ったかが入る（R22-004）', () => {
  const dir = makeFixture([
    { id: 'D1', file: 'target.txt', find: 'ALPHA', replace: 'XXXXX',
      test: 'test/passes.test.mjs', desc: '正常' }
  ]);
  const r = runRunner(dir);
  const p = r.receipt.provenance;
  assert.ok(p, '由来が証跡に無い');
  for (const k of ['runnerSha256', 'specSha256', 'nodeVersion', 'startedAt', 'completedAt', 'timeoutMs']) {
    assert.ok(p[k] !== undefined && p[k] !== null, `由来に ${k} が無い`);
  }
  assert.match(p.runnerSha256, /^[0-9a-f]{64}$/);
  assert.match(p.specSha256, /^[0-9a-f]{64}$/);
  /* 定義を1文字変えたら、証跡のハッシュも変わる（＝本当にその定義を測っている） */
  const spec = JSON.parse(readFileSync(join(dir, 'test/mutations.json'), 'utf8'));
  spec.mutations[0].desc += '（変えた）';
  writeFileSync(join(dir, 'test/mutations.json'), JSON.stringify(spec, null, 2));
  const r2 = runRunner(dir, { receipt: 'receipt2.json' });
  assert.notEqual(r2.receipt.provenance.specSha256, p.specSha256,
    '定義を変えても証跡のハッシュが同じ＝測った対象を記録できていない');
});

test('証跡を書けなければ、成功で終わらない（R22-004）', () => {
  const dir = makeFixture([
    { id: 'E1', file: 'target.txt', find: 'ALPHA', replace: 'XXXXX',
      test: 'test/passes.test.mjs', desc: '正常' }
  ]);
  /* 存在しない階層の下を指す＝書けない */
  const r = runRunner(dir, { receipt: join('no-such-dir', 'deep', 'receipt.json') });
  assert.notEqual(r.exitCode, 0, '証跡を書けなかったのに成功で終わっている');
  assert.match(r.stdout + '', /./);
});

test('元へ戻せなかったら、検知ではなくランナー失敗にする（R22-004）', () => {
  const dir = makeFixture([
    { id: 'F1', file: 'target.txt', find: 'ALPHA', replace: 'XXXXX',
      test: 'test/passes.test.mjs', desc: '書き戻せない題材' }
  ]);
  /*
   * 復旧そのものを失敗させるのは環境依存が大きい（root では読み取り専用でも書ける）。
   * ここでは**判定の分岐が実在すること**を、ランナーの実装から確かめる。
   * ⚠️ 静的な確認であることを承知のうえで、「戻せた」ことの実測は上のテストが持つ。
   */
  const src = readFileSync(RUNNER, 'utf8');
  assert.match(src, /if \(!restored\) \{\s*\n\s*results\.push\(\{ \.\.\.common, outcome: 'runner_error'/,
    '復旧できなかったときに runner_error にする分岐が無い');
  const r = runRunner(dir);
  assert.equal(r.receipt.results[0].restored, true, '対照: ふつうは戻せている');
});

test('分類の4値は、証跡の集計と1件ずつ一致する（R22-004）', () => {
  const dir = makeFixture([
    { id: 'G1', file: 'target.txt', find: 'ALPHA', replace: 'XXXXX',
      test: 'test/passes.test.mjs', desc: '落ちる' },
    { id: 'G2', file: 'target.txt', find: 'BETA', replace: 'YYYYY',
      test: 'test/blind.test.mjs', desc: '素通り' },
    { id: 'G3', file: 'target.txt', find: 'NOPE', replace: 'ZZZZZ',
      test: 'test/passes.test.mjs', desc: '当たらない' },
    { id: 'G4', file: 'target.txt', find: 'BETA', replace: 'WWWWW',
      test: 'test/fails.test.mjs', desc: 'ランナー失敗' }
  ]);
  const r = runRunner(dir);
  const count = (o) => r.receipt.results.filter((x) => x.outcome === o).length;
  assert.equal(r.receipt.applied_and_killed, count('applied_and_killed'));
  assert.equal(r.receipt.applied_but_survived, count('applied_but_survived'));
  assert.equal(r.receipt.not_applied, count('not_applied'));
  assert.equal(r.receipt.runner_error, count('runner_error'));
  assert.equal(r.receipt.total, r.receipt.results.length);
  assert.deepEqual(
    [r.receipt.applied_and_killed, r.receipt.applied_but_survived,
      r.receipt.not_applied, r.receipt.runner_error],
    [1, 1, 1, 1], `4値がそれぞれ1件ずつにならない: ${JSON.stringify(r.receipt.results.map((x) => [x.id, x.outcome]))}`);
  /* 集計の見出しにも、素通り・当たらない・ランナー失敗が出る */
  assert.match(r.stdout, /素通り 1/);
  assert.match(r.stdout, /当たらなかった 1/);
  assert.match(r.stdout, /ランナー失敗 1/);
});

test('呼ばれ方（NODE_TEST_CONTEXT）で判定が変わらない（R22-004の作業中に発見）', () => {
  /*
   * ⚠️ `node --test` は、自分が別の test runner の子だと判断すると
   * **失敗しても終了コード 0 で終わる**。この変数が孫へ伝わると、
   * ランナーから見たテストは常に「通った」——**全件が素通りに化ける**。
   *
   * 落ちるはずのテストが 0 で返ってくるので、出力からは区別できない。
   * 実際、このファイルを書いた最初の版は**7件中4件が誤判定**していた
   * （検知 0 件・素通り 3 件）。判定の根拠を環境変数に握らせないこと。
   */
  const mutations = [
    { id: 'H1', file: 'target.txt', find: 'ALPHA', replace: 'XXXXX',
      test: 'test/passes.test.mjs', desc: '落ちるはず' },
    { id: 'H2', file: 'target.txt', find: 'BETA', replace: 'YYYYY',
      test: 'test/blind.test.mjs', desc: '素通りするはず' }
  ];
  /*
   * まず、この環境変数が本当に終了コードを変えることを確かめる（対照）。
   * ⚠️ このテスト自身が `node --test` の中で動いているので、**素の環境は
   *    自分で作る**。`process.env` をそのまま使うと既に変数が入っていて、
   *    対照のほうが空振りする（最初に書いた版がそうだった）。
   */
  const probe = makeFixture(mutations);
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

  /* その状態でランナーを起動しても、分類が変わらないこと */
  const dir = makeFixture(mutations);
  const r = runRunner(dir, { env: { NODE_TEST_CONTEXT: 'child-v8' } });
  assert.equal(outcomeOf(r, 'H1'), 'applied_and_killed',
    '呼び出し元の環境変数で、検知が素通りに化けている');
  assert.equal(outcomeOf(r, 'H2'), 'applied_but_survived');
});
