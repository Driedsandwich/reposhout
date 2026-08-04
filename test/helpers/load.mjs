/*
 * 素の <script> として書かれた src/share.js と test/fixtures.js を、
 * ブラウザと同じ形（globalThis へ代入される）のまま Node で読み込む。
 * 変換もコピーもしないので、テストが見ているのは出荷されるファイルそのもの。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadScript(relPath) {
  const code = readFileSync(join(ROOT, relPath), 'utf8');
  vm.runInThisContext(code, { filename: relPath });
}

export function loadShare() {
  loadScript('src/share.js');
  loadScript('test/fixtures.js');
  return { GXS: globalThis.GXS, FIX: globalThis.GXS_FIXTURES };
}
