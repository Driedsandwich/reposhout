#!/usr/bin/env node
/*
 * 変異対照ランナー（第21回監査 R21-004 で新設／第22回監査 R22-004 で fail-closed 化）
 *
 * 「その検査は、落ちるべきときに落ちるか」を1件ずつ確かめる。
 *
 * ⚠️ **このランナーが在る理由**
 * 第20回の作業中、面を1件ずつ落とす変異15件が **全件「素通り」と表示された**。
 * 調べると、置換に使う正規表現のエスケープを誤っていて、**変異が一度も
 * 適用されていなかった**。手で1件外すとテストは正しく落ちた。
 *
 *   **当たらなかった変異と、素通りした変異は、出力の見た目が同じ。**
 *
 * しかも変異は「検査を強くするために」回すので、素通りと出ると検査のほうを
 * 直しに行く——存在しない穴を埋めるために、余計な検査を足す方向へ走る。
 *
 * ⚠️ **第22回監査 R22-004 で見つかった、その裏返し**
 * 「テストの終了コードが 0 でなければ検知」としていたので、**変異と関係なく
 * 失敗するものが全部「検知」に化けていた**:
 *
 *   ・もともと落ちるテストを指していた       → 検知（実際は何も測っていない）
 *   ・存在しないテストファイルを指していた   → 検知（node が起動できずに 1）
 *   ・終わらないテストを指していた           → 検知（cancelled で 1）
 *
 * 変異の効果を「落ちた」と読めるのは、**同じテストが変異前に通っていたとき
 * だけ**。そこで変異を当てる前に対象テストを1度素で走らせ、通らなければ
 * `runner_error` にする（検知として数えない）。
 *
 * 結果は**4つに分けて**必ず区別する:
 *
 *   applied_and_killed    変異が当たり、テストが落ちた（＝検査が効いている）
 *   applied_but_survived  変異が当たったのに、テストが通った（＝検査の穴）
 *   not_applied           変異が当たらなかった（＝**結果は何も言えない**）
 *   runner_error          ランナー側／前提の失敗（＝**結果は何も言えない**）
 *
 * `not_applied` も `runner_error` も `survived` や `killed` へ寄せない。
 * 当たったことは**一致数とファイルのハッシュ**で証明する（前後で必ず変わること）。
 *
 * 使い方:
 *   npm run test:mutations                          全部
 *   npm run test:mutations -- --id M03              1件だけ
 *   npm run test:mutations -- --receipt out.json    証跡をJSONで残す
 *   npm run test:mutations -- --timeout 5000        1件あたりの上限（既定 300000ms）
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute, resolve, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_FILE = fileURLToPath(import.meta.url);
const sha = (s) => createHash('sha256').update(s).digest('hex');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const onlyId = argOf('--id');
const receiptPath = argOf('--receipt');
const specPath = argOf('--spec') || 'test/mutations.json';
const timeoutMs = Number(argOf('--timeout') || 300000);

/* --spec は絶対パスでも渡せるようにする（対照用の定義を repo の外へ置けるため） */
const specFile = isAbsolute(specPath) ? specPath : join(ROOT, specPath);
const specText = readFileSync(specFile, 'utf8');
const spec = JSON.parse(specText);
const mutations = spec.mutations.filter((m) => !onlyId || m.id === onlyId);
if (!mutations.length) {
  console.error(`変異が1件も選ばれていない（--id ${onlyId}）`);
  process.exit(2);
}

const startedAt = new Date().toISOString();

/* 由来（第22回監査 R22-004 §8.6）。証跡だけ見て、何を測ったか辿れるようにする */
function gitOut(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return null;
  }
}
const gitStatus = gitOut(['status', '--porcelain']);
const provenance = {
  sourceCommit: gitOut(['rev-parse', 'HEAD']),
  sourceTree: gitOut(['rev-parse', 'HEAD^{tree}']),
  /* 未コミットの変更があるまま測ったのかどうか。null は git が使えなかったとき */
  workingTreeDirty: gitStatus === null ? null : gitStatus !== '',
  runnerSha256: sha(readFileSync(RUNNER_FILE, 'utf8')),
  specSha256: sha(specText),
  nodeVersion: process.version,
  platform: process.platform,
  timeoutMs
};

/*
 * 対象テストが「測れる状態にあるか」を先に確かめる（第22回監査 R22-004 §8.4）。
 * リポジトリの中の、実在する通常ファイルであること。
 */
function checkTargetPath(rel) {
  if (typeof rel !== 'string' || !rel) return '対象テストが指定されていない';
  const abs = resolve(ROOT, rel);
  const inside = relative(ROOT, abs);
  if (inside.startsWith('..') || isAbsolute(inside)) return `対象テストがリポジトリの外を指している: ${rel}`;
  if (!existsSync(abs)) return `対象テストのファイルが無い: ${rel}`;
  if (!statSync(abs).isFile()) return `対象テストが通常ファイルでない: ${rel}`;
  return null;
}

/*
 * ⚠️ **テストを起動する環境を、必ず素にする。**（第22回監査 R22-004 の作業中に発見）
 *
 * `node --test` は、自分が別の test runner の子だと判断すると（`NODE_TEST_CONTEXT`）
 * 結果を親へ送る形に切り替え、**失敗しても終了コード 0 で終わる**。
 * このランナーを `node --test` の中から起動すると——まさに自己検査がそうする——
 * その変数が孫へ伝わり、**すべての変異が「素通り」に化ける**。
 * 落ちるはずのテストが 0 で返ってくるので、区別する術が無い。
 *
 * 判定の根拠を環境変数に握らせない。呼ばれ方によらず同じ意味になるよう剥がす。
 */
const CHILD_ENV = (() => {
  const e = { ...process.env };
  delete e.NODE_TEST_CONTEXT;
  delete e.NODE_OPTIONS;
  return e;
})();

/* テストを1回走らせ、プロセスの終わり方まで記録する（第22回監査 R22-004 §8.3） */
function runTest(rel) {
  const out = { exitCode: null, signal: null, timedOut: false, spawnError: null,
    stdoutSha256: null, stderrSha256: null };
  try {
    const stdout = execFileSync(process.execPath, ['--test', rel],
      { cwd: ROOT, stdio: 'pipe', timeout: timeoutMs, encoding: 'utf8', env: CHILD_ENV });
    out.exitCode = 0;
    out.stdoutSha256 = sha(stdout || '');
    out.stderrSha256 = sha('');
    out.passed = true;
    return out;
  } catch (e) {
    out.exitCode = typeof e.status === 'number' ? e.status : null;
    out.signal = e.signal || null;
    /*
     * 上限で打ち切ったことを、ふつうの失敗と混ぜない。
     * ⚠️ **`killed` や `signal` では見分けられない。** Node 22 で実測すると、
     * `execFileSync` の timeout で打ち切ったとき
     *   status=1 / signal=null / killed=undefined / code='ETIMEDOUT'
     * になる（テストランナーが SIGTERM を受けて自分で 1 を返すため）。
     * `killed === true` だけを見ていた版は、**終わらないテストを
     * 「ふつうに落ちた」と読んでいた**——変異対照がそれを見つけた。
     */
    out.timedOut = e.code === 'ETIMEDOUT' || e.killed === true || e.signal === 'SIGTERM';
    if (e.code && e.code !== 'ETIMEDOUT' && typeof e.status !== 'number') {
      out.spawnError = String(e.code);
    }
    out.stdoutSha256 = sha(String(e.stdout || ''));
    out.stderrSha256 = sha(String(e.stderr || ''));
    out.passed = false;
    return out;
  }
}

/*
 * 変異前の対照。同じ対象テストは1回だけ走らせて覚える。
 * ⚠️ 覚えてよいのは「毎回きちんと元へ戻せている」あいだだけ。
 *    戻せなかった時点で覚えを捨てる（後続が古い前提で走らないように）。
 */
const baselineCache = new Map();
function baselineFor(rel) {
  if (!baselineCache.has(rel)) baselineCache.set(rel, runTest(rel));
  return baselineCache.get(rel);
}

/* 対象ファイルを読み、期待した回数だけ現れることを確かめてから**全部**置換する */
function applyMutation(m) {
  const path = join(ROOT, m.file);
  const before = readFileSync(path, 'utf8');
  const parts = before.split(m.find);
  const actualMatches = parts.length - 1;
  const expected = m.expectMatches === undefined ? 1 : m.expectMatches;

  if (actualMatches !== expected) {
    return { applied: false, before, actualMatches, expected, replacements: 0,
      why: `一致数が期待と違う（期待 ${expected} / 実際 ${actualMatches}）` };
  }
  /*
   * ⚠️ `String.prototype.replace` に文字列を渡すと**最初の1個しか置換しない**
   * （第22回監査 R22-004 §8.5）。`expectMatches: 2` と書いても1個だけ変えていた
   * ので、「2箇所とも検査されている」ことの対照になっていなかった。
   * split/join で**期待した数だけ**置き換え、実際に置き換えた数を記録する。
   */
  const after = parts.join(m.replace);
  const replacements = actualMatches;
  if (after === before) {
    return { applied: false, before, actualMatches, expected, replacements: 0,
      why: '置換しても中身が変わらなかった' };
  }
  writeFileSync(path, after);
  const readBack = readFileSync(path, 'utf8');
  if (readBack !== after) {
    return { applied: false, before, actualMatches, expected, replacements: 0,
      why: '書き込んだ内容が読み戻せない' };
  }
  return { applied: true, before, after, actualMatches, expected, replacements };
}

function restore(m, before) {
  const path = join(ROOT, m.file);
  writeFileSync(path, before);
  return readFileSync(path, 'utf8') === before;
}

const results = [];
for (const m of mutations) {
  const path = join(ROOT, m.file);
  const base = { id: m.id, file: m.file, desc: m.desc, test: m.test };

  /* ① 対象テストが測れる状態にあるか */
  const pathProblem = checkTargetPath(m.test);
  if (pathProblem) {
    results.push({ ...base, outcome: 'runner_error', error: pathProblem, restored: true });
    continue;
  }

  /* ② 変異前に、その対象テストが素で通ること */
  const bl = baselineFor(m.test);
  if (!bl.passed) {
    results.push({ ...base, outcome: 'runner_error',
      error: bl.timedOut ? `対象テストが ${timeoutMs}ms で終わらない（変異前）`
        : bl.spawnError ? `対象テストを起動できない（${bl.spawnError}）`
          : bl.signal ? `対象テストが signal ${bl.signal} で落ちた（変異前）`
            : `対象テストが変異前から落ちている（exit ${bl.exitCode}）`,
      baseline: bl, restored: true });
    continue;
  }

  /* ③ 変異を当てる */
  let r;
  try {
    r = applyMutation(m);
  } catch (e) {
    results.push({ ...base, outcome: 'runner_error',
      error: String(e && e.message), restored: 'unknown' });
    continue;
  }
  if (!r.applied) {
    /* ★ ここを survived と数えない。結果は「何も言えない」 */
    results.push({ ...base, outcome: 'not_applied', why: r.why,
      expectedMatches: r.expected, actualMatches: r.actualMatches,
      beforeSha256: sha(r.before), restored: true });
    continue;
  }

  /* ④ 変異後に走らせ、必ず元へ戻す */
  const run = runTest(m.test);
  const restored = restore(m, r.before);
  if (!restored) baselineCache.clear();          // 前提が崩れたので覚えを捨てる
  const restoredSha256 = sha(readFileSync(path, 'utf8'));

  const common = {
    ...base,
    expectedMatches: r.expected, actualMatches: r.actualMatches,
    appliedReplacementCount: r.replacements,
    beforeSha256: sha(r.before), afterSha256: sha(r.after),
    changed: sha(r.before) !== sha(r.after),
    baseline: { exitCode: bl.exitCode, stdoutSha256: bl.stdoutSha256 },
    exitCode: run.exitCode, signal: run.signal, timedOut: run.timedOut,
    spawnError: run.spawnError, stdoutSha256: run.stdoutSha256, stderrSha256: run.stderrSha256,
    restored, restoredSha256
  };

  if (!restored) {
    results.push({ ...common, outcome: 'runner_error', error: '変異したファイルを元へ戻せなかった' });
    continue;
  }
  /*
   * ⚠️ 変異後に**上限で終わらない／signal で死ぬ／起動できない**のは、
   *    「検査が落とした」ではない。検知として数えない。
   */
  if (run.timedOut || run.spawnError || (run.signal && run.exitCode === null)) {
    results.push({ ...common, outcome: 'runner_error',
      error: run.timedOut ? `変異後に ${timeoutMs}ms で終わらない`
        : run.spawnError ? `変異後にテストを起動できない（${run.spawnError}）`
          : `変異後に signal ${run.signal} で死んだ` });
    continue;
  }
  results.push({ ...common, outcome: run.passed ? 'applied_but_survived' : 'applied_and_killed' });
}

const by = (o) => results.filter((r) => r.outcome === o);
const killed = by('applied_and_killed'), survived = by('applied_but_survived');
const notApplied = by('not_applied'), errors = by('runner_error');
const badRestore = results.filter((r) => r.restored !== true);

for (const r of results) {
  const mark = { applied_and_killed: '  OK 落ちた       ', applied_but_survived: '★ 素通り         ',
    not_applied: '★ 変異が当たらない', runner_error: '★ ランナー失敗   ' }[r.outcome];
  console.log(`${r.id.padEnd(5)} ${mark} ${String(r.file).padEnd(34)} ${r.desc}`);
  if (r.outcome === 'not_applied') console.log(`        理由: ${r.why}`);
  if (r.outcome === 'runner_error') console.log(`        ${r.error}`);
}

console.log();
console.log(`変異 ${results.length} 件: 落ちた ${killed.length} / 素通り ${survived.length}`
  + ` / 当たらなかった ${notApplied.length} / ランナー失敗 ${errors.length}`);
if (survived.length) console.log('★ 素通り（検査の穴）:\n  ' + survived.map((r) => `${r.id} ${r.desc}`).join('\n  '));
if (notApplied.length) console.log('★ 当たらなかった（結果は何も言えない）:\n  ' + notApplied.map((r) => `${r.id} ${r.why}`).join('\n  '));
if (errors.length) console.log('★ ランナー失敗（結果は何も言えない）:\n  ' + errors.map((r) => `${r.id} ${r.error}`).join('\n  '));
if (badRestore.length) console.log('★ 復旧できなかったファイルがある:\n  ' + badRestore.map((r) => r.file).join('\n  '));

const summary = {
  spec: specPath, total: results.length,
  applied_and_killed: killed.length, applied_but_survived: survived.length,
  not_applied: notApplied.length, runner_error: errors.length,
  provenance: { ...provenance, startedAt, completedAt: new Date().toISOString() },
  baselines: [...baselineCache.entries()].map(([test, b]) => ({
    test, passed: b.passed, exitCode: b.exitCode, stdoutSha256: b.stdoutSha256
  })),
  results
};

if (receiptPath) {
  /*
   * 証跡が書けないまま「全部通った」と終わらせない（第22回監査 R22-004）。
   * CI 側も `if-no-files-found: error` にしてあり、両側で落ちる。
   */
  try {
    writeFileSync(receiptPath, JSON.stringify(summary, null, 2) + '\n');
    console.log(`証跡: ${receiptPath}`);
  } catch (e) {
    console.error(`★ 証跡を書けなかった: ${receiptPath}\n  ${e && e.message}`);
    process.exit(2);
  }
}

/* 落ちたもの以外が1つでもあれば失敗にする（当たらなかったのも、ランナー失敗も） */
const ok = survived.length === 0 && notApplied.length === 0
  && errors.length === 0 && badRestore.length === 0;
process.exit(ok ? 0 : 1);
