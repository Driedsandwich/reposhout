/*
 * zip-read.mjs — ZIPを厳しく読む最小限の実装（読み手）
 *
 * 書く側（scripts/package.mjs）とは別に持つ。「書いたものが本当に読めるか」を
 * 独立に確かめるためで、同じコードを共有すると読み手が書き手の間違いに合わせてしまう。
 *
 * ここへ切り出したのは、提出前の確認（scripts/verify-store-readiness.mjs）でも
 * ダウンロードした実物の成果物を開く必要が出たため（第10回監査 R10-002）。
 * test/package.test.mjs はここを読み込んで、壊したZIPで落ちることを確かめている。
 */
import { inflateRawSync } from 'node:zlib';

/*
 * GitHub Actions からダウンロードする「外側の」成果物ZIPは、書きながら送る作りなので
 * ローカルヘッダのサイズとCRCが 0 で、実体は data descriptor と中央ディレクトリにある
 * （実測。第10回監査 R10-002 の --artifact 実装中に判明）。自分で作る配布ZIPには
 * これを許さないが、他人が作った容れ物を開くときだけ opts.allowDataDescriptor で緩める。
 * **緩めるのは「ローカルヘッダと中央ディレクトリの突き合わせ」だけで、CRCと展開後の
 * 長さは中央ディレクトリの値で必ず検証する。**
 */
export function readZip(buf, opts = {}) {
  const allowDD = opts.allowDataDescriptor === true;
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
    if ((cFlags & 0x0008) && !allowDD) throw new Error(`data descriptor 付きは受け取らない: ${name}`);
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
    if (lFlags !== cFlags) throw new Error(`フラグが食い違う: ${name}`);
    /* data descriptor 付きは、ローカルヘッダのCRC・サイズが 0 で入っている */
    if (!(allowDD && (cFlags & 0x0008))) {
      if (lCrc !== cCrc) throw new Error(`CRCが食い違う: ${name}`);
      if (lComp !== cComp || lRaw !== cRaw) throw new Error(`サイズが食い違う: ${name}`);
    }

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

