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

/*
 * 「もう書いていない」を確かめる検査は、**コードだけ**に当てる。
 * 注釈まで見ると「以前は window.open で開いていた」と経緯を書いた行で落ちる——
 * 落ちる理由が実装と関係なくなり、経緯を書けなくなる。
 *
 * **ここが唯一の定義**（第19回監査で共通化）。docs と background の両方が使う。
 * 2つ持つと、片方だけ直る形——第18回に直したばかりの誤りをもう一度作ることになる。
 * 消しすぎ・消せなさすぎは test/background.test.mjs が実物で検査している。
 */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
