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
import { inflateRawSync } from 'node:zlib';
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
  }, /GITHUB_SHA が一致しない/],
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

/*
 * ZIPを読む最小限の実装。書く側（scripts/package.mjs）と別に用意して、
 * 「書いたものが本当に読めるか」を独立に確かめる。
 *
 * 第7回監査 R7-004: 最初の版は CRC32 を見ておらず、標準の unzip が
 * 「bad CRC」で拒否する壊れたZIPを素通りさせていた。読み手が甘いと、
 * 「11ファイルあってハッシュも一致」という報告が壊れた成果物にも出てしまう。
 * 中央ディレクトリとローカルヘッダの食い違いも見る。
 */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('ZIPの終端レコードが見つからない');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央ディレクトリの署名が違う');
    const cFlags = buf.readUInt16LE(p + 8);
    const cMethod = buf.readUInt16LE(p + 10);
    const cCrc = buf.readUInt32LE(p + 16);
    const cComp = buf.readUInt32LE(p + 20);
    const cRaw = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    if (cFlags & 0x0001) throw new Error(`暗号化されている: ${name}`);
    if (cFlags & 0x0008) throw new Error(`data descriptor 付きは受け取らない: ${name}`);
    if (cMethod !== 0 && cMethod !== 8) throw new Error(`知らない圧縮方式 ${cMethod}: ${name}`);
    if (seen.has(name)) throw new Error(`同じ名前が2度入っている: ${name}`);
    seen.add(name);
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\') ||
        name.split('/').includes('..')) {
      throw new Error(`危険な名前: ${name}`);
    }

    if (offset + 30 > buf.length || buf.readUInt32LE(offset) !== 0x04034b50) {
      throw new Error(`ローカルヘッダの署名が違う: ${name}`);
    }
    const lFlags = buf.readUInt16LE(offset + 6);
    const lMethod = buf.readUInt16LE(offset + 8);
    const lCrc = buf.readUInt32LE(offset + 14);
    const lComp = buf.readUInt32LE(offset + 18);
    const lRaw = buf.readUInt32LE(offset + 22);
    const lNameLen = buf.readUInt16LE(offset + 26);
    const lExtraLen = buf.readUInt16LE(offset + 28);
    const lName = buf.subarray(offset + 30, offset + 30 + lNameLen).toString('utf8');

    // 中央ディレクトリとローカルヘッダが食い違うZIPは受け取らない
    if (lName !== name) throw new Error(`名前が食い違う: ${name} / ${lName}`);
    if (lMethod !== cMethod) throw new Error(`圧縮方式が食い違う: ${name}`);
    if (lCrc !== cCrc) throw new Error(`CRCが食い違う: ${name}`);
    if (lComp !== cComp || lRaw !== cRaw) throw new Error(`サイズが食い違う: ${name}`);
    if (lFlags !== cFlags) throw new Error(`フラグが食い違う: ${name}`);

    const dataAt = offset + 30 + lNameLen + lExtraLen;
    if (dataAt + cComp > buf.length) throw new Error(`データが足りない: ${name}`);
    const body = buf.subarray(dataAt, dataAt + cComp);
    const data = cMethod === 0 ? Buffer.from(body) : inflateRawSync(body);
    if (data.length !== cRaw) throw new Error(`展開後の長さが違う: ${name}`);
    if (crc32(data) !== cCrc) throw new Error(`CRCが合わない: ${name}`);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* CRC-32（ZIPが要求するもの）。書く側とは別に、ここで独立に持つ */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/*
 * 提出物のQAで実際に起きる形を、そのまま再現する。
 *
 * Actions からダウンロードして展開したフォルダには release-manifest.json と
 * ZIP とハッシュしか入っておらず、manifest.json が無い。そのフォルダを
 * 「パッケージ化されていない拡張機能」として読み込むことはできない。
 * 内側のZIPを別のフォルダへ展開して初めて読み込める（第6回監査 R6-004）。
 */
test('成果物のフォルダには manifest.json が無く、内側のZIPを展開して初めて読み込める', () => {
  const distDir = freshDist();
  const r = buildOnce(distDir);

  // ① ダウンロードして展開したのと同じ中身
  const outer = readdirSync(distDir).sort();
  assert.deepEqual(outer, [
    'release-manifest.json',
    `reposhout-${r.version}.zip`,
    `reposhout-${r.version}.zip.sha256`
  ].sort());
  assert.equal(existsSync(join(distDir, 'manifest.json')), false,
    '成果物の直下に manifest.json がある＝この検査の前提が崩れている');

  // ② 内側のZIPを展開すると、直下に manifest.json がある
  const zip = readFileSync(join(distDir, `reposhout-${r.version}.zip`));
  const entries = readZip(zip);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('manifest.json'), `内側のZIPに manifest.json が無い: ${names}`);
  assert.equal(names.length, r.files.length, '収録件数が記録と違う');

  const extracted = join(dirname(distDir), 'unpacked');
  for (const e of entries) {
    const dest = join(extracted, e.name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, e.data);
  }
  assert.ok(existsSync(join(extracted, 'manifest.json')),
    '展開したフォルダの直下に manifest.json が無い');
  const mf = JSON.parse(readFileSync(join(extracted, 'manifest.json'), 'utf8'));
  assert.equal(mf.version, r.version, '展開した manifest の版が違う');
  assert.equal(mf.manifest_version, 3);

  // ③ 展開したものが、記録のper-fileハッシュと1件残らず一致する
  const m = JSON.parse(readFileSync(join(distDir, 'release-manifest.json'), 'utf8'));
  for (const rec of m.files) {
    const e = entries.find((x) => x.name === rec.name);
    assert.ok(e, `記録にあるファイルがZIPに無い: ${rec.name}`);
    assert.equal(createHash('sha256').update(e.data).digest('hex'), rec.sha256,
      `中身が記録と違う: ${rec.name}`);
  }
});

/*
 * 読み手が甘いと、壊れた成果物に「11ファイルあってハッシュも一致」と報告してしまう。
 * 第7回監査 R7-004 では、CRCを1ビット変えたZIPを標準の unzip は拒否したのに、
 * こちらの読み手は素通りさせた。壊し方ごとに、拒否できることを確かめる。
 */
test('壊したZIPを、読み手がちゃんと拒否する（R7-004の回帰）', () => {
  const distDir = freshDist();
  const r = buildOnce(distDir);
  const zipPath = join(distDir, `reposhout-${r.version}.zip`);
  const good = readFileSync(zipPath);

  // まず正常なものは読めること（対照）
  assert.equal(readZip(good).length, r.files.length);

  const at = (buf, sig, from = 0) => buf.indexOf(Buffer.from(sig), from);
  const LOCAL = [0x50, 0x4b, 0x03, 0x04];
  const CENTRAL = [0x50, 0x4b, 0x01, 0x02];

  const mutations = {
    'CRCを1ビット変える（中央とローカルの両方）': (b) => {
      const l = at(b, LOCAL), c = at(b, CENTRAL);
      b.writeUInt32LE((b.readUInt32LE(l + 14) ^ 1) >>> 0, l + 14);
      b.writeUInt32LE((b.readUInt32LE(c + 16) ^ 1) >>> 0, c + 16);
    },
    '中央とローカルでCRCを食い違わせる': (b) => {
      const c = at(b, CENTRAL);
      b.writeUInt32LE((b.readUInt32LE(c + 16) ^ 1) >>> 0, c + 16);
    },
    '中央とローカルで圧縮方式を食い違わせる': (b) => {
      const c = at(b, CENTRAL);
      b.writeUInt16LE(b.readUInt16LE(c + 10) === 8 ? 0 : 8, c + 10);
    },
    '知らない圧縮方式にする': (b) => {
      const l = at(b, LOCAL), c = at(b, CENTRAL);
      b.writeUInt16LE(99, l + 8);
      b.writeUInt16LE(99, c + 10);
    },
    '暗号化フラグを立てる': (b) => {
      const l = at(b, LOCAL), c = at(b, CENTRAL);
      b.writeUInt16LE(b.readUInt16LE(l + 6) | 0x0001, l + 6);
      b.writeUInt16LE(b.readUInt16LE(c + 8) | 0x0001, c + 8);
    },
    '中身を1バイト書き換える': (b) => {
      const l = at(b, LOCAL);
      const nameLen = b.readUInt16LE(l + 26);
      const extraLen = b.readUInt16LE(l + 28);
      const data = l + 30 + nameLen + extraLen;
      b[data] = b[data] ^ 0xFF;
    },
    '末尾を切り詰める': (b) => b.subarray(0, b.length - 40)
  };

  for (const [label, mutate] of Object.entries(mutations)) {
    const broken = Buffer.from(good);
    const result = mutate(broken) || broken;
    assert.throws(() => readZip(result), (e) => e instanceof Error,
      `壊したのに読めてしまう: ${label}`);
  }
});

test('危険な名前と重複する名前を拒否する', () => {
  // 中央ディレクトリの名前だけを書き換えて確かめる（長さは変えない）
  const distDir = freshDist();
  const r = buildOnce(distDir);
  const good = readFileSync(join(distDir, `reposhout-${r.version}.zip`));
  const c = good.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const nameLen = good.readUInt16LE(c + 28);
  const nameAt = c + 46;
  assert.equal(good.subarray(nameAt, nameAt + nameLen).toString(), 'manifest.json');

  for (const evil of ['../manifest.jso', '/manifest.json', 'a\\manifest.jso']) {
    const b = Buffer.from(good);
    Buffer.from(evil.padEnd(nameLen, '_').slice(0, nameLen)).copy(b, nameAt);
    assert.throws(() => readZip(b), /危険な名前|名前が食い違う/, `拒否できない: ${evil}`);
  }
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
