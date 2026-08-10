/*
 * manifest と配布物の検査
 *
 * 目的は「気づかないうちに権限が増える」「外部コードが混ざる」を止めること。
 * 権限は allowlist で固定しているので、増やすときはこのテストも直すことになる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers/load.mjs';
import { PACKAGE_FILES } from '../scripts/package-files.mjs';

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

test('Manifest V3 の必須項目がそろっている', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+(\.\d+){1,3}$/);
  assert.ok(manifest.name.length <= 75, 'name が75文字を超えている');
  assert.ok(manifest.description.length <= 132, 'description が132文字を超えている');
  assert.ok(manifest.background && manifest.background.service_worker, 'service_worker が無い');
});

test('package.json と manifest.json のバージョンが一致する', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, manifest.version,
    `package.json=${pkg.version} / manifest.json=${manifest.version}`);
});

test('依存は許可した開発用パッケージだけ（配布物には入らない）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  // 実行時の依存はゼロを維持する。拡張が読み込むのは src/ の自前コードだけ。
  assert.deepEqual(pkg.dependencies || {}, {});
  // 開発用は allowlist。増やすときはここも直すことになる。
  assert.deepEqual(pkg.devDependencies || {}, { 'twitter-text': '3.1.0' });
  // 版は範囲指定ではなく完全固定であること
  for (const [name, range] of Object.entries(pkg.devDependencies || {})) {
    assert.match(range, /^\d+\.\d+\.\d+$/, `${name} が完全固定でない: ${range}`);
  }
});

test('開発用依存が配布物へ混ざらない', () => {
  for (const f of PACKAGE_FILES) {
    const body = readFileSync(join(ROOT, f));
    if (!f.endsWith('.js')) continue;
    assert.ok(!/require\(|from ['"]twitter-text/.test(body.toString('utf8')),
      `配布物が外部パッケージを参照している: ${f}`);
  }
});

test('権限は allowlist と完全一致する（増えたら落ちる）', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'storage']);
  assert.equal(manifest.host_permissions, undefined, 'host_permissions は使わない');
  assert.equal(manifest.optional_permissions, undefined);
});

test('content script は github.com と x.com だけ', () => {
  const matches = manifest.content_scripts.flatMap((cs) => cs.matches).sort();
  assert.deepEqual(matches, ['https://github.com/*', 'https://x.com/*']);
});

test('manifest が指すファイルが実在する', () => {
  const refs = [
    manifest.background.service_worker,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((cs) => cs.js)
  ];
  for (const r of refs) {
    assert.ok(existsSync(join(ROOT, r.replace(/^\//, ''))), `参照先が無い: ${r}`);
  }
});

test('外部コードを読み込む書き方が無い', () => {
  const forbidden = [
    [/\bimportScripts\(\s*['"](?!\/src\/)/, 'importScripts で拡張外を読んでいる'],
    [/\beval\s*\(/, 'eval がある'],
    [/new\s+Function\s*\(/, 'new Function がある'],
    [/\bfetch\s*\(/, 'fetch がある'],
    [/XMLHttpRequest/, 'XMLHttpRequest がある'],
    [/new\s+WebSocket/, 'WebSocket がある'],
    [/<script[^>]+src=/, '外部スクリプトタグがある']
  ];
  for (const f of ['src/share.js', 'src/content.js', 'src/background.js', 'src/esc-close.js']) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    for (const [re, why] of forbidden) {
      assert.ok(!re.test(s), `${f}: ${why}`);
    }
  }
});

test('配布物の一覧が固定されている', () => {
  assert.deepEqual(PACKAGE_FILES, [
    'manifest.json',
    '_locales/en/messages.json',
    '_locales/ja/messages.json',
    'icons/icon16.png',
    'icons/icon32.png',
    'icons/icon48.png',
    'icons/icon128.png',
    'src/share.js',
    'src/content.js',
    'src/background.js',
    'src/esc-close.js'
  ]);
  for (const f of PACKAGE_FILES) {
    assert.ok(existsSync(join(ROOT, f)), `配布対象が無い: ${f}`);
  }
});

test('言語ファイルの鍵がそろっていて、manifest の参照が解決する', () => {
  const manifest2 = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest2.default_locale, 'en');

  const locales = ['en', 'ja'];
  const tables = {};
  for (const loc of locales) {
    tables[loc] = JSON.parse(readFileSync(join(ROOT, `_locales/${loc}/messages.json`), 'utf8'));
  }
  const base = Object.keys(tables[manifest2.default_locale]).sort();
  assert.ok(base.length >= 5, `鍵が少なすぎる: ${base.length}`);
  for (const loc of locales) {
    assert.deepEqual(Object.keys(tables[loc]).sort(), base, `${loc} の鍵が既定と違う`);
    for (const [k, v] of Object.entries(tables[loc])) {
      assert.ok(v.message && v.message.trim(), `${loc}/${k} が空`);
    }
  }

  // manifest 内の __MSG_x__ が既定の言語で解決すること
  const refs = [...readFileSync(join(ROOT, 'manifest.json'), 'utf8').matchAll(/__MSG_([A-Za-z0-9_]+)__/g)]
    .map((m) => m[1]);
  assert.ok(refs.length >= 2, `__MSG__ 参照が少なすぎる: ${refs.length}`);
  for (const r of refs) {
    assert.ok(base.includes(r), `既定の言語に ${r} が無い`);
  }
});

test('コードが呼ぶ翻訳キーが、言語ファイルに全部ある', () => {
  /*
   * 鍵の綴りを間違えても chrome.i18n.getMessage は空文字を返すだけで、
   * 落ちも警告も出ない（バッジの見出しが空になる）。第16回監査 R16-003 で
   * noticeReloadRequired を足したので、コード側から見た取りこぼしも見張る。
   */
  const used = new Set();
  for (const f of ['src/background.js', 'src/content.js', 'src/esc-close.js']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/getMessage\(\s*'([^']+)'\s*\)/g)) used.add(m[1]);
    for (const m of src.matchAll(/\bt\(\s*'([^']+)'\s*,/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 5, `拾えたキーが少なすぎる（拾い方が壊れている）: ${used.size}`);
  for (const loc of ['en', 'ja']) {
    const table = JSON.parse(readFileSync(join(ROOT, `_locales/${loc}/messages.json`), 'utf8'));
    for (const k of used) {
      assert.ok(k in table, `${loc} に ${k} が無い（空文字が表示される）`);
    }
  }
  /* 対照: 拾い方が効いていること（実在するキーを1つ名指しで確かめる） */
  assert.ok(used.has('noticeReloadRequired'), 'キーの拾い方が効いていない');
});

test('利用者に見える文字列をコードへ直書きしていない', () => {
  const content = readFileSync(join(ROOT, 'src/content.js'), 'utf8');
  const code = content.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter((l) => !/^\s*\/\//.test(l)).join('\n');
  // ボタンの title / aria-label / 表示文字は _locales から取る
  for (const re of [/\.title\s*=\s*'[^']*[ぁ-んァ-ヶ一-龠]/, /aria-label',\s*'[^']*[ぁ-んァ-ヶ一-龠]/]) {
    assert.ok(!re.test(code), '日本語の文字列が直書きされている');
  }
  assert.ok(/chrome\.i18n\.getMessage/.test(code), 'i18n を使っていない');
});

test('CIワークフローが供給網の最低条件を満たす', () => {
  // 改行はLFへ揃えてから見る（Windowsのチェックアウトで CRLF になっても判定を変えない）
  const wf = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
  const uses = [...wf.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 3, `uses が少なすぎる: ${uses.length}`);
  for (const u of uses) {
    // 可変タグ（@v7）は付け替えられるので、完全なcommit SHAで固定する
    assert.match(u, /@[0-9a-f]{40}$/, `commit SHA で固定されていない: ${u}`);
  }
  assert.match(wf, /^permissions:\n  contents: read$/m, 'permissions: contents: read が無い');
  assert.match(wf, /timeout-minutes:\s*\d+/, 'timeout-minutes が無い');
  assert.ok(!/pull_request_target/.test(wf), 'pull_request_target は使わない');
  assert.ok(!/\$\{\{\s*secrets\./.test(wf), 'secret を参照している');

  // チェックアウトのたびにトークンを .git/config へ残さない
  const checkouts = uses.filter((u) => u.startsWith('actions/checkout@'));
  assert.ok(checkouts.length >= 2, `checkout の数が想定と違う: ${checkouts.length}`);
  assert.equal(
    (wf.match(/persist-credentials: false/g) || []).length,
    checkouts.length,
    'persist-credentials: false が付いていない checkout がある'
  );
});

/*
 * PRのCIが作るZIPは、GitHubがPR検証のために作る一時マージコミットから出来ている。
 * それを提出候補と同じ名前で残していたので、所有者が取り違えられた（第5回監査 R5-003）。
 * ここは文言ではなくワークフローの構造を見る。
 */
test('PRのCIは提出候補の成果物を残さない', () => {
  const wf = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
  const steps = wf.split(/\n      - /).slice(1);
  const uploads = steps.filter((s) => /uses:\s*actions\/upload-artifact@/.test(s));
  assert.ok(uploads.length >= 1, 'upload-artifact のステップが無い');

  for (const step of uploads) {
    /*
     * 「PRでなければ残す」では緩い。workflow_dispatch は実行するブランチを選べるので、
     * feature ブランチやタグから回した成果物まで提出候補の名前で残りえた（R6-001）。
     * 残してよいのは main への push だけ。
     */
    assert.match(step, /if:\s*github\.event_name\s*==\s*'push'\s*&&\s*github\.ref\s*==\s*'refs\/heads\/main'/,
      'upload-artifact の条件が「main への push」に限定されていない');
    assert.match(step, /name:\s*reposhout-package-\$\{\{\s*github\.sha\s*\}\}/,
      '成果物の名前にコミットが入っていない（どのコミット由来か辿れない）');
  }

  // PRでも package は走らせる（作れることは確かめる）
  assert.match(wf, /run: npm run package/, 'package を走らせていない');
  // PRの head / base を package へ渡している
  assert.match(wf, /PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/,
    'PRの head SHA を記録へ渡していない');
  assert.match(wf, /PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
    'PRの base SHA を記録へ渡していない');
});

/*
 * 「作れること」のステップが、何も作らないまま成功していた（2026-08-06・CIで発覚）。
 * 直接実行の判定を `file://${process.argv[1]}` で書いていたため、Windows では
 * 絶対に一致せず、CLIの出口が丸ごと動いていなかった。走らなかったのか成功したのかを
 * 出力から見分けられない、いちばん危ない失敗の形。
 */
test('スクリプトの直接実行の判定が、Windowsのパスでも成立する', () => {
  const src = readFileSync(join(ROOT, 'scripts/package.mjs'), 'utf8');
  assert.ok(!/import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`/.test(src),
    'file://${process.argv[1]} との比較は Windows で一致しない');
  assert.ok(/pathToFileURL\(process\.argv\[1\]\)\.href/.test(src),
    'pathToFileURL でURL同士を比べていない');

  // 対照: 旧い書き方は Windows 形式のパスで実際に一致しない
  const winPath = 'D:\\a\\repo\\scripts\\package.mjs';
  const winUrl = 'file:///D:/a/repo/scripts/package.mjs';
  assert.notEqual(winUrl, `file://${winPath}`, '対照が成立していない');
});

/*
 * タグを打ったときに走るCIが、そのタグ自身を検証していなかった（第8回監査 R8-004）。
 * 過去の確定済みの行を突き合わせるだけでは、いま付けたタグが正しいかを見ていない。
 * 別の版のタグを同じコミットへ付けても通る構造だった。
 */
test('タグpushのCIが、いま付けたタグ自身を検証する', () => {
  const wf = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
  const i = wf.indexOf('いま付けたタグを検証する');
  assert.ok(i > 0, 'タグ検証のステップが無い');
  const step = wf.slice(i, wf.indexOf('\n      - name:', i + 10));

  assert.match(step, /if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/,
    'タグpushのときだけ走る条件になっていない');
  for (const [needle, why] of Object.entries({
    'v$VERSION': 'タグ名と manifest の版の一致',
    '^{}': 'タグの指す先（peeled）',
    'GITHUB_SHA': '走っているコミットとの一致',
    'merge-base --is-ancestor': 'main に入っていること'
  })) {
    assert.ok(step.includes(needle), `タグ検証に「${why}」が無い: ${needle}`);
  }
  // 失敗したら止まること（警告で流さない）
  assert.equal((step.match(/exit 1/g) || []).length, 3, '3つの判定すべてで停止していない');
});

/*
 * 決定論のステップが、2回目のビルドが何もしなくても通る形だった（第9回監査 R9-006）。
 * 前の dist を消さずにハッシュを読み直していたため。第7回で見つけた
 * 「何もしないまま成功する」型と同じ。
 */
test('決定論のステップが、2回目を作り直させている', () => {
  const wf = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
  const i = wf.indexOf('同じ内容から同じZIPができることを確かめる');
  assert.ok(i > 0, '決定論のステップが無い');
  const step = wf.slice(i, wf.indexOf('\n      - name:', i + 10));

  assert.ok(step.includes('rm -rf dist'), '2回目の前に dist を消していない');
  assert.ok(step.includes('release-manifest.json'), '2回目が記録を作ったか見ていない');
  assert.ok(/-eq 3/.test(step), '出力が3点そろったか見ていない');
  assert.ok(step.includes('cmp '), 'バイト列を比べていない');
  // 何も無いまま成功する成果物アップロードを許さない
  assert.ok(wf.includes('if-no-files-found: error'),
    'upload-artifact が空でも成功する設定になっている');
});

test('配布するファイルに CRLF が混ざっていない', () => {
  /*
   * 改行が混ざると、同じコミットでもOSによってZIPの中身が変わり、
   * SHA-256 が一致しなくなる。.gitattributes でLFへ固定しているが、
   * 効いていることをここで実測する。
   */
  for (const f of PACKAGE_FILES) {
    if (f.endsWith('.png')) continue;
    const body = readFileSync(join(ROOT, f), 'utf8');
    assert.ok(!body.includes('\r'), `CRLF が混ざっている: ${f}`);
  }
});

test('配布物にテスト・ストア素材・文書を含めない', () => {
  for (const f of PACKAGE_FILES) {
    assert.ok(!f.startsWith('test/'), f);
    assert.ok(!f.startsWith('store/'), f);
    assert.ok(!f.startsWith('scripts/'), f);
    assert.ok(!f.endsWith('.md'), f);
  }
});
