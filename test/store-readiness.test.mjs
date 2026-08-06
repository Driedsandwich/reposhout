/*
 * 提出前の関門が、でたらめな値を通さないことを確かめる
 *
 * 第9回で作った関門にはテストが1つも無く、第10回監査 R10-002 で次のとおり
 * **全部 ✅ になって「すべてそろっています」と表示する**ことが実測で示された。
 *
 *   成果物名 40桁の0 / SHA 64桁の0 / 確認日 not-a-date / 設問文 空白1文字 /
 *   3つの証明すべて未チェック / ポリシーURL http://invalid.example
 *
 * ここでは「正しい入力」を1つ作り、そこから1箇所ずつ壊して、そのたびに
 * 落ちることを見る。落ちない壊し方があれば、その検査は無い。
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

/* 本人の確認が済んだ状態を作る（実ファイルは pending のまま。ここだけの仮定） */
function confirmedDisclosure() {
  const d = clone(DISCLOSURE);
  for (const c of d.categories) {
    if (c.confirmationStatus !== 'pending') continue;
    c.confirmationStatus = 'confirmed';
    c.answer = c.proposedAnswer;
    c.ownerConfirmation = {
      dashboardQuestionText: 'Does your extension handle authentication information?',
      confirmedOn: '2026-08-06',
      chosen: c.proposedAnswer,
      reason: 'ダッシュボードの現行の設問文を読んで判断した（テスト用の仮の値）'
    };
  }
  return d;
}

function goodInputs(over = {}) {
  return {
    disclosure: confirmedDisclosure(),
    candidate: clone(CANDIDATE),
    manifestVersion: JSON.parse(read('manifest.json')).version,
    packageVersion: JSON.parse(read('package.json')).version,
    privacy: read('PRIVACY.md'),
    listing: read('store/LISTING.md'),
    dashboardChanges: read('store/STORE_DASHBOARD_CHANGES.md'),
    today: '2026-08-06',
    artifact: null,
    audit: null,
    sha256,
    ...over
  };
}

const run = (over) => validateStoreReadiness(goodInputs(over));
/* 壊した1点が、実際に問題として出ているか */
function failsWith(over, needle) {
  const r = run(over);
  assert.ok(r.problems.length > 0, `落ちるべきなのに通った: ${needle}`);
  assert.ok(r.problems.some((p) => p.includes(needle)),
    `別の理由で落ちている。期待「${needle}」実際:\n${r.problems.join('\n')}`);
}

/* ---- 対照: 正しい入力なら通る ------------------------------------------ */
test('確認が済んだ状態なら、問題ゼロで通る', () => {
  const r = run({});
  assert.deepEqual(r.problems, [], `通るべきなのに落ちた:\n${r.problems.join('\n')}`);
  assert.ok(r.ok.length > 20, `検査が少なすぎる: ${r.ok.length} 件`);
});

/* ---- いまのリポジトリの実状態 ------------------------------------------ */
test('いまの実ファイルは、本人の確認待ち2件だけで落ちる', () => {
  const r = validateStoreReadiness(goodInputs({ disclosure: clone(DISCLOSURE) }));
  const pending = r.problems.filter((p) => p.includes('本人の確認がまだ'));
  assert.equal(pending.length, 2, `確認待ちが2件でない:\n${r.problems.join('\n')}`);
  assert.equal(r.problems.length, 2,
    `確認待ち以外の問題が出ている:\n${r.problems.join('\n')}`);
});

/* ---- 本人確認の欄 ------------------------------------------------------ */
test('確認欄が空白だけなら落ちる', () => {
  const d = confirmedDisclosure();
  d.categories.find((c) => c.id === 'authentication_information')
    .ownerConfirmation.dashboardQuestionText = '   ';
  failsWith({ disclosure: d }, 'の読んだ設問文');
});

test('理由が空白だけなら落ちる', () => {
  const d = confirmedDisclosure();
  d.categories.find((c) => c.id === 'user_activity').ownerConfirmation.reason = '\t\n ';
  failsWith({ disclosure: d }, 'の理由');
});

test('確認日が日付の形でなければ落ちる', () => {
  const d = confirmedDisclosure();
  d.categories.find((c) => c.id === 'user_activity').ownerConfirmation.confirmedOn = 'not-a-date';
  failsWith({ disclosure: d }, 'の確認した日');
});

test('存在しない日付なら落ちる', () => {
  const d = confirmedDisclosure();
  d.categories.find((c) => c.id === 'user_activity').ownerConfirmation.confirmedOn = '2026-02-30';
  failsWith({ disclosure: d }, 'の確認した日');
});

test('確認日が未来なら落ちる', () => {
  const d = confirmedDisclosure();
  d.categories.find((c) => c.id === 'user_activity').ownerConfirmation.confirmedOn = '2026-08-07';
  failsWith({ disclosure: d, today: '2026-08-06' }, '確認日が未来でない');
});

test('答えと、本人が選んだ答えが食い違えば落ちる', () => {
  const d = confirmedDisclosure();
  const c = d.categories.find((x) => x.id === 'authentication_information');
  c.answer = 'Yes';   // chosen は 'No' のまま
  failsWith({ disclosure: d }, 'の一致');
});

test('確認が済んでいないのに答えを入れていても、確認待ちとして落ちる', () => {
  const d = clone(DISCLOSURE);
  d.categories.find((c) => c.id === 'user_activity').answer = 'No';
  failsWith({ disclosure: d }, '本人の確認がまだ');
});

/* ---- 3つの証明 --------------------------------------------------------- */
test('証明のチェックが1つでも外れていれば落ちる', () => {
  const d = confirmedDisclosure();
  d.certifications[1].checked = false;
  failsWith({ disclosure: d }, `証明 ${DISCLOSURE.certifications[1].id}`);
});

/* ---- ポリシーURL ------------------------------------------------------- */
test('ポリシーURLがHTTPなら落ちる', () => {
  const d = confirmedDisclosure();
  d.privacyPolicyUrl = 'http://invalid.example';
  failsWith({ disclosure: d }, 'ポリシーURLがHTTPS');
});

test('ポリシーURLが正本と違えば落ちる', () => {
  const d = confirmedDisclosure();
  d.privacyPolicyUrl = 'https://example.com/privacy';
  failsWith({ disclosure: d }, 'ポリシーURLが正本と一致');
});

/* ---- 出す成果物 -------------------------------------------------------- */
test('成果物名が桁数だけ合っていても、正本と違えば落ちる', () => {
  const cand = clone(CANDIDATE);
  cand.artifactName = `reposhout-package-${'0'.repeat(40)}`;
  cand.sourceCommit = '0'.repeat(40);
  failsWith({ candidate: cand }, '成果物名が正本と一致');
});

test('ハッシュが64桁の0でも落ちる', () => {
  const cand = clone(CANDIDATE);
  cand.innerSha256 = '0'.repeat(64);
  failsWith({ candidate: cand }, '中身のZIPのハッシュが正本と一致');
});

test('文書に、正本に無いコミットが書いてあれば落ちる', () => {
  const listing = read('store/LISTING.md') +
    '\n現在の main は ce48958 です（この手の記述は翌日には古くなる）。\n';
  failsWith({ listing }, '古くなるコミットを書いていない');
});

/* ---- 提出手順 ---------------------------------------------------------- */
test('更新手順が Privacy practices を必須と書いていなければ落ちる', () => {
  const listing = read('store/LISTING.md')
    .replace(/§0 事前確認・§1 パッケージ・§2 Store listing・§3 Privacy practices を\n> すべて完了させてください/,
             '§1 と §2 だけを直せば足ります');
  failsWith({ listing }, 'Privacy practices も必須と書いてある');
});

test('手元ビルドを提出用として案内していれば落ちる', () => {
  const dashboardChanges = read('store/STORE_DASHBOARD_CHANGES.md') +
    '\n`npm run package` で作れます。\n';
  failsWith({ dashboardChanges }, 'store/STORE_DASHBOARD_CHANGES.md の案内');
});

/* ---- プライバシーポリシーの言い過ぎ ------------------------------------ */
test('「人は誰も読まない」と断定していれば落ちる', () => {
  const privacy = read('PRIVACY.md') +
    '\nNo human — including the developer — reads this data.\n';
  failsWith({ privacy }, 'Limited Use の書き方');
});

test('「受け取れるサーバーも存在しません」と限定なしに書いていれば落ちる', () => {
  const privacy = read('PRIVACY.md') + '\n受け取れるサーバーも存在しません。\n';
  failsWith({ privacy }, 'Limited Use の書き方');
});

test('「何も保存しない」と断定していれば落ちる', () => {
  const privacy = read('PRIVACY.md') + '\nNothing is retained.\n';
  failsWith({ privacy }, 'Limited Use の書き方');
});

test('人手閲覧の限定が消えていれば落ちる', () => {
  /* 本文は行で折り返されているので、空白をまたいで消す */
  const privacy = read('PRIVACY.md')
    .replace(/human review by the developer or\s+anyone acting on the developer's behalf/,
             'human review');
  failsWith({ privacy }, '人手閲覧の限定（英語）');
});

test('遵守声明そのものが無ければ落ちる', () => {
  const privacy = read('PRIVACY.md')
    .replace('adheres to the Chrome Web Store User Data Policy', 'follows some policy');
  failsWith({ privacy }, 'Limited Use の遵守声明（英語）');
});

/* ---- 実物の成果物 ------------------------------------------------------ */
const INNER = Buffer.from('これは中身のZIPの代わり（大きさとハッシュだけ見る）', 'utf8');
function fakeArtifact(over = {}) {
  const inner = over.inner || INNER;
  const rm = {
    version: CANDIDATE.version,
    sourceCommit: CANDIDATE.sourceCommit,
    treeSha: CANDIDATE.treeSha,
    dirty: false,
    submittable: true,
    zip: { name: CANDIDATE.innerName, bytes: inner.length, sha256: sha256(inner) },
    ci: { eventName: 'push', ref: 'refs/heads/main', runId: CANDIDATE.runId },
    ...(over.manifest || {})
  };
  return {
    outerName: over.outerName || CANDIDATE.artifactName,
    files: [
      { name: 'release-manifest.json', data: Buffer.from(JSON.stringify(rm), 'utf8') },
      { name: CANDIDATE.innerName, data: inner },
      { name: `${CANDIDATE.innerName}.sha256`, data: Buffer.from(`${sha256(inner)}  ${CANDIDATE.innerName}\n`, 'utf8') }
    ]
  };
}

/* 正本のハッシュ・大きさを、この作り物に合わせた候補 */
function candidateFor(inner) {
  const cand = clone(CANDIDATE);
  cand.innerSha256 = sha256(inner);
  cand.innerBytes = inner.length;
  return cand;
}
function listingFor(cand) {
  return read('store/LISTING.md')
    .replace(CANDIDATE.innerSha256, cand.innerSha256);
}

test('実物の成果物が正本どおりなら、成果物の検査も通る', () => {
  const cand = candidateFor(INNER);
  const r = validateStoreReadiness(goodInputs({
    candidate: cand, listing: listingFor(cand), artifact: fakeArtifact()
  }));
  assert.deepEqual(r.problems, [], r.problems.join('\n'));
  assert.equal(r.artifactChecked, true, '成果物を見たことになっていない');
});

test('中身のZIPのハッシュが正本と違えば落ちる', () => {
  const cand = candidateFor(INNER);
  const other = Buffer.from('別のZIP', 'utf8');
  failsWith({
    candidate: cand, listing: listingFor(cand),
    artifact: fakeArtifact({ inner: other })
  }, '中身のZIPの実ハッシュ');
});

test('成果物の名前が正本と違えば落ちる', () => {
  const cand = candidateFor(INNER);
  failsWith({
    candidate: cand, listing: listingFor(cand),
    artifact: fakeArtifact({ outerName: `reposhout-package-${'0'.repeat(40)}` })
  }, '成果物の名前');
});

test('PRで作られた成果物なら落ちる', () => {
  const cand = candidateFor(INNER);
  failsWith({
    candidate: cand, listing: listingFor(cand),
    artifact: fakeArtifact({ manifest: { ci: { eventName: 'pull_request', ref: 'refs/pull/9/merge', runId: CANDIDATE.runId } } })
  }, 'main への push で作られた');
});

test('別のコミットから作られた成果物なら落ちる', () => {
  const cand = candidateFor(INNER);
  failsWith({
    candidate: cand, listing: listingFor(cand),
    artifact: fakeArtifact({ manifest: { sourceCommit: 'e68c81e38e74524b00a28839d70099924c14a87a' } })
  }, '記録のコミット');
});

test('未コミットの変更がある状態で作られた成果物なら落ちる', () => {
  const cand = candidateFor(INNER);
  failsWith({
    candidate: cand, listing: listingFor(cand),
    artifact: fakeArtifact({ manifest: { dirty: true } })
  }, '未コミットの変更が無い状態');
});

test('成果物を渡さなければ、実物は見ていないことが分かる', () => {
  const r = run({});
  assert.equal(r.artifactChecked, false);
});

/* ---- 外部監査の申告 ---------------------------------------------------- */
test('外部監査が NOT_READY なら落ちる', () => {
  failsWith({
    audit: {
      verdict: 'NOT_READY', sourceCommit: CANDIDATE.sourceCommit,
      reportSha256: 'a'.repeat(64), date: '2026-08-06'
    }
  }, '外部監査の判定');
});

test('外部監査が別のコミットを見ていれば落ちる', () => {
  failsWith({
    audit: {
      verdict: 'READY', sourceCommit: 'e68c81e38e74524b00a28839d70099924c14a87a',
      reportSha256: 'a'.repeat(64), date: '2026-08-06'
    }
  }, '外部監査が見たコミット');
});

test('外部監査の申告が無ければ、見ていないことが分かる', () => {
  const r = run({});
  assert.equal(r.auditChecked, false, '監査を見たことになっている');
});

/* ---- 版 ---------------------------------------------------------------- */
test('版が食い違えば落ちる', () => {
  failsWith({ packageVersion: '1.1.8' }, '版の一致');
});

test('正本の版が食い違っても落ちる', () => {
  const cand = clone(CANDIDATE);
  cand.version = '1.1.6';
  failsWith({ candidate: cand }, '版の一致');
});
