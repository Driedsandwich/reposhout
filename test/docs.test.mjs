/*
 * 文書とコードの言っていることを揃えるための検査
 *
 * 「どこにも送らない」と書いてある文書が残っていたのを、
 * 3回の監査で3回とも指摘された。人が読み直す運用では落ちるので、
 * 禁止する言い回しを機械で見張る。
 *
 * 履歴を書いた文書（CHANGELOG・実装報告・ストア差分表）は対象外にする。
 * そこでは「昔こう書いていたのが誤りだった」と**引用する必要がある**ため。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers/load.mjs';

/* 利用者が読む文書。ここに旧説明が残ってはいけない */
const USER_FACING = ['README.md', 'README.ja.md', 'PRIVACY.md', 'store/LISTING.md'];

/* 実挙動と食い違う言い回し。過去3回の監査で名指しされたもの */
const FORBIDDEN = [
  'sends nothing anywhere',
  'not transmitted anywhere',
  'transmitted anywhere by the extension',
  'does not transmit any user information',
  'does not collect, store, or transmit',
  'All processing happens locally',
  'all processing happens locally',
  '保存も送信もありません',
  '保存も送信もしません',
  '収集・保存・送信しません',
  '独自の通信を一切行いません',
  '過去に審査を通ったので',
  'どこにも送信しません',
  /*
   * 第5回監査 R5-001。少なく言うのと同じくらい、事実より広く言うのもまずい。
   * 共有できて account 名を含まないURLが実在する（search / explore / topics）。
   */
  'URL always contains',
  'always contains a GitHub account',
  '必ずGitHubのアカウント名',
  'アカウント名が必ず含まれ'
];

/* 改行はLFへ揃えてから見る（Windowsのチェックアウトで CRLF になっても判定を変えない） */
const read = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

test('利用者が読む文書に、実挙動と食い違う言い回しが残っていない', () => {
  for (const f of USER_FACING) {
    const body = read(f);
    for (const phrase of FORBIDDEN) {
      assert.ok(!body.includes(phrase), `${f} に禁止表現が残っている: ${phrase}`);
    }
  }
});

test('検査が効いているかの対照', () => {
  // 禁止表現の一覧そのものには当然その文字列が入っている＝grepは機能している
  const self = read('test/docs.test.mjs');
  for (const phrase of ['sends nothing anywhere', '保存も送信もありません']) {
    assert.ok(self.includes(phrase), `対照が成立していない: ${phrase}`);
  }
});

test('Xへ渡ることが、利用者が読む文書すべてに書いてある', () => {
  const mustMention = {
    'README.md': ['travel to X', 'composer opens'],
    'README.ja.md': ['Xへ渡ります', '画面が開いた時点'],
    'PRIVACY.md': ['sent to X', 'Xへ送られます'],
    'store/LISTING.md': ['sent to X']
  };
  for (const [f, phrases] of Object.entries(mustMention)) {
    const body = read(f);
    for (const p of phrases) {
      assert.ok(body.includes(p), `${f} に「Xへ渡る」の記述が無い: ${p}`);
    }
  }
});

/*
 * 1.1.4 から公式の conformance コーパスを**実際に走らせている**。
 * ただし走らせているのは文字数の3節だけで、autolink や extract は走らせていない。
 * だから「conformance を実行した」と書いてよいが、**範囲を書かずに書いてはいけない**。
 *
 * 範囲を示す語（走らせているファイル名・節・件数、または走らせていないという否定）が
 * 同じ行に無ければ落とす。
 */
const SCOPED = /validate\.yml|counting section|文字数の?\d+節|not run|not shipped|実行していない|同梱されていない|走らせていない|していません/i;

test('conformance を、範囲を書かずに「実行した」と書いていない', () => {
  for (const f of [...USER_FACING, 'CHANGELOG.md', 'IMPLEMENTATION_REPORT.md']) {
    for (const line of read(f).split('\n')) {
      if (!/conformance/i.test(line)) continue;
      assert.ok(SCOPED.test(line),
        `${f}: conformance の範囲を書かずに触れている行がある: ${line.trim().slice(0, 90)}`);
    }
  }
});

test('conformance の検査が効いているかの対照', () => {
  const claim = '公式 conformance コーパスを実行して全PASSした';
  assert.ok(/conformance/i.test(claim) && !SCOPED.test(claim),
    '対照が成立していない＝この検査は範囲抜きの主張を捕まえられない');
});

/*
 * 有限のfixtureで測ったことを「証明した」と書かない。
 * 履歴の文書（CHANGELOG・実装報告）は、過去に書いた誤りを引用する必要があるので対象外。
 */
const OVERCLAIMS = [
  'never under-counts',
  'proving the counter',
  'proves the counter',
  'over all inputs',
  'for all inputs',
  'for any input',
  '全入力',
  'すべての入力',
  '絶対に下回らない',
  '数学的に証明',
  /*
   * 第6回監査 R6-002。上の一覧に入れていなかった言い回しが素通りしていた。
   * 検出器の探索範囲が狭いと、範囲の外に書けば何でも通る。
   */
  'only ever allowed to over-count',
  'is never allowed to under-count',
  '多く数えることはあっても、少なく数えることはない',
  '少なく数えることはありません',
  '必ず多めに数える',
  '公式がどの解釈を採っても、こちらがそれを下回らない'
];

/* 「全入力に対する証明ではありません」のような**否定**は、むしろ書いてよい */
const DENIED = /not a proof|does not prove|ではありません|ではない|とは限りません|限りません/i;

test('文字数の保証を、実際に測った範囲より広く書いていない', () => {
  for (const f of USER_FACING) {
    for (const line of read(f).split('\n')) {
      const hit = OVERCLAIMS.find((p) => line.includes(p));
      if (!hit) continue;
      assert.ok(DENIED.test(line),
        `${f} に測った範囲を超える言い方が残っている（${hit}）: ${line.trim().slice(0, 90)}`);
    }
  }
});

test('言い過ぎの検査が効いているかの対照', () => {
  const claim = 'an oracle proving the counter never under-counts';
  assert.ok(OVERCLAIMS.some((p) => claim.includes(p)) && !DENIED.test(claim),
    '対照が成立していない＝この検査は言い過ぎを捕まえられない');
});

/*
 * 「走らせていない」と書いたまま走らせるようになると、こんどは過少申告になる。
 * 1.1.4 から固定した validate.yml の文字数対象節は実際に走っているので、
 * 現行版の文書に「公式コーパスは走らせていない」と読める記述を残さない（R6-003）。
 */
test('現行版の文書に「公式コーパスを走らせていない」が残っていない', () => {
  const stale = [
    'so it is not run',
    'is not run.',
    '公式 conformance コーパスは走らせていない',
    'conformance コーパスを走らせていません'
  ];
  for (const f of USER_FACING) {
    const body = read(f);
    for (const phrase of stale) {
      assert.ok(!body.includes(phrase), `${f} に古い記述が残っている: ${phrase}`);
    }
  }
});

/*
 * 提出物のQA手順。ダウンロードした成果物のフォルダには manifest.json が無く、
 * そのままでは拡張として読み込めない。内側のZIPを展開する工程が要る（第6回監査 R6-004）。
 * ここでは手順書に必要な工程が、必要な順で書いてあることを見る。
 * 「本当に manifest.json が無い」ことは test/package.test.mjs が実物で確かめる。
 */
test('提出物のQA手順に、内側のZIPを展開する工程がある', () => {
  const body = read('store/LISTING.md');
  const i = body.indexOf('### どのZIPを出すか');
  assert.ok(i > 0, 'どのZIPを出すかの節が無い');
  const section = body.slice(i, body.indexOf('\n同梱物は', i));

  const order = [
    'ダウンロード',
    'release-manifest.json',
    '.sha256',
    '新しい空のフォルダ',
    '展開',
    'manifest.json',
    'パッケージ化されていない拡張機能',
    'アップロード'
  ];
  let at = 0;
  for (const step of order) {
    const found = section.indexOf(step, at);
    assert.ok(found >= 0, `QA手順に「${step}」が無い（または順序が違う）`);
    at = found;
  }
  assert.ok(section.includes('そのまま読み込'),
    '「そのまま読み込んではいけない」という注意が無い');
});

test('QA手順の検査が効いているかの対照', () => {
  // 内側ZIPの展開工程が無い旧手順は、同じ検査を通らない
  const old = 'ダウンロードする / release-manifest.json を確かめる / .sha256 を確かめる / ' +
              'その展開物をそのままパッケージ化されていない拡張機能として読み込む / アップロードする';
  assert.ok(!old.includes('新しい空のフォルダ'),
    '対照が成立していない＝旧手順でも通ってしまう');
});

test('公式コーパスを走らせている範囲が、READMEに書いてある', () => {
  for (const [f, needles] of Object.entries({
    'README.md': ['validate.yml', 'counting sections', 'pinned upstream commit'],
    'README.ja.md': ['validate.yml', '文字数の3節', '配布物には入りません']
  })) {
    const body = read(f);
    for (const n of needles) {
      assert.ok(body.includes(n), `${f} に公式コーパスの範囲が書いていない: ${n}`);
    }
  }
});

/*
 * ストアのデータ申告は store/DATA_DISCLOSURE.json だけを正本にする。
 *
 * 以前は LISTING.md が「PII: No」、STORE_DASHBOARD_CHANGES.md が「PII: Yes推奨」で、
 * どちらの文書を見て入力するかによって申告が変わった（第5回監査 R5-001）。
 * 文書は正本から写すものとし、写し違いをここで捕まえる。
 */
const DISCLOSURE = JSON.parse(read('store/DATA_DISCLOSURE.json'));

/* 表の行から Yes / No を取り出す。「**Yes へ変更**」も Yes として読む */
function answersFrom(file, answerColumn) {
  const out = new Map();
  for (const line of read(file).split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const label = cells[1];
    const cell = (cells[answerColumn] || '').replace(/\*/g, '').trim();
    const m = /^(Yes|No)\b/.exec(cell);
    if (label && m) out.set(label, m[1]);
  }
  return out;
}

const DISCLOSURE_TABLES = [
  { file: 'store/LISTING.md', answerColumn: 2 },
  { file: 'store/STORE_DASHBOARD_CHANGES.md', answerColumn: 3 }
];

test('ストア文書のデータ申告が、正本と1つ残らず一致する', () => {
  for (const { file, answerColumn } of DISCLOSURE_TABLES) {
    const got = answersFrom(file, answerColumn);
    for (const cat of DISCLOSURE.categories) {
      assert.ok(got.has(cat.label), `${file} に「${cat.label}」の行が無い`);
      assert.equal(got.get(cat.label), cat.answer,
        `${file} の「${cat.label}」が正本と違う: 文書=${got.get(cat.label)} 正本=${cat.answer}`);
    }
  }
});

test('データ申告の欄が9つそろっていて、答えが Yes / No のどちらかである', () => {
  const labels = DISCLOSURE.categories.map((c) => c.label);
  assert.equal(labels.length, 9, `欄の数が違う: ${labels.length}`);
  assert.equal(new Set(labels).size, 9, '同じ欄が二重に入っている');
  for (const c of DISCLOSURE.categories) {
    assert.ok(['Yes', 'No'].includes(c.answer), `${c.label} の答えが Yes / No でない: ${c.answer}`);
    // コードの事実と、規約上の判断は別の欄に書く（どちらか片方で断定しない）
    assert.ok(c.codeFact && c.codeFact.length > 5, `${c.label} にコードの事実が無い`);
    assert.ok(c.policyBasis && c.policyBasis.length > 3, `${c.label} に規約上の根拠が無い`);
  }
  assert.equal(DISCLOSURE.version, JSON.parse(read('manifest.json')).version,
    '正本のバージョンが manifest とずれている');
});

test('申告の検査が効いているかの対照', () => {
  // 正本を1か所だけ書き換えた偽物を作れば、同じ突き合わせが必ず食い違いを出す
  const flipped = DISCLOSURE.categories.map((c) =>
    c.id === 'web_history' ? { ...c, answer: c.answer === 'Yes' ? 'No' : 'Yes' } : c);
  const got = answersFrom('store/LISTING.md', 2);
  const target = flipped.find((c) => c.id === 'web_history');
  assert.notEqual(got.get(target.label), target.answer,
    '対照が成立していない＝この検査は食い違いを捕まえられない');
});

test('渡り先・タイミング・開発者が受け取らないことが、申告の正本に書いてある', () => {
  const f = DISCLOSURE.dataFlow;
  assert.match(f.thirdPartyRecipient, /X/, '渡る先が書いていない');
  assert.match(f.whenItReachesX, /投稿画面/, '渡るタイミングが書いていない');
  assert.match(f.developerServer, /受け取らない|無い/, '開発者が受け取らないことが書いていない');
  assert.equal(f.postIsUserDecision, true);
  assert.match(f.persistentStorageOfTitleOrUrl, /無い/, 'タイトル・URLを保存しないことが書いていない');
  // PII の根拠は「username が公式の例に入っている」こと。ここが抜けると理由が言えない
  assert.equal(DISCLOSURE.policyReference.piiExamplesIncludeUsername, true);
  assert.match(DISCLOSURE.policyReference.handleMeans, /transmit/,
    'handle に transmit が含まれることを書いていない');
});

test('アカウント名は「入る場合がある」と書いてある（「必ず入る」ではない）', () => {
  const en = read('PRIVACY.md');
  assert.match(en, /may contain a GitHub username or organisation identifier/,
    'PRIVACY.md（英語）に「含む場合がある」の記述が無い');
  assert.match(en, /入る場合があります/, 'PRIVACY.md（日本語）に「含む場合がある」の記述が無い');

  const pii = DISCLOSURE.categories.find((c) => c.id === 'personally_identifiable_information');
  assert.match(pii.codeFact, /場合がある/, '正本が「必ず入る」と読める書き方になっている');
});

/*
 * ダッシュボードへ貼るホスト権限の説明を、実装と揃える。
 *
 * README と PRIVACY は直したのに、**実際に審査へ出す文面だけ**が
 * 「ページを読むのはボタン行を探すためだけで、要素を1つ足す」のまま残っていた
 * （第6回監査 R6-002）。人が読み直す運用では、貼る文面ほど見落とす。
 */
test('ストアへ貼る github.com の権限説明が、実装と揃っている', () => {
  const body = read('store/LISTING.md');
  const i = body.indexOf('**Host permission: github.com**');
  assert.ok(i > 0, 'github.com の権限説明が無い');
  const section = body.slice(i, body.indexOf('**Host permission: x.com**', i));

  const must = {
    'action row': 'どこを探すのか',
    '<style>': '足す style 要素',
    'wrapper': 'ボタンを包む要素',
    '<li> or a <div>': 'コンテナによって li か div になること',
    'location.href': '読む値（URL）',
    'document.title': '読む値（タイトル）',
    'event.isTrusted': '合成クリックを拒否すること',
    'activeTab': 'ツールバー/ショートカットは別経路であること'
  };
  for (const [needle, why] of Object.entries(must)) {
    assert.ok(section.includes(needle), `github.com の権限説明に「${why}」が書いていない: ${needle}`);
  }

  // 旧文の言い回しが残っていないこと
  for (const stale of ['adds a single <li> element', 'reads\nthe page only to locate']) {
    assert.ok(!section.includes(stale), `旧い説明が残っている: ${stale}`);
  }
});

test('権限説明の検査が効いているかの対照', () => {
  const old = "The content script reads the page only to locate the button row, and adds a single <li> element.";
  for (const needle of ['<style>', 'location.href', 'document.title', 'event.isTrusted']) {
    assert.ok(!old.includes(needle), `対照が成立していない＝旧文でも通ってしまう: ${needle}`);
  }
});

test('バージョンが manifest / package.json / CHANGELOG / ストア文書で揃っている', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, manifest.version);
  assert.ok(read('CHANGELOG.md').includes(`## [${manifest.version}]`),
    `CHANGELOG に ${manifest.version} の節が無い`);

  /*
   * ストアへ貼る文書が古い版を指したまま残っていたことが実際にあった。
   * 提出のとき人が読むのはこの2枚なので、版が揃っていることを機械で見る。
   */
  for (const f of ['store/LISTING.md', 'store/STORE_DASHBOARD_CHANGES.md']) {
    const body = read(f);
    assert.ok(body.includes(manifest.version), `${f} が ${manifest.version} を指していない`);
    for (const m of body.matchAll(/reposhout-(\d+\.\d+\.\d+)\.zip/g)) {
      assert.equal(m[1], manifest.version, `${f} が古いZIP名を指している: ${m[1]}`);
    }
  }
});
