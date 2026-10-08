/*
 * 外部検証器（scripts/verify-mutation-receipt.mjs）の対照
 *   第26回監査 R26-002 で新設
 *
 * ⚠️ **なぜ要るか**
 * 第25回に新設した検証器は「外から独立に確かめる」と名乗っていたが、実際に
 * 確かめていたのは件数・ID集合・ハッシュの**内部整合**だけだった。実測した証跡の
 * 写しを作り、
 *
 *   provenance の runnerSha256 / specSha256 / sourceTree を消す
 *   failureKind と actualFailureKind を出鱈目にする
 *   expectedFailure を正本と無関係な値にする
 *   failedTestNames を空にする / matchedBody を "x" にする
 *   exitCode=0 / timedOut=true / signal=SIGKILL
 *
 * と壊しても **problems 0 で通った**。意味のある欄はすべてランナーの自己申告のまま
 * 信じていた。ここでは「1項目ずつ壊して、1件ずつ拒むこと」を実際に起動して見る。
 *
 * ⚠️ この題材の証跡は**組み立てたもの**であって、変異を測った記録ではない。
 * 検証器の判定を試すためだけに使い、成果物としては一切出さない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './helpers/load.mjs';
import { shardOf } from '../scripts/lib/shard.mjs';

const VERIFIER = join(ROOT, 'scripts/verify-mutation-receipt.mjs');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

const SPEC_TEXT = readFileSync(join(ROOT, 'test/mutations.json'), 'utf8');
const SPEC = JSON.parse(SPEC_TEXT);
const RUNNER_TEXT = readFileSync(join(ROOT, 'scripts/run-mutations.mjs'), 'utf8');
const HEAD = git('rev-parse', 'HEAD');
const TREE = git('rev-parse', 'HEAD^{tree}');

const hex = (seed) => sha(String(seed));

/** いまの正本と噛み合う「通るはずの」証跡を組み立てる */
function buildReceipt() {
  const results = SPEC.mutations.map((m) => {
    const ef = m.expectedFailure;
    const kind = ef.kind || 'assertion';
    const before = hex(`${m.id}-before`);
    return {
      id: m.id, file: m.file, desc: m.desc, test: m.test,
      expectedFailure: { ...ef },
      expectedMatches: m.expectMatches === undefined ? 1 : m.expectMatches,
      actualMatches: m.expectMatches === undefined ? 1 : m.expectMatches,
      appliedReplacementCount: m.expectMatches === undefined ? 1 : m.expectMatches,
      beforeSha256: before, afterSha256: hex(`${m.id}-after`), restoredSha256: before,
      changed: true, wrote: true, restored: true, restoreError: null,
      exitCode: 1, signal: null, timedOut: false, spawnError: null,
      failedTestNames: [ef.testName],
      outcome: 'applied_and_killed',
      failureKind: kind === 'assertion' ? 'expected_assertion_failure' : 'expected_declared_failure',
      expectedFailureKind: kind, actualFailureKind: kind,
      expectedFailureMatched: true,
      expectedFailureDetail: kind === 'assertion'
        ? { name: ef.testName, failureType: 'testCodeFailure', code: 'ERR_ASSERTION', errName: 'AssertionError' }
        : { name: ef.testName, failureType: kind, code: 'ERR_TEST_FAILURE', errName: null },
      matchedBody: `${ef.diagnosticMarker} 題材の本文`
    };
  });
  const tests = [...new Set(results.map((r) => r.test))];
  return {
    spec: 'test/mutations.json', state: 'complete', evidenceEligible: true,
    currentMutationId: null, lastCompletedMutationId: results[results.length - 1].id,
    total: results.length,
    applied_and_killed: results.length, applied_but_survived: 0,
    not_applied: 0, runner_error: 0,
    workspaceUnchanged: true,
    provenance: {
      sourceCommit: HEAD, sourceTree: TREE,
      workingTreeDirty: false,
      runnerSha256: sha(RUNNER_TEXT), specSha256: sha(SPEC_TEXT),
      nodeVersion: process.version, platform: process.platform, timeoutMs: 300000,
      startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:10:00.000Z'
    },
    baselines: tests.map((t) => ({ test: t, passed: true, exitCode: 0, stdoutSha256: hex(t) })),
    results
  };
}

const DIR = mkdtempSync(join(tmpdir(), 'reposhout-verify-'));
let seq = 0;
function runVerifier(receipt, { expectedCommit = HEAD, write = true } = {}) {
  const p = join(DIR, `receipt-${++seq}.json`);
  if (write) writeFileSync(p, JSON.stringify(receipt, null, 2));
  const args = [VERIFIER, p, ...(expectedCommit ? ['--expected-commit', expectedCommit] : [])];
  try {
    const out = execFileSync(process.execPath, args,
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
    return { code: 0, out };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : -1,
      out: `${String(e.stdout || '')}${String(e.stderr || '')}` };
  }
}

/* ---- ★対照: 噛み合った証跡は通る（常に拒む器では意味がない） ---- */
test('いまの正本・ランナー・tree と噛み合う証跡は通す（R26-002の対照）', () => {
  const r = runVerifier(buildReceipt());
  assert.equal(r.code, 0,
    `GXS_MARK.VR01 噛み合った証跡を拒んでいる＝この検証器は何でも拒む:\n${r.out}`);
  assert.match(r.out, /証拠として使えます/, `通ったのに、そう言っていない:\n${r.out}`);
});

/*
 * ---- 1項目ずつ壊して、1件ずつ拒むこと ----
 * ⚠️ 「拒んだ」だけでは足りない。**壊した項目が理由で**拒んだのかを、
 * 出力の文言まで見て確かめる（別の理由で偶然拒んでも通ってしまう）。
 */
const CASES = [
  ['runnerSha256 を消す', (r) => { delete r.provenance.runnerSha256; }, /runnerSha256 が無い/],
  ['specSha256 を消す', (r) => { delete r.provenance.specSha256; }, /specSha256 が無い/],
  ['sourceTree を消す', (r) => { delete r.provenance.sourceTree; }, /sourceTree が無い/],
  ['nodeVersion を消す', (r) => { delete r.provenance.nodeVersion; }, /nodeVersion が無い/],
  ['timeoutMs を消す', (r) => { delete r.provenance.timeoutMs; }, /timeoutMs/],
  ['sourceTree を別の値にする', (r) => { r.provenance.sourceTree = hex('other'); },
    /sourceTree がいまの tree と違う/],
  ['runnerSha256 を別の値にする', (r) => { r.provenance.runnerSha256 = hex('other'); },
    /runnerSha256 が、いまの/],
  ['specSha256 を別の値にする', (r) => { r.provenance.specSha256 = hex('other'); },
    /正本のハッシュが、いまの正本と違う/],
  ['ハッシュを 64桁の16進でなくする', (r) => { r.results[0].beforeSha256 = 'zzz'; },
    /64桁の16進でない/],
  ['expectedFailure を正本と無関係にする',
    (r) => { r.results[0].expectedFailure.testName = 'まったく別のテスト'; },
    /宣言したテスト名が正本と違う/],
  ['目印を正本と違うものにする',
    (r) => { r.results[0].expectedFailure.diagnosticMarker = 'GXS_MARK.BOGUS'; },
    /目印が正本と違う/],
  ['目印を予約形でないものにする', (r) => {
    for (const x of r.results) x.expectedFailure.diagnosticMarker = 'xpected ';
  }, /予約形/],
  ['残す本文から目印を消す', (r) => { r.results[0].matchedBody = 'x'; },
    /残された本文に目印が無い/],
  ['落ちたテストの一覧を空にする', (r) => { r.results[0].failedTestNames = []; },
    /落ちたテストの一覧に宣言したテストが無い/],
  ['落ち方の種類を出鱈目にする', (r) => { r.results[0].actualFailureKind = 'fabricated'; },
    /実際の落ち方が宣言と違う/],
  ['failureKind を出鱈目にする', (r) => { r.results[0].failureKind = 'fabricated'; },
    /failureKind が宣言と噛み合っていない/],
  ['assertion なのに ERR_ASSERTION でない',
    (r) => { r.results[0].expectedFailureDetail.code = 'ERR_OTHER'; },
    /assertion として落ちたことになっていない/],
  ['終了コードを 0 にする', (r) => { r.results[0].exitCode = 0; },
    /終了コードが 0 でないことを示していない/],
  ['上限で打ち切られたことにする', (r) => { r.results[0].timedOut = true; },
    /上限で打ち切られている/],
  ['signal で死んだことにする', (r) => { r.results[0].signal = 'SIGKILL'; },
    /signal で死んでいる/],
  ['起動に失敗したことにする', (r) => { r.results[0].spawnError = 'ENOENT'; },
    /起動に失敗している/],
  ['変異前の対照を落とす', (r) => { r.baselines.shift(); },
    /変異前の対照が無い対象テストがある/],
  ['変異前の対照が通っていない', (r) => { r.baselines[0].passed = false; },
    /変異前の対照が通っていない/],
  ['state を running にする', (r) => { r.state = 'running'; }, /complete でない/],
  ['state を aborted にする', (r) => { r.state = 'aborted'; }, /complete でない/],
  ['汚れた木で測ったことにする', (r) => { r.provenance.workingTreeDirty = true; },
    /作業ツリーが汚れている/],
  ['証拠にできない印を無視する', (r) => { r.evidenceEligible = false; },
    /evidenceEligible が true でない/],
  ['測っている最中の欄が残っている', (r) => { r.currentMutationId = 'M01'; },
    /測っている最中の変異が残っている/],
  ['最後に終えた変異が結果と食い違う', (r) => { r.lastCompletedMutationId = 'M01'; },
    /最後に終えた変異が、結果の最後と違う/],
  ['変異を1件抜く', (r) => { r.results.pop(); r.total = r.results.length; },
    /証跡に無い変異がある|正本は/],
  ['前後でファイルが変わっていない',
    (r) => { r.results[0].afterSha256 = r.results[0].beforeSha256; },
    /変異の前後でファイルが変わっていない/],
  ['戻したあとが変異前と違う', (r) => { r.results[0].restoredSha256 = hex('other2'); },
    /戻したあとが変異前と違う/]
];

/*
 * ⚠️ テスト名は**ソースに書いた文字列のまま**にする（第26回監査 R26-001）。
 * `test(\`… ${name} …\`)` のように組み立てると、宣言を読む側からは名前が決まらず、
 * 変異の宣言（どのテストが落ちるはずか）と突き合わせられない。
 * だから 1本のテストの中で 1件ずつ回し、どの項目で落ちたかはメッセージで言う。
 */
test('改竄した証跡を、項目ごとに拒む（R26-002）', () => {
  const passed = [];
  for (const [name, breakIt, want] of CASES) {
    const r = buildReceipt();
    breakIt(r);
    const out = runVerifier(r);
    if (out.code === 0) passed.push(`${name}: 通してしまった`);
    else if (!want.test(out.out)) passed.push(`${name}: 止まった理由が違う（${out.out.split('\n').slice(1, 3).join(' / ')}）`);
  }
  assert.deepEqual(passed, [],
    `GXS_MARK.VR02 壊した証跡を拒めていない:\n${passed.join('\n')}`);
});

test('束の証跡は、その束に属する変異だけを持つ（R26-002）', () => {
  /*
   * ⚠️ 束に分けると、1枚の証跡は正本の一部しか覆わない。そこで件数の一致だけを
   * 緩めると、**束の外の変異が混ざっていても通る**ようになる。
   * 「この束に属するIDの集合」を、読む側がハッシュから計算し直して突き合わせる。
   */
  const N = 3;
  const inShard = (i) => SPEC.mutations.filter((m) => shardOf(m.id, N) === i - 1).map((m) => m.id);
  const build = (i, ids) => {
    const r = buildReceipt();
    r.shard = { index: i, total: N };
    r.results = r.results.filter((x) => ids.includes(x.id));
    r.total = r.results.length;
    r.applied_and_killed = r.results.length;
    r.lastCompletedMutationId = r.results.length ? r.results[r.results.length - 1].id : null;
    r.baselines = r.baselines.filter((b) => r.results.some((x) => x.test === b.test));
    return r;
  };
  /* ★対照: 束どおりなら通る */
  const ok = runVerifier(build(1, inShard(1)));
  assert.equal(ok.code, 0, `GXS_MARK.VR06 束どおりの証跡を拒んでいる:\n${ok.out}`);

  /* 束の外のIDが1件混ざっていたら拒む */
  const alien = inShard(2)[0];
  const bad = runVerifier(build(1, [...inShard(1), alien]));
  assert.notEqual(bad.code, 0, '束の外の変異が混ざっていても通している');
  /*
   * ⚠️ 止まった理由まで見る。件数の検査だけでも「1件多い」で止まるので、
   * **束の外かどうかを見る検査は、外しても落ちない行**になってしまう
   *（件数が同じまま入れ替わった形は、件数では捕まらない）。
   */
  assert.match(bad.out, /この束に属さない変異が入っている/,
    `GXS_MARK.VR07 束の外だと気づいて止めていない:\n${bad.out}`);
});

test('測ったコミットが違えば拒む（R26-002）', () => {
  const out = runVerifier(buildReceipt(), { expectedCommit: hex('another-commit') });
  assert.notEqual(out.code, 0, 'GXS_MARK.VR03 別のコミットの証跡を通している');
  assert.match(out.out, /測った commit が違う/, `止まった理由が違う:\n${out.out}`);
});

test('証跡そのものが無ければ拒む（R25-003 / R26-002）', () => {
  /* ⚠️ 「無い」を通すと、**走らなかったこと**が成功に化ける */
  const out = runVerifier(null, { write: false });
  assert.notEqual(out.code, 0, 'GXS_MARK.VR04 証跡が無いのに通している');
  assert.match(out.out, /証跡が無い/, `止まった理由が違う:\n${out.out}`);
});

test('引数を厳格に読む（R26-002）', () => {
  const p = join(DIR, 'args.json');
  writeFileSync(p, JSON.stringify(buildReceipt()));
  const run = (args) => {
    try {
      execFileSync(process.execPath, [VERIFIER, ...args],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
      return { code: 0, out: '' };
    } catch (e) {
      return { code: typeof e.status === 'number' ? e.status : -1,
        out: `${String(e.stdout || '')}${String(e.stderr || '')}` };
    }
  };
  assert.equal(run([p, '--nope', 'x']).code, 2, 'GXS_MARK.VR05 知らない引数を受け取っている');
  assert.equal(run([p, '--expected-commit']).code, 2, '値の無い引数を受け取っている');
  assert.equal(run([p, '--expected-commit', HEAD, '--expected-commit', HEAD]).code, 2,
    '同じ引数を2回受け取っている');
  assert.equal(run([p, p]).code, 2, 'GXS_MARK.Y18 証跡のパスを2つ受け取っている');
  assert.equal(run([]).code, 2, 'パス無しで走っている');
});
