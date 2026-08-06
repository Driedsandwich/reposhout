/*
 * 公開状態の記述を、git の実物と突き合わせる
 *
 * 実行: node --test test/release-status.test.mjs（npm test に含まれる）
 *
 * 3回続けて同じ失敗をした（1.1.3・1.1.4・1.1.5）。どれも「作業ツリーのみ」と書いたまま
 * マージしてタグまで打ち、文書が古いまま残った。1.1.4 で入れた検査は
 * 「未リリース」「作業ツリーにあるだけ」という**言い回しの一覧**で見張る方式だったので、
 * 1.1.5 が「作業ツリーのみ」と書いた瞬間に素通りした（第7回監査 R7-003）。
 *
 * 言い回しを増やしても同じことが起きる。方式を変える。
 *
 *   ① 確定した版だけを表に書く。その値を git と突き合わせる
 *   ② 作業中の版は状態を書かない（書いてあったら落とす）
 *   ③ git が使えない・タグが無いなら、黙って通さずその旨を出して落とす
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './helpers/load.mjs';

const read = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const version = JSON.parse(read('manifest.json')).version;
const doc = read('RELEASE_STATUS.md');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

/* 表の「確定した版」を読む。| 1.1.4 | `0be7aaf…` | `v1.1.4` | … | */
function settledRows() {
  const out = [];
  for (const line of doc.split('\n')) {
    const m = /^\|\s*(\d+\.\d+\.\d+)\s*\|\s*`([0-9a-f]{40})`\s*\|\s*`(v[\d.]+)`\s*\|/.exec(line);
    if (m) out.push({ version: m[1], commit: m[2], tag: m[3] });
  }
  return out;
}

test('git が使える（使えなければ、この検査は何も確かめていない）', () => {
  const head = git(['rev-parse', 'HEAD']);
  assert.match(head, /^[0-9a-f]{40}$/, `HEAD が読めない: ${head}`);
});

test('確定した版の表が、git の実物と一致する', () => {
  const rows = settledRows();
  assert.ok(rows.length >= 5, `確定した版の行が少なすぎる: ${rows.length}`);

  const tags = new Set(git(['tag', '-l', 'v*']).split('\n').filter(Boolean));
  assert.ok(tags.size > 0,
    'タグが1本も見えない。このチェックアウトでは表を検証できないので落とす（黙って通さない）');

  for (const row of rows) {
    assert.equal(row.tag, `v${row.version}`, `タグ名が版と揃っていない: ${row.version}`);
    assert.ok(tags.has(row.tag), `表にあるタグが実在しない: ${row.tag}`);
    const target = git(['rev-parse', `${row.tag}^{}`]);
    assert.equal(target, row.commit,
      `${row.tag} の指す先が表と違う: git=${target} 表=${row.commit}`);
    /*
     * そのコミットが本当に main にあること。
     * `git branch --contains` はローカルのブランチしか見ないので、PRの浅い
     * チェックアウト（detached HEAD・ローカルに main が無い）では答えられない。
     * リモート追跡ブランチも含めて見る。それでも見えないなら、環境が浅いだけなのか
     * 本当に main に無いのか区別できないので、区別できないと言って落とす。
     */
    const branches = git(['branch', '-a', '--contains', row.commit]);
    const onMain = /(^|\n)\s*\*?\s*(remotes\/origin\/)?main\s*$/m.test(branches);
    const shallow = git(['rev-parse', '--is-shallow-repository']) === 'true';
    assert.ok(onMain,
      shallow
        ? `浅いチェックアウトなので ${row.tag} が main にあるか確かめられない（git fetch --unshallow が要る）`
        : `${row.tag} のコミットが main に無い: ${row.commit}`);
  }
});

/*
 * 作業中の版（＝表に無い版）については、状態を書かない。
 * 「まだ」「作業ツリー」と書いた瞬間に、それは次のマージで古くなる。
 */
test('作業中の版の状態を、表へ書いていない', () => {
  const rows = settledRows();
  const settled = new Set(rows.map((r) => r.version));
  if (settled.has(version)) return;   // すでに確定している版なら、この検査は対象外

  for (const line of doc.split('\n')) {
    if (!line.startsWith('|')) continue;
    assert.ok(!line.includes(version),
      `作業中の版 ${version} の行が表にある。状態は書かず、実測コマンドを指すこと: ${line.trim()}`);
  }
  assert.ok(doc.includes('npm run release:status'),
    '作業中の版を実測する手段が書いていない');
});

test('確定した版と、その時点の CHANGELOG が食い違っていない', () => {
  const changelog = read('CHANGELOG.md');
  for (const row of settledRows()) {
    const heading = changelog.split('\n').find((l) => l.startsWith(`## [${row.version}]`));
    assert.ok(heading, `CHANGELOG に ${row.version} の節が無い`);
    /*
     * 言い回しの一覧では取りこぼす（1.1.5 は「作業ツリーのみ」で素通りした）。
     * 確定した版の見出しには、**そのタグ名が書いてあること**を要求する。
     * 書きようがないので、うっかり「まだ」と書いたままにはできない。
     */
    assert.ok(heading.includes(row.tag),
      `確定した版の見出しにタグが書いていない: ${heading.trim()}`);
  }
});

test('検査が効いているかの対照', () => {
  // 表の値を1文字変えれば、git との突き合わせは必ず食い違う
  const rows = settledRows();
  const fake = { ...rows[0], commit: rows[0].commit.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')) };
  const real = git(['rev-parse', `${fake.tag}^{}`]);
  assert.notEqual(real, fake.commit, '対照が成立していない＝この検査はずれを捕まえられない');

  // 「作業ツリーのみ」のような、一覧に無い言い回しでも捕まえられること
  const oldStyleWording = ['未リリース', '作業ツリーにあるだけ'];
  assert.ok(!oldStyleWording.some((w) => '作業ツリーのみ'.includes(w)),
    '対照が成立していない＝旧方式でも 1.1.5 の書き方を捕まえられたことになる');
});
