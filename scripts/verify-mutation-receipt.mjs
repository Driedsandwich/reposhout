#!/usr/bin/env node
/*
 * 変異対照の証跡が、証拠として使える形かを**外から**確かめる（第25回監査 R25-003）。
 *
 * ⚠️ ランナー自身の終了コードだけを信じない。ランナーが途中で強制終了されると
 * 証跡は「走っている」ままか、そもそも残らない。**証跡を読む側**が、
 * 完了していること・測った対象がコミットと一致していること・
 * 汚れた木で測っていないことを、独立に判定する。
 *
 *   node scripts/verify-mutation-receipt.mjs mutation-receipt.json \
 *     --expected-commit "$GITHUB_SHA"
 *
 * 問題があれば1行ずつ出して exit 1。何も無ければ exit 0。
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const KNOWN = ['--expected-commit', '--spec'];
function parseArgs(argv) {
  const out = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    if (!KNOWN.includes(a)) return { error: `知らない引数: ${a}` };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) return { error: `${a} に値が無い` };
    out[a] = v; i++;
  }
  return { out, rest };
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.error) {
  console.error(`${parsed.error}\n使い方: verify-mutation-receipt.mjs <証跡.json> [--expected-commit <sha>] [--spec <path>]`);
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

/* ③ 件数が合うこと。合計が total と一致し、素通り・未適用・ランナー失敗が0 */
const results = Array.isArray(r.results) ? r.results : [];
need(results.length === r.total, `results が ${results.length} 件、total は ${r.total}`);
const by = (o) => results.filter((x) => x.outcome === o).length;
const killed = by('applied_and_killed');
need(killed === r.applied_and_killed, `検知の数が合わない: ${killed} と ${r.applied_and_killed}`);
need(killed + by('applied_but_survived') + by('not_applied') + by('runner_error') === results.length,
  '結果の内訳が全体と合わない（知らない outcome がある）');
need((r.applied_but_survived || 0) === 0, `素通りが ${r.applied_but_survived} 件ある`);
need((r.not_applied || 0) === 0, `当たらなかった変異が ${r.not_applied} 件ある`);
need((r.runner_error || 0) === 0, `ランナー失敗が ${r.runner_error} 件ある`);

/* ④ 変異の一覧と数が、いまの正本と一致すること */
const specPath = parsed.out['--spec'] || r.spec || 'test/mutations.json';
const specAbs = isAbsolute(specPath) ? specPath : resolve(ROOT, specPath);
if (existsSync(specAbs)) {
  const specText = readFileSync(specAbs, 'utf8');
  const spec = JSON.parse(specText);
  need(spec.mutations.length === r.total,
    `正本は ${spec.mutations.length} 件だが、証跡は ${r.total} 件`);
  const ids = new Set(results.map((x) => x.id));
  const missing = spec.mutations.map((m) => m.id).filter((id) => !ids.has(id));
  need(missing.length === 0, `証跡に無い変異がある: ${missing.slice(0, 10).join(' ')}`);
  need(ids.size === results.length, '証跡に同じIDが2度出ている');
  if (r.provenance && r.provenance.specSha256) {
    need(r.provenance.specSha256 === sha256(specText),
      '証跡が指す正本のハッシュが、いまの正本と違う');
  }
} else {
  problems.push(`正本が見つからない: ${specPath}`);
}

/* ⑤ 測った先が、期待するコミットであること */
const expected = parsed.out['--expected-commit'];
if (expected) {
  need(r.provenance && r.provenance.sourceCommit === expected,
    `測った commit が違う: ${r.provenance && r.provenance.sourceCommit} ≠ ${expected}`);
}

/* ⑥ 1件ずつ: 当たったこと・戻したこと・宣言どおり落ちたこと */
for (const x of results) {
  const w = (cond, msg) => { if (!cond) problems.push(`${x.id}: ${msg}`); };
  w(x.restored === true, '戻したことになっていない');
  w(!x.restoreError, `戻すときに失敗している（${x.restoreError}）`);
  if (x.outcome === 'applied_and_killed') {
    w(x.beforeSha256 && x.afterSha256 && x.beforeSha256 !== x.afterSha256,
      '変異の前後でファイルが変わっていない（当たっていない疑い）');
    w(x.restoredSha256 === x.beforeSha256, '戻したあとが変異前と違う');
    w(x.expectedFailureMatched === true, '宣言どおりに落ちたことになっていない');
    w(typeof x.matchedBody === 'string' && x.matchedBody.length > 0,
      '落ちた本文が残っていない（どの assertion が落ちたか言えない）');
  }
}

if (problems.length) {
  console.error(`★ 証跡が証拠として使えません（${problems.length} 件）`);
  for (const p of problems) console.error(`  ・${p}`);
  process.exit(1);
}
console.log(`✅ 証跡は証拠として使えます: ${r.total} 件すべて検知 / state=${r.state} / commit=${r.provenance.sourceCommit}`);
