/*
 * verify-store-readiness.mjs — ストアへ出す前の一括確認
 *
 * 実行: npm run verify:store-readiness
 *
 * 「出してよい状態か」を1つのコマンドで見る。1件でも欠けていれば終了コードは0でない。
 * 提出そのものは人が行う（この本は何も送らない・何も変えない）。
 *
 * ここで見るのは、テストでは見きれない**本人の作業待ち**を含む項目。
 * 第9回監査 R9-002 で、確認待ちのまま提出へ進める状態だと指摘された。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const problems = [];
const ok = [];
const check = (label, condition, detail) => {
  (condition ? ok : problems).push(condition ? label : `${label} — ${detail}`);
};

const disclosure = JSON.parse(read('store/DATA_DISCLOSURE.json'));
const manifest = JSON.parse(read('manifest.json'));

/* 1. データ申告が全欄そろって確定しているか */
for (const c of disclosure.categories) {
  if (c.confirmationStatus === 'not_required') {
    check(`申告 ${c.label}`, ['Yes', 'No'].includes(c.answer), `答えが Yes / No でない: ${c.answer}`);
    continue;
  }
  check(`申告 ${c.label}`, c.confirmationStatus === 'confirmed',
    '本人の確認がまだ（ダッシュボードの設問文を読んで確定してください）');
  if (c.confirmationStatus !== 'confirmed') continue;

  const oc = c.ownerConfirmation || {};
  check(`申告 ${c.label} の答え`, ['Yes', 'No'].includes(c.answer), `答えが Yes / No でない: ${c.answer}`);
  check(`申告 ${c.label} の一致`, c.answer === oc.chosen,
    `answer(${c.answer}) と ownerConfirmation.chosen(${oc.chosen}) が違う`);
  for (const [k, why] of Object.entries({
    dashboardQuestionText: '読んだ設問文',
    confirmedOn: '確認した日',
    chosen: '選んだ答え',
    reason: '理由'
  })) {
    check(`申告 ${c.label} の${why}`, Boolean(oc[k]), '空のまま');
  }
}

/* 2. 版が揃っているか */
const pkg = JSON.parse(read('package.json'));
check('版の一致', pkg.version === manifest.version && disclosure.version === manifest.version,
  `manifest=${manifest.version} package=${pkg.version} disclosure=${disclosure.version}`);

/* 3. プライバシーポリシーに Limited Use の遵守声明があるか */
const privacy = read('PRIVACY.md');
check('Limited Use の遵守声明（英語）', /adheres to the Chrome Web Store User Data Policy/i.test(privacy),
  'PRIVACY.md に英語の遵守声明が無い');
check('Limited Use の遵守声明（日本語）', /ユーザーデータポリシー（Limited Use の要件を含む）に従います/.test(privacy),
  'PRIVACY.md に日本語の遵守声明が無い');

/* 4. 提出手順が「既存アイテムの差し替え」になっているか */
const listing = read('store/LISTING.md');
check('更新の手順', listing.includes('Upload New Package'), 'store/LISTING.md が新規登録のままになっている');
check('提出する成果物の指定', /成果物 : reposhout-package-[0-9a-f]{40}/.test(listing),
  'どの成果物を出すかが一意に書かれていない');
check('提出するZIPのハッシュ', /SHA-256 : [0-9a-f]{64}/.test(listing),
  '提出するZIPのSHA-256が書かれていない');

/* 5. 手元ビルドを提出用として案内していないか */
for (const f of ['store/LISTING.md', 'store/STORE_DASHBOARD_CHANGES.md']) {
  check(`${f} の案内`, !/`npm run package` で作れます/.test(read(f)),
    '手元ビルドを提出用として案内している');
}

console.log('ストア提出前の確認\n');
for (const line of ok) console.log(`  ✅ ${line}`);
for (const line of problems) console.log(`  ❌ ${line}`);
console.log();

if (problems.length) {
  console.log(`${problems.length} 件そろっていません。ここが埋まるまで提出しないでください。`);
  console.log('（データ申告の欄は本人がダッシュボードで確認して埋めるところです）');
  process.exit(1);
}
console.log('すべてそろっています。提出そのものは本人が行ってください。');
