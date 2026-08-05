/*
 * 配布物に入れるファイル（allowlist・この順で固める）
 *
 * 「除外リスト」ではなく「収録リスト」にしているのは、
 * ファイルが増えたときに黙って混入しないようにするため。
 * 変更したら test/manifest.test.mjs も落ちる。
 */
export const PACKAGE_FILES = [
  'manifest.json',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'src/share.js',
  'src/content.js',
  'src/background.js',
  'src/esc-close.js'
];
