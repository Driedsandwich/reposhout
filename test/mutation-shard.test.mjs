/*
 * 変異対照を束に分けて走らせるときの対照
 *   第26回監査 R26-002 §11
 *
 * ⚠️ **分けた瞬間に「覆えていない」が起こりうる。**
 * 束を1つ落としても、束の中身が重なっても、走った側の証跡はどれも「完了」に見える。
 * ここでは
 *   ① 束が正本を**ちょうど1回ずつ**覆うこと（実際に走らせて数える）
 *   ② 束の指定がおかしいときは走らないこと
 *   ③ 覆えていない証跡を、数え直す器が拒むこと
 * を見る。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './helpers/load.mjs';
import { makeFixture, mut } from './helpers/mutation-fixture.mjs';
import { shardOf } from '../scripts/lib/shard.mjs';

const COVERAGE = join(ROOT, 'scripts/verify-mutation-coverage.mjs');

function runIn(dir, args) {
  try {
    const out = execFileSync(process.execPath, args,
      { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 120000 });
    return { code: 0, out };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : -1,
      out: `${String(e.stdout || '')}${String(e.stderr || '')}` };
  }
}

const IDS = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9'];

test('束は、正本をちょうど1回ずつ覆う（R26-002）', () => {
  const dir = makeFixture(IDS.map((id) => mut(id))).dir;
  const runner = join(dir, 'scripts/run-mutations.mjs');
  const spec = join(dir, 'test/mutations.json');
  const seen = new Map();
  const N = 3;
  for (let i = 1; i <= N; i++) {
    const rp = join(dir, `receipt-${i}.json`);
    const r = runIn(dir, [runner, '--spec', spec, '--timeout', '8000', '--allow-dirty',
      '--shard', `${i}/${N}`, '--receipt', rp]);
    assert.equal(r.code, 0, `束 ${i}/${N} が走れていない:\n${r.out}`);
    const rec = JSON.parse(readFileSync(rp, 'utf8'));
    assert.deepEqual(rec.shard, { index: i, total: N },
      `GXS_MARK.SHARD_RECORDED 束の番号が証跡に残っていない: ${JSON.stringify(rec.shard)}`);
    for (const x of rec.results) {
      /* ⚠️ 同じIDが2つの束に入っていないこと（重なると「覆えた」に見える） */
      assert.ok(!seen.has(x.id),
        `同じ変異が2つの束に入っている: ${x.id}`);
      seen.set(x.id, i);
      assert.equal(shardOf(x.id, N), i - 1,
        `GXS_MARK.SHARD_ONCE 違う束で測っている: ${x.id} は束 ${shardOf(x.id, N) + 1} のはず`);
    }
  }
  assert.deepEqual([...seen.keys()].sort(), [...IDS].sort(),
    'GXS_MARK.SHARD_ALL 束を合わせても、正本を覆えていない');
});

test('束の指定がおかしければ、1件も測らない（R26-002）', () => {
  const dir = makeFixture([mut('A1')]).dir;
  const runner = join(dir, 'scripts/run-mutations.mjs');
  const spec = join(dir, 'test/mutations.json');
  const base = [runner, '--spec', spec, '--timeout', '8000', '--allow-dirty'];
  /*
   * ⚠️ 「止まった」だけでは足りない。**束の指定がおかしいから**止めたのかを見る。
   * 範囲の検査を外しても、選ばれる変異が0件になって「1件も選ばれていない」で
   * 止まるので、終了コードだけでは素通りする（実測）。
   */
  const badCases = [['0/4', /束の番号は/], ['5/4', /束の番号は/], ['abc', /「番号\/総数」/],
    ['1/0', /束の総数は/], ['1/65', /束の総数は/], ['-1/4', /「番号\/総数」/]];
  for (const [bad, why] of badCases) {
    const r = runIn(dir, [...base, '--shard', bad]);
    assert.equal(r.code, 2, `おかしな束の指定で走っている: ${bad}\n${r.out}`);
    assert.match(r.out, why,
      `GXS_MARK.SHARD_RANGE 束の指定がおかしいことで止めていない（${bad}）: ${r.out.slice(0, 160)}`);
  }
  /* ⚠️ 1件だけ測るのと束を測るのは、証跡から区別できなければならない */
  const both = runIn(dir, [...base, '--shard', '1/2', '--id', 'A1']);
  assert.equal(both.code, 2, 'GXS_MARK.SHARD_NOT_WITH_ID --id と --shard を同時に受け取っている');
  assert.match(both.out, /同時に使えない/, `止まった理由が違う: ${both.out.slice(0, 160)}`);

  /* ★対照: 正しい束の指定なら走る */
  const ok = runIn(dir, [...base, '--shard', '1/1', '--receipt', join(dir, 'r.json')]);
  assert.equal(ok.code, 0, `対照が成立していない＝この検査は何でも拒む:\n${ok.out}`);
});

/* ------------------------------------------------------------------
 * 数え直す器（verify-mutation-coverage.mjs）
 * ------------------------------------------------------------------ */

const DIR = mkdtempSync(join(tmpdir(), 'reposhout-cov-'));
let seq = 0;
const HEX = (s) => execFileSync(process.execPath, ['-e',
  `process.stdout.write(require('crypto').createHash('sha256').update(${JSON.stringify(s)}).digest('hex'))`],
{ encoding: 'utf8' });

/** 小さな正本と、それを覆う束の証跡を組み立てる */
function buildSet({ total = 3, dropShard = null, duplicate = false,
  swapBuckets = false, differentRunner = false } = {}) {
  const dir = join(DIR, `set-${++seq}`);
  mkdirSync(dir, { recursive: true });
  const specPath = join(dir, 'mutations.json');
  const spec = { mutations: IDS.map((id) => ({ id, file: 'mod.mjs', find: 'x', replace: 'y',
    test: 'test/guard.test.mjs', desc: id,
    expectedFailure: { testName: 'g', diagnosticMarker: `GXS_MARK.${id}` } })) };
  writeFileSync(specPath, JSON.stringify(spec, null, 2));
  const specSha = HEX(JSON.stringify(spec, null, 2));
  const paths = [];
  for (let i = 1; i <= total; i++) {
    if (dropShard === i) continue;
    let ids = IDS.filter((id) => shardOf(id, total) === i - 1);
    if (duplicate && i === 1) ids = [...ids, IDS.find((id) => shardOf(id, total) !== 0)];
    /* 束1と束2の中身だけ入れ替える。**覆えてはいる**ので、束の検査でしか捕まらない */
    if (swapBuckets && (i === 1 || i === 2)) {
      ids = IDS.filter((id) => shardOf(id, total) === (i === 1 ? 1 : 0));
    }
    const rec = {
      spec: 'test/mutations.json', state: 'complete', evidenceEligible: true,
      shard: { index: i, total }, total: ids.length,
      applied_and_killed: ids.length, applied_but_survived: 0, not_applied: 0, runner_error: 0,
      workspaceUnchanged: true,
      provenance: {
        sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), workingTreeDirty: false,
        runnerSha256: (differentRunner && i === 1) ? 'c'.repeat(64) : 'd'.repeat(64),
        specSha256: specSha, nodeVersion: process.version, platform: process.platform,
        timeoutMs: 300000
      },
      results: ids.map((id) => ({ id, outcome: 'applied_and_killed' }))
    };
    const p = join(dir, `receipt-${i}.json`);
    writeFileSync(p, JSON.stringify(rec, null, 2));
    paths.push(p);
  }
  return { specPath, paths };
}

function runCoverage({ specPath, paths }, extra = []) {
  return runIn(ROOT, [COVERAGE, ...paths, '--spec', specPath, ...extra]);
}

test('揃った束は通す（R26-002の対照）', () => {
  const r = runCoverage(buildSet());
  assert.equal(r.code, 0, `GXS_MARK.COV_OK 揃った束を拒んでいる＝この器は何でも拒む:\n${r.out}`);
  assert.match(r.out, /ちょうど1回ずつ覆っています/, `通ったのに、そう言っていない:\n${r.out}`);
});

test('覆えていない束は拒む（R26-002）', () => {
  /*
   * ⚠️ **止まった理由まで見る。**（第26回監査の作業中に実測）
   * 「束が1つ足りない」は、束の数を見なくても「一度も測っていない変異がある」で
   * 止まる。「違う束で測っている」も、覆えていなければ同じ理由で止まる。
   * どちらの理由で止まったかを見ないと、**外しても落ちない検査**ができる。
   * だから理由を1つに絞り、`swapBuckets` は**覆えてはいるが束が入れ替わっている**
   * 形（それ以外の検査では捕まらない）にしてある。
   */
  const cases = [
    ['束が1つ足りない', buildSet({ dropShard: 2 }), /走っていない束がある/],
    ['同じ変異が2つの束にある', buildSet({ duplicate: true }), /2回以上測った変異がある/],
    ['束が入れ替わっている', buildSet({ swapBuckets: true }), /違う束で測られた変異がある/],
    ['別々の版を寄せ集めている', buildSet({ differentRunner: true }), /runnerSha256 が証跡ごとに違う/]
  ];
  const passed = [];
  for (const [name, set, want] of cases) {
    const r = runCoverage(set);
    if (r.code === 0) passed.push(`${name}: 通してしまった`);
    else if (!want.test(r.out)) passed.push(`${name}: 止まった理由が違う（${r.out.split('\n').slice(1, 3).join(' / ')}）`);
  }
  assert.deepEqual(passed, [], `GXS_MARK.COV_GUARD 覆えていない束を拒めていない:\n${passed.join('\n')}`);
});

test('証跡が1枚も無ければ拒む（R26-002）', () => {
  const set = buildSet();
  const r = runIn(ROOT, [COVERAGE, join(DIR, 'no-such-receipt.json'), '--spec', set.specPath]);
  assert.notEqual(r.code, 0, 'GXS_MARK.COV_MISSING 無い証跡を通している');
  assert.match(r.out, /証跡が無い/, `止まった理由が違う:\n${r.out}`);
  assert.equal(runIn(ROOT, [COVERAGE, '--spec', set.specPath]).code, 2, 'パス無しで走っている');
});
