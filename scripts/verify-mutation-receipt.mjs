#!/usr/bin/env node
/*
 * 変異対照の証跡が、証拠として使える形かを**外から**確かめる。
 *   第25回監査 R25-003 で新設
 *   第26回監査 R26-002 で「独立していなかった」ことが分かり、作り直した
 *
 * ⚠️ ランナー自身の終了コードだけを信じない。ランナーが途中で強制終了されると
 * 証跡は「走っている」ままか、そもそも残らない。**証跡を読む側**が独立に判定する。
 *
 * ⚠️ **第26回 R26-002 で見つかった、その裏返し**
 * 「外から確かめる」と名乗っていたのに、確かめていたのは件数・ID・ハッシュの
 * 内部整合だけだった。実際に測った証跡の写しを作り、
 *
 *   provenance の runnerSha256 / specSha256 / sourceTree を消す
 *   failureKind と actualFailureKind を出鱈目にする
 *   expectedFailure を正本と無関係な値にする
 *   failedTestNames を空にする / matchedBody を "x" にする
 *   exitCode=0 / timedOut=true / signal=SIGKILL
 *
 * と改竄しても、ID・件数・sourceCommit・前後ハッシュさえ保てば **problems 0** で
 * 通った。**意味のある欄はすべてランナーの自己申告のまま**信じていた。
 *
 * そこで、判定の根拠を**いま手元にあるファイル**へ結び直す:
 *
 *   ① 由来の欄が全部あること（欠けを「無検査」で済ませない）
 *   ② HEAD・tree・ランナー・正本のハッシュを**この場で測り直して**照合する
 *   ③ 結果1件ずつを、いまの正本へ ID で結合し、宣言の全項目を突き合わせる
 *   ④ 落ち方とプロセスの終わり方（exit / timeout / signal / spawn）まで見る
 *   ⑤ 目印が、残された本文の中に実際に在ること
 *   ⑥ 変異前の対照が、対象テストを全部覆っていること
 *
 *   node scripts/verify-mutation-receipt.mjs mutation-receipt.json \
 *     --expected-commit "$GITHUB_SHA"
 *
 * 問題があれば1行ずつ出して exit 1。何も無ければ exit 0。
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
/* ⚠️ 目印の形は、作る側（ランナー）と**同じ1つ**を読む（第26回監査 R26-001） */
import { MARKER_PREFIX, MARKER_RE } from './lib/marker-format.mjs';
import { shardOf, MAX_SHARDS } from './lib/shard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const GITOID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

const KNOWN = ['--expected-commit', '--spec', '--runner'];
function parseArgs(argv) {
  const out = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    if (!KNOWN.includes(a)) return { error: `知らない引数: ${a}` };
    if (out[a] !== undefined) return { error: `${a} が2回ある` };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) return { error: `${a} に値が無い` };
    out[a] = v; i++;
  }
  if (rest.length > 1) return { error: `証跡のパスが ${rest.length} 個ある` };
  return { out, rest };
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.error) {
  console.error(`${parsed.error}\n使い方: verify-mutation-receipt.mjs <証跡.json>`
    + ' [--expected-commit <sha>] [--spec <path>] [--runner <path>]');
  process.exit(2);
}
const receiptPath = parsed.rest[0];
if (!receiptPath) {
  console.error('証跡のパスを渡してください');
  process.exit(2);
}
if (!existsSync(receiptPath)) {
  /*
   * ⚠️ 「無い」を通さない。ランナーが強制終了されると証跡は残らないので、
   * ここで通すと**走らなかったこと**が成功に化ける。
   */
  console.error(`★ 証跡が無い: ${receiptPath}`);
  process.exit(1);
}

let r;
try { r = JSON.parse(readFileSync(receiptPath, 'utf8')); }
catch (e) { console.error(`★ 証跡が JSON として読めない: ${e && e.message}`); process.exit(1); }

const problems = [];
const need = (cond, msg) => { if (!cond) problems.push(msg); };

/* ① 完了していること。running / aborted は証拠にしない */
need(r.state === 'complete', `state が complete でない: ${JSON.stringify(r.state)}`);

/* ② 汚れた木で測っていないこと */
need(r.evidenceEligible === true, `evidenceEligible が true でない: ${JSON.stringify(r.evidenceEligible)}`);
need(r.provenance && r.provenance.workingTreeDirty === false,
  `測る前から作業ツリーが汚れている: ${r.provenance && r.provenance.workingTreeDirty}`);
need(r.workspaceUnchanged === true,
  `実行前後で作業ツリーが同じだと言えていない: ${JSON.stringify(r.workspaceUnchanged)}`);

/*
 * ③ 由来の欄が**全部**あること（第26回監査 R26-002）。
 * 前は「あれば見る」だったので、消すだけで検査を外せた。
 */
const prov = r.provenance || {};
const REQUIRED_PROVENANCE = ['sourceCommit', 'sourceTree', 'runnerSha256', 'specSha256',
  'nodeVersion', 'platform', 'timeoutMs', 'workingTreeDirty'];
for (const k of REQUIRED_PROVENANCE) {
  need(prov[k] !== undefined && prov[k] !== null, `provenance.${k} が無い`);
}
need(typeof prov.timeoutMs === 'number' && Number.isInteger(prov.timeoutMs) && prov.timeoutMs > 0,
  `provenance.timeoutMs が正の整数でない: ${JSON.stringify(prov.timeoutMs)}`);
for (const k of ['runnerSha256', 'specSha256']) {
  if (prov[k] !== undefined && prov[k] !== null) {
    need(HEX64.test(String(prov[k])), `provenance.${k} が 64桁の16進でない: ${JSON.stringify(prov[k])}`);
  }
}
/* ⚠️ git のオブジェクトIDは 40 桁（SHA-1）。SHA-256 のリポジトリなら 64 桁 */
for (const k of ['sourceCommit', 'sourceTree']) {
  if (prov[k] !== undefined && prov[k] !== null) {
    need(GITOID.test(String(prov[k])), `provenance.${k} が git のオブジェクトIDの形でない: ${JSON.stringify(prov[k])}`);
  }
}

/*
 * ④ **いま手元にあるファイルから測り直して**照合する（第26回監査 R26-002）。
 * ランナーが名乗った値を、ランナーが作った証跡の中だけで突き合わせても、
 * 突き合わせたことにならない。
 */
function gitOut(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) { return null; }
}
const headCommit = gitOut(['rev-parse', 'HEAD']);
const headTree = gitOut(['rev-parse', 'HEAD^{tree}']);
/*
 * ⚠️ git が使えない場所で「照合できなかった」を成功にしない。
 * 測れないなら、そう言って落とす（第24回 R24-002 と同じ形の穴）。
 */
need(headCommit !== null, 'いまの HEAD を取れない（git が無い？）。照合できないので通さない');
need(headTree !== null, 'いまの HEAD の tree を取れない。照合できないので通さない');
if (headCommit !== null) {
  need(prov.sourceCommit === headCommit,
    `証跡の sourceCommit がいまの HEAD と違う: ${prov.sourceCommit} ≠ ${headCommit}`);
}
if (headTree !== null) {
  need(prov.sourceTree === headTree,
    `証跡の sourceTree がいまの tree と違う: ${prov.sourceTree} ≠ ${headTree}`);
}

const runnerPath = parsed.out['--runner'] || 'scripts/run-mutations.mjs';
const runnerAbs = isAbsolute(runnerPath) ? runnerPath : resolve(ROOT, runnerPath);
if (existsSync(runnerAbs)) {
  need(prov.runnerSha256 === sha256(readFileSync(runnerAbs, 'utf8')),
    `証跡の runnerSha256 が、いまの ${runnerPath} と違う`);
} else {
  problems.push(`ランナーが見つからない: ${runnerPath}`);
}

/* ⑤ 件数が合うこと。合計が total と一致し、素通り・未適用・ランナー失敗が0 */
const results = Array.isArray(r.results) ? r.results : [];
/*
 * 進み具合の欄が、完了と噛み合っていること（第26回監査 R26-003）。
 * 完了しているのに「いま○○を測っている」が残っている証跡は、
 * 走り切っていないものを complete と名乗らせている疑いがある。
 */
need(r.currentMutationId === null || r.currentMutationId === undefined,
  `完了なのに測っている最中の変異が残っている: ${JSON.stringify(r.currentMutationId)}`);
if (results.length) {
  need(r.lastCompletedMutationId === results[results.length - 1].id,
    `最後に終えた変異が、結果の最後と違う: ${JSON.stringify(r.lastCompletedMutationId)}`
    + ` ≠ ${results[results.length - 1].id}`);
}
need(results.length === r.total, `results が ${results.length} 件、total は ${r.total}`);
const by = (o) => results.filter((x) => x.outcome === o).length;
const killed = by('applied_and_killed');
need(killed === r.applied_and_killed, `検知の数が合わない: ${killed} と ${r.applied_and_killed}`);
need(killed + by('applied_but_survived') + by('not_applied') + by('runner_error') === results.length,
  '結果の内訳が全体と合わない（知らない outcome がある）');
need((r.applied_but_survived || 0) === 0, `素通りが ${r.applied_but_survived} 件ある`);
need((r.not_applied || 0) === 0, `当たらなかった変異が ${r.not_applied} 件ある`);
need((r.runner_error || 0) === 0, `ランナー失敗が ${r.runner_error} 件ある`);

/* ⑥ 変異の一覧・数・中身が、いまの正本と一致すること */
const specPath = parsed.out['--spec'] || r.spec || 'test/mutations.json';
const specAbs = isAbsolute(specPath) ? specPath : resolve(ROOT, specPath);
let specById = new Map();
const specIds = new Set();
if (existsSync(specAbs)) {
  const specText = readFileSync(specAbs, 'utf8');
  let spec = null;
  try { spec = JSON.parse(specText); }
  catch (e) { problems.push(`正本が JSON として読めない: ${e && e.message}`); }
  if (spec && Array.isArray(spec.mutations)) {
    for (const m of spec.mutations) { specById.set(m.id, m); specIds.add(m.id); }
    /*
     * 束に分けて走らせた証跡なら、**その束に属する変異だけ**が入っているはず
     *（第26回監査 R26-002 §11）。全体を覆っているかは束をまたいで数え直す
     * （`scripts/verify-mutation-coverage.mjs`）——ここは1枚の中の話に限る。
     */
    let expectedIds = spec.mutations.map((m) => m.id);
    if (r.shard !== undefined && r.shard !== null) {
      const sh = r.shard;
      const okShape = sh && Number.isInteger(sh.index) && Number.isInteger(sh.total)
        && sh.total >= 1 && sh.total <= MAX_SHARDS && sh.index >= 1 && sh.index <= sh.total;
      need(okShape, `束の宣言がおかしい: ${JSON.stringify(sh)}`);
      if (okShape) {
        expectedIds = expectedIds.filter((id) => shardOf(id, sh.total) === sh.index - 1);
      }
    }
    need(expectedIds.length === r.total,
      `この証跡が覆うはずの変異は ${expectedIds.length} 件だが、証跡は ${r.total} 件`);
    const ids = new Set(results.map((x) => x.id));
    const missing = expectedIds.filter((id) => !ids.has(id));
    need(missing.length === 0, `証跡に無い変異がある: ${missing.slice(0, 10).join(' ')}`);
    /* ⚠️ 束の外のIDが混ざっていたら、束の切り分けが壊れている */
    const outside = [...ids].filter((id) => !expectedIds.includes(id));
    need(outside.length === 0, `この束に属さない変異が入っている: ${outside.slice(0, 10).join(' ')}`);
    need(ids.size === results.length, '証跡に同じIDが2度出ている');
    need(prov.specSha256 === sha256(specText),
      '証跡が指す正本のハッシュが、いまの正本と違う');
  }
} else {
  problems.push(`正本が見つからない: ${specPath}`);
}

/* ⑦ 測った先が、期待するコミットであること */
const expected = parsed.out['--expected-commit'];
if (expected) {
  need(prov.sourceCommit === expected,
    `測った commit が違う: ${prov.sourceCommit} ≠ ${expected}`);
}

/*
 * ⑧ 1件ずつ。**いまの正本と結合してから**、宣言・落ち方・終わり方・目印を見る。
 */
const seenTests = new Set();
for (const x of results) {
  const w = (cond, msg) => { if (!cond) problems.push(`${x.id}: ${msg}`); };
  w(x.restored === true, '戻したことになっていない');
  w(!x.restoreError, `戻すときに失敗している（${x.restoreError}）`);

  const m = specById.get(x.id);
  if (specById.size && !m) { w(false, 'いまの正本にこのIDが無い'); continue; }
  if (m) {
    /* 宣言そのものが、いまの正本と同じか（第26回監査 R26-002） */
    w(x.file === m.file, `変異する対象が正本と違う: ${x.file} ≠ ${m.file}`);
    w(x.test === m.test, `対象テストが正本と違う: ${x.test} ≠ ${m.test}`);
    w(x.desc === m.desc, '説明が正本と違う');
    const wantMatches = m.expectMatches === undefined ? 1 : m.expectMatches;
    const ef = m.expectedFailure || {};
    const gf = x.expectedFailure || {};
    w(gf.testName === ef.testName, `宣言したテスト名が正本と違う: ${gf.testName} ≠ ${ef.testName}`);
    w((gf.kind || 'assertion') === (ef.kind || 'assertion'), '宣言した落ち方が正本と違う');
    w(gf.diagnosticMarker === ef.diagnosticMarker,
      `目印が正本と違う: ${gf.diagnosticMarker} ≠ ${ef.diagnosticMarker}`);
    w((gf.why || null) === (ef.why || null), '宣言の理由（why）が正本と違う');
    if (x.outcome === 'applied_and_killed') {
      w(x.expectedMatches === wantMatches,
        `期待一致数が正本と違う: ${x.expectedMatches} ≠ ${wantMatches}`);
    }
  }

  if (x.outcome !== 'applied_and_killed') continue;
  seenTests.add(x.test);

  /* 当たったこと（前後で違い、戻したら元通り） */
  for (const k of ['beforeSha256', 'afterSha256', 'restoredSha256']) {
    w(HEX64.test(String(x[k] || '')), `${k} が 64桁の16進でない: ${JSON.stringify(x[k])}`);
  }
  w(x.beforeSha256 !== x.afterSha256, '変異の前後でファイルが変わっていない（当たっていない疑い）');
  w(x.restoredSha256 === x.beforeSha256, '戻したあとが変異前と違う');
  w(x.changed === true, 'changed が true でない');
  w(x.wrote === true, 'wrote が true でない');
  w(x.actualMatches === x.expectedMatches,
    `一致数が期待と違う: ${x.actualMatches} ≠ ${x.expectedMatches}`);
  w(x.appliedReplacementCount === x.expectedMatches,
    `実際に置き換えた数が期待と違う: ${x.appliedReplacementCount} ≠ ${x.expectedMatches}`);

  /* プロセスの終わり方（第26回監査 R26-002） */
  w(typeof x.exitCode === 'number' && x.exitCode !== 0,
    `終了コードが 0 でないことを示していない: ${JSON.stringify(x.exitCode)}`);
  w(x.timedOut === false, `上限で打ち切られている: ${JSON.stringify(x.timedOut)}`);
  w(x.signal === null || x.signal === undefined, `signal で死んでいる: ${JSON.stringify(x.signal)}`);
  w(x.spawnError === null || x.spawnError === undefined,
    `起動に失敗している: ${JSON.stringify(x.spawnError)}`);

  /* 落ち方（宣言した種類で、宣言したテストが落ちたか） */
  const wantKind = (x.expectedFailure && x.expectedFailure.kind) || 'assertion';
  const wantName = x.expectedFailure && x.expectedFailure.testName;
  w(x.failureKind === (wantKind === 'assertion'
    ? 'expected_assertion_failure' : 'expected_declared_failure'),
  `failureKind が宣言と噛み合っていない: ${x.failureKind}`);
  w(x.expectedFailureKind === wantKind, `expectedFailureKind が宣言と違う: ${x.expectedFailureKind}`);
  w(x.actualFailureKind === wantKind,
    `実際の落ち方が宣言と違う: ${x.actualFailureKind} ≠ ${wantKind}`);
  w(x.expectedFailureMatched === true, '宣言どおりに落ちたことになっていない');
  w(Array.isArray(x.failedTestNames) && x.failedTestNames.includes(wantName),
    `落ちたテストの一覧に宣言したテストが無い: ${JSON.stringify(x.failedTestNames)}`);
  const det = x.expectedFailureDetail || {};
  w(det.name === wantName, `落ちたテストの名前が宣言と違う: ${det.name}`);
  if (wantKind === 'assertion') {
    w(det.code === 'ERR_ASSERTION' && det.errName === 'AssertionError',
      `assertion として落ちたことになっていない（code=${det.code} / name=${det.errName}）`);
    w(det.failureType === 'testCodeFailure' || det.failureType === null,
      `assertion なのに failureType が ${det.failureType}`);
  } else {
    w(det.failureType === wantKind, `failureType が宣言と違う: ${det.failureType}`);
  }

  /*
   * 目印（第26回監査 R26-001）——予約形であること、そして
   * **証跡に残った本文の中に実際に在ること**。
   * ここが第25回の検証器に無かった: `matchedBody` が空でないことしか見ておらず、
   * `"x"` に書き換えても通った。
   */
  const marker = x.expectedFailure && x.expectedFailure.diagnosticMarker;
  if (!MARKER_RE.test(String(marker || ''))) {
    w(false, `目印が予約形（${MARKER_PREFIX}<名前>）でない: ${JSON.stringify(marker)}`);
  } else {
    const key = String(marker).slice(MARKER_PREFIX.length);
    w(!specIds.has(key) || key === x.id, `目印が別の変異のID（${key}）を名乗っている`);
    w(typeof x.matchedBody === 'string' && x.matchedBody.includes(marker),
      '残された本文に目印が無い（どの assertion が落ちたか、証跡から言えない）');
  }
}

/*
 * ⑨ 変異前の対照が、対象テストを全部覆っていること（第26回監査 R26-002）。
 * 「変異前は通っていた」を確かめないまま検知にすると、元から落ちるテストが
 * 全部「検知」に化ける（第22回 R22-004 で実測した形）。
 */
const baselines = Array.isArray(r.baselines) ? r.baselines : [];
const baseByTest = new Map(baselines.map((b) => [b.test, b]));
for (const t of seenTests) {
  const b = baseByTest.get(t);
  if (!b) { problems.push(`変異前の対照が無い対象テストがある: ${t}`); continue; }
  if (b.passed !== true) problems.push(`変異前の対照が通っていない: ${t}`);
  if (!HEX64.test(String(b.stdoutSha256 || ''))) {
    problems.push(`変異前の対照の出力ハッシュが 64桁の16進でない: ${t}`);
  }
}

if (problems.length) {
  console.error(`★ 証跡が証拠として使えません（${problems.length} 件）`);
  for (const p of problems) console.error(`  ・${p}`);
  process.exit(1);
}
console.log(`✅ 証跡は証拠として使えます: ${r.total} 件すべて検知 / state=${r.state}`
  + ` / commit=${prov.sourceCommit} / runner・正本・treeを実測照合`);
