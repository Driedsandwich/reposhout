/*
 * manifest と配布物の検査
 *
 * 目的は「気づかないうちに権限が増える」「外部コードが混ざる」を止めること。
 * 権限は allowlist で固定しているので、増やすときはこのテストも直すことになる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers/load.mjs';
import { PACKAGE_FILES } from '../scripts/package-files.mjs';

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

test('Manifest V3 の必須項目がそろっている', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+(\.\d+){1,3}$/);
  assert.ok(manifest.name.length <= 75, 'name が75文字を超えている');
  assert.ok(manifest.description.length <= 132, 'description が132文字を超えている');
  assert.ok(manifest.background && manifest.background.service_worker, 'service_worker が無い');
});

test('package.json と manifest.json のバージョンが一致する', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, manifest.version,
    `package.json=${pkg.version} / manifest.json=${manifest.version}`);
});

test('依存は許可した開発用パッケージだけ（配布物には入らない）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  // 実行時の依存はゼロを維持する。拡張が読み込むのは src/ の自前コードだけ。
  assert.deepEqual(pkg.dependencies || {}, {});
  // 開発用は allowlist。増やすときはここも直すことになる。
  assert.deepEqual(pkg.devDependencies || {}, { 'twitter-text': '3.1.0' });
  // 版は範囲指定ではなく完全固定であること
  for (const [name, range] of Object.entries(pkg.devDependencies || {})) {
    assert.match(range, /^\d+\.\d+\.\d+$/, `${name} が完全固定でない: ${range}`);
  }
});

test('開発用依存が配布物へ混ざらない', () => {
  for (const f of PACKAGE_FILES) {
    const body = readFileSync(join(ROOT, f));
    if (!f.endsWith('.js')) continue;
    assert.ok(!/require\(|from ['"]twitter-text/.test(body.toString('utf8')),
      `配布物が外部パッケージを参照している: ${f}`);
  }
});

test('権限は allowlist と完全一致する（増えたら落ちる）', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'storage']);
  assert.equal(manifest.host_permissions, undefined, 'host_permissions は使わない');
  assert.equal(manifest.optional_permissions, undefined);
});

test('content script は github.com と x.com だけ', () => {
  const matches = manifest.content_scripts.flatMap((cs) => cs.matches).sort();
  assert.deepEqual(matches, ['https://github.com/*', 'https://x.com/*']);
});

test('manifest が指すファイルが実在する', () => {
  const refs = [
    manifest.background.service_worker,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((cs) => cs.js)
  ];
  for (const r of refs) {
    assert.ok(existsSync(join(ROOT, r.replace(/^\//, ''))), `参照先が無い: ${r}`);
  }
});

test('外部コードを読み込む書き方が無い', () => {
  const forbidden = [
    [/\bimportScripts\(\s*['"](?!\/src\/)/, 'importScripts で拡張外を読んでいる'],
    [/\beval\s*\(/, 'eval がある'],
    [/new\s+Function\s*\(/, 'new Function がある'],
    [/\bfetch\s*\(/, 'fetch がある'],
    [/XMLHttpRequest/, 'XMLHttpRequest がある'],
    [/new\s+WebSocket/, 'WebSocket がある'],
    [/<script[^>]+src=/, '外部スクリプトタグがある']
  ];
  for (const f of ['src/share.js', 'src/content.js', 'src/background.js', 'src/esc-close.js']) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    for (const [re, why] of forbidden) {
      assert.ok(!re.test(s), `${f}: ${why}`);
    }
  }
});

test('配布物の一覧が固定されている', () => {
  assert.deepEqual(PACKAGE_FILES, [
    'manifest.json',
    'icons/icon16.png',
    'icons/icon32.png',
    'icons/icon48.png',
    'icons/icon128.png',
    'src/share.js',
    'src/content.js',
    'src/background.js',
    'src/esc-close.js'
  ]);
  for (const f of PACKAGE_FILES) {
    assert.ok(existsSync(join(ROOT, f)), `配布対象が無い: ${f}`);
  }
});

test('CIワークフローが供給網の最低条件を満たす', () => {
  const wf = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const uses = [...wf.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 3, `uses が少なすぎる: ${uses.length}`);
  for (const u of uses) {
    // 可変タグ（@v7）は付け替えられるので、完全なcommit SHAで固定する
    assert.match(u, /@[0-9a-f]{40}$/, `commit SHA で固定されていない: ${u}`);
  }
  assert.match(wf, /^permissions:\n  contents: read$/m, 'permissions: contents: read が無い');
  assert.match(wf, /timeout-minutes:\s*\d+/, 'timeout-minutes が無い');
  assert.ok(!/pull_request_target/.test(wf), 'pull_request_target は使わない');
  assert.ok(!/\$\{\{\s*secrets\./.test(wf), 'secret を参照している');
});

test('配布物にテスト・ストア素材・文書を含めない', () => {
  for (const f of PACKAGE_FILES) {
    assert.ok(!f.startsWith('test/'), f);
    assert.ok(!f.startsWith('store/'), f);
    assert.ok(!f.startsWith('scripts/'), f);
    assert.ok(!f.endsWith('.md'), f);
  }
});
