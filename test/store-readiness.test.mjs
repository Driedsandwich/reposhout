/*
 * 提出前の関門が、でたらめな値を通さないことを確かめる
 *
 * 第9回で作った関門にはテストが1つも無く、第10回監査 R10-002 で
 * 「成果物名が40桁の0・SHA が64桁の0・確認日が not-a-date・設問文が空白1文字・
 * 3つの証明がすべて未チェック・ポリシーURLが http://invalid.example」でも
 * 全部 ✅ になることが実測で示された。
 *
 * 第11回監査 R11-002 で、さらに次を確かめる。
 *   ・preflight は最終関門ではない（成果物も外部監査も見ないまま通り得る）
 *   ・strict は実物の成果物と外部監査の申告が無ければ必ず落ちる
 *   ・外部監査の報告書は、実体のハッシュで結び付ける
 *   ・申告は配布物と文書の両方の位置に結び付ける
 *   ・成果物は root 直下ちょうど3点だけ（R11-004）
 *   ・確認日は JST で見る（R11-005）
 *
 * ここでは「正しい入力」を1つ作り、そこから1箇所ずつ壊して落ちることを見る。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateStoreReadiness } from '../scripts/store-readiness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const clone = (o) => JSON.parse(JSON.stringify(o));

const DISCLOSURE = JSON.parse(read('store/DATA_DISCLOSURE.json'));
const CANDIDATE = JSON.parse(read('store/SUBMISSION_CANDIDATE.json'));

/* 中身のZIPの代わり（大きさとハッシュだけ見る） */
const INNER = Buffer.from('これは中身のZIPの代わり', 'utf8');
const INNER_SHA = sha256(INNER);

const META = { sourceCommit: 'a'.repeat(40), treeSha: 'b'.repeat(40), dirty: false };

/* 成果物が出たあとの正本（いまのリポジトリは pending なので、ここで作る） */
function readyCandidate() {
  return {
    status: 'ready',
    itemId: CANDIDATE.itemId,
    version: CANDIDATE.version,
    tag: `v${CANDIDATE.version}`,
    sourceCommit: 'c'.repeat(40),
    treeSha: 'd'.repeat(40),
    runId: '12345678',
    artifactName: `reposhout-package-${'c'.repeat(40)}`,
    innerName: CANDIDATE.innerName,
    innerBytes: INNER.length,
    innerFiles: 11,
    innerSha256: INNER_SHA,
    privacyPolicyUrl: CANDIDATE.privacyPolicyUrl,
    confirmationTimeZone: 'Asia/Tokyo'
  };
}

/* 本人の確認が済んだ状態（実ファイルは pending のまま。ここだけの仮定） */
function confirmedDisclosure() {
  const d = clone(DISCLOSURE);
  for (const c of d.categories) {
    if (c.confirmationStatus !== 'pending') continue;
    c.confirmationStatus = 'confirmed';
    c.answer = c.proposedAnswer;
    c.ownerConfirmation = {
      dashboardQuestionText: 'Does your extension handle authentication information?',
      confirmedOn: '2026-08-07',
      chosen: c.proposedAnswer,
      reason: 'ダッシュボードの現行の設問文を読んで判断した（テスト用の仮の値）'
    };
  }
  return d;
}

/*
 * 検査に掛ける文書は、実ファイルではなくここで組み立てる。
 * 実ファイルを使うと、リポジトリ側の状態（版・成果物が確定したかどうか）で
 * テストの意味が変わってしまう。実ファイルそのものを見る検査は別に置く
 * （「いまの実ファイルは…」のテスト）。
 */
function docsFor(cand) {
  const listing = [
    '# 提出手順（テスト用の最小の写し）',
    '',
    '> **⚠️ 今回の更新では、§0 事前確認・§1 パッケージ・§2 Store listing・§3 Privacy practices を',
    '> すべて完了させてください。** 掲載中の版は9項目を**すべて No** で申告しています。',
    '',
    '既存のアイテムを開き、**Upload New Package** から差し替えます。',
    '',
    '```',
    `成果物 : ${cand.artifactName}`,
    `中のZIP : ${cand.innerName}`,
    `SHA-256 : ${cand.innerSha256}`,
    '```',
    '',
    `プライバシーポリシー: ${cand.privacyPolicyUrl}`,
    ''
  ].join('\n');
  const dashboard = [
    '# 掲載欄の差分（テスト用の最小の写し）',
    '',
    '出すもの:',
    '',
    '```',
    `成果物 : ${cand.artifactName}`,
    `SHA-256 : ${cand.innerSha256}`,
    '```',
    ''
  ].join('\n');
  return { listing, dashboard };
}

function goodAudit(cand) {
  return {
    verdict: 'READY',
    auditor: 'GPT-5.6 Sol Pro',
    auditDate: '2026-08-07',
    runtimeVersion: cand.version,
    runtimeTag: cand.tag,
    runtimeSourceCommit: cand.sourceCommit,
    runtimeTree: cand.treeSha,
    innerSha256: cand.innerSha256,
    metadataSourceCommit: META.sourceCommit,
    metadataTree: META.treeSha,
    reportSha256: 'e'.repeat(64)
  };
}

function fakeArtifact(cand, over = {}) {
  const inner = over.inner || INNER;
  const rm = {
    version: cand.version,
    sourceCommit: cand.sourceCommit,
    treeSha: cand.treeSha,
    dirty: false,
    submittable: true,
    zip: { name: cand.innerName, bytes: inner.length, sha256: sha256(inner) },
    ci: { eventName: 'push', ref: 'refs/heads/main', runId: cand.runId },
    ...(over.manifest || {})
  };
  const files = over.files || [
    { name: 'release-manifest.json', data: Buffer.from(JSON.stringify(rm), 'utf8') },
    { name: cand.innerName, data: inner },
    { name: `${cand.innerName}.sha256`,
      data: Buffer.from(`${sha256(inner)}  ${cand.innerName}\n`, 'utf8') }
  ];
  return { outerName: over.outerName || cand.artifactName, files };
}

/* strict が通る状態を1つ作る。ここから1箇所ずつ壊す */
function strictInputs(over = {}) {
  const cand = over.candidate || readyCandidate();
  const docs = docsFor(cand);
  return {
    mode: 'strict',
    disclosure: confirmedDisclosure(),
    candidate: cand,
    manifestVersion: JSON.parse(read('manifest.json')).version,
    packageVersion: JSON.parse(read('package.json')).version,
    privacy: read('PRIVACY.md'),
    listing: docs.listing,
    dashboardChanges: docs.dashboard,
    today: '2026-08-07',
    artifact: fakeArtifact(cand),
    audit: goodAudit(cand),
    auditReportSha256: 'e'.repeat(64),
    metadata: { ...META },
    sha256,
    ...over
  };
}

function preflightInputs(over = {}) {
  return { ...strictInputs(over), mode: 'preflight',
           artifact: null, audit: null, auditReportSha256: null, ...over };
}

function failsWith(inputs, needle) {
  const r = validateStoreReadiness(inputs);
  assert.ok(r.problems.length > 0, `落ちるべきなのに通った: ${needle}`);
  assert.ok(r.problems.some((p) => p.includes(needle)),
    `別の理由で落ちている。期待「${needle}」実際:\n${r.problems.join('\n')}`);
}

/* ---- 対照: 正しい入力なら通る ------------------------------------------ */
test('strict: すべてそろっていれば問題ゼロで通る', () => {
  const r = validateStoreReadiness(strictInputs());
  assert.deepEqual(r.problems, [], `通るべきなのに落ちた:\n${r.problems.join('\n')}`);
  assert.equal(r.artifactChecked, true);
  assert.equal(r.auditChecked, true);
  assert.ok(r.ok.length > 35, `検査が少なすぎる: ${r.ok.length} 件`);
});

/* ---- preflight は最終関門ではない（R11-002 の核心） --------------------- */
test('preflight は、成果物も外部監査も見ないまま通り得る', () => {
  const r = validateStoreReadiness(preflightInputs());
  assert.deepEqual(r.problems, [], r.problems.join('\n'));
  assert.equal(r.artifactChecked, false, '成果物を見たことになっている');
  assert.equal(r.auditChecked, false, '外部監査を見たことになっている');
});

test('strict は、成果物が無ければ必ず落ちる', () => {
  failsWith(strictInputs({ artifact: null }), '実物の成果物');
});

test('strict は、外部監査の申告が無ければ必ず落ちる', () => {
  failsWith(strictInputs({ audit: null, auditReportSha256: null }), '外部監査の判定');
});

/* ---- いまのリポジトリの実状態 ------------------------------------------ */
test('いまの実ファイルは、preflight では本人の確認待ち2件だけで落ちる', () => {
  const r = validateStoreReadiness({
    ...preflightInputs(),
    disclosure: clone(DISCLOSURE),
    candidate: clone(CANDIDATE),
    listing: read('store/LISTING.md'),
    dashboardChanges: read('store/STORE_DASHBOARD_CHANGES.md')
  });
  const pending = r.problems.filter((p) => p.includes('本人の確認がまだ'));
  assert.equal(pending.length, 2, `確認待ちが2件でない:\n${r.problems.join('\n')}`);
  assert.equal(r.problems.length, 2, `確認待ち以外の問題が出ている:\n${r.problems.join('\n')}`);
});

/* まだ main の CI が作っていない状態の正本（実ファイルの状態に依存させない） */
function pendingCandidate(over = {}) {
  const c = readyCandidate();
  return {
    ...c, status: 'pending_main_ci', tag: null, sourceCommit: null, treeSha: null,
    runId: null, artifactName: null, innerBytes: null, innerFiles: null, innerSha256: null,
    ...over
  };
}

test('成果物がまだ無い状態（pending_main_ci）は、strict では必ず落ちる', () => {
  failsWith({
    ...strictInputs(),
    candidate: pendingCandidate(),
    listing: read('store/LISTING.md'),
    dashboardChanges: read('store/STORE_DASHBOARD_CHANGES.md'),
    artifact: null, audit: null, auditReportSha256: null
  }, 'pending_main_ci');
});

test('pending なのに正本へ値を書いたら落ちる（推測で埋めない）', () => {
  failsWith({
    ...preflightInputs(),
    candidate: pendingCandidate({ innerSha256: 'f'.repeat(64) }),
    listing: read('store/LISTING.md'),
    dashboardChanges: read('store/STORE_DASHBOARD_CHANGES.md')
  }, '正本の innerSha256 が空のまま');
});

/* ---- 本人確認の欄 ------------------------------------------------------ */
test('確認欄が空白だけなら落ちる', () => {
  const d = confirmedDisclosure();
  d.categories.find((c) => c.id === 'authentication_information')
    .ownerConfirmation.dashboardQuestionText = '   ';
  failsWith(strictInputs({ disclosure: d }), 'の読んだ設問文');
});

test('理由が空白だけなら落ちる', () => {
  const d = confirmedDisclosure();
  d.categories.find((c) => c.id === 'user_activity').ownerConfirmation.reason = '\t\n ';
  failsWith(strictInputs({ disclosure: d }), 'の理由');
});

test('確認日が日付の形でなければ落ちる', () => {
  const d = confirmedDisclosure();
  d.categories.find((c) => c.id === 'user_activity').ownerConfirmation.confirmedOn = 'not-a-date';
  failsWith(strictInputs({ disclosure: d }), 'の確認した日');
});

test('存在しない日付なら落ちる', () => {
  const d = confirmedDisclosure();
  d.categories.find((c) => c.id === 'user_activity').ownerConfirmation.confirmedOn = '2026-02-30';
  failsWith(strictInputs({ disclosure: d }), 'の確認した日');
});

test('確認日が未来なら落ちる', () => {
  const d = confirmedDisclosure();
  d.categories.find((c) => c.id === 'user_activity').ownerConfirmation.confirmedOn = '2026-08-08';
  failsWith(strictInputs({ disclosure: d, today: '2026-08-07' }), '確認日が未来でない');
});

test('うるう日は実在する日として扱う', () => {
  const d = confirmedDisclosure();
  for (const c of d.categories) {
    if (c.confirmationStatus === 'confirmed' && c.ownerConfirmation) {
      c.ownerConfirmation.confirmedOn = '2028-02-29';
    }
  }
  const r = validateStoreReadiness(strictInputs({ disclosure: d, today: '2028-03-01' }));
  assert.deepEqual(r.problems, [], r.problems.join('\n'));
});

test('答えと、本人が選んだ答えが食い違えば落ちる', () => {
  const d = confirmedDisclosure();
  d.categories.find((x) => x.id === 'authentication_information').answer = 'Yes';
  failsWith(strictInputs({ disclosure: d }), 'の一致');
});

/* ---- 3つの証明 / ポリシーURL -------------------------------------------- */
test('証明のチェックが1つでも外れていれば落ちる', () => {
  const d = confirmedDisclosure();
  d.certifications[1].checked = false;
  failsWith(strictInputs({ disclosure: d }), `証明 ${DISCLOSURE.certifications[1].id}`);
});

test('ポリシーURLがHTTPなら落ちる', () => {
  const d = confirmedDisclosure();
  d.privacyPolicyUrl = 'http://invalid.example';
  failsWith(strictInputs({ disclosure: d }), 'ポリシーURLがHTTPS');
});

test('ポリシーURLが正本と違えば落ちる', () => {
  const d = confirmedDisclosure();
  d.privacyPolicyUrl = 'https://example.com/privacy';
  failsWith(strictInputs({ disclosure: d }), 'ポリシーURLが正本と一致');
});

/* ---- プライバシーポリシーの言い過ぎ ------------------------------------ */
test('「人は誰も読まない」と断定していれば落ちる', () => {
  failsWith(strictInputs({
    privacy: read('PRIVACY.md') + '\nNo human — including the developer — reads this data.\n'
  }), 'Limited Use の書き方');
});

test('遵守声明そのものが無ければ落ちる', () => {
  failsWith(strictInputs({
    privacy: read('PRIVACY.md')
      .replace('adheres to the Chrome Web Store User Data Policy', 'follows some policy')
  }), 'Limited Use の遵守声明（英語）');
});

/* ---- 文書 -------------------------------------------------------------- */
test('文書に、正本に無いコミットが書いてあれば落ちる', () => {
  const cand = readyCandidate();
  const docs = docsFor(cand);
  failsWith(strictInputs({
    candidate: cand,
    listing: docs.listing + '\n現在の main は 1d4b78b です。\n',
    dashboardChanges: docs.dashboard
  }), '古くなるコミットを書いていない');
});

test('更新手順が Privacy practices を必須と書いていなければ落ちる', () => {
  const cand = readyCandidate();
  const docs = docsFor(cand);
  failsWith(strictInputs({
    candidate: cand,
    listing: docs.listing.replace(
      /§0 事前確認・§1 パッケージ・§2 Store listing・§3 Privacy practices を\n> すべて完了させてください/,
      '§1 と §2 だけを直せば足ります'),
    dashboardChanges: docs.dashboard
  }), 'Privacy practices も必須と書いてある');
});

test('手元ビルドを提出用として案内していれば落ちる', () => {
  const cand = readyCandidate();
  const docs = docsFor(cand);
  failsWith(strictInputs({
    candidate: cand,
    listing: docs.listing,
    dashboardChanges: docs.dashboard + '\n`npm run package` で作れます。\n'
  }), 'store/STORE_DASHBOARD_CHANGES.md の案内');
});

/* ---- 実物の成果物 ------------------------------------------------------ */
test('中身のZIPのハッシュが正本と違えば落ちる', () => {
  const cand = readyCandidate();
  failsWith(strictInputs({
    candidate: cand,
    artifact: fakeArtifact(cand, { inner: Buffer.from('別のZIP', 'utf8') })
  }), '中身のZIPの実ハッシュ');
});

test('成果物の名前が正本と違えば落ちる', () => {
  const cand = readyCandidate();
  failsWith(strictInputs({
    candidate: cand,
    artifact: fakeArtifact(cand, { outerName: `reposhout-package-${'0'.repeat(40)}` })
  }), '成果物の名前');
});

test('成果物に入れ子の同名ファイルがあれば落ちる（R11-004）', () => {
  /*
   * 以前は basename だけで引いていたので、nested/release-manifest.json が
   * root の記録を上書きし、余計なファイルにも気づけなかった。
   */
  const cand = readyCandidate();
  const base = fakeArtifact(cand);
  const files = base.files.concat([
    { name: 'nested/release-manifest.json', data: Buffer.from('{}', 'utf8') }
  ]);
  failsWith(strictInputs({ candidate: cand, artifact: { ...base, files } }),
    '成果物の中身がちょうど3点');
});

test('成果物に余計なファイルがあれば落ちる', () => {
  const cand = readyCandidate();
  const base = fakeArtifact(cand);
  const files = base.files.concat([{ name: 'README.txt', data: Buffer.from('x', 'utf8') }]);
  failsWith(strictInputs({ candidate: cand, artifact: { ...base, files } }),
    '成果物の中身がちょうど3点');
});

test('ハッシュの控えが1行まるごと一致しなければ落ちる', () => {
  const cand = readyCandidate();
  const base = fakeArtifact(cand);
  const files = base.files.map((f) => f.name.endsWith('.sha256')
    ? { ...f, data: Buffer.from(`${cand.innerSha256}  wrong-name.zip\n`, 'utf8') }
    : f);
  failsWith(strictInputs({ candidate: cand, artifact: { ...base, files } }),
    'ハッシュの控えが1行まるごと一致');
});

test('PRで作られた成果物なら落ちる', () => {
  const cand = readyCandidate();
  failsWith(strictInputs({
    candidate: cand,
    artifact: fakeArtifact(cand, {
      manifest: { ci: { eventName: 'pull_request', ref: 'refs/pull/1/merge', runId: cand.runId } }
    })
  }), 'main への push で作られた');
});

test('未コミットの変更がある状態で作られた成果物なら落ちる', () => {
  const cand = readyCandidate();
  failsWith(strictInputs({ candidate: cand, artifact: fakeArtifact(cand, { manifest: { dirty: true } }) }),
    '未コミットの変更が無い状態');
});

/* ---- 外部監査の申告 ---------------------------------------------------- */
test('外部監査が NOT_READY なら落ちる', () => {
  const cand = readyCandidate();
  const audit = goodAudit(cand);
  audit.verdict = 'NOT_READY';
  failsWith(strictInputs({ candidate: cand, audit }), '外部監査の判定');
});

test('報告書の実体を渡さなければ落ちる（書式だけでは通さない）', () => {
  failsWith(strictInputs({ auditReportSha256: null }), '外部監査の報告書が実物と一致');
});

test('報告書の実体が申告と違えば落ちる', () => {
  failsWith(strictInputs({ auditReportSha256: '9'.repeat(64) }), '外部監査の報告書が実物と一致');
});

test('報告書のハッシュが64桁の0でも、実体と合わなければ落ちる', () => {
  const cand = readyCandidate();
  const audit = goodAudit(cand);
  audit.reportSha256 = '0'.repeat(64);
  failsWith(strictInputs({ candidate: cand, audit }), '外部監査の報告書が実物と一致');
});

test('外部監査が別の配布物を見ていれば落ちる', () => {
  const cand = readyCandidate();
  const audit = goodAudit(cand);
  audit.runtimeSourceCommit = '1'.repeat(40);
  failsWith(strictInputs({ candidate: cand, audit }), '外部監査が見た配布物のコミット');
});

test('監査のあとで文書を書き換えていたら落ちる', () => {
  /*
   * 掲載文とデータ申告は、監査が終わったあとでも書き換えられる。
   * 申告を配布物だけに結び付けると、そこが見えない（第11回監査 R11-002）。
   */
  failsWith(strictInputs({
    metadata: { sourceCommit: '2'.repeat(40), treeSha: '3'.repeat(40), dirty: false }
  }), '外部監査が見た文書のコミット');
});

test('文書側に未コミットの変更があれば落ちる', () => {
  failsWith(strictInputs({ metadata: { ...META, dirty: true } }), '文書側に未コミットの変更が無い');
});

test('いまの文書側の位置を渡さなければ落ちる', () => {
  failsWith(strictInputs({ metadata: null }), '外部監査が見た文書のコミット');
});

/* ---- 版 ---------------------------------------------------------------- */
test('版が食い違えば落ちる', () => {
  failsWith(strictInputs({ packageVersion: '9.9.9' }), '版の一致');
});

