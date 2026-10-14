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

import vm from 'node:vm';

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

/*
 * `/` が正規表現の始まりか（割り算でないか）。（第28回監査 R28-003）
 * 直前の意味のある文字だけで決めていたので、`return /\(/` の `/` を割り算と読み、
 * 正規表現の中の `(` を呼び出しの括弧として数えた。演算子の後と、式を取る語
 *（return・typeof など）の後は正規表現にする。`obj.return / 2` のようなプロパティは除く。
 */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
  'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
function slashStartsRegex(src, i, prev) {
  if (/[(,=:[!&|?{};+\-*%<>~^\n]/.test(prev)) return true;
  if (!/[A-Za-z0-9_$]/.test(prev)) return false;
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
  if (k >= 0 && src[k] === '.') return false;
  return REGEX_AFTER_WORD.has(src.slice(k + 1, j + 1));
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
    if (c === '/' && slashStartsRegex(src, i, prev)) { i = skipRegex(src, i); prev = '/'; continue; }
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
    if (c === '/' && slashStartsRegex(src, i, prev)) { i = skipRegex(src, i); prev = '/'; continue; }
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
  /*
   * ⚠️ 読み違えて閉じ括弧を見落とすと、範囲が次のテストまで延びる（第28回監査 R28-003）。
   * 次の宣言を越えた範囲は推測なので使わない（null＝範囲を決められない、で止める）。
   */
  const next = decls[idx + 1];
  if (next && end > next.start) return null;
  const span = src.slice(decls[idx].start, end);
  /*
   * ⚠️ 次の宣言が無いと、上の検査は働かない（第28回監査 R28-107。最後のテストの後ろの文まで範囲が延びた）。
   * 範囲が**それ1つの呼び出しの式**として読めるかを、Node の構文解析器で確かめる（実行はしない）。
   * 延びた範囲は文の並びを含むので、括弧で囲んだ式としては読めない。読めなければ範囲を決めない。
   */
  return parsesAsOneCall(span) ? span : null;
}

function parsesAsOneCall(span) {
  /* import.meta はモジュールの外では書けないので、同じ長さの識別子へ置き換えてから読む */
  const code = `(\n${span.replace(/\bimport\.meta\b/g, '__gxs_imeta')}\n)`;
  try {
    new vm.Script(code, { filename: 'test-span-check' });
    return true;
  } catch (e) {
    return false;
  }
}
