#!/usr/bin/env node
/*
 * 変異対照ランナー（第21回監査 R21-004）
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
 * そこでこのランナーは、結果を**4つに分けて**必ず区別する:
 *
 *   applied_and_killed    変異が当たり、テストが落ちた（＝検査が効いている）
 *   applied_but_survived  変異が当たったのに、テストが通った（＝検査の穴）
 *   not_applied           変異が当たらなかった（＝**結果は何も言えない**）
 *   runner_error          ランナー側の失敗（復旧できたかも記録する）
 *
 * `not_applied` を `survived` として数えない。当たったことは
 * **一致数とファイルのハッシュ**で証明する（前後で必ず変わること）。
 *
 * 使い方:
 *   npm run test:mutations                 全部
 *   npm run test:mutations -- --id M03     1件だけ
 *   npm run test:mutations -- --receipt out.json   証跡をJSONで残す
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (s) => createHash('sha256').update(s).digest('hex');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const onlyId = argOf('--id');
const receiptPath = argOf('--receipt');
const specPath = argOf('--spec') || 'test/mutations.json';

/* --spec は絶対パスでも渡せるようにする（対照用の定義を repo の外へ置けるため） */
const specFile = isAbsolute(specPath) ? specPath : join(ROOT, specPath);
const spec = JSON.parse(readFileSync(specFile, 'utf8'));
const mutations = spec.mutations.filter((m) => !onlyId || m.id === onlyId);
if (!mutations.length) {
  console.error(`変異が1件も選ばれていない（--id ${onlyId}）`);
  process.exit(2);
}

/* 対象ファイルを読み、期待した回数だけ現れることを確かめてから置換する */
function applyMutation(m) {
  const path = join(ROOT, m.file);
  const before = readFileSync(path, 'utf8');
  const parts = before.split(m.find);
  const actualMatches = parts.length - 1;
  const expected = m.expectMatches === undefined ? 1 : m.expectMatches;

  if (actualMatches !== expected) {
    return { applied: false, before, actualMatches, expected,
      why: `一致数が期待と違う（期待 ${expected} / 実際 ${actualMatches}）` };
  }
  const after = before.replace(m.find, m.replace);
  if (after === before) {
    return { applied: false, before, actualMatches, expected,
      why: '置換しても中身が変わらなかった' };
  }
  writeFileSync(path, after);
  const readBack = readFileSync(path, 'utf8');
  if (readBack !== after) {
    return { applied: false, before, actualMatches, expected,
      why: '書き込んだ内容が読み戻せない' };
  }
  return { applied: true, before, after, actualMatches, expected };
}

function restore(m, before) {
  const path = join(ROOT, m.file);
  writeFileSync(path, before);
  return readFileSync(path, 'utf8') === before;
}

const results = [];
for (const m of mutations) {
  const path = join(ROOT, m.file);
  let r;
  try {
    r = applyMutation(m);
  } catch (e) {
    results.push({ id: m.id, outcome: 'runner_error', file: m.file, desc: m.desc,
      error: String(e && e.message), restored: 'unknown' });
    continue;
  }

  if (!r.applied) {
    /* ★ ここを survived と数えない。結果は「何も言えない」 */
    results.push({ id: m.id, outcome: 'not_applied', file: m.file, desc: m.desc,
      why: r.why, expectedMatches: r.expected, actualMatches: r.actualMatches,
      beforeSha256: sha(r.before), restored: true });
    continue;
  }

  let killed = null, exitCode = null;
  try {
    execFileSync(process.execPath, ['--test', m.test], { cwd: ROOT, stdio: 'pipe', timeout: 300000 });
    killed = false; exitCode = 0;
  } catch (e) {
    killed = true; exitCode = typeof e.status === 'number' ? e.status : -1;
  }
  const restored = restore(m, r.before);

  results.push({
    id: m.id, outcome: killed ? 'applied_and_killed' : 'applied_but_survived',
    file: m.file, desc: m.desc, test: m.test,
    expectedMatches: r.expected, actualMatches: r.actualMatches,
    beforeSha256: sha(r.before), afterSha256: sha(r.after),
    changed: sha(r.before) !== sha(r.after),
    exitCode, restored, restoredSha256: sha(readFileSync(path, 'utf8'))
  });
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
if (badRestore.length) console.log('★ 復旧できなかったファイルがある:\n  ' + badRestore.map((r) => r.file).join('\n  '));

if (receiptPath) {
  writeFileSync(receiptPath, JSON.stringify({
    spec: specPath, total: results.length,
    applied_and_killed: killed.length, applied_but_survived: survived.length,
    not_applied: notApplied.length, runner_error: errors.length,
    results
  }, null, 2) + '\n');
  console.log(`証跡: ${receiptPath}`);
}

/* 落ちたもの以外が1つでもあれば失敗にする（当たらなかったのも失敗） */
const ok = survived.length === 0 && notApplied.length === 0
  && errors.length === 0 && badRestore.length === 0;
process.exit(ok ? 0 : 1);
