/*
 * verify-store-readiness.mjs — 提出前の確認（ファイルを読んで、判定を表示する）
 *
 * 2つの入口がある（第11回監査 R11-002）。
 *
 *   npm run verify:store-preflight
 *     リポジトリ側の材料だけを見る。**これは最終関門ではない。**
 *     成果物も外部監査の判定も見ないまま通ることがある。
 *
 *   npm run verify:submission-ready -- --artifact <成果物.zip> \
 *       --audit-report <報告書> --audit-attestation <申告.json>
 *     実物の成果物と外部監査の申告を必須にする。報告書は実体を読んでハッシュを
 *     計算し、申告の値と突き合わせる。申告は配布物と文書の両方の位置に結び付ける。
 *
 * 判定そのものは scripts/store-readiness.mjs の純粋な関数が持つ。
 * このファイルは何も送らない・何も変えない。
 */
import { readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateStoreReadiness, dateIn } from './store-readiness.mjs';
import { readZip } from './zip-read.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const argOf = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) {
    console.error(`${name} のあとにパスが要ります`);
    process.exit(2);
  }
  return v;
};

const candidate = JSON.parse(read('store/SUBMISSION_CANDIDATE.json'));

/* 確認日は本人の暮らしている時間帯で見る（第11回監査 R11-005） */
const today = argOf('--today') || dateIn(candidate.confirmationTimeZone || 'Asia/Tokyo');

/* 外側の成果物ZIP。GitHub が書くので data descriptor 付きで来る（実測） */
const artifactPath = argOf('--artifact');
let artifact = null;
if (artifactPath) {
  artifact = {
    outerName: basename(artifactPath).replace(/\.zip$/i, ''),
    files: readZip(readFileSync(artifactPath), { allowDataDescriptor: true })
  };
}

/* 外部監査の申告と、その報告書の実体 */
const attestationPath = argOf('--audit-attestation');
const reportPath = argOf('--audit-report');
const audit = attestationPath ? JSON.parse(readFileSync(attestationPath, 'utf8')) : null;
const auditReportSha256 = reportPath ? sha256(readFileSync(reportPath)) : null;

/* いまの文書側の位置（監査後に書き換えていないかを見るため） */
const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
};
const head = git(['rev-parse', 'HEAD']);
const metadata = head
  ? { sourceCommit: head, treeSha: git(['rev-parse', 'HEAD^{tree}']),
      dirty: git(['status', '--porcelain']) !== '' }
  : null;

const result = validateStoreReadiness({
  mode: strict ? 'strict' : 'preflight',
  disclosure: JSON.parse(read('store/DATA_DISCLOSURE.json')),
  candidate,
  manifestVersion: JSON.parse(read('manifest.json')).version,
  packageVersion: JSON.parse(read('package.json')).version,
  privacy: read('PRIVACY.md'),
  listing: read('store/LISTING.md'),
  dashboardChanges: read('store/STORE_DASHBOARD_CHANGES.md'),
  today,
  artifact,
  audit,
  auditReportSha256,
  metadata,
  sha256,
  readZipStrict: (buf) => readZip(buf)
});

console.log(strict
  ? '提出直前の確認（実物の成果物と外部監査を含む）\n'
  : 'リポジトリ側の事前確認（preflight）\n');
for (const line of result.ok) console.log(`  ✅ ${line}`);
for (const line of result.problems) console.log(`  ❌ ${line}`);
console.log();
console.log(`  基準日: ${today}（${candidate.confirmationTimeZone || 'Asia/Tokyo'}）`);
if (!result.artifactChecked) console.log('  ※ 実物の成果物は見ていません');
if (!result.auditChecked) console.log('  ※ 外部監査の判定は見ていません');

if (result.problems.length) {
  console.log(`\n${result.problems.length} 件そろっていません。ここが埋まるまで提出しないでください。`);
  process.exit(1);
}

if (strict) {
  console.log('\nAll machine-verifiable submission checks passed.');
  console.log('機械で確かめられる項目はすべて通りました。');
  console.log('**ダッシュボードでの人の確認と、提出そのものは本人の作業です。**');
} else {
  console.log('\nリポジトリ側の材料はそろっています。');
  console.log('**これは「提出してよい」という意味ではありません（preflight）。**');
  console.log('提出の可否は npm run verify:submission-ready で、実物の成果物と');
  console.log('外部監査の報告書・申告を渡して確かめてください。');
}
