/*
 * 配布物の作り方を、実際に失敗させて確かめる
 *
 * これまでは「作れること」しか見ていなかった。第5回監査 R5-002 の指摘は
 * 「途中で失敗したら前の成果物まで消える」で、成功する経路をいくら回しても出ない。
 * ここでは書き込みを1つずつ壊して、そのたびに
 *
 *   ① 前に作った正常な成果物が残っているか
 *   ② 中途半端なファイルが残っていないか
 *   ③ 作業用ディレクトリが残っていないか
 *   ④ 終了コードが0でないか（例外が出るか）
 *
 * を見る。dist/ は一時ディレクトリへ向けるので、実際の dist/ には触らない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { makePackage, realIo } from '../scripts/package.mjs';

/* 「未コミットの変更なし・既知のコミット」を装う git */
const CLEAN_COMMIT = '4db83f086735db360443f4d45512702f38ca5936';
const CLEAN_TREE = '1111111111111111111111111111111111111111';
const fakeGit = ({ dirty = false } = {}) => (args) => {
  if (args[0] === 'status') return dirty ? ' M src/share.js' : '';
  if (args[1] === 'HEAD') return CLEAN_COMMIT;
  if (args[1] === 'HEAD^{tree}') return CLEAN_TREE;
  return null;
};

/* 提出候補になる唯一の経路＝main への push */
const mainPushEnv = (sha = CLEAN_COMMIT) => ({
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_RUN_ID: '999',
  GITHUB_SHA: sha
});

function freshDist() {
  const base = mkdtempSync(join(tmpdir(), 'reposhout-dist-'));
  return join(base, 'dist');
}

/*
 * n回目の write、または dist への配置だけ失敗する io。
 *
 * failRename: 'once'  … 1回だけ失敗する（一時的な失敗。元に戻せるはず）
 *             'always' … 配置も復旧も失敗し続ける（戻せない状況）
 */
function faultyIo({ failWrite = null, failRename = null }) {
  let writes = 0;
  let renameFailures = 0;
  return {
    ...realIo,
    writeFileSync(p, data, enc) {
      writes++;
      if (failWrite && writes === failWrite) throw new Error(`書き込み失敗を注入: ${basename(p)}`);
      return writeFileSync(p, data, enc);
    },
    renameSync(a, b) {
      // dist への配置だけ失敗させる（古い dist を退避するリネームは通す）
      if (failRename && basename(b) === 'dist') {
        renameFailures++;
        if (failRename === 'always' || renameFailures === 1) {
          throw new Error('最終配置の失敗を注入');
        }
      }
      return renameSync(a, b);
    }
  };
}

const leftovers = (distDir) => readdirSync(dirname(distDir)).filter((n) => n !== 'dist');

function buildOnce(distDir, extra = {}) {
  return makePackage({ distDir, git: fakeGit(), env: mainPushEnv(), ...extra });
}

test('通常のビルドが3点そろって出来て、記録が実物と一致する', () => {
  const distDir = freshDist();
  const r = buildOnce(distDir);
  assert.equal(r.written, true);
  assert.equal(r.submittable, true);

  const names = readdirSync(distDir).sort();
  const zipName = `reposhout-${r.version}.zip`;
  assert.deepEqual(names, [zipName, `${zipName}.sha256`, 'release-manifest.json'].sort());

  const zip = readFileSync(join(distDir, zipName));
  assert.equal(createHash('sha256').update(zip).digest('hex'), r.sha256);
  assert.equal(readFileSync(join(distDir, `${zipName}.sha256`), 'utf8'), `${r.sha256}  ${zipName}\n`);

  const m = JSON.parse(readFileSync(join(distDir, 'release-manifest.json'), 'utf8'));
  assert.equal(m.zip.name, zipName, '記録のZIP名が実ファイル名と一致していない');
  assert.equal(m.zip.sha256, r.sha256);
  assert.equal(m.zip.bytes, zip.length);
  assert.equal(m.sourceCommit, CLEAN_COMMIT);
  assert.equal(m.treeSha, CLEAN_TREE);
  assert.equal(m.submittable, true);
  assert.equal(m.notSubmittableBecause, null);
  assert.equal(leftovers(distDir).length, 0, '作業用ディレクトリが残っている');
});

/*
 * 本題。1回成功させたあと、次のビルドを1か所ずつ壊す。
 * 壊れたビルドのあとも「1回目の成果物」がそのまま残っていなければならない。
 */
for (const [label, opts] of [
  ['ZIPの書き込みが失敗しても', { failWrite: 1 }],
  ['ハッシュファイルの書き込みが失敗しても', { failWrite: 2 }],
  ['記録の書き込みが失敗しても', { failWrite: 3 }],
  ['最後の入れ替えが一時的に失敗しても', { failRename: 'once' }]
]) {
  test(`${label}、前の成果物が残る`, () => {
    const distDir = freshDist();
    const first = buildOnce(distDir);
    const zipName = `reposhout-${first.version}.zip`;
    const before = readFileSync(join(distDir, zipName));
    const beforeNames = readdirSync(distDir).sort();

    assert.throws(
      () => buildOnce(distDir, { io: faultyIo(opts) }),
      /注入/,
      '失敗を注入したのに例外が出ていない'
    );

    assert.ok(existsSync(distDir), 'dist が消えた');
    assert.deepEqual(readdirSync(distDir).sort(), beforeNames, '中身が入れ替わっている');
    assert.deepEqual(readFileSync(join(distDir, zipName)), before, '前のZIPが壊れている');
    assert.equal(
      readFileSync(join(distDir, `${zipName}.sha256`), 'utf8'),
      `${first.sha256}  ${zipName}\n`,
      '前のハッシュファイルが壊れている'
    );
    assert.equal(leftovers(distDir).length, 0, `作業用の残骸がある: ${leftovers(distDir)}`);
  });
}

/*
 * 入れ替えにも復旧にも失敗する状況。ここは元の場所へは戻せない。
 * せめて「前の成果物がどこにあるか」を例外に書いて落ちること。
 */
test('入れ替えも復旧も失敗するときは、前の成果物の在処を言って落ちる', () => {
  const distDir = freshDist();
  const first = buildOnce(distDir);
  const zipName = `reposhout-${first.version}.zip`;
  const before = readFileSync(join(distDir, zipName));

  let thrown = null;
  try {
    buildOnce(distDir, { io: faultyIo({ failRename: 'always' }) });
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, '失敗を注入したのに例外が出ていない');
  assert.match(thrown.message, /前の成果物は .+ に残っています/);

  const parked = thrown.message.match(/前の成果物は (.+?) に残っています/)[1];
  assert.ok(existsSync(join(parked, zipName)), `言っている場所に前の成果物が無い: ${parked}`);
  assert.deepEqual(readFileSync(join(parked, zipName)), before, '前のZIPが壊れている');
  assert.equal(existsSync(distDir), false, 'dist があるなら退避と言うのはおかしい');

  // 作業用ディレクトリは片付いていること（残るのは退避したものだけ）
  const rest = leftovers(distDir).filter((n) => n.includes('staging'));
  assert.deepEqual(rest, [], `作業用の残骸がある: ${rest}`);
});

/*
 * この検査が本当に効いているかの対照。
 * 「先に dist を消してから書く」旧方式を再現すると、同じ検査が必ず落ちる。
 */
test('検査が効いているかの対照（先に消す旧方式なら前の成果物は失われる）', () => {
  const distDir = freshDist();
  const first = buildOnce(distDir);
  const zipName = `reposhout-${first.version}.zip`;
  assert.ok(existsSync(join(distDir, zipName)));

  // 旧 scripts/package.mjs と同じ順序：消す → 作る → 書く（ここで失敗）
  assert.throws(() => {
    rmSync(distDir, { recursive: true, force: true });
    mkdirSync(distDir, { recursive: true });
    throw new Error('書き込み失敗を注入');
  }, /注入/);

  assert.equal(existsSync(join(distDir, zipName)), false,
    '旧方式でも前の成果物が残ってしまう＝この対照は成立していない');
});

test('未コミットの変更があるとき、提出用の名前では作らない', () => {
  const distDir = freshDist();
  assert.throws(
    () => makePackage({ distDir, git: fakeGit({ dirty: true }), env: mainPushEnv() }),
    /未コミットの変更があります/
  );
  assert.equal(existsSync(distDir), false, '失敗したのに dist を作っている');
});

test('--allow-dirty のとき、ファイル名と記録の名前が一致する', () => {
  const distDir = freshDist();
  const r = makePackage({ distDir, git: fakeGit({ dirty: true }), env: {}, allowDirty: true });
  const expected = `reposhout-${r.version}-dirty-NON-SUBMITTABLE.zip`;

  assert.equal(basename(r.file), expected);
  assert.ok(existsSync(join(distDir, expected)), '-dirty の名前で出来ていない');
  const m = JSON.parse(readFileSync(join(distDir, 'release-manifest.json'), 'utf8'));
  assert.equal(m.zip.name, expected, '記録が提出用の名前のままになっている');
  assert.equal(m.dirty, true);
  assert.equal(m.submittable, false);
  assert.ok(m.notSubmittableBecause.some((s) => s.includes('未コミット')));
  assert.equal(readFileSync(join(distDir, `${expected}.sha256`), 'utf8'), `${r.sha256}  ${expected}\n`);
});

test('CI では --allow-dirty を使えない', () => {
  const distDir = freshDist();
  assert.throws(
    () => makePackage({ distDir, git: fakeGit({ dirty: true }), env: { CI: 'true' }, allowDirty: true }),
    /CI では --allow-dirty を使えません/
  );
});

test('PRの検証ビルドは、名前と記録の両方で提出候補と区別される', () => {
  const distDir = freshDist();
  const env = {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REF: 'refs/pull/4/merge',
    GITHUB_RUN_ID: '123',
    GITHUB_SHA: '0b8be2aabb062fab7f443435a5435aa3a722d1ff',
    PR_HEAD_SHA: 'e79b4a158d0f7ea1b96659e68311afa1462b6490',
    PR_BASE_SHA: 'b1d9a41000000000000000000000000000000000'
  };
  const r = makePackage({ distDir, git: fakeGit(), env });
  const expected = `reposhout-${r.version}-NON-SUBMITTABLE.zip`;

  assert.equal(basename(r.file), expected, 'PRビルドが提出候補と同じ名前になっている');
  assert.equal(r.submittable, false);
  const m = JSON.parse(readFileSync(join(distDir, 'release-manifest.json'), 'utf8'));
  assert.equal(m.zip.name, expected);
  assert.equal(m.submittable, false);
  assert.equal(m.ci.eventName, 'pull_request');
  assert.equal(m.ci.pullRequest, 4);
  assert.equal(m.ci.githubSha, env.GITHUB_SHA, 'PR検証用の一時コミットを記録していない');
  assert.equal(m.ci.prHeadSha, env.PR_HEAD_SHA);
  assert.equal(m.ci.prBaseSha, env.PR_BASE_SHA);
  assert.notEqual(m.sourceCommit, m.ci.githubSha,
    'このテストの前提が崩れている（一時マージコミットと取り出したコミットが同じ）');
});

test('main への push で作った成果物は提出候補になる', () => {
  const distDir = freshDist();
  const env = mainPushEnv();
  const r = makePackage({ distDir, git: fakeGit(), env });
  assert.equal(basename(r.file), `reposhout-${r.version}.zip`);
  assert.equal(r.submittable, true);
  const m = JSON.parse(readFileSync(join(distDir, 'release-manifest.json'), 'utf8'));
  assert.equal(m.ci.eventName, 'push');
  assert.equal(m.ci.ref, 'refs/heads/main');
  assert.equal(m.sourceCommit, m.ci.githubSha,
    '取り出したコミットと GITHUB_SHA が一致していない');
});

/*
 * 提出候補になれるのは「main への push」だけ。
 *
 * 以前は「PRでなく、汚れてもいなければ提出候補」という消去法だったので、
 * 手元のビルドも、feature ブランチやタグから手で回した CI も提出候補に見えた
 * （第6回監査 R6-001）。workflow_dispatch は実行するブランチを選べるので、
 * これは机上の話ではない。
 */
for (const [label, env, expectReason] of [
  ['手元のビルド', {}, /手元のビルド/],
  ['main で手動実行した CI', {
    CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: CLEAN_COMMIT
  }, /workflow_dispatch/],
  ['feature ブランチで手動実行した CI', {
    CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/feat/anything', GITHUB_SHA: CLEAN_COMMIT
  }, /workflow_dispatch/],
  ['タグで手動実行した CI', {
    CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/tags/v9.9.9', GITHUB_SHA: CLEAN_COMMIT
  }, /workflow_dispatch/],
  ['main 以外への push', {
    CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/feat/anything', GITHUB_SHA: CLEAN_COMMIT
  }, /main 以外の ref/],
  ['取り出したコミットと GITHUB_SHA が違う', {
    CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'f'.repeat(40)
  }, /GITHUB_SHA が一致しない/]
]) {
  test(`${label} は提出候補にならない`, () => {
    const distDir = freshDist();
    const r = makePackage({ distDir, git: fakeGit(), env });
    assert.equal(r.submittable, false, `${label} が提出候補になっている`);
    assert.equal(basename(r.file), `reposhout-${r.version}-NON-SUBMITTABLE.zip`,
      `${label} のZIPが提出用と同じ名前になっている`);
    const m = JSON.parse(readFileSync(join(distDir, 'release-manifest.json'), 'utf8'));
    assert.equal(m.submittable, false);
    assert.ok(m.notSubmittableBecause.some((s) => expectReason.test(s)),
      `理由が書かれていない: ${JSON.stringify(m.notSubmittableBecause)}`);
  });
}

test('提出可否の判定が効いているかの対照', () => {
  // 旧判定（PRでなく汚れていなければ提出可）だと、手元のビルドまで提出候補になる
  const oldPredicate = (ci, dirty) => !dirty && ci.eventName !== 'pull_request';
  assert.equal(oldPredicate({ eventName: 'local' }, false), true,
    '対照が成立していない＝旧判定でも手元ビルドを弾けてしまう');

  const r = makePackage({ distDir: freshDist(), git: fakeGit(), env: {} });
  assert.equal(r.submittable, false, '新しい判定が手元ビルドを弾いていない');
});

test('同じ入力からは同じZIPが出来る（決定論）', () => {
  const a = makePackage({ distDir: freshDist(), git: fakeGit(), env: {} });
  const b = makePackage({ distDir: freshDist(), git: fakeGit(), env: {} });
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.zipBytes, b.zipBytes);
});

test('収録するのは allowlist のファイルだけ', () => {
  const r = makePackage({ distDir: freshDist(), git: fakeGit(), env: {}, dryRun: true });
  assert.equal(r.written, false);
  assert.ok(r.files.length > 0);
  for (const f of r.files) {
    assert.ok(!f.name.startsWith('test/'), `テストが混ざっている: ${f.name}`);
    assert.ok(!f.name.startsWith('store/'), `ストア文書が混ざっている: ${f.name}`);
    assert.ok(!f.name.includes('node_modules'), `依存が混ざっている: ${f.name}`);
  }
});
