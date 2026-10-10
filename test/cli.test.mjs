/*
 * 提出前の関門の CLI を、子プロセスとして実行して確かめる
 *
 * 第12回監査 R12-004。引数の読み方が緩く、`--today not-a-date` を渡すと
 * 未来日の検査が黙って飛んでいた。知らない指定・二度書き・値なしも
 * 素通りしていた。ここでは**終了コード**で確かめる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts/verify-store-readiness.mjs');

function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

test('知らない指定は終了コード2で止まる', () => {
  const r = run(['--bogus']);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /知らない指定/);
});

test('同じ指定を二度書いたら止まる', () => {
  const r = run(['--today', '2026-08-07', '--today', '2026-08-06']);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /二度/);
});

test('値のない指定は止まる', () => {
  const r = run(['--artifact']);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /値が要ります/);
});

test('日付として読めない --today は止まる（検査を飛ばさない）', () => {
  const r = run(['--today', 'not-a-date']);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /YYYY-MM-DD/);
});

test('存在しない日付の --today も止まる', () => {
  assert.equal(run(['--today', '2026-02-30']).code, 2);
});

test('時間帯として読めない --timezone は止まる', () => {
  const r = run(['--timezone', 'Not/AZone']);
  assert.equal(r.code, 2, r.err);
});

test('日付を渡しても、読めない時刻帯は止まり、実在しない日は倒れずに止まる（R27-111）', () => {
  /*
   * 第27回監査 R27-111。`--today` を渡すと時刻帯の検査（dateIn）が呼ばれず、
   * `--today 2026-10-10 --timezone Not/AZone` が通った。`2026-99-99` は toISOString で倒れていた。
   */
  const r = run(['--today', '2026-10-10', '--timezone', 'Not/AZone']);
  assert.equal(r.code, 2, `GXS_MARK.X29 日付を渡すと読めない時刻帯が通る: ${r.err}`);
  assert.match(r.err, /時間帯として読めません/, `止まった理由が違う: ${r.err}`);
  const bad = run(['--today', '2026-99-99']);
  assert.equal(bad.code, 2, `実在しない日で倒れている（exit ${bad.code}）: ${bad.err.slice(0, 200)}`);
  assert.match(bad.err, /YYYY-MM-DD/, `理由を言わずに倒れている: ${bad.err.slice(0, 200)}`);
  /* 対照: 正しい時刻帯を渡せば、その時刻帯を基準日の表示に出す */
  const ok = run(['--today', '2026-10-10', '--timezone', 'UTC']);
  assert.match(ok.out, /基準日: 2026-10-10（UTC）/, `使った時刻帯を表示していない: ${ok.out.slice(-200)}`);
});

test('読めない申告ファイルは、理由を出して止まる', () => {
  const r = run(['--strict', '--audit-attestation', join(ROOT, 'package.json'), '--audit-report', join(ROOT, 'README.md')]);
  // package.json は JSON として読めるので、ここは「止まらない」ことだけ見る（別の理由で1になる）
  assert.notEqual(r.code, 2, r.err);
  const bad = run(['--strict', '--audit-attestation', join(ROOT, 'README.md')]);
  assert.equal(bad.code, 2, bad.err);
  assert.match(bad.err, /申告が読めません/);
});

test('preflight は、いまの状態では本人確認待ちで1になる', () => {
  const r = run([]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /本人の確認がまだ/);
  assert.match(r.out, /ここが埋まるまで提出しないでください/);
  /* preflight を「最終関門」と読ませない文言が、成功時に出る側にあること */
  assert.match(readFileSync(CLI, 'utf8'), /これは「提出してよい」という意味ではありません（preflight）/);
});

test('strict は、成果物も監査も無いので1になる', () => {
  const r = run(['--strict']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /--artifact が要ります/);
});
