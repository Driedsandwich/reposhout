#!/usr/bin/env node
/*
 * 変異対照ランナー
 *   第21回監査 R21-004 で新設
 *   第22回監査 R22-004 で「変異前の対照」を必須にした
 *   第23回監査 R23-001 / R23-002 で「落ちた理由」と「書き込む範囲」を締めた
 *
 * 「その検査は、落ちるべきときに落ちるか」を1件ずつ確かめる。
 *
 * ⚠️ **このランナーが在る理由**
 * 第20回の作業中、面を1件ずつ落とす変異15件が **全件「素通り」と表示された**。
 * 置換の正規表現を誤っていて、**変異が一度も適用されていなかった**。
 *
 *   **当たらなかった変異と、素通りした変異は、出力の見た目が同じ。**
 *
 * ⚠️ **第22回 R22-004 で見つかった、その裏返し**
 * 「終了コードが 0 でなければ検知」としていたので、変異と関係なく失敗するもの
 * （元から落ちる／存在しない／終わらないテスト）が全部「検知」に化けていた。
 * → **変異を当てる前に対象テストを素で1回走らせ**、通らなければ `runner_error`。
 *
 * ⚠️ **第23回 R23-001 で見つかった、さらにその裏返し**
 * 変異前に通っていても、**落ちた理由まで見ていなかった**。隔離した題材で測ると:
 *
 *   意図した検査が落ちた         → 検知（これだけが正しい）
 *   構文が壊れただけ（SyntaxError）→ 検知
 *   import に失敗しただけ         → 検知
 *   読み込み時に例外（setup 失敗） → 検知
 *   **別のテストだけ**が落ちた     → 検知
 *
 * 5つとも同じ「検知」でした。**守りたい検査は無傷なのに、守られていることに
 * なってしまう。** そこで各変異に「どのテストが落ちるはずか」を宣言させ、
 * `not ok` の名前と突き合わせます。宣言が無い変異は `runner_error` にします。
 *
 * ⚠️ **第23回 R23-002**
 * 変異する対象（`m.file`）にはリポジトリ境界の検査が無く、`../outside.txt` を
 * 指すと**リポジトリの外を書き換えて**「検知」と報告していました。
 * また復旧が例外を投げると**証跡が1行も残らず**、書き込んだのに読み戻せなかった
 * 経路は復旧を呼ばないまま `restored: true` と記録していました。
 *
 * 結果は4つに分けて必ず区別する:
 *
 *   applied_and_killed    変異が当たり、**宣言したテストが**落ちた
 *   applied_but_survived  変異が当たったのに、テストが通った（＝検査の穴）
 *   not_applied           変異が当たらなかった（＝**結果は何も言えない**）
 *   runner_error          ランナー側／前提／落ち方の失敗（＝**結果は何も言えない**）
 *
 * 使い方:
 *   npm run test:mutations                          全部
 *   npm run test:mutations -- --id M03              1件だけ
 *   npm run test:mutations -- --receipt out.json    証跡をJSONで残す
 *   npm run test:mutations -- --timeout 5000        1件あたりの上限（既定 300000ms）
 */
import { readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute, resolve, relative, basename } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_FILE = fileURLToPath(import.meta.url);
const sha = (s) => createHash('sha256').update(s).digest('hex');

/*
 * ⚠️ **引数を厳格に読む。**（第24回監査 R24-002）
 * 前は `Number(argOf('--timeout') || 300000)` だったので:
 *   ・`--timeout 0` が通り、Node では **0 は「上限なし」**（実測: 打ち切られない）
 *   ・`--timeout abc` が NaN のまま渡り、実行時に ERR_OUT_OF_RANGE で落ちる
 *   ・知らない綴りの引数は黙って無視される
 * 上限は有限の正整数だけ。知らない引数は受け取らない。
 */
const KNOWN_FLAGS = ['--id', '--receipt', '--spec', '--timeout'];
const MAX_TIMEOUT_MS = 3600000;
const argv = process.argv.slice(2);
function parseArgs() {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!KNOWN_FLAGS.includes(a)) return { error: `知らない引数: ${a}` };
    const v = argv[i + 1];
    if (v === undefined || KNOWN_FLAGS.includes(v)) return { error: `${a} に値が無い` };
    out[a] = v;
    i++;
  }
  return { out };
}
const parsed = parseArgs();
if (parsed.error) {
  console.error(`${parsed.error}\n使える引数: ${KNOWN_FLAGS.join(' ')}`);
  process.exit(2);
}
const onlyId = parsed.out['--id'] || null;
const receiptPath = parsed.out['--receipt'] || null;

/*
 * ⚠️ **証跡を書かずに死ぬ経路を残さない。**（第24回監査 R24-002 の続き・N19 で実測）
 * 途中で予期しない例外が出ると、ここまでの分も含めて**証跡が1行も残らなかった**。
 * 受け取る側から見ると「まだ走っていない」と「途中で死んだ」が区別できない
 * （実際、N19 の変異で受け取り側は null を読んで TypeError になり、
 *   守りたい検査は一度も走らなかった）。
 * どんな終わり方でも、最後に必ず何か書く。
 */
let receiptWritten = false;
function saveReceipt(obj) {
  if (!receiptPath) { receiptWritten = true; return true; }
  try {
    writeFileSync(receiptPath, JSON.stringify(obj, null, 2) + '\n');
    receiptWritten = true;
    return true;
  } catch (e) {
    console.error(`★ 証跡を書けなかった: ${receiptPath}\n  ${e && e.message}`);
    return false;
  }
}
process.on('exit', (code) => {
  if (receiptWritten || !receiptPath) return;
  try {
    writeFileSync(receiptPath, JSON.stringify({
      spec: parsed.out['--spec'] || 'test/mutations.json', total: 0,
      precondition: 'aborted',
      error: `証跡を書く前に終了した（exit ${code}）。結果は何も言えない`,
      results: []
    }, null, 2) + '\n');
  } catch (e) { /* 書けないなら、そのまま落とす */ }
});
const specPath = parsed.out['--spec'] || 'test/mutations.json';
let timeoutMs = 300000;
if (parsed.out['--timeout'] !== undefined) {
  const raw = parsed.out['--timeout'];
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_TIMEOUT_MS) {
    console.error(`--timeout は 1〜${MAX_TIMEOUT_MS} の整数（受け取った値: ${JSON.stringify(raw)}）`
      + '\n※ 0 は Node では「上限なし」になるので受け付けない');
    process.exit(2);
  }
  timeoutMs = n;
}

/* --spec は絶対パスでも渡せる（対照用の定義を repo の外へ置けるため）。
   ただし **spec が指す対象は repo の中だけ**（下の validatePath）。 */
const specFile = isAbsolute(specPath) ? specPath : join(ROOT, specPath);
const specText = readFileSync(specFile, 'utf8');
const spec = JSON.parse(specText);
/* ⚠️ IDが重複していると、証跡のどの行がどの変異か決まらない（第24回監査 R24-001） */
const idCount = {};
for (const m of spec.mutations) idCount[m.id] = (idCount[m.id] || 0) + 1;
const dupIds = Object.keys(idCount).filter((k) => idCount[k] > 1);
if (dupIds.length) {
  console.error(`変異IDが重複している: ${dupIds.join(' ')}`);
  process.exit(2);
}

const mutations = spec.mutations.filter((m) => !onlyId || m.id === onlyId);
if (!mutations.length) {
  console.error(`変異が1件も選ばれていない（--id ${onlyId}）`);
  process.exit(2);
}

const startedAt = new Date().toISOString();

function gitOut(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return null;
  }
}
const gitStatusStart = gitOut(['status', '--porcelain']);
const sourceCommit = gitOut(['rev-parse', 'HEAD']);
const sourceTree = gitOut(['rev-parse', 'HEAD^{tree}']);
/*
 * ⚠️ **由来が取れないまま成功させない。**（第24回監査 R24-002）
 * `gitOut` は git の失敗をすべて null に変えるので、`.git` の無い複製や
 * git の入っていない環境でも、commit も tree も dirty も null のまま走り切り、
 * 最後の条件（`workspaceUnchanged !== false`）は **null を成功側**として扱っていた。
 * 何を測ったのか言えない証跡は、証跡ではない。
 */
if (sourceCommit === null || sourceTree === null || gitStatusStart === null) {
  const missing = [['sourceCommit', sourceCommit], ['sourceTree', sourceTree],
    ['gitStatus', gitStatusStart]].filter(([, v]) => v === null).map(([k]) => k);
  const msg = `git から由来を取れない（${missing.join(' / ')}）。何を測ったか言えないので走らない`;
  console.error(`★ ${msg}`);
  saveReceipt({
    spec: specPath, total: 0, precondition: 'failed', error: msg,
    provenance: { sourceCommit, sourceTree, nodeVersion: process.version,
      platform: process.platform, timeoutMs, startedAt, completedAt: new Date().toISOString() },
    results: []
  });
  process.exit(2);
}
const provenance = {
  sourceCommit,
  sourceTree,
  workingTreeDirty: gitStatusStart !== '',
  runnerSha256: sha(readFileSync(RUNNER_FILE, 'utf8')),
  specSha256: sha(specText),
  nodeVersion: process.version,
  platform: process.platform,
  timeoutMs
};

/* ------------------------------------------------------------------
 * 書き込んでよい場所（第23回監査 R23-002）
 * ------------------------------------------------------------------
 * `m.file`（変異させる対象）と `m.test`（走らせるテスト）の**両方**に当てる。
 * 前は `m.test` にしか当てていなかったので、`m.file: '../outside.txt'` で
 * リポジトリの外を書き換えられた（隔離した題材で実測）。
 *
 * symlink は **realpath より先に lstat で弾く**——realpath は追ってしまうので、
 * 「repo の中の symlink が外を指している」形を見逃す。
 */
const REAL_ROOT = (() => {
  try { return realpathSync(ROOT); } catch (e) { return ROOT; }
})();

function validatePath(rel, label) {
  if (typeof rel !== 'string' || !rel) return `${label} が指定されていない`;
  if (isAbsolute(rel)) return `${label} に絶対パスは使えない: ${rel}`;
  const abs = resolve(ROOT, rel);
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    return `${label} のファイルが無い: ${rel}`;
  }
  if (st.isSymbolicLink()) return `${label} が symlink を指している: ${rel}`;
  if (!st.isFile()) return `${label} が通常ファイルでない: ${rel}`;
  let real;
  try {
    real = realpathSync(abs);
  } catch (e) {
    return `${label} の実体を解決できない: ${rel}`;
  }
  const inside = relative(REAL_ROOT, real);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    return `${label} がリポジトリの外を指している: ${rel}`;
  }
  return null;
}

/*
 * ⚠️ **同じ名前のテストが2つあると、どちらが落ちたか決まらない。**（第24回監査 R24-001）
 * 守りたい方は通り、無関係な同名だけが落ちても、名前の一致は成立してしまう。
 * 走らせる前に、対象ファイルの中で宣言名が一意であることを確かめる。
 */
const TEST_NAME_RE = /(?:^|\s)(?:it|test)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gm;
const nameCache = new Map();
function countTestName(rel, want) {
  if (!nameCache.has(rel)) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const names = [];
    let g;
    TEST_NAME_RE.lastIndex = 0;
    while ((g = TEST_NAME_RE.exec(src)) !== null) names.push(g[2]);
    nameCache.set(rel, names);
  }
  return nameCache.get(rel).filter((n) => n === want).length;
}

/*
 * ⚠️ **テストを起動する環境を、必ず素にする。**（第22回監査 R22-004 の作業中に発見）
 * `node --test` は、自分が別の test runner の子だと判断すると（`NODE_TEST_CONTEXT`）
 * **失敗しても終了コード 0 で終わる**。自己検査がまさにその形で起動するので、
 * 剥がさないと**すべての変異が「素通り」に化ける**。
 */
const CHILD_ENV = (() => {
  const e = { ...process.env };
  delete e.NODE_TEST_CONTEXT;
  delete e.NODE_OPTIONS;
  return e;
})();

/* ------------------------------------------------------------------
 * 落ち方を読む（第23回監査 R23-001）
 * ------------------------------------------------------------------
 * ⚠️ 見分け方は**実測してから**書いた（2026-08-12・Node 22）。
 *
 *   assertion が落ちた   → `not ok N - <テストの名前>`（他のテストは通る）
 *   SyntaxError          → `not ok 1 - <テストファイルのパス>` ＋ `# SyntaxError:`
 *   import に失敗        → `not ok 1 - <テストファイルのパス>` ＋ `ERR_MODULE_NOT_FOUND`
 *   読み込み時の例外     → `not ok 1 - <テストファイルのパス>`（pass 0）
 *
 * つまり**ファイルごと読めなかったときは、落ちた名前がテストファイルのパスになる**。
 * ここが assertion 失敗との境目。想像で書くと、この境目を取り違える。
 */
const NOT_OK = /^(\s*)not ok \d+ - (.+?)\s*$/gm;

/*
 * ⚠️ **名前が一致しただけでは「その検査が落とした」と言えない。**（第24回監査 R24-001）
 * 宣言したテストが落ちていても、実際には
 *   ・正本の JSON が壊れて `JSON.parse` が投げた（SyntaxError）
 *   ・null/undefined を読んで TypeError
 *   ・unhandledRejection
 * ということがある。その場合、**守りたい assertion は一度も走っていない**。
 * 111件を1件ずつ測って、5件がこれだった。
 *
 * TAP は `not ok` の直後の YAML に `failureType` / `code` / `name` を書く。
 * そこまで読んで、`AssertionError`（`ERR_ASSERTION`）だけを検知として認める。
 */
function failureDetails(output) {
  const lines = output.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)not ok \d+ - (.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const rec = { name: m[2].trim(), failureType: null, code: null, errName: null };
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) continue;
      const ind = l.length - l.trimStart().length;
      if (ind <= indent && !/^\s*(---|\.\.\.)\s*$/.test(l)) break;
      const t = l.trim();
      let g;
      if ((g = /^failureType:\s*'?([^']+)'?/.exec(t))) rec.failureType = g[1];
      else if ((g = /^code:\s*'?([^']+)'?/.exec(t))) rec.code = g[1];
      else if ((g = /^name:\s*'?([^']+)'?/.exec(t))) rec.errName = g[1];
      if (/^\.\.\.$/.test(t) && ind <= indent + 2) break;
    }
    out.push(rec);
  }
  return out;
}
const isAssertionFailure = (f) => !!f && (f.errName === 'AssertionError' || f.code === 'ERR_ASSERTION');

/*
 * 実際の落ち方を、宣言できる語へ落とす。
 * 既定は `assertion` で、それ以外を検知にしたいときは**変異の側で宣言させる**
 * （`expectedFailure.kind` ＋ 理由）。宣言の無い種類は検知にしない。
 */
const ALLOWED_KINDS = ['assertion', 'unhandledRejection'];
function actualKind(f) {
  if (isAssertionFailure(f)) return 'assertion';
  if (f && f.failureType === 'unhandledRejection') return 'unhandledRejection';
  return (f && (f.errName || f.failureType)) || 'unknown';
}

function parseFailure(rel, output) {
  const details = failureDetails(output);
  const names = details.map((d) => d.name);

  /*
   * ⚠️ **区切り文字と絶対パスに依らず判定する。**（Windows の CI で実測）
   * `test/guard.test.mjs` を、Windows の node は `test\guard.test.mjs` の形で
   * 報告する。前は「文字列が一致するか」で見ていたので**対象ファイルだと
   * 気づけず**、SyntaxError を「別のテストが落ちた」と読み違えていた。
   * 区切りを `/` へ揃え、末尾一致でも認める。
   */
  const norm = (x) => String(x).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const relN = norm(rel), baseN = norm(basename(rel));
  const isTargetFile = (n) => {
    const x = norm(n);
    return x === relN || x === baseN || x.endsWith('/' + relN) || x.endsWith('/' + baseN);
  };
  const bootstrap = names.filter(isTargetFile);
  const testNames = names.filter((n) => !isTargetFile(n));

  let kind;
  if (bootstrap.length) {
    if (/SyntaxError/.test(output)) kind = 'syntax_error';
    else if (/ERR_MODULE_NOT_FOUND|Cannot find module|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_DIR_IMPORT/.test(output)) kind = 'module_resolution_error';
    else kind = 'bootstrap_error';
  } else if (testNames.length) {
    kind = 'assertion_failure';
  } else {
    kind = 'no_failure_reported';
  }
  return { failureKind: kind, failedTestNames: testNames, bootstrapNames: bootstrap,
    failedTests: details.filter((d) => !isTargetFile(d.name)) };
}

/*
 * 診断の一部だけを、伏せてから残す（絶対パスと資格情報らしき列を消す）。
 *
 * ⚠️ 最初は「`#` で始まる行」を先頭から12行取っていたが、それは
 * `# Subtest: …` の見出しばかりで、**なぜ落ちたのかが1行も入らなかった**。
 * 落ちた所の情報（`location:` / `error:` / `code:` / `failureType:`）と、
 * 見出しではない `#` の行（SyntaxError などの診断）を集める。
 */
function sanitizeDiagnostic(output, limit = 600) {
  /*
   * ⚠️ `error:` の**中身**は次の行から始まる（TAP のブロック）。見出しの行だけを
   * 集めていたので、**落ちた理由の本文が1文字も入っていなかった**
   * （伏字の検査が、当たるものが無いまま通っていた——変異 P25 で判明）。
   */
  const all = output.split('\n');
  const lines = [];
  for (let i = 0; i < all.length; i++) {
    const l = all[i];
    const head = /^\s*(location:|error:|code:|failureType:)/.test(l);
    const diag = /^\s*#/.test(l)
      && !/^\s*# (Subtest:|tests |pass |fail |cancelled |skipped |todo |duration_ms)/.test(l);
    if (!head && !diag) continue;
    lines.push(l);
    if (/^\s*error:/.test(l)) {
      const indent = l.length - l.trimStart().length;
      for (let j = i + 1; j < all.length && lines.length < 24; j++) {
        const b = all[j];
        if (!b.trim()) continue;
        if (b.length - b.trimStart().length <= indent) break;
        lines.push(b);
      }
    }
  }
  let text = lines.slice(0, 24).join('\n');
  /* ⚠️ `/` だけ見ていたので、Windows の `D:\a\…` が伏せられていなかった（CIで実測） */
  text = text.replace(/(\/[^\s'"]+){2,}/g, '<path>');
  /* ⚠️ 2つの規則で同じ入力を覆っていたので、片方を外しても何も起きなかった
     （変異 P25 が素通り）。**1つにまとめて**、外したら落ちるようにする */
  text = text.replace(/(?:[A-Za-z]:)?(?:\\[^\s'"\\]+){2,}/g, '<path>');
  text = text.replace(/[A-Za-z0-9_-]{24,}/g, '<token>');
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/* テストを1回走らせ、プロセスの終わり方と落ち方まで記録する */
function runTest(rel) {
  const out = { exitCode: null, signal: null, timedOut: false, spawnError: null,
    stdoutSha256: null, stderrSha256: null };
  let stdout = '', stderr = '';
  try {
    stdout = execFileSync(process.execPath, ['--test', rel],
      { cwd: ROOT, stdio: 'pipe', timeout: timeoutMs, encoding: 'utf8', env: CHILD_ENV }) || '';
    out.exitCode = 0;
    out.passed = true;
  } catch (e) {
    out.exitCode = typeof e.status === 'number' ? e.status : null;
    out.signal = e.signal || null;
    /*
     * ⚠️ 上限で打ち切ったことは `killed` や `signal` では見分けられない。
     * Node 22 の実測は status=1 / signal=null / killed=undefined / code='ETIMEDOUT'。
     */
    out.timedOut = e.code === 'ETIMEDOUT' || e.killed === true || e.signal === 'SIGTERM';
    if (e.code && e.code !== 'ETIMEDOUT' && typeof e.status !== 'number') out.spawnError = String(e.code);
    stdout = String(e.stdout || '');
    stderr = String(e.stderr || '');
    out.passed = false;
  }
  out.stdoutSha256 = sha(stdout);
  out.stderrSha256 = sha(stderr);
  const combined = `${stdout}\n${stderr}`;
  Object.assign(out, parseFailure(rel, combined));
  out.sanitizedDiagnostic = out.passed ? null : sanitizeDiagnostic(combined);
  return out;
}

/*
 * 変異前の対照。同じ対象テストは1回だけ走らせて覚える。
 * 覚えてよいのは「毎回きちんと元へ戻せている」あいだだけ。
 */
const baselineCache = new Map();
function baselineFor(rel) {
  if (!baselineCache.has(rel)) baselineCache.set(rel, runTest(rel));
  return baselineCache.get(rel);
}

/* 対象ファイルを読み、期待した回数だけ現れることを確かめてから**全部**置換する */
/*
 * ⚠️ 書き込んだ事実は、**この変数**にだけ持たせる。
 * applyMutation の途中で例外が出ても finally から辿れるようにするため
 * （戻り値に持たせると、throw したときに誰も知らないまま変異が残る）。
 */
let pendingWrite = null;

function applyMutation(m) {
  const path = join(ROOT, m.file);
  const before = readFileSync(path, 'utf8');
  const parts = before.split(m.find);
  const actualMatches = parts.length - 1;
  const expected = m.expectMatches === undefined ? 1 : m.expectMatches;

  if (actualMatches !== expected) {
    return { applied: false, wrote: false, before, actualMatches, expected, replacements: 0,
      why: `一致数が期待と違う（期待 ${expected} / 実際 ${actualMatches}）` };
  }
  /*
   * ⚠️ `String.prototype.replace` に文字列を渡すと最初の1個しか置換しない。
   * split/join で**期待した数だけ**置き換え、実際に置き換えた数を記録する。
   */
  const after = parts.join(m.replace);
  /*
   * ⚠️ **置き残しを数える。**（第23回監査 R23-001 の作業中に発見）
   * 「1個だけ置換する」旧挙動へ戻す変異が素通りした——置換した数を
   * 一致数から計算していたので、実際に置き換わったかを見ていなかった。
   * 置換後に `find` が残っていたら、期待した数だけ当たっていない。
   * （`replace` の中に `find` を含む変異だけは、残って当たり前なので除く）
   */
  const remainingAfter = after.split(m.find).length - 1;
  if (remainingAfter !== 0 && !m.replace.includes(m.find)) {
    return { applied: false, wrote: false, before, actualMatches, expected, replacements: 0,
      remainingAfter,
      why: `置き換え残しがある（${remainingAfter} 箇所）。期待した数だけ当たっていない` };
  }
  if (after === before) {
    return { applied: false, wrote: false, before, actualMatches, expected, replacements: 0,
      why: '置換しても中身が変わらなかった' };
  }
  pendingWrite = { file: m.file, before };
  writeFileSync(path, after);
  const readBack = readFileSync(path, 'utf8');
  if (readBack !== after) {
    /*
     * ⚠️ **もう書いてしまっている。**（第23回監査 R23-002）
     * 前はここを `not_applied` かつ `restored: true` として、復旧を呼ばずに
     * 次へ進んでいた——ファイルは変異したまま、証跡は「戻した」と言っていた。
     */
    return { applied: false, wrote: true, before, after, actualMatches, expected,
      replacements: actualMatches, readbackSha256: sha(readBack),
      why: '書き込んだ内容が読み戻せない' };
  }
  return { applied: true, wrote: true, before, after, actualMatches, expected,
    replacements: actualMatches, remainingAfter };
}

function restoreExact(m, before) {
  const path = join(ROOT, m.file);
  writeFileSync(path, before);
  return readFileSync(path, 'utf8') === before;
}

const results = [];
let fatal = null;

for (const m of mutations) {
  const base = { id: m.id, file: m.file, desc: m.desc, test: m.test,
    expectedFailure: m.expectedFailure || null };

  /* ① 変異する対象と対象テストの両方が、書いてよい場所にあるか */
  const problem = validatePath(m.file, '変異する対象') || validatePath(m.test, '対象テスト');
  if (problem) {
    results.push({ ...base, outcome: 'runner_error', failureKind: 'target_rejected',
      error: problem, restored: true });
    continue;
  }

  /* ② どのテストが落ちるはずかを宣言していること（宣言が無ければ測れない） */
  if (!m.expectedFailure || typeof m.expectedFailure.testName !== 'string'
      || !m.expectedFailure.testName.trim()) {
    results.push({ ...base, outcome: 'runner_error', failureKind: 'expectation_missing',
      error: 'expectedFailure.testName が宣言されていない（何が落ちれば正解か決まらない）',
      restored: true });
    continue;
  }
  /*
   * 落ち方の種類も宣言できる（既定は assertion）。assertion 以外を検知にしたいなら、
   * **なぜそれが欠陥の姿なのか**を書かせる。書かせないと、ただの逃げ道になる。
   */
  const want0 = m.expectedFailure.testName.trim();
  const wantKind = m.expectedFailure.kind || 'assertion';
  if (!ALLOWED_KINDS.includes(wantKind)) {
    results.push({ ...base, outcome: 'runner_error', failureKind: 'expectation_invalid',
      error: `expectedFailure.kind が不正: ${wantKind}`, restored: true });
    continue;
  }
  if (wantKind !== 'assertion'
      && !(typeof m.expectedFailure.why === 'string' && m.expectedFailure.why.trim().length >= 10)) {
    results.push({ ...base, outcome: 'runner_error', failureKind: 'expectation_invalid',
      error: `assertion 以外（${wantKind}）を検知にするなら、理由（why）を書く`, restored: true });
    continue;
  }

  /* 宣言した名前が、対象ファイルの中で一意であること */
  const nameCount = countTestName(m.test, want0);
  if (nameCount !== 1) {
    results.push({ ...base, outcome: 'runner_error', failureKind: 'duplicate_test_name',
      error: nameCount === 0
        ? `宣言した名前のテストが ${m.test} に無い`
        : `宣言した名前のテストが ${m.test} に ${nameCount} 件ある（どれが落ちたか決まらない）`,
      restored: true });
    continue;
  }

  /* ③ 変異前に、その対象テストが素で通ること */
  const bl = baselineFor(m.test);
  if (!bl.passed) {
    results.push({ ...base, outcome: 'runner_error', failureKind: 'baseline_failed',
      error: bl.timedOut ? `対象テストが ${timeoutMs}ms で終わらない（変異前）`
        : bl.spawnError ? `対象テストを起動できない（${bl.spawnError}）`
          : bl.signal ? `対象テストが signal ${bl.signal} で落ちた（変異前）`
            : `対象テストが変異前から落ちている（exit ${bl.exitCode} / ${bl.failureKind}）`,
      baseline: { exitCode: bl.exitCode, failureKind: bl.failureKind,
        failedTestNames: bl.failedTestNames, sanitizedDiagnostic: bl.sanitizedDiagnostic },
      restored: true });
    continue;
  }

  /* ④ 変異を当て、**必ず**元へ戻す */
  let r = null, run = null, restored = null, restoredSha256 = null, restoreError = null;
  let thrown = null;
  try {
    r = applyMutation(m);
    if (r.applied) run = runTest(m.test);
  } catch (e) {
    thrown = String((e && e.message) || e);
  } finally {
    /* 一度でも書いたなら、当たったかどうかに関わらず戻す（R23-002）。
       判断の根拠は pendingWrite——applyMutation が途中で throw しても効く */
    if (pendingWrite) {
      const w = pendingWrite;
      pendingWrite = null;
      try {
        restored = restoreExact({ file: w.file }, w.before);
        restoredSha256 = sha(readFileSync(join(ROOT, w.file), 'utf8'));
      } catch (e) {
        restored = false;
        restoreError = String(e && e.message);
        baselineCache.clear();      // 前提が崩れたので覚えを捨てる
      }
    }
  }

  if (thrown) {
    results.push({ ...base, outcome: 'runner_error', failureKind: 'apply_failed',
      error: thrown, restored: restored === null ? true : restored, restoreError });
    continue;
  }

  const common = {
    ...base,
    expectedMatches: r.expected, actualMatches: r.actualMatches,
    appliedReplacementCount: r.replacements,
    remainingAfter: r.remainingAfter === undefined ? null : r.remainingAfter,
    beforeSha256: sha(r.before),
    afterSha256: r.after ? sha(r.after) : null,
    changed: r.after ? sha(r.before) !== sha(r.after) : false,
    wrote: r.wrote === true,
    restored: r.wrote ? restored : true,
    restoredSha256, restoreError
  };

  /* 復旧できなかったのは、何より先に報告する */
  if (r.wrote && restored !== true) {
    results.push({ ...common, outcome: 'runner_error', failureKind: 'restore_failed',
      error: restoreError || '変異したファイルを元へ戻せなかった' });
    continue;
  }

  if (!r.applied) {
    if (r.wrote) {
      /* 書いたが読み戻せなかった＝当たったとも当たらなかったとも言えない */
      results.push({ ...common, outcome: 'runner_error', failureKind: 'readback_mismatch',
        error: r.why, readbackSha256: r.readbackSha256 });
    } else {
      /* ★ ここを survived と数えない。結果は「何も言えない」 */
      results.push({ ...common, outcome: 'not_applied', why: r.why });
    }
    continue;
  }

  const withRun = {
    ...common,
    baseline: { exitCode: bl.exitCode, stdoutSha256: bl.stdoutSha256 },
    exitCode: run.exitCode, signal: run.signal, timedOut: run.timedOut,
    spawnError: run.spawnError, stdoutSha256: run.stdoutSha256, stderrSha256: run.stderrSha256,
    failedTestNames: run.failedTestNames,
    failedTests: run.failedTests, sanitizedDiagnostic: run.sanitizedDiagnostic
  };

  /* ⑤ 落ち方で分ける。**検知にしてよいのは、宣言したテストが落ちたときだけ** */
  if (run.timedOut) {
    results.push({ ...withRun, outcome: 'runner_error', failureKind: 'timeout',
      error: `変異後に ${timeoutMs}ms で終わらない` });
    continue;
  }
  if (run.spawnError) {
    results.push({ ...withRun, outcome: 'runner_error', failureKind: 'spawn_error',
      error: `変異後にテストを起動できない（${run.spawnError}）` });
    continue;
  }
  if (run.signal && run.exitCode === null) {
    results.push({ ...withRun, outcome: 'runner_error', failureKind: 'signal',
      error: `変異後に signal ${run.signal} で死んだ` });
    continue;
  }
  if (run.passed) {
    results.push({ ...withRun, outcome: 'applied_but_survived', failureKind: 'survived',
      expectedFailureMatched: false });
    continue;
  }
  if (run.failureKind !== 'assertion_failure') {
    /* 構文・import・読み込み時の例外は、検査が落としたのではない */
    results.push({ ...withRun, outcome: 'runner_error', failureKind: run.failureKind,
      error: '検査が落としたのではなく、テストを読み込めていない',
      bootstrapNames: run.bootstrapNames, expectedFailureMatched: false });
    continue;
  }
  const want = want0;
  const hits = (run.failedTests || []).filter((f) => f.name === want);
  if (!hits.length) {
    results.push({ ...withRun, outcome: 'runner_error', failureKind: 'wrong_test_failure',
      error: `宣言したテストが落ちていない（宣言: ${want}）`, expectedFailureMatched: false });
    continue;
  }
  /*
   * ⚠️ 同じ名前のテストが2つ以上落ちたら、**どちらが落ちたのか決まらない**。
   * 「守りたい方は通り、無関係な同名だけが落ちた」でも名前は一致してしまう。
   */
  if (hits.length > 1) {
    results.push({ ...withRun, outcome: 'runner_error', failureKind: 'ambiguous_test_name',
      error: `同じ名前のテストが ${hits.length} 件落ちていて、どれが落ちたか決まらない（宣言: ${want}）`,
      expectedFailureMatched: false });
    continue;
  }
  /* ⚠️ **宣言した種類で落ちたときだけ検知にする。**（第24回監査 R24-001） */
  const gotKind = actualKind(hits[0]);
  if (gotKind !== wantKind) {
    results.push({ ...withRun, outcome: 'runner_error', failureKind: 'unexpected_failure_kind',
      error: `宣言したテストは落ちたが、落ち方が違う（宣言: ${wantKind} / 実際: ${gotKind}）`
        + '——守りたい検査は走っていない',
      expectedFailureKind: wantKind, actualFailureKind: gotKind,
      expectedFailureMatched: false });
    continue;
  }
  results.push({ ...withRun, outcome: 'applied_and_killed',
    failureKind: wantKind === 'assertion' ? 'expected_assertion_failure' : 'expected_declared_failure',
    expectedFailureKind: wantKind, actualFailureKind: gotKind,
    expectedFailureMatched: true, expectedFailureDetail: hits[0] });
}

/* 作業ツリーが元に戻っているか（第23回監査 R23-002 §6.6） */
const gitStatusEnd = gitOut(['status', '--porcelain']);
const workspaceUnchanged = gitStatusStart === null || gitStatusEnd === null
  ? null : gitStatusStart === gitStatusEnd;

const by = (o) => results.filter((r) => r.outcome === o);
const killed = by('applied_and_killed'), survived = by('applied_but_survived');
const notApplied = by('not_applied'), errors = by('runner_error');
const badRestore = results.filter((r) => r.restored !== true);

for (const r of results) {
  const mark = { applied_and_killed: '  OK 落ちた       ', applied_but_survived: '★ 素通り         ',
    not_applied: '★ 変異が当たらない', runner_error: '★ ランナー失敗   ' }[r.outcome];
  console.log(`${r.id.padEnd(5)} ${mark} ${String(r.file).padEnd(34)} ${r.desc}`);
  if (r.outcome === 'not_applied') console.log(`        理由: ${r.why}`);
  if (r.outcome === 'runner_error') console.log(`        [${r.failureKind}] ${r.error}`);
}

console.log();
console.log(`変異 ${results.length} 件: 落ちた ${killed.length} / 素通り ${survived.length}`
  + ` / 当たらなかった ${notApplied.length} / ランナー失敗 ${errors.length}`);
if (survived.length) console.log('★ 素通り（検査の穴）:\n  ' + survived.map((r) => `${r.id} ${r.desc}`).join('\n  '));
if (notApplied.length) console.log('★ 当たらなかった（結果は何も言えない）:\n  ' + notApplied.map((r) => `${r.id} ${r.why}`).join('\n  '));
if (errors.length) console.log('★ ランナー失敗（結果は何も言えない）:\n  ' + errors.map((r) => `${r.id} [${r.failureKind}] ${r.error}`).join('\n  '));
if (badRestore.length) console.log('★ 復旧できなかったファイルがある:\n  ' + badRestore.map((r) => r.file).join('\n  '));
if (workspaceUnchanged === false) {
  console.log('★ 作業ツリーが実行前と違う（何かを残している）');
  console.log(`  実行前: ${JSON.stringify(gitStatusStart).slice(0, 200)}`);
  console.log(`  実行後: ${JSON.stringify(gitStatusEnd).slice(0, 200)}`);
}

const summary = {
  spec: specPath, total: results.length,
  applied_and_killed: killed.length, applied_but_survived: survived.length,
  not_applied: notApplied.length, runner_error: errors.length,
  workspaceUnchanged,
  provenance: { ...provenance, startedAt, completedAt: new Date().toISOString() },
  baselines: [...baselineCache.entries()].map(([test, b]) => ({
    test, passed: b.passed, exitCode: b.exitCode, stdoutSha256: b.stdoutSha256
  })),
  results
};
if (fatal) summary.fatal = fatal;

if (receiptPath) {
  if (!saveReceipt(summary)) process.exit(2);
  console.log(`証跡: ${receiptPath}`);
}

const ok = survived.length === 0 && notApplied.length === 0
  && errors.length === 0 && badRestore.length === 0 && workspaceUnchanged === true;
process.exit(ok ? 0 : 1);
