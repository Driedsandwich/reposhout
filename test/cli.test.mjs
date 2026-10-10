/*
 * 提出前の関門の CLI を、子プロセスとして実行して確かめる
 *
 * 第12回監査 R12-004。引数の読み方が緩く、`--today not-a-date` を渡すと
 * 未来日の検査が黙って飛んでいた。知らない指定・二度書き・値なしも
 * 素通りしていた。ここでは**終了コード**で確かめる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { makeInnerZip, makeStoredZip } from './helpers/zip-write.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts/verify-store-readiness.mjs');

function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

test('知らない指定は終了コード2で止まる', () => {
  const r = run(['--bogus']);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /知らない指定/);
});

test('同じ指定を二度書いたら止まる', () => {
  const r = run(['--today', '2026-08-07', '--today', '2026-08-06']);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /二度/);
});

test('値のない指定は止まる', () => {
  const r = run(['--artifact']);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /値が要ります/);
});

test('日付として読めない --today は止まる（検査を飛ばさない）', () => {
  const r = run(['--today', 'not-a-date']);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /YYYY-MM-DD/);
});

test('存在しない日付の --today も止まる', () => {
  assert.equal(run(['--today', '2026-02-30']).code, 2);
});

test('時間帯として読めない --timezone は止まる', () => {
  const r = run(['--timezone', 'Not/AZone']);
  assert.equal(r.code, 2, r.err);
});

test('日付を渡しても、読めない時刻帯は止まり、実在しない日は倒れずに止まる（R27-111）', () => {
  /*
   * 第27回監査 R27-111。`--today` を渡すと時刻帯の検査（dateIn）が呼ばれず、
   * `--today 2026-10-10 --timezone Not/AZone` が通った。`2026-99-99` は toISOString で倒れていた。
   */
  const r = run(['--today', '2026-10-10', '--timezone', 'Not/AZone']);
  assert.equal(r.code, 2, `GXS_MARK.X29 日付を渡すと読めない時刻帯が通る: ${r.err}`);
  assert.match(r.err, /時間帯として読めません/, `止まった理由が違う: ${r.err}`);
  const bad = run(['--today', '2026-99-99']);
  assert.equal(bad.code, 2, `実在しない日で倒れている（exit ${bad.code}）: ${bad.err.slice(0, 200)}`);
  assert.match(bad.err, /YYYY-MM-DD/, `理由を言わずに倒れている: ${bad.err.slice(0, 200)}`);
  /* 対照: 正しい時刻帯を渡せば、その時刻帯を基準日の表示に出す */
  const ok = run(['--today', '2026-10-10', '--timezone', 'UTC']);
  assert.match(ok.out, /基準日: 2026-10-10（UTC）/, `使った時刻帯を表示していない: ${ok.out.slice(-200)}`);
});

test('読めない申告ファイルは、理由を出して止まる', () => {
  const r = run(['--strict', '--audit-attestation', join(ROOT, 'package.json'), '--audit-report', join(ROOT, 'README.md')]);
  // package.json は JSON として読めるので、ここは「止まらない」ことだけ見る（別の理由で1になる）
  assert.notEqual(r.code, 2, r.err);
  const bad = run(['--strict', '--audit-attestation', join(ROOT, 'README.md')]);
  assert.equal(bad.code, 2, bad.err);
  assert.match(bad.err, /申告が読めません/);
});

test('preflight は、いまの状態では本人確認待ちで1になる', () => {
  const r = run([]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /本人の確認がまだ/);
  assert.match(r.out, /ここが埋まるまで提出しないでください/);
  /* preflight を「最終関門」と読ませない文言が、成功時に出る側にあること */
  assert.match(readFileSync(CLI, 'utf8'), /これは「提出してよい」という意味ではありません（preflight）/);
});

test('strict は、成果物も監査も無いので1になる', () => {
  const r = run(['--strict']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /--artifact が要ります/);
});

/*
 * ⚠️ CLI の境界で「全部そろえば exit 0」を確かめる（第27回監査 R27-205）。
 * 本番に試験用の抜け道は足さない。代わりに、いまの作業ツリーを写した使い捨ての repo に
 * 本人の欄・Web Intent の回答・提出候補を**題材として**書き、GitHub の API と
 * `git ls-remote` だけを PATH の先頭に置いた差し替えの道具で答える。
 * 本物の正本・提出の記録には一切書かない（題材は一時置き場の中だけ）。
 */
function cliFixture() {
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const dir = mkdtempSync(join(tmpdir(), 'reposhout-cli-ok-'));
  const repo = join(dir, 'repo');
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'],
    { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const f of files) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    try { copyFileSync(join(ROOT, f), join(repo, f)); } catch (e) { /* 消えたファイルは写さない */ }
  }
  const version = JSON.parse(readFileSync(join(repo, 'manifest.json'), 'utf8')).version;
  const inner = makeInnerZip();
  const innerName = `reposhout-${version}.zip`;
  const runtimeCommit = 'c'.repeat(40);
  const runtimeTree = 'd'.repeat(40);
  const runId = '424242';
  const artifactName = `reposhout-package-${runtimeCommit}`;
  const rm = { version, sourceCommit: runtimeCommit, treeSha: runtimeTree, dirty: false, submittable: true,
    zip: { name: innerName, bytes: inner.length, sha256: sha(inner) },
    ci: { eventName: 'push', ref: 'refs/heads/main', runId } };
  const outer = makeStoredZip([
    { name: 'release-manifest.json', data: Buffer.from(JSON.stringify(rm), 'utf8') },
    { name: innerName, data: inner },
    { name: `${innerName}.sha256`, data: Buffer.from(`${sha(inner)}  ${innerName}\n`, 'utf8') }
  ]);
  const outerPath = join(dir, `${artifactName}.zip`);
  writeFileSync(outerPath, outer);

  /* 題材の正本: 候補・本人の欄・Web Intent の回答（**一時置き場の写しの中だけ**） */
  const candPath = join(repo, 'store/SUBMISSION_CANDIDATE.json');
  const cand = JSON.parse(readFileSync(candPath, 'utf8'));
  const oldName = cand.artifactName; const oldSha = cand.innerSha256;
  Object.assign(cand, { status: 'ready', sourceCommit: runtimeCommit, treeSha: runtimeTree, runId,
    artifactName, innerName, innerBytes: inner.length, innerFiles: 11, innerSha256: sha(inner) });
  writeFileSync(candPath, JSON.stringify(cand, null, 2) + '\n');
  for (const f of ['store/LISTING.md', 'store/STORE_DASHBOARD_CHANGES.md']) {
    let t = readFileSync(join(repo, f), 'utf8');
    if (oldName) t = t.split(oldName).join(artifactName);
    if (oldSha) t = t.split(oldSha).join(sha(inner));
    /* 実物が「まだ無い」の形（pending_main_ci）なら、題材の値を差し込む */
    t = t.split('status : pending_main_ci\n').join('')
      .split('成果物 : まだ無い').join(`成果物 : ${artifactName}`)
      .split('SHA-256 : 未確定').join(`SHA-256 : ${sha(inner)}`)
      .split('大きさ : 未確定').join(`大きさ : ${inner.length} B / 11ファイル`);
    writeFileSync(join(repo, f), t);
  }
  const discPath = join(repo, 'store/DATA_DISCLOSURE.json');
  const disc = JSON.parse(readFileSync(discPath, 'utf8'));
  for (const c of disc.categories) {
    if (c.confirmationStatus !== 'pending') continue;
    c.confirmationStatus = 'confirmed'; c.answer = c.proposedAnswer;
    c.ownerConfirmation = { dashboardQuestionText: '（題材）設問文', confirmedOn: '2026-10-09',
      chosen: c.proposedAnswer, reason: '（題材）CLI の成功の対照のための作り物' };
  }
  writeFileSync(discPath, JSON.stringify(disc, null, 2) + '\n');
  const wiPath = join(repo, 'store/WEB_INTENT_POLICY_DECISION.json');
  const wi = JSON.parse(readFileSync(wiPath, 'utf8'));
  Object.assign(wi, { status: 'confirmed_allowed', askedOn: '2026-10-01', question: '（題材）',
    responseOn: '2026-10-05', response: '（題材）', ticket: 'FIXTURE-0000', decision: 'proceed',
    decidedBy: 'owner', appliesToVersion: version,
    questionScope: ['secure_query_transport', 'redirection_policy'], responseCoversBoth: true });
  writeFileSync(wiPath, JSON.stringify(wi, null, 2) + '\n');

  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  g('init', '-q');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture');
  g('remote', 'add', 'origin', 'https://github.com/Driedsandwich/reposhout.git');
  const head = g('rev-parse', 'HEAD');
  const tree = g('rev-parse', 'HEAD^{tree}');

  /* 差し替えの道具: gh は決まった答えだけを返す。git は ls-remote だけを答え、他は本物へ渡す */
  const jobs = { jobs: ['test', 'windows', 'mutation-coverage', 'package-candidate',
    ...[1, 2, 3, 4, 5, 6].map((i) => `mutations (${i})`)].map((name) => ({ name, conclusion: 'success' })) };
  const base = 'repos/Driedsandwich/reposhout/actions/runs';
  const answers = {
    [`${base}?head_sha=${head}&per_page=20`]: { workflow_runs: [{ id: 777, path: '.github/workflows/ci.yml',
      event: 'push', head_branch: 'main', head_sha: head, conclusion: 'success' }] },
    [`${base}/777/jobs`]: jobs,
    [`${base}/${runId}`]: { id: Number(runId), path: '.github/workflows/ci.yml', event: 'push',
      head_branch: 'main', head_sha: runtimeCommit, conclusion: 'success' },
    [`${base}/${runId}/jobs`]: jobs,
    [`${base}/${runId}/artifacts`]: { artifacts: [{ name: artifactName, expired: false, digest: `sha256:${sha(outer)}` }] }
  };
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'gh-answers.json'), JSON.stringify(answers));
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const a = process.argv.slice(2);
const m = JSON.parse(require('fs').readFileSync(${JSON.stringify(join(dir, 'gh-answers.json'))}, 'utf8'));
if (a[0] !== 'api' || !(a[1] in m)) { process.stderr.write('題材の gh が知らない問い: ' + a.join(' ')); process.exit(1); }
process.stdout.write(JSON.stringify(m[a[1]]));
`);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === 'ls-remote') { process.stdout.write(${JSON.stringify(head)} + '\\trefs/heads/main\\n'); process.exit(0); }
const r = require('child_process').spawnSync(${JSON.stringify(realGit)}, a, { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`);
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'git'), 0o755);

  const report = Buffer.from('（題材）外部監査の報告書\n', 'utf8');
  writeFileSync(join(dir, 'report.md'), report);
  const attestation = { verdict: 'READY', runtimeSourceCommit: runtimeCommit, runtimeTree, innerSha256: sha(inner),
    runtimeVersion: version, auditDate: '2026-10-09', auditor: '（題材）', reportSha256: sha(report),
    metadataSourceCommit: head, metadataTree: tree };
  const run = (over = {}, extra = []) => {
    const att = join(dir, `att-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(att, JSON.stringify({ ...attestation, ...over }));
    const r = spawnSync(process.execPath, [join(repo, 'scripts/verify-store-readiness.mjs'), '--strict',
      '--artifact', outerPath, '--audit-report', join(dir, 'report.md'), '--audit-attestation', att,
      '--today', '2026-10-10', ...extra],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
  };
  return { run };
}

test('CLI の境界で、全部そろえば exit 0・不備は 1・入力不正は 2（R27-205）',
  { skip: process.platform === 'win32' ? 'PATH の先頭に置いた差し替えの道具（#! の台本）を Windows では起動できない' : false }, () => {
  const fx = cliFixture();
  const ok = fx.run();
  assert.equal(ok.code, 0, `GXS_MARK.X35 全部そろえたのに通らない:\n${ok.out.slice(-1500)}\n${ok.err.slice(-500)}`);
  assert.match(ok.out, /中身のZIPが厳しい読み手で開ける/, 'CLI が中身の ZIP を読み手に通していない');
  const bad = fx.run({ verdict: 'NOT_READY' });
  assert.equal(bad.code, 1, `監査の判定が NOT_READY でも exit ${bad.code}`);
  const invalid = fx.run({}, ['--timezone', 'Not/AZone']);
  assert.equal(invalid.code, 2, `入力が不正なのに exit ${invalid.code}`);
});
