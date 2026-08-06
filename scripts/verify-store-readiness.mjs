/*
 * verify-store-readiness.mjs — ストアへ出す前の確認（表示だけを担当する）
 *
 * 実行:
 *   npm run verify:store-readiness
 *   npm run verify:store-readiness -- --artifact <ダウンロードした成果物.zip>
 *
 * 判定そのものは scripts/store-readiness.mjs の純粋な関数が持つ（第10回監査 R10-002）。
 * ここはファイルを読んで渡し、結果を出すだけ。1件でも欠けていれば終了コードは0でない。
 *
 * **通っても「提出してよい」ではない。** ここで見られるのはリポジトリ側の材料だけで、
 * 外部監査の判定と、ダッシュボードの現行の設問文を本人が読んで確定する作業は別に要る。
 */
import { readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateStoreReadiness } from './store-readiness.mjs';
import { readZip } from './zip-read.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const argv = process.argv.slice(2);
const artifactAt = argv.indexOf('--artifact');
let artifact = null;
if (artifactAt !== -1) {
  const path = argv[artifactAt + 1];
  if (!path) {
    console.error('--artifact のあとにファイルのパスが要ります');
    process.exit(2);
  }
  /*
   * 外側の成果物ZIPは GitHub が書くもので、data descriptor 付きで来る（実測）。
   * 容れ物としてはそれを許し、**中身の配布ZIPは自分たちが作ったものなので
   * 厳しいまま**読む（下の readZipStrict）。
   */
  artifact = {
    outerName: basename(path).replace(/\.zip$/i, ''),
    files: readZip(readFileSync(path), { allowDataDescriptor: true })
  };
}

/* 外部監査の申告は、あれば読む（無ければ「未確認」として扱う） */
let audit = null;
try {
  audit = JSON.parse(read('store/EXTERNAL_AUDIT.json'));
} catch { /* 無くてよい */ }

const result = validateStoreReadiness({
  disclosure: JSON.parse(read('store/DATA_DISCLOSURE.json')),
  candidate: JSON.parse(read('store/SUBMISSION_CANDIDATE.json')),
  manifestVersion: JSON.parse(read('manifest.json')).version,
  packageVersion: JSON.parse(read('package.json')).version,
  privacy: read('PRIVACY.md'),
  listing: read('store/LISTING.md'),
  dashboardChanges: read('store/STORE_DASHBOARD_CHANGES.md'),
  today: new Date().toISOString().slice(0, 10),
  artifact,
  audit,
  sha256,
  readZipStrict: (buf) => readZip(buf)
});

console.log('ストア提出前の確認（リポジトリ側）\n');
for (const line of result.ok) console.log(`  ✅ ${line}`);
for (const line of result.problems) console.log(`  ❌ ${line}`);
console.log();

if (!result.artifactChecked) {
  console.log('※ 実物の成果物は見ていません（--artifact <成果物.zip> を付けると中身まで確かめます）');
}
if (!result.auditChecked) {
  console.log('※ 外部監査の判定は見ていません（store/EXTERNAL_AUDIT.json がありません）');
}

if (result.problems.length) {
  console.log(`\n${result.problems.length} 件そろっていません。ここが埋まるまで提出しないでください。`);
  console.log('（データ申告の欄は本人がダッシュボードで確認して埋めるところです）');
  process.exit(1);
}

console.log('\nリポジトリ側の材料はそろっています。');
console.log('**これは「提出してよい」という意味ではありません。** このあと、');
console.log('  ① 外部監査の判定（合格していること）');
console.log('  ② 本人がダッシュボードの現行の設問文を読んで確定すること');
console.log('  ③ 出す成果物を --artifact で実物ごと確かめること');
console.log('が要ります。提出そのものは本人が行ってください。');
