/*
 * release-status.mjs — 「いまどこまで出したか」を実物から作って表示する
 *
 * 実行: npm run release:status
 *
 * RELEASE_STATUS.md は確定した版だけを書いた文書で、書いた時点で古くなる。
 * 作業中の版がどこまで進んだかは、この出力（git と gh の実測）で見ること。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }).trim() };
  } catch (e) {
    return { ok: false, out: '' };
  }
}

const version = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')).version;
const tag = `v${version}`;

const head = run('git', ['rev-parse', 'HEAD']);
const tree = run('git', ['rev-parse', 'HEAD^{tree}']);
const dirty = run('git', ['status', '--porcelain']);
const tags = run('git', ['tag', '-l', 'v*']);
const remoteTags = run('git', ['ls-remote', '--tags', 'origin']);
const onMain = run('git', ['branch', '--contains', 'HEAD']);

const tagList = tags.ok ? tags.out.split('\n').filter(Boolean) : [];
const tagged = tagList.includes(tag);
const tagTarget = tagged ? run('git', ['rev-parse', `${tag}^{}`]).out : null;

const remoteHasTag = remoteTags.ok && remoteTags.out.includes(`refs/tags/${tag}`);
const merged = onMain.ok && /(^|\n)\*?\s*main$/m.test(onMain.out);

const releases = run('gh', ['release', 'list', '--limit', '50']);

const say = (label, value) => console.log(`  ${label.padEnd(28)} ${value}`);

console.log(`RepoShout ${version} — いまの状態（実測）\n`);
say('HEAD', head.ok ? head.out : '(git が使えない)');
say('tree', tree.ok ? tree.out : '(git が使えない)');
say('未コミットの変更', dirty.ok ? (dirty.out ? `あり（${dirty.out.split('\n').length} 件）` : 'なし') : '(不明)');
say('main に入っているか', onMain.ok ? (merged ? 'はい' : 'いいえ') : '(不明)');
say(`タグ ${tag}`, tagged ? `あり → ${tagTarget}` : 'まだ無い');
say('リモートのタグ', remoteTags.ok ? (remoteHasTag ? 'あり' : 'まだ無い') : '(取得できない)');
say('GitHub Release', releases.ok ? (releases.out ? releases.out.split('\n').length + ' 本' : '無し') : '(gh が使えない)');
say('ストアで公開中', '1.0.1（ここは自動で確かめられない。RELEASE_STATUS.md の手順を見る）');

console.log();
if (tagged && tagTarget !== head.out) {
  console.log(`⚠️ タグ ${tag} は ${tagTarget} を指していて、いまの HEAD とは違います`);
}
if (!merged) {
  console.log('この版はまだ main に入っていません。提出候補のZIPは作れません');
} else if (!tagged) {
  console.log('main には入っていますが、タグはまだです');
} else {
  console.log(`確定済み。RELEASE_STATUS.md の表に ${version} の行があるか確かめてください`);
}
