/*
 * テストの宣言（`test('…')` / `it('…')`）を、**文字列・テンプレート・コメント・
 * 正規表現の中を飛ばして**探す。（第26回監査 R26-001）
 *
 * ⚠️ **なぜ正規表現1本ではだめか**
 * `test/mutation-runner.test.mjs` は、隔離した題材のソースを**テンプレート文字列の中に
 * 書いて**いる。その中にも `test('…')` があるので、素の正規表現で数えると
 * **題材の中の宣言まで本物として数える**。実測すると、対象テストの範囲が
 * 題材の位置で切れてしまい、assertion に置いた目印が「テストの外」に見えた（6件）。
 *
 * 同じ理由で、同名判定（`countTestName`）も題材の文字列に引きずられる。
 * 読み手をここ1つに集めて、ランナーからも検算からも同じものを使う。
 */

/** テンプレート文字列を読み飛ばす（`${ }` の中は普通の式として扱う） */
function skipTemplate(src, i) {
  i++;                                   /* 開きの ` の次から */
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    if (c === '$' && src[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        const d = src[i];
        if (d === '{') { depth++; i++; }
        else if (d === '}') { depth--; i++; }
        else if (d === "'" || d === '"') { i = skipQuoted(src, i, d); }
        else if (d === '`') { i = skipTemplate(src, i); }
        else if (d === '\\') { i += 2; }
        else i++;
      }
      continue;
    }
    i++;
  }
  return i;
}

/** '…' / "…" を読み飛ばす */
function skipQuoted(src, i, q) {
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === q) return i + 1;
    i++;
  }
  return i;
}

/** 正規表現リテラルを読み飛ばす（[...] の中の / は終わりでない） */
function skipRegex(src, i) {
  i++;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) { i++; break; }
    else if (c === '\n') break;          /* 改行を跨ぐ正規表現は無い＝読み違い */
    i++;
  }
  while (i < src.length && /[dgimsuvy]/.test(src[i])) i++;
  return i;
}

const DECL_RE = /^(?:test|it)\s*\(\s*(['"`])/;

/**
 * ソースの中の本物のテスト宣言を、現れる順に返す。
 * @returns {{name: string, start: number}[]} start は `test` の `t` の位置
 */
export function findTestDeclarations(src) {
  const out = [];
  let i = 0;
  let prev = '\n';                        /* 直前の意味のある文字（正規表現の判定に使う） */
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === '//') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (two === '/*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === "'" || c === '"') { i = skipQuoted(src, i, c); prev = c; continue; }
    if (c === '`') { i = skipTemplate(src, i); prev = c; continue; }
    if (c === '/' && /[(,=:[!&|?{};+\n]/.test(prev)) { i = skipRegex(src, i); prev = '/'; continue; }
    /* `foo.test(` や `mytest(` を拾わないよう、直前が識別子の一部でないことを見る */
    if ((c === 't' || c === 'i') && !/[A-Za-z0-9_$.]/.test(prev)) {
      const m = DECL_RE.exec(src.slice(i, i + 32));
      if (m) {
        const q = m[1];
        const nameStart = i + m[0].length;
        let j = nameStart;
        let name = '';
        let ok = false;
        while (j < src.length) {
          if (src[j] === '\\') { name += src[j + 1]; j += 2; continue; }
          if (src[j] === q) { ok = true; break; }
          if (src[j] === '\n' && q !== '`') break;   /* 閉じていない＝読み違い */
          name += src[j];
          j++;
        }
        if (ok) {
          out.push({ name, start: i });
          i = j + 1;
          prev = q;
          continue;
        }
      }
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/**
 * 宣言名がソースの中にいくつあるか（同名のテストを見分けられないことの検査用）
 */
export function countTestName(src, want) {
  return findTestDeclarations(src).filter((d) => d.name === want).length;
}

/**
 * `test(` の開き括弧に対応する閉じ括弧の次の位置。文字列・テンプレート・コメント・正規表現の
 * 中の括弧は数えない。閉じが見つからなければ -1（推測で範囲を広げない）。
 */
function callEnd(src, start) {
  let i = src.indexOf('(', start);
  if (i < 0) return -1;
  let depth = 0;
  let prev = '(';
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === '//') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (two === '/*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === "'" || c === '"') { i = skipQuoted(src, i, c); prev = c; continue; }
    if (c === '`') { i = skipTemplate(src, i); prev = c; continue; }
    if (c === '/' && /[(,=:[!&|?{};+\n]/.test(prev)) { i = skipRegex(src, i); prev = '/'; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i + 1; }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return -1;
}

/**
 * 宣言名のテスト1件が占める範囲の文字列。
 * **`test(` の呼び出しの閉じ括弧まで**を範囲とする（第27回監査 R27-104）。
 * 第26回は「次の宣言の手前まで」だったので、テストの後ろ（モジュール直下の定数や
 * コメント）に置いた目印も「範囲の中」に見えた。一意に決まらないとき・閉じが
 * 見つからないときは null。
 */
export function testSpanText(src, want) {
  const decls = findTestDeclarations(src);
  const idx = decls.findIndex((d) => d.name === want);
  if (idx < 0 || decls.filter((d) => d.name === want).length !== 1) return null;
  const end = callEnd(src, decls[idx].start);
  if (end < 0) return null;
  return src.slice(decls[idx].start, end);
}
