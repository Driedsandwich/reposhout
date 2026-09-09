#!/usr/bin/env node
/*
 * 束に分けて走らせた証跡が、**全部を1回ずつ**覆っているかを数え直す。
 *   第26回監査 R26-002 §11
 *
 * ⚠️ **分けた瞬間に「覆えていない」が起こりうる。**
 * 束を1つ落としても、束の中身が重なっても、走った側の証跡はどれも「完了」に見える。
 * だから読む側が、いまの正本と突き合わせて **どのIDもちょうど1回** を自分で数える。
 * ⚠️ **代表抽出の言い訳にしない。** ここが通るのは、全部の束が揃っているときだけ。
 *
 *   node scripts/verify-mutation-coverage.mjs r1.json r2.json … \
 *     --expected-commit "$GITHUB_SHA"
 *
 * 1枚ずつの中身（落ち方・目印・戻したか）は verify-mutation-receipt.mjs が見る。
 * ここは**束のあいだ**だけを見る。
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shardOf } from './lib/shard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const KNOWN = ['--expected-commit', '--spec'];
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
  return { out, rest };
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.error) {
  console.error(`${parsed.error}\n使い方: verify-mutation-coverage.mjs <証跡.json…>`
    + ' [--expected-commit <sha>] [--spec <path>]');
  process.exit(2);
}
if (!parsed.rest.length) {
  console.error('証跡のパスを1つ以上渡してください');
  process.exit(2);
}

const problems = [];
const need = (cond, msg) => { if (!cond) problems.push(msg); };

/* ① 全部読めること。1枚でも無ければ、覆えたとは言えない */
const receipts = [];
for (const p of parsed.rest) {
  if (!existsSync(p)) { problems.push(`証跡が無い: ${p}`); continue; }
  try { receipts.push({ path: p, r: JSON.parse(readFileSync(p, 'utf8')) }); }
  catch (e) { problems.push(`証跡が JSON として読めない（${p}）: ${e && e.message}`); }
}

/* ② いまの正本を読む */
const specPath = parsed.out['--spec'] || 'test/mutations.json';
const specAbs = isAbsolute(specPath) ? specPath : resolve(ROOT, specPath);
let spec = null, specText = null;
if (!existsSync(specAbs)) problems.push(`正本が見つからない: ${specPath}`);
else {
  specText = readFileSync(specAbs, 'utf8');
  try { spec = JSON.parse(specText); }
  catch (e) { problems.push(`正本が JSON として読めない: ${e && e.message}`); }
}

if (spec && receipts.length) {
  const specIds = spec.mutations.map((m) => m.id);

  /* ③ 束の宣言がそろっていること（数・番号の重複・欠け） */
  const totals = new Set(receipts.map(({ r }) => (r.shard ? r.shard.total : null)));
  need(totals.size === 1, `束の総数が証跡ごとに違う: ${[...totals].join(' / ')}`);
  const total = receipts[0].r.shard ? receipts[0].r.shard.total : null;
  if (total === null) {
    /* 束に分けていないなら、証跡は1枚で全部を覆うはず */
    need(receipts.length === 1, `束に分けていないのに証跡が ${receipts.length} 枚ある`);
  } else {
    need(receipts.length === total,
      `束は ${total} 個のはずだが、証跡は ${receipts.length} 枚しかない`);
    const idx = receipts.map(({ r }) => r.shard.index);
    need(new Set(idx).size === idx.length, `同じ番号の束が2枚ある: ${idx.join(' ')}`);
    const missingShards = [];
    for (let i = 1; i <= total; i++) if (!idx.includes(i)) missingShards.push(i);
    need(missingShards.length === 0, `走っていない束がある: ${missingShards.join(' ')}`);
  }

  /* ④ どの証跡も、証拠として使える形であること（1枚ずつの中身は別の器が見る） */
  for (const { path, r } of receipts) {
    need(r.state === 'complete', `${path}: state が complete でない（${r.state}）`);
    need(r.evidenceEligible === true, `${path}: evidenceEligible が true でない`);
    need(r.provenance && r.provenance.workingTreeDirty === false,
      `${path}: 汚れた木で測っている`);
  }

  /* ⑤ 由来が全部そろって同じであること（違う版の寄せ集めを通さない） */
  for (const k of ['sourceCommit', 'sourceTree', 'runnerSha256', 'specSha256']) {
    const vals = new Set(receipts.map(({ r }) => (r.provenance || {})[k]));
    const one = [...vals][0];
    need(vals.size === 1 && one !== undefined && one !== null,
      `${k} が証跡ごとに違うか、欠けている（別々の版を寄せ集めている）: ${[...vals].join(' / ')}`);
  }
  if (specText !== null) {
    for (const { path, r } of receipts) {
      need((r.provenance || {}).specSha256 === sha256(specText),
        `${path}: 測ったときの正本が、いまの正本と違う`);
    }
  }
  const expected = parsed.out['--expected-commit'];
  if (expected) {
    for (const { path, r } of receipts) {
      need((r.provenance || {}).sourceCommit === expected,
        `${path}: 測った commit が違う（${(r.provenance || {}).sourceCommit}）`);
    }
  }

  /*
   * ⑥ **どのIDもちょうど1回**。ここが本題。
   * 走った側が何と言おうと、こちらで数える。
   */
  const seen = new Map();
  for (const { path, r } of receipts) {
    for (const x of (r.results || [])) {
      if (!seen.has(x.id)) seen.set(x.id, []);
      seen.get(x.id).push(path);
    }
  }
  const missing = specIds.filter((id) => !seen.has(id));
  need(missing.length === 0, `一度も測っていない変異がある: ${missing.slice(0, 20).join(' ')}`);
  const twice = [...seen.entries()].filter(([, ps]) => ps.length > 1);
  need(twice.length === 0,
    `2回以上測った変異がある: ${twice.slice(0, 10).map(([id, ps]) => `${id}(${ps.length})`).join(' ')}`);
  const unknown = [...seen.keys()].filter((id) => !specIds.includes(id));
  need(unknown.length === 0, `正本に無い変異が測られている: ${unknown.slice(0, 10).join(' ')}`);

  /* ⑦ 束に入るべき先が、実際の束と合っていること */
  if (total !== null) {
    const wrong = [];
    for (const { r } of receipts) {
      for (const x of (r.results || [])) {
        if (shardOf(x.id, total) !== r.shard.index - 1) wrong.push(`${x.id}→${r.shard.index}`);
      }
    }
    need(wrong.length === 0, `違う束で測られた変異がある: ${wrong.slice(0, 10).join(' ')}`);
  }

  /* ⑧ 合計が正本の件数と合うこと */
  const sum = receipts.reduce((a, { r }) => a + (r.total || 0), 0);
  need(sum === specIds.length, `束の合計が ${sum} 件、正本は ${specIds.length} 件`);
}

if (problems.length) {
  console.error(`★ 束が全体を覆えていません（${problems.length} 件）`);
  for (const p of problems) console.error(`  ・${p}`);
  process.exit(1);
}
console.log(`✅ ${receipts.length} 枚の証跡が、正本 ${spec.mutations.length} 件をちょうど1回ずつ覆っています`);
