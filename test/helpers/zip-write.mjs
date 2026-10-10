/*
 * 試験の題材にする小さな ZIP を書く（無圧縮・data descriptor なし）。第27回監査 R27-205。
 *
 * 提出ゲートの成功の対照が、ZIP でない文字列を「中身の ZIP」として渡していたので、
 * 実際の読み手（scripts/zip-read.mjs）を一度も通っていなかった。ここで本物の ZIP を作り、
 * 読み手に通す。**配布物を作る書き手（scripts/package.mjs）とは別に持つ**——同じコードを
 * 共有すると、読み手と書き手が同じ間違いに合わせてしまう（zip-read.mjs の冒頭と同じ考え）。
 * CRC-32 は Node の zlib.crc32 を使う（読み手は自前の表で計算するので、独立している）。
 */
import { crc32 } from 'node:zlib';

/** @param {{name: string, data: Buffer}[]} entries */
export function makeStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // 展開に要る版
    local.writeUInt16LE(0, 6);             // フラグ
    local.writeUInt16LE(0, 8);             // 無圧縮
    local.writeUInt16LE(0, 10);            // 時刻
    local.writeUInt16LE(0x21, 12);         // 日付（1980-01-01）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/** 拡張の直下の形をした、11 ファイルの中身の ZIP（manifest.json を直下に持つ） */
export function makeInnerZip({ files = 11, withManifest = true } = {}) {
  const entries = [];
  if (withManifest) entries.push({ name: 'manifest.json', data: Buffer.from('{"manifest_version":3}', 'utf8') });
  while (entries.length < files) {
    entries.push({ name: `src/f${entries.length}.js`, data: Buffer.from(`// ${entries.length}\n`, 'utf8') });
  }
  return makeStoredZip(entries);
}
