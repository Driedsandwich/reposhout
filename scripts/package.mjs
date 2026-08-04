/*
 * package.mjs — 提出用ZIPを決定論的に作る
 *
 * 実行: npm run package        → dist/reposhout-<version>.zip と .sha256 を作る
 *       npm run package:dry    → 収録物だけ表示して何も書かない
 *
 * ZIPを手で組み立てているのは、zip コマンドがファイルの更新時刻を書き込むため。
 * 同じ内容でも作るたびにバイト列が変わり、「提出したZIPと手元のZIPが同じか」を
 * ハッシュで確かめられない。ここでは日時を固定値（1980-01-01）にして、
 * 同じ入力から必ず同じバイト列が出るようにしている。
 *
 * 注: 圧縮結果は zlib の実装に依存するため、「同じcommit・同じNode」で同一になる。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { PACKAGE_FILES } from './package-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

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

export function makePackage({ dryRun = false } = {}) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const entries = PACKAGE_FILES.map((name) => {
    const p = join(ROOT, name);
    if (!existsSync(p)) throw new Error(`配布対象が見つからない: ${name}`);
    return { name, data: readFileSync(p) };
  });

  const zip = buildZip(entries);
  const sha = createHash('sha256').update(zip).digest('hex');
  const outName = `reposhout-${manifest.version}.zip`;

  const report = {
    version: manifest.version,
    file: join('dist', outName),
    files: entries.map((e) => ({ name: e.name, bytes: e.data.length })),
    zipBytes: zip.length,
    sha256: sha,
    written: false
  };

  if (!dryRun) {
    if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
    mkdirSync(DIST, { recursive: true });
    writeFileSync(join(DIST, outName), zip);
    writeFileSync(join(DIST, `${outName}.sha256`), `${sha}  ${outName}\n`);
    report.written = true;
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run');
  const r = makePackage({ dryRun });
  console.log(`RepoShout ${r.version} — ${dryRun ? '収録予定' : '生成しました'}`);
  for (const f of r.files) console.log(`  ${String(f.bytes).padStart(7)} B  ${f.name}`);
  console.log(`  ---`);
  console.log(`  ZIP: ${r.zipBytes} B  ${r.written ? r.file : '(未書き込み)'}`);
  console.log(`  SHA-256: ${r.sha256}`);
  console.log(`  除外: test/ store/ scripts/ 文書 dist/（allowlist方式）`);
}
