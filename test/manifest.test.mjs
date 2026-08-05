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

test('依存パッケージを持たない', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies || {}, {});
  assert.deepEqual(pkg.devDependencies || {}, {});
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

test('配布物にテスト・ストア素材・文書を含めない', () => {
  for (const f of PACKAGE_FILES) {
    assert.ok(!f.startsWith('test/'), f);
    assert.ok(!f.startsWith('store/'), f);
    assert.ok(!f.startsWith('scripts/'), f);
    assert.ok(!f.endsWith('.md'), f);
  }
});
