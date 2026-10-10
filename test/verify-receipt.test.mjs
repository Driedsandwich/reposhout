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
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ROOT } from './helpers/load.mjs';
import { shardOf } from '../scripts/lib/shard.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');

/*
 * ⚠️ **題材は「いまの作業ツリーをそのまま写した、使い捨ての git リポジトリ」。**（第27回監査 R27-103）
 * 検証器は、各変異の前・後・復旧のハッシュを**測ったコミットの実体から計算し直し**、
 * 追跡しているファイルに変更が無いことも見るようになった。作り物のハッシュの題材は
 * 通らなくなるので、検証器を緩めずに題材のほうを実体のあるものへ直した。
 * 作業ツリーをそのまま写すので、手元で未コミットの変更があっても、変異が当たった状態でも、
 * その状態の検証器と正本を試せる。
 */
function cleanCopyOfWorkingTree() {
  const dir = mkdtempSync(join(tmpdir(), 'reposhout-verify-root-'));
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'],
    { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    try { copyFileSync(join(ROOT, f), join(dir, f)); } catch (e) { /* 消えたファイルは写さない */ }
  }
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  g('init', '-q');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'fixture');
  return dir;
}
const FIX = cleanCopyOfWorkingTree();
const VERIFIER = join(FIX, 'scripts/verify-mutation-receipt.mjs');
const git = (...a) => execFileSync('git', a, { cwd: FIX, encoding: 'utf8' }).trim();

const SPEC_TEXT = readFileSync(join(FIX, 'test/mutations.json'), 'utf8');
const SPEC = JSON.parse(SPEC_TEXT);
const RUNNER_TEXT = readFileSync(join(FIX, 'scripts/run-mutations.mjs'), 'utf8');
const HEAD = git('rev-parse', 'HEAD');
const TREE = git('rev-parse', 'HEAD^{tree}');
/* 変異の対象の中身から、前・後のハッシュを実際に作る */
const CONTENT_AT_START = new Map();
const contentOf = (f) => {
  if (!CONTENT_AT_START.has(f)) CONTENT_AT_START.set(f, readFileSync(join(FIX, f), 'utf8'));
  return CONTENT_AT_START.get(f);
};
const buildReceiptFrom = () => buildReceipt();

const hex = (seed) => sha(String(seed));

/** いまの正本と噛み合う「通るはずの」証跡を組み立てる */
function buildReceipt() {
  const results = SPEC.mutations.map((m) => {
    const ef = m.expectedFailure;
    const kind = ef.kind || 'assertion';
    const text = contentOf(m.file);
    const before = sha(text);
    const after = sha(text.split(m.find).join(m.replace));
    return {
      id: m.id, file: m.file, desc: m.desc, test: m.test,
      expectedFailure: { ...ef },
      expectedMatches: m.expectMatches === undefined ? 1 : m.expectMatches,
      actualMatches: m.expectMatches === undefined ? 1 : m.expectMatches,
      appliedReplacementCount: m.expectMatches === undefined ? 1 : m.expectMatches,
      beforeSha256: before, afterSha256: after, restoredSha256: before,
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
      { cwd: FIX, encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
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
    /戻したあとが変異前と違う/],
  /* ---- 第27回監査 R27-101: 結果行が「検知していない」と言っているのに通していた ---- */
  ['結果行を素通りにし、上位の欄は検知を1つ減らすだけ',
    (r) => { r.results[0].outcome = 'applied_but_survived'; r.applied_and_killed -= 1; },
    /applied_but_survived の数が結果行と合わない/],
  ['結果行を未適用にし、上位の欄は0のまま',
    (r) => { r.results[0].outcome = 'not_applied'; r.applied_and_killed -= 1; },
    /not_applied の数が結果行と合わない/],
  ['結果行をランナー失敗にし、上位の欄は0のまま',
    (r) => { r.results[0].outcome = 'runner_error'; r.applied_and_killed -= 1; },
    /runner_error の数が結果行と合わない/],
  ['上位の欄も結果行と矛盾なく素通りを1件数えた（内訳は合っている）', (r) => {
    r.results[0].outcome = 'applied_but_survived';
    r.applied_and_killed -= 1; r.applied_but_survived += 1;
  }, /検知していない結果がある/],
  ['非検知の件数の欄を消す', (r) => { delete r.not_applied; },
    /not_applied が 0 以上の整数でない/],
  ['非検知の件数の欄を文字列にする', (r) => { r.runner_error = '0'; },
    /runner_error が 0 以上の整数でない/],
  /* ---- 第27回監査 R27-103: ハッシュと変異前の対照を実体へ結び付けていなかった ---- */
  ['前・後・復旧のハッシュを実体と無関係な値にする', (r) => {
    r.results[0].beforeSha256 = 'a'.repeat(64); r.results[0].restoredSha256 = 'a'.repeat(64);
    r.results[0].afterSha256 = 'b'.repeat(64);
  }, /変異前のハッシュが、測ったコミットの中身と違う/],
  ['変異後のハッシュだけを実体と無関係な値にする', (r) => { r.results[0].afterSha256 = 'b'.repeat(64); },
    /変異後のハッシュが、正本どおり置き換えた中身と違う/],
  ['変異前の対照の終了コードを1にして passed は残す', (r) => { r.baselines[0].exitCode = 1; },
    /変異前の対照の終了コードが 0 でない/],
  ['変異前の対照を2度書く', (r) => { r.baselines.push({ ...r.baselines[0] }); },
    /変異前の対照に同じテストが2度出ている/]
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
        { cwd: FIX, encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
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

test('証跡に正本を選ばせない・正本の形が壊れていれば照合を飛ばさずに落とす（R27-102）', () => {
  /*
   * 第27回監査 R27-102。検証器は既定の照合先に証跡の `spec` を使っていたので、
   * `{}` の JSON を指させると件数・ID・正本ハッシュの照合が黙って飛び、exit 0 だった。
   */
  const empty = join(DIR, 'empty-spec.json');
  writeFileSync(empty, '{}');
  const r = buildReceipt();
  r.spec = empty;
  const out = runVerifier(r);
  assert.notEqual(out.code, 0, '証跡が指した別の正本で照合している');
  /* ⚠️ 止まった理由まで見る。正本の形の検査も {} を拒むので、止まっただけでは区別できない */
  assert.match(out.out, /証跡が名乗る正本/, `GXS_MARK.VR08 証跡が名乗る正本だと気づいて止めていない:\n${out.out}`);
  /* 呼び出し側が壊れた正本を渡しても、照合を飛ばさずに落とす */
  for (const body of ['{}', 'null', '{"mutations":[]}', '{"mutations":[{"id":1}]}',
    JSON.stringify({ mutations: [SPEC.mutations[0], SPEC.mutations[0]] })]) {
    const bad = join(DIR, `bad-spec-${++seq}.json`);
    writeFileSync(bad, body);
    const r2 = buildReceipt();
    r2.spec = bad;
    const p = join(DIR, `receipt-${++seq}.json`);
    writeFileSync(p, JSON.stringify(r2));
    let code = 0; let text = '';
    try {
      execFileSync(process.execPath, [VERIFIER, p, '--expected-commit', HEAD, '--spec', bad],
        { cwd: FIX, encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
    } catch (e) { code = e.status; text = `${e.stdout}${e.stderr}`; }
    assert.notEqual(code, 0, `壊れた正本（${body.slice(0, 40)}）で照合を飛ばして通している`);
    assert.match(text, /正本/, `止まった理由が違う（${body.slice(0, 40)}）: ${text.slice(0, 200)}`);
  }
});

test('証跡を作ったあとで追跡中のファイルを変えたら通さない（R27-103）', () => {
  /*
   * 第27回監査 R27-103。HEAD の tree を確かめることと、いまの作業ファイルがその tree どおりで
   * あることは別。変異の対象を書き換えても、同じ証跡が通っていた。
   */
  const target = SPEC.mutations[0].file;
  const abs = join(FIX, target);
  const original = readFileSync(abs, 'utf8');
  try {
    writeFileSync(abs, original + '\n/* 証跡のあとで書き換えた */\n');
    const out = runVerifier(buildReceiptFrom(original));
    assert.notEqual(out.code, 0, '手元の変更があるのに通している');
    /* ⚠️ 作業ファイルの中身の照合も同じ変更で止まるので、理由まで見て区別する */
    assert.match(out.out, /追跡しているファイルに変更がある/, `GXS_MARK.VR09 追跡中のファイルの変更だと気づいて止めていない:\n${out.out}`);
  } finally {
    writeFileSync(abs, original);
  }
  /* 対照: 戻せば通る */
  assert.equal(runVerifier(buildReceipt()).code, 0, '戻したのに通らない');
});
