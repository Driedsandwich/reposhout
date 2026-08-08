/*
 * package.mjs — 提出用ZIPを決定論的に作る
 *
 * 実行: npm run package        → dist/ にZIPと .sha256 と release-manifest.json を作る
 *       npm run package:dry    → 収録物だけ表示して何も書かない
 *
 * ⚠️ 手元で走らせて出来るのは `reposhout-<version>-NON-SUBMITTABLE.zip` である。
 * 提出してよい名前（`reposhout-<version>.zip`）になるのは、main への push で走った
 * CI のときだけ（第6回監査 R6-001・第7回監査 R7-005）。中身のバイト列は同じで、
 * 違うのは名前と release-manifest.json の記録だけ。
 *
 * ZIPを手で組み立てているのは、zip コマンドがファイルの更新時刻を書き込むため。
 * 同じ内容でも作るたびにバイト列が変わり、「提出したZIPと手元のZIPが同じか」を
 * ハッシュで確かめられない。ここでは日時を固定値（1980-01-01）にして、
 * 同じ入力から必ず同じバイト列が出るようにしている。
 *
 * 注: 圧縮結果は zlib の実装に依存するため、「同じcommit・同じNode」で同一になる。
 *
 * 書き出しは「作業用ディレクトリで全部作って検算し、通ったときだけ入れ替える」方式。
 * 以前は先に dist/ を消してから書いていたので、途中で失敗すると
 * **前に作った正常な成果物まで失われ、中途半端な dist/ が残った**（第5回監査 R5-002）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PACKAGE_FILES } from './package-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/*
 * ファイル操作をここ経由にしておくと、テストから「この書き込みだけ失敗させる」
 * ことができる。失敗したときに前の成果物が残るかどうかは、実際に失敗させないと
 * 確かめられない（第5回監査の受入条件）。
 */
export const realIo = { writeFileSync, mkdirSync, rmSync, renameSync, readFileSync, existsSync };

/* git への問い合わせも差し替え可能にする（テストで「未コミット無し」の状態を作るため） */
export const realGit = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
};

/* CRC-32（ZIPが要求するもの） */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// 1980-01-01 00:00:00（DOS形式の最小値）。時刻を入力に含めないための固定値。
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const deflated = deflateRawSync(e.data, { level: 9 });
    // 圧縮して大きくなるファイル（小さなPNG等）は無圧縮で入れる
    const useStore = deflated.length >= e.data.length;
    const body = useStore ? e.data : deflated;
    const method = useStore ? 0 : 8;
    const crc = crc32(e.data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0, 6);           // flags
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);          // extra
    locals.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);          // version made by
    ch.writeUInt16LE(20, 6);          // version needed
    ch.writeUInt16LE(0, 8);           // flags
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);          // extra
    ch.writeUInt16LE(0, 32);          // comment
    ch.writeUInt16LE(0, 34);          // disk
    ch.writeUInt16LE(0, 36);          // internal attrs
    ch.writeUInt32LE(0, 38);          // external attrs
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/*
 * その成果物をストアへ出してよいかを、作った側で判定して書き残す。
 *
 * PRのCIが作るZIPは、GitHubがPR検証のために作る一時的なマージ結果から作られる。
 * それは main のどのコミットとも一致しないのに、名前は提出候補と同じだった
 * （第5回監査 R5-003）。名前と記録の両方で区別する。
 */
function readCiContext(env) {
  const eventName = env.GITHUB_ACTIONS ? (env.GITHUB_EVENT_NAME || 'unknown') : 'local';
  return {
    eventName,
    ref: env.GITHUB_REF || null,
    runId: env.GITHUB_RUN_ID || null,
    pullRequest: eventName === 'pull_request' ? Number((env.GITHUB_REF || '').split('/')[2]) || null : null,
    // pull_request では GITHUB_SHA が「PR検証用の一時マージコミット」を指す。
    // PRの head / base はワークフロー側から明示的に渡す（環境変数に既定では入らない）
    githubSha: env.GITHUB_SHA || null,
    prHeadSha: env.PR_HEAD_SHA || null,
    prBaseSha: env.PR_BASE_SHA || null,
    isCi: Boolean(env.CI)
  };
}

export function makePackage({
  dryRun = false,
  allowDirty = false,
  io = realIo,
  git = realGit,
  distDir = DIST,
  env = process.env
} = {}) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const entries = PACKAGE_FILES.map((name) => {
    const p = join(ROOT, name);
    if (!existsSync(p)) throw new Error(`配布対象が見つからない: ${name}`);
    return { name, data: readFileSync(p) };
  });

  const zip = buildZip(entries);
  const sha = createHash('sha256').update(zip).digest('hex');

  /*
   * どのコミットから作ったZIPなのかを一緒に残す。
   * ZIP自体はこの情報を含まないので、ハッシュの決定論は壊れない。
   */
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const ci = readCiContext(env);
  const dirty = git(['status', '--porcelain']) !== '';
  const sourceCommit = git(['rev-parse', 'HEAD']);
  const treeSha = git(['rev-parse', 'HEAD^{tree}']);

  /*
   * 提出してよい成果物の条件を「満たすべきものを並べて全部通ったときだけ true」にする。
   *
   * 以前は「PRでなく、汚れてもいなければ true」という消去法だった（第6回監査 R6-001）。
   * それだと手元のビルドも、feature ブランチやタグから手で回した CI も提出候補に見える。
   * `workflow_dispatch` は実行するブランチを選べるので、これは机上の話ではない。
   */
  const notSubmittableBecause = [];
  if (ci.eventName === 'local') {
    notSubmittableBecause.push('手元のビルド（CIが作ったものではない）');
  } else if (ci.eventName !== 'push') {
    notSubmittableBecause.push(`${ci.eventName} で作られている（main への push ではない）`);
  } else if (ci.ref !== 'refs/heads/main') {
    notSubmittableBecause.push(`main 以外の ref から作られている（${ci.ref}）`);
  }
  /*
   * 第7回監査 R7-005。`ci.githubSha &&` で守っていたので、GITHUB_SHA が空や欠落だと
   * 突き合わせを飛ばして提出可のままになっていた（無いものは無条件で通る＝fail-open）。
   * 揃っていることを条件にする。分からないなら提出しない側へ倒す。
   */
  const HEX40 = /^[0-9a-f]{40}$/;
  if (!HEX40.test(sourceCommit || '')) {
    notSubmittableBecause.push('取り出したコミットが分からない');
  }
  if (!HEX40.test(treeSha || '')) {
    notSubmittableBecause.push('ツリーが分からない');
  }
  if (ci.eventName !== 'local') {
    if (!HEX40.test(ci.githubSha || '')) {
      notSubmittableBecause.push('GITHUB_SHA が無い');
    } else if (sourceCommit !== ci.githubSha) {
      notSubmittableBecause.push('取り出したコミットと GITHUB_SHA が一致しない');
    }
  }
  if (dirty) notSubmittableBecause.push('未コミットの変更がある');
  const submittable = notSubmittableBecause.length === 0;

  /*
   * 名前にも書く。記録を読まずにファイルだけ拾っても間違えないように。
   * 提出してよいものだけが素の名前になる。
   */
  const marks = [dirty ? 'dirty' : null, submittable ? null : 'NON-SUBMITTABLE'].filter(Boolean);
  const finalName = `reposhout-${manifest.version}${marks.map((m) => `-${m}`).join('')}.zip`;

  const provenance = {
    version: manifest.version,
    sourceCommit,
    treeSha,
    dirty,
    submittable,
    /*
     * submittable が見ているのは「この成果物の素性」だけ——main への push で走った
     * CIが、未コミットの変更が無い状態で作ったか。**ストアへ出してよいかではない**
     * （第10回監査 R10-002）。掲載文・データ申告・外部監査・本人の確認は
     * npm run verify:store-preflight / verify:submission-ready の側で見る。
     */
    submittableMeans: 'artifact provenance eligibility only — not Chrome Web Store submission readiness',
    notSubmittableBecause: submittable ? null : notSubmittableBecause,
    ci,
    node: process.version,
    generatedFrom: 'scripts/package.mjs',
    files: entries.map((e) => ({
      name: e.name,
      bytes: e.data.length,
      sha256: createHash('sha256').update(e.data).digest('hex')
    })),
    zip: { name: finalName, bytes: zip.length, sha256: sha },
    runtimeDependencies: pkg.dependencies || {},
    testOnlyDependencies: pkg.devDependencies || {}
  };

  const report = {
    provenance,
    version: manifest.version,
    file: join(distDir, finalName),
    files: entries.map((e) => ({ name: e.name, bytes: e.data.length })),
    zipBytes: zip.length,
    sha256: sha,
    submittable,
    written: false
  };

  if (dryRun) return report;

  /*
   * 未コミットの変更があるまま「提出用」の名前でZIPを作らない。
   * 手元だけにある変更が入った成果物を、あとから履歴と突き合わせられなくなる。
   * 試したいときは --allow-dirty を付ける（名前に -dirty が入る）。
   */
  if (dirty && !allowDirty) {
    throw new Error(
      '未コミットの変更があります。コミットしてから作るか、--allow-dirty を付けてください。'
    );
  }
  if (dirty && allowDirty && ci.isCi) {
    throw new Error('CI では --allow-dirty を使えません（履歴と一致しない成果物を残さないため）。');
  }

  writeAtomically({ io, distDir, finalName, zip, sha, provenance });
  report.written = true;
  return report;
}

/*
 * 作業用ディレクトリで全部作り、読み直して検算し、通ったときだけ dist/ を置き換える。
 *
 * 途中で失敗したら作業用ディレクトリだけ消す。**前の成果物には触らない**。
 * 入れ替えはディレクトリのリネームで行う。1ファイルずつ置いていくと、
 * 「ZIPだけ新しくハッシュは古い」という食い違った状態を作りうる。
 */
function writeAtomically({ io, distDir, finalName, zip, sha, provenance }) {
  const shaText = `${sha}  ${finalName}\n`;
  const manifestText = JSON.stringify(provenance, null, 2) + '\n';
  const staging = `${distDir}.staging-${process.pid}-${Date.now()}`;
  const parked = `${distDir}.previous-${process.pid}-${Date.now()}`;

  try {
    io.mkdirSync(staging, { recursive: true });
    io.writeFileSync(join(staging, finalName), zip);
    io.writeFileSync(join(staging, `${finalName}.sha256`), shaText);
    io.writeFileSync(join(staging, 'release-manifest.json'), manifestText);

    /* 書いたものを読み直して確かめる。書き込みが黙って化けていないか */
    const backZip = io.readFileSync(join(staging, finalName));
    if (backZip.length !== zip.length) throw new Error('書き出したZIPの長さが違う');
    if (createHash('sha256').update(backZip).digest('hex') !== sha) {
      throw new Error('書き出したZIPのSHA-256が違う');
    }
    if (io.readFileSync(join(staging, `${finalName}.sha256`), 'utf8') !== shaText) {
      throw new Error('書き出したハッシュファイルの中身が違う');
    }
    const backManifest = JSON.parse(io.readFileSync(join(staging, 'release-manifest.json'), 'utf8'));
    if (backManifest.zip.name !== finalName) {
      throw new Error(`記録のZIP名が実ファイル名と違う: ${backManifest.zip.name} ≠ ${finalName}`);
    }
    if (backManifest.zip.sha256 !== sha || backManifest.zip.bytes !== zip.length) {
      throw new Error('記録のZIPハッシュ・サイズが実物と違う');
    }
  } catch (e) {
    io.rmSync(staging, { recursive: true, force: true });
    throw e;
  }

  /*
   * ここから入れ替え。古い dist/ を退避してから新しいものを置き、最後に退避を消す。
   *
   * ディレクトリのリネームは、中身の入ったディレクトリを上書きできない（ENOTEMPTY）。
   * そのため「退避 → 配置」の2手になり、配置に失敗する瞬間だけ dist/ が無い。
   * その場合は退避を戻す。戻すことすらできなければ、前の成果物が**どこにあるか**を
   * 例外に書いて落とす（黙って失われるのが一番まずい）。
   */
  let moved = false;
  try {
    if (io.existsSync(distDir)) { io.renameSync(distDir, parked); moved = true; }
    io.renameSync(staging, distDir);
  } catch (e) {
    io.rmSync(staging, { recursive: true, force: true });
    if (moved && !io.existsSync(distDir)) {
      try {
        io.renameSync(parked, distDir);
      } catch (e2) {
        throw new Error(
          `配布物の入れ替えに失敗し、元に戻すこともできませんでした。` +
          `前の成果物は ${parked} に残っています（原因: ${e.message} / 復旧: ${e2.message}）`
        );
      }
    }
    throw e;
  }
  if (moved) io.rmSync(parked, { recursive: true, force: true });
}

/*
 * 直接実行されたときだけ動かす。
 *
 * `file://${process.argv[1]}` と比べていたが、**Windows では絶対に一致しない**
 * （argv[1] は D:\a\... で、import.meta.url は file:///D:/a/... になる）。
 * そのため Windows のCIでは「配布物を作れること」のステップが、何も作らないまま
 * 成功していた。走らなかったのか成功したのかを、出力から見分けられなかった。
 * pathToFileURL で正しく比べる（2026-08-06・第7回監査の作業中にCIで発覚）。
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = process.argv.includes('--dry-run');
  const allowDirty = process.argv.includes('--allow-dirty');
  const r = makePackage({ dryRun, allowDirty });
  console.log(`RepoShout ${r.version} — ${dryRun ? '収録予定' : '生成しました'}`);
  for (const f of r.files) console.log(`  ${String(f.bytes).padStart(7)} B  ${f.name}`);
  console.log(`  ---`);
  console.log(`  ZIP: ${r.zipBytes} B  ${r.written ? r.file : '(未書き込み)'}`);
  console.log(`  SHA-256: ${r.sha256}`);
  console.log(`  コミット: ${r.provenance.sourceCommit || '(不明)'}${r.provenance.dirty ? ' (未コミットの変更あり)' : ''}`);
  console.log(`  ビルド種別: ${r.provenance.ci.eventName}`);
  if (r.submittable) {
    console.log(`  提出可否: 技術的には提出候補（素性は問題なし）`);
    console.log(`           ※ ストアへ出してよいかは別です。`);
    console.log(`             npm run verify:store-preflight（リポジトリ側だけ）`);
    console.log(`             npm run verify:submission-ready -- --artifact <成果物.zip> …（提出直前）`);
  } else {
    console.log(`  提出可否: ★ストアへ提出しないでください — ${r.provenance.notSubmittableBecause.join(' / ')}`);
  }
  console.log(`  除外: test/ store/ scripts/ 文書 dist/（allowlist方式）`);
}
