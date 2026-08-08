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
import { validateStoreReadiness, dateIn } from '../scripts/store-readiness.mjs';

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
  return {
    outerName: over.outerName || cand.artifactName,
    outerSha256: over.outerSha256 || OUTER_SHA,
    files
  };
}

/* 外側の成果物の実バイトのハッシュ。GitHub 側の digest と突き合わせる（R14-005） */
const OUTER_SHA = 'f'.repeat(64);

/*
 * 正本が名指しする run と成果物が GitHub 上に在る、という状態
 * （第14回監査 R14-005）。ここから1つずつ壊して、落ちることを見る。
 */
function goodRuntime(cand, over = {}) {
  return {
    run: {
      id: cand.runId, path: '.github/workflows/ci.yml', event: 'push', branch: 'main',
      headSha: cand.sourceCommit, conclusion: 'success',
      jobs: { test: 'success', windows: 'success' }
    },
    artifact: { name: cand.artifactName, expired: false, digest: `sha256:${OUTER_SHA}` },
    ...over
  };
}

/* strict が通る状態を1つ作る。ここから1箇所ずつ壊す */
const GOOD_REMOTE = {
  originUrl: 'https://github.com/Driedsandwich/reposhout.git',
  originMainSha: 'a'.repeat(40),
  expectedOrigin: 'Driedsandwich/reposhout'
};
const GOOD_CI = {
  conclusion: 'success', event: 'push', branch: 'main',
  headSha: 'a'.repeat(40), runId: '999', jobs: { test: 'success', windows: 'success' }
};

function strictInputs(over = {}) {
  const cand = over.candidate || readyCandidate();
  const docs = docsFor(cand);
  return {
    mode: 'strict',
    remote: { ...GOOD_REMOTE },
    metadataCi: { ...GOOD_CI },
    runtime: goodRuntime(cand),
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

/* ---- 時間帯（R11-005） ---------------------------------------------------
 *
 * UTC で「今日」を出すと、JST の 00:30 に確認した当日が翌日扱いになり、
 * 正しく記録した確認日を「未来」として弾く。境界で確かめる。
 */
test('「今日」は JST で数える', () => {
  const cases = [
    ['2026-08-06T14:59:00Z', '2026-08-06', 'JST 23:59（同じ日）'],
    ['2026-08-06T15:00:00Z', '2026-08-07', 'JST 00:00（日付が変わる）'],
    ['2026-08-06T15:30:00Z', '2026-08-07', 'JST 00:30（監査が指摘した時刻）'],
    ['2026-08-06T23:59:00Z', '2026-08-07', 'JST 08:59'],
    ['2026-08-07T00:00:00Z', '2026-08-07', 'JST 09:00'],
    ['2028-02-28T15:30:00Z', '2028-02-29', 'うるう日をまたぐ']
  ];
  for (const [iso, want, why] of cases) {
    assert.equal(dateIn('Asia/Tokyo', new Date(iso)), want, why);
  }
  // 対照: 同じ時刻を UTC で見ると別の日になる（＝この違いが問題だった）
  assert.equal(dateIn('UTC', new Date('2026-08-06T15:30:00Z')), '2026-08-06');
});

test('JST の当日に確認した記録が、未来として弾かれない', () => {
  const d = confirmedDisclosure();
  for (const c of d.categories) {
    if (c.ownerConfirmation) c.ownerConfirmation.confirmedOn = '2026-08-07';
  }
  const jst = dateIn('Asia/Tokyo', new Date('2026-08-06T15:30:00Z'));   // JST 00:30
  const r = validateStoreReadiness(strictInputs({ disclosure: d, today: jst }));
  assert.deepEqual(r.problems, [], r.problems.join('\n'));
  // UTC で数えると、同じ記録が未来扱いになる（対照）
  const utc = dateIn('UTC', new Date('2026-08-06T15:30:00Z'));
  const bad = validateStoreReadiness(strictInputs({ disclosure: d, today: utc }));
  assert.ok(bad.problems.some((p) => p.includes('確認日が未来でない')),
    '対照が成立していない＝UTCでも弾かれない');
});

/* ---- リモートの main と CI への結び付け（第12回監査 R12-003） ---------- */

test('手元だけのコミット（origin/main と違う）なら落ちる', () => {
  failsWith(strictInputs({
    remote: { ...GOOD_REMOTE, originMainSha: '9'.repeat(40) }
  }), 'origin/main と同じ');
});

test('別のリポジトリを origin にしていたら落ちる', () => {
  failsWith(strictInputs({
    remote: { ...GOOD_REMOTE, originUrl: 'https://github.com/someone/else.git' }
  }), 'リモートが対象のリポジトリ');
});

test('いまの文書のCIが取れなければ落ちる（警告で続けない）', () => {
  failsWith(strictInputs({ metadataCi: { error: 'Service Unavailable' } }), 'いまの文書のCI');
  failsWith(strictInputs({ metadataCi: null }), 'いまの文書のCI');
});

test('いまの文書のCIが失敗していれば落ちる', () => {
  failsWith(strictInputs({ metadataCi: { ...GOOD_CI, conclusion: 'failure' } }),
    'いまの文書のCIが success');
});

test('片方のジョブだけ成功では落ちる', () => {
  failsWith(strictInputs({
    metadataCi: { ...GOOD_CI, jobs: { test: 'cancelled', windows: 'success' } }
  }), 'いまの文書のCI（test）');
  failsWith(strictInputs({
    metadataCi: { ...GOOD_CI, jobs: { test: 'success', windows: 'failure' } }
  }), 'いまの文書のCI（windows）');
});

test('別のコミットのCIでは落ちる', () => {
  failsWith(strictInputs({ metadataCi: { ...GOOD_CI, headSha: '8'.repeat(40) } }),
    'いまの文書のCIが同じコミットのもの');
});

test('PR の run では落ちる', () => {
  failsWith(strictInputs({ metadataCi: { ...GOOD_CI, event: 'pull_request', branch: 'feat/x' } }),
    'いまの文書のCIが main への push');
});

test('preflight では、リモートやCIを見ないまま通る（最終関門ではない）', () => {
  const r = validateStoreReadiness(preflightInputs({ remote: null, metadataCi: null }));
  assert.deepEqual(r.problems, [], r.problems.join('\n'));
});

/* ---- 日付（第12回監査 R12-004） ---------------------------------------- */

test('基準日そのものが日付でなければ落ちる', () => {
  failsWith(strictInputs({ today: 'not-a-date' }), '基準日');
  failsWith(strictInputs({ today: '2026-02-30' }), '基準日');
});

test('外部監査の日付が未来なら落ちる', () => {
  const cand = readyCandidate();
  const audit = goodAudit(cand);
  audit.auditDate = '2026-08-08';
  failsWith(strictInputs({ candidate: cand, audit, today: '2026-08-07' }), '外部監査の日付が未来でない');
});

/* ---- 正本が名指しする run と成果物の実在（第14回監査 R14-005） ---------- */

/*
 * ここまでの照合は、正本・成果物・記録という**手元で全部作れるもの**どうしだった。
 * run と成果物を GitHub から引いて、落としてきた実バイトのハッシュまで合わせる。
 */

test('正本の run が GitHub にあり、成果物のハッシュも一致すれば通る（R14-005）', () => {
  const r = validateStoreReadiness(strictInputs());
  assert.deepEqual(r.problems, [], r.problems.join('\n'));
  assert.ok(r.ok.some((line) => line.includes('正本の run が実在')),
    '検査そのものが走っていない');
});

test('run の番号が正本と違えば落ちる（R14-005）', () => {
  const cand = readyCandidate();
  failsWith(strictInputs({
    runtime: goodRuntime(cand, { run: { ...goodRuntime(cand).run, id: '999999' } })
  }), '正本の run が実在し、番号が一致');
});

test('別のワークフローの run なら落ちる（R14-005）', () => {
  const cand = readyCandidate();
  failsWith(strictInputs({
    runtime: goodRuntime(cand, {
      run: { ...goodRuntime(cand).run, path: '.github/workflows/release.yml' }
    })
  }), '期待するワークフロー');
});

test('main への push でない run なら落ちる（R14-005）', () => {
  const cand = readyCandidate();
  for (const over of [{ event: 'pull_request' }, { branch: 'feat/x' }]) {
    failsWith(strictInputs({
      runtime: goodRuntime(cand, { run: { ...goodRuntime(cand).run, ...over } })
    }), '正本の run が main への push');
  }
});

test('run のコミットが正本と違えば落ちる（R14-005）', () => {
  const cand = readyCandidate();
  failsWith(strictInputs({
    runtime: goodRuntime(cand, { run: { ...goodRuntime(cand).run, headSha: '9'.repeat(40) } })
  }), '正本の run が正本のコミットのもの');
});

test('run が success でなければ落ちる（R14-005）', () => {
  const cand = readyCandidate();
  failsWith(strictInputs({
    runtime: goodRuntime(cand, { run: { ...goodRuntime(cand).run, conclusion: 'failure' } })
  }), '正本の run が success');
});

test('片方のジョブしか success でなければ落ちる（R14-005）', () => {
  const cand = readyCandidate();
  for (const jobs of [{ test: 'success', windows: 'failure' },
                      { test: 'failure', windows: 'success' },
                      { test: 'success' }]) {
    failsWith(strictInputs({
      runtime: goodRuntime(cand, { run: { ...goodRuntime(cand).run, jobs } })
    }), '正本の run（');
  }
});

test('その run に正本の成果物が無ければ落ちる（R14-005）', () => {
  const cand = readyCandidate();
  failsWith(strictInputs({
    runtime: goodRuntime(cand, { artifact: { name: null, expired: null, digest: null } })
  }), '正本の成果物がその run にある');
});

test('成果物が失効していたら落ちる（R14-005）', () => {
  const cand = readyCandidate();
  failsWith(strictInputs({
    runtime: goodRuntime(cand, {
      artifact: { name: cand.artifactName, expired: true, digest: `sha256:${OUTER_SHA}` }
    })
  }), '失効していない');
});

test('GitHub 側の digest と実バイトが違えば落ちる（R14-005）', () => {
  const cand = readyCandidate();
  failsWith(strictInputs({
    runtime: goodRuntime(cand, {
      artifact: { name: cand.artifactName, expired: false, digest: `sha256:${'0'.repeat(64)}` }
    })
  }), 'GitHub 側と同じ');
});

test('成果物の実バイトを渡していなければ、digest は比べられないので落ちる（R14-005）', () => {
  const cand = readyCandidate();
  const art = fakeArtifact(cand);
  delete art.outerSha256;
  failsWith(strictInputs({ artifact: art }), 'GitHub 側と同じ');
});

test('GitHub API を引けなかったら通さない（R14-005）', () => {
  for (const runtime of [{ error: 'Service Unavailable' }, { error: 'rate limit' }, null]) {
    failsWith(strictInputs({ runtime }), '正本の run — 確かめられなかった');
  }
});

test('候補がまだ無い（pending）ときは、run の照合を求めない（R14-005）', () => {
  /* 作り直している最中に、存在しない run を要求して止めない */
  const r = validateStoreReadiness(strictInputs({
    candidate: { ...readyCandidate(), status: 'pending_main_ci' }, runtime: null
  }));
  /* 「正本の runId が空のまま」とは別物なので、needle を取り違えないこと */
  assert.ok(!r.problems.some((p) => p.startsWith('正本の run —') || p.includes('正本の run が')),
    `pending なのに run を求めている:\n${r.problems.join('\n')}`);
});
