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
import { execFileSync } from 'node:child_process';
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
/*
 * 公開済みの拡張機能を更新する手順なのに、「新しいアイテムを追加」を案内していた
 * （第8回監査 R8-001）。そのまま実行すると別IDの拡張機能がもう1つ出来て、
 * いまの利用者・評価・自動更新は引き継がれない。取り返しがつきにくい種類の間違い。
 */
test('更新の手順が、新規登録ではなく既存アイテムへの差し替えになっている', () => {
  const body = read('store/LISTING.md');
  const i = body.indexOf('## 1. パッケージのアップロード');
  assert.ok(i > 0, 'アップロードの節が無い');
  const section = body.slice(i, body.indexOf('\n## 2.', i));

  for (const needle of ['Upload New Package', 'Package', '既存のアイテム',
                        'joaipdjaiefbenoijcekdnjagiadikkd', 'Submit for review']) {
    assert.ok(section.includes(needle), `更新の手順に「${needle}」が無い`);
  }
  // 新規登録の入口を、更新の手順の中で案内していないこと
  assert.ok(!section.includes('「新しいアイテムを追加」→'),
    '更新の手順の中で新規登録の入口を案内している');
  assert.ok(/新しいアイテムを追加.{0,40}(押さない|使いません)/s.test(section),
    '新規登録の入口を使わない旨の注意が無い');

  // 初回登録の手順は残す（消してしまうと初回に困る）。ただし別の節へ
  assert.ok(body.includes('付録: 初回登録の手順'), '初回登録の手順が消えている');
});

test('更新手順の検査が効いているかの対照', () => {
  const old = '**「新しいアイテムを追加」→ ZIPをドラッグ**';
  assert.ok(!old.includes('Upload New Package'), '対照が成立していない＝旧手順でも通る');
});

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

/*
 * 第9回監査 R9-005。禁止語の一覧方式は、語の間に別の語が挟まると一致しない。
 * 日本語READMEの「公式の conformance コーパスは npm パッケージに同梱されていないため、
 * 走らせていません」は、禁止語「公式 conformance コーパスは走らせていない」と一字違いで
 * 素通りしていた。**書いてあるべきことを積極的に要求する**形へ変える。
 */
test('READMEが、実装と一致する事実を積極的に書いている', () => {
  const must = {
    'README.md': [
      ['validate.yml', '走らせている公式コーパスの名前'],
      ['counting sections', '走らせている範囲'],
      ['pinned upstream commit', '固定していること'],
      ['refused at every entry point', '設定・認証ページを全入口で拒否すること']
    ],
    'README.ja.md': [
      ['validate.yml', '走らせている公式コーパスの名前'],
      ['文字数の3節', '走らせている範囲'],
      ['配布物には入りません', '配布物に入らないこと'],
      ['すべての入口で拒否', '設定・認証ページを全入口で拒否すること'],
      ['文字数の3節は実際に走らせています', '走らせている事実（否定形で書かない）']
    ]
  };
  for (const [f, pairs] of Object.entries(must)) {
    const body = read(f);
    for (const [needle, why] of pairs) {
      assert.ok(body.includes(needle), `${f} に「${why}」が書いていない: ${needle}`);
    }
  }
});

test('プライバシーポリシーに Limited Use の遵守声明がある', () => {
  const p = read('PRIVACY.md');
  for (const [needle, why] of [
    ['adheres to the Chrome Web Store User Data Policy', '英語の遵守声明'],
    ['Limited Use', 'Limited Use の明記'],
    ['ユーザーデータポリシー（Limited Use の要件を含む）に従います', '日本語の遵守声明'],
    ['creditworthiness', '信用力判断に使わないこと'],
    ["human review by the developer or", '人手閲覧を開発者側に限定していること'],
    ['開発者または開発者のために行動する者の人手閲覧', '日本語側の同じ限定']
  ]) {
    assert.ok(p.replace(/\s+/g, ' ').includes(needle), `PRIVACY.md に「${why}」が無い: ${needle}`);
  }
  // ストアへ貼るポリシーURLがこの文書を指していること
  assert.ok(read('store/LISTING.md').includes('blob/main/PRIVACY.md'),
    'ストア文書のポリシーURLが PRIVACY.md を指していない');
});

/*
 * 第10回監査 R10-001。同じ文書が「Xへ渡る」と書いているのに「人は誰も読まない」
 * 「受け取れるサーバーは無い」「何も保存しない」と断定していた。約束できるのは
 * 開発者側だけで、X側で誰が読むかも、session storage に何が残るかも別の話。
 */
test('プライバシーポリシーが、保証できない範囲まで断定していない', () => {
  const flat = read('PRIVACY.md').replace(/\s+/g, ' ');
  assert.ok(/X receives|Xへ渡/.test(flat), '前提が崩れている（Xへ渡ると書いていない）');
  for (const [re, why] of [
    [/No human [\u2014-] including the developer/, '「人は誰も読まない」と断定している'],
    [/開発者を含め、人がこのデータを読むことはありません/, '同（日本語）'],
    [/there is no server that could receive it/i, '「受け取れるサーバーは無い」と限定なしに断定している'],
    [/受け取れるサーバーも存在しません/, '同（日本語）'],
    [/nothing is retained/i, '「何も保存しない」と断定している（ウィンドウIDと時刻は保存する）']
  ]) {
    assert.ok(!re.test(flat), `PRIVACY.md が言い過ぎている: ${why}`);
  }
  // Xが受け取ったあとの扱いは、Xのポリシーの話だと書いてあること
  assert.ok(/X's own policies/i.test(flat) && /Xのポリシーに従って/.test(flat),
    'X側の扱いについての限定が無い');
});

/*
 * 第10回監査 R10-001。content script の表が「ボタン行を探すためだけに読む」と
 * だけ書いていたが、押された時点で location.href と document.title を読む。
 */
test('content script の表が、押されたときに読む2つを書いている', () => {
  /*
   * 文書のどこかにあるか、ではなく**その行にあるか**を見る。英語の行から消しても
   * 日本語の行に同じ語が残っていて通ってしまった（この検査を作ったときの変異で実測）。
   */
  const rows = read('PRIVACY.md').split('\n')
    .filter((l) => l.startsWith('| `https://github.com/*`'));
  assert.equal(rows.length, 2, `GitHub側の行が2つ（英日）でない: ${rows.length}`);
  for (const row of rows) {
    for (const needle of ['location.href', 'document.title']) {
      assert.ok(row.includes(needle), `PRIVACY.md の表の行に「${needle}」が無い: ${row.slice(0, 60)}…`);
    }
  }
  assert.ok(rows.some((r) => r.includes('trusted click')), '英語の行に trusted click が無い');
  assert.ok(rows.some((r) => r.includes('利用者の操作によるクリック')), '日本語の行に同じ説明が無い');
});

/*
 * 第10回監査 R10-004。冒頭に「更新なら §1 と §2 だけを直せば足ります」と書いてあった。
 * 今回の 1.0.1 → 1.1.7 では §3（Privacy practices）も必須で、掲載中の申告は
 * 9項目すべて No のままなので、飛ばすと事実と違う申告を残して提出することになる。
 */
test('更新の手順が、Privacy practices まで必須と書いてある', () => {
  const listing = read('store/LISTING.md');
  assert.ok(/§0[^\n]*§3/.test(listing), 'store/LISTING.md が §3 まで必須と書いていない');
  assert.ok(/すべて No/.test(listing), '掲載中の古い申告（すべてNo）を直す指示が無い');
  assert.ok(!/§1 と §2 だけを直せば足ります/.test(listing),
    '「§1と§2だけで足りる」が残っている');
  // 対照: 旧文面は同じ判定を通らない
  const old = 'ページの手順。更新のときは §1 のアップロードと §2 の掲載文だけを直せば足ります。';
  assert.ok(!/§0[^\n]*§3/.test(old), '対照が成立していない＝旧文面でも通ってしまう');
});

/*
 * 第10回監査 R10-006。ストア文書は SUBMISSION_CANDIDATE.json と
 * 一致し、いまの main の位置（すぐ古くなる）を書かない。
 */
test('ストア文書が、正本の成果物と一致していて、可変な main を書いていない', () => {
  const cand = JSON.parse(read('store/SUBMISSION_CANDIDATE.json'));
  /* 履歴に残した過去の版の値も「正本の一部」として許す */
  const known = [cand, ...(cand.history || [])]
    .flatMap((o) => [o.sourceCommit, o.treeSha, o.innerSha256])
    .filter(Boolean);
  const pending = cand.status === 'pending_main_ci';

  for (const f of ['store/LISTING.md', 'store/STORE_DASHBOARD_CHANGES.md']) {
    const body = read(f);
    if (pending) {
      /*
       * まだ main の CI が作っていない版では、成果物名もハッシュも存在しない。
       * ここで「それらしい値」を書かせない——書けば必ず作り話になる。
       */
      assert.ok(body.includes('pending_main_ci'),
        `${f} に「成果物がまだ無い」ことが書いていない`);
      assert.ok(!/成果物名 : reposhout-package-[0-9a-f]{40}/.test(body),
        `${f} に、まだ存在しない成果物名が書いてある`);
    } else {
      assert.ok(body.includes(cand.artifactName), `${f} に正本の成果物名が無い`);
      assert.ok(body.includes(cand.innerSha256), `${f} に正本のSHA-256が無い`);
    }
    /* 数字だけの並び（run ID など）はコミットではない */
    const strays = [...new Set((body.match(/\b[0-9a-f]{7,40}\b/g) || [])
      .filter((h) => /[a-f]/.test(h))
      .filter((h) => !known.some((k) => k && k.startsWith(h))))];
    assert.deepEqual(strays, [], `${f} に、正本に無いコミットが書いてある: ${strays.join(', ')}`);
  }
});

test('正本が pending のときは、成果物の欄が空のまま', () => {
  const cand = JSON.parse(read('store/SUBMISSION_CANDIDATE.json'));
  if (cand.status !== 'pending_main_ci') return;   // 確定後はこの検査の対象外
  for (const k of ['sourceCommit', 'treeSha', 'runId', 'artifactName', 'innerSha256', 'innerBytes']) {
    assert.equal(cand[k], null, `${k} に推測の値が入っている: ${cand[k]}`);
  }
  // 過去の版は履歴として残っていること（何を出さないことにしたのかが分かるように）
  assert.ok((cand.history || []).length >= 1, '履歴が空');
});

/*
 * 第10回監査 R10-005。READMEの冒頭は「ツールバーとショートカットはGitHubのどの
 * ページでも使える」と書いていた。実装は認証・アカウント・設定・組織管理を
 * 全入口で拒否するので、事実と違う。
 *
 * 第9回で入れた検査は**文書のどこかに正しい文があるか**しか見ていなかったので、
 * 巻末の「制約」に正しい説明があることで通ってしまい、冒頭の矛盾を見逃した。
 * ここでは**その節だけを切り出して**判定する。
 */
function section(body, heading) {
  const i = body.indexOf(heading);
  assert.ok(i >= 0, `見出しが無い: ${heading}`);
  const rest = body.slice(i + heading.length);
  const next = rest.search(/\n## /);
  return rest.slice(0, next === -1 ? undefined : next);
}

/* 節に対する判定。対照（旧文面）でも同じ関数を使う */
function topSectionProblems(sec, forbidden, required) {
  const problems = [];
  for (const [needle, why] of forbidden) if (sec.includes(needle)) problems.push(`言い過ぎ: ${why}`);
  for (const [needle, why] of required) if (!sec.includes(needle)) problems.push(`不足: ${why}`);
  return problems;
}

const TOP_RULES = {
  'README.md': {
    heading: '## What it does',
    forbidden: [['every GitHub page', '「どのページでも使える」'],
                ['Anywhere else on GitHub', '「GitHubのそれ以外どこでも」']],
    required: [['shareable GitHub pages', '共有できるページに限る、と書くこと'],
               ['refused at every entry point', '機微なページを全入口で拒否すること']]
  },
  'README.ja.md': {
    heading: '## できること',
    forbidden: [['どのページでも使えます', '「どのページでも使える」'],
                ['| その他のGitHubページ |', '「その他のGitHubページ」（共有可能の限定が無い）']],
    required: [['共有可能なGitHubページ', '共有できるページに限る、と書くこと'],
               ['すべての入口で拒否', '機微なページを全入口で拒否すること']]
  }
};

test('READMEの冒頭の節が、実装と食い違っていない', () => {
  for (const [f, rule] of Object.entries(TOP_RULES)) {
    const sec = section(read(f), rule.heading);
    const problems = topSectionProblems(sec, rule.forbidden, rule.required);
    assert.deepEqual(problems, [], `${f} の冒頭: ${problems.join(' / ')}`);
  }
});

test('冒頭の節の検査が効いているかの対照', () => {
  /*
   * 旧文面（巻末には正しい説明があるが冒頭は矛盾している状態）を作って、
   * 同じ判定に掛ける。落ちなければ、この検査は矛盾を捕まえられていない。
   */
  const old = {
    'README.md': '\n| Anywhere else on GitHub | Toolbar icon |\n\n' +
                 'The toolbar icon and the shortcut work on every GitHub page.\n',
    'README.ja.md': '\n| その他のGitHubページ | ツールバーのアイコン |\n\n' +
                    'ツールバーアイコンとショートカットは、GitHubのどのページでも使えます。\n'
  };
  for (const [f, rule] of Object.entries(TOP_RULES)) {
    const problems = topSectionProblems(old[f], rule.forbidden, rule.required);
    assert.ok(problems.length >= 2,
      `対照が成立していない＝旧文面でも通ってしまう: ${f} / ${problems.join(' / ')}`);
  }
});

test('ストア文書が、手元ビルドを提出用として案内していない', () => {
  for (const f of ['store/LISTING.md', 'store/STORE_DASHBOARD_CHANGES.md']) {
    const body = read(f);
    assert.ok(!body.includes('`npm run package` で作れます'),
      `${f} が手元ビルドを提出用として案内している`);
    assert.ok(body.includes('reposhout-package-') || body.includes('pending_main_ci'),
      `${f} に、どの成果物を出すか（または、まだ無いこと）が書いていない`);
  }
  // 出す正本が一意に決まっていること（成果物が確定してから）
  const cand = JSON.parse(read('store/SUBMISSION_CANDIDATE.json'));
  if (cand.status !== 'pending_main_ci') {
    assert.match(read('store/LISTING.md'), /成果物 : reposhout-package-[0-9a-f]{40}/,
      '提出する成果物が一意に指定されていない');
    assert.match(read('store/LISTING.md'), /SHA-256 : [0-9a-f]{64}/,
      '提出するZIPのSHA-256が書いていない');
  }
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
      /*
       * 第7回監査 R7-002。本人の確認が要る欄を、文書側では確定した No として
       * 見せていた。貼る人は文書しか見ないので、確認待ちのものを確定値で出さない。
       */
      if (cat.requiresOwnerConfirmation && cat.confirmationStatus !== 'confirmed') {
        assert.equal(cat.answer, null, `${cat.label}: 確認待ちなのに正本が答えを持っている`);
        assert.ok(['Yes', 'No'].includes(cat.proposedAnswer),
          `${cat.label}: 案（proposedAnswer）が無い`);
        assert.equal(got.get(cat.label), undefined,
          `${file}: 確認待ちの「${cat.label}」が確定値として書かれている`);
        assert.ok(new RegExp(`\\| ${cat.label} \\|[^\\n]*要確認`).test(read(file)),
          `${file}: 「${cat.label}」に要確認の印が無い`);
        continue;
      }
      assert.ok(got.has(cat.label), `${file} に「${cat.label}」の行が無い`);
      assert.equal(got.get(cat.label), cat.answer,
        `${file} の「${cat.label}」が正本と違う: 文書=${got.get(cat.label)} 正本=${cat.answer}`);
    }
  }
});

test('確認待ちの欄に、確認結果を書く場所が用意してある', () => {
  const pending = DISCLOSURE.categories.filter((c) => c.requiresOwnerConfirmation);
  assert.ok(pending.length >= 1, '確認待ちの欄が1つも無い');
  for (const c of pending) {
    const oc = c.ownerConfirmation;
    assert.ok(oc, `${c.label}: ownerConfirmation が無い`);
    for (const k of ['dashboardQuestionText', 'confirmedOn', 'chosen', 'reason']) {
      assert.ok(k in oc, `${c.label}: ${k} の欄が無い`);
    }
  }
});

test('データ申告の欄が9つそろっている', () => {
  const labels = DISCLOSURE.categories.map((c) => c.label);
  assert.equal(labels.length, 9, `欄の数が違う: ${labels.length}`);
  assert.equal(new Set(labels).size, 9, '同じ欄が二重に入っている');
  for (const c of DISCLOSURE.categories) {
    assert.ok(['pending', 'confirmed', 'not_required'].includes(c.confirmationStatus),
      `${c.label}: confirmationStatus が想定外: ${c.confirmationStatus}`);
    assert.equal(c.requiresOwnerConfirmation, c.confirmationStatus !== 'not_required',
      `${c.label}: 確認の要否と状態が食い違っている`);
    if (c.confirmationStatus === 'pending') {
      assert.equal(c.answer, null, `${c.label}: 確認待ちなら答えは持たない`);
      assert.ok(['Yes', 'No'].includes(c.proposedAnswer), `${c.label} の案が Yes / No でない`);
    } else {
      assert.ok(['Yes', 'No'].includes(c.answer), `${c.label} の答えが Yes / No でない: ${c.answer}`);
    }
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

/*
 * 公開状態の検査は test/release-status.test.mjs へ移した（第7回監査 R7-003）。
 * ここに置いていた「未リリース」等の禁止語方式は、1.1.5 が「作業ツリーのみ」と
 * 書いた瞬間に素通りした。言い回しではなく git の実物と突き合わせる方式にしてある。
 */

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

/*
 * 第13回監査 R13-005。npm run package の出力と DATA_DISCLOSURE が、
 * 廃止した `verify:store-readiness` を案内していた（実在しない）。
 * **文書や出力が名指しするスクリプトは、package.json に在ることを機械で見る。**
 */
test('案内している npm run のスクリプトが、すべて実在する', () => {
  const scripts = Object.keys(JSON.parse(read('package.json')).scripts);
  const sources = ['scripts/package.mjs', 'scripts/verify-store-readiness.mjs',
                   'store/DATA_DISCLOSURE.json', 'store/LISTING.md',
                   'store/STORE_DASHBOARD_CHANGES.md', 'README.md', 'README.ja.md',
                   'CHANGELOG.md', 'PRIVACY.md'];
  const missing = [];
  for (const f of sources) {
    for (const m of read(f).matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
      if (!scripts.includes(m[1])) missing.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `実在しないスクリプトを案内している: ${missing.join(' / ')}`);
  /* 対照: 実在しない名前を混ぜれば必ず見つかる */
  const control = 'npm run this-script-does-not-exist';
  const found = [...control.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)].map((m) => m[1]);
  assert.deepEqual(found, ['this-script-does-not-exist'], '対照が成立していない');
  assert.ok(!scripts.includes('this-script-does-not-exist'));
});

/*
 * 第13回監査 R13-002。README・ストア掲載文・PRIVACY が旧仕様のままだった
 * （検索語や下書きの title / body を残すと宣伝し、x.com のスクリプトを
 * 「Escapeだけを聞く」と説明していた）。**文書のどこかにあるか**ではなく、
 * その説明をしている箇所に正しい記述があることを要求する。
 */
test('文書が、いまの共有方針を正しく説明している（R13-002）', () => {
  const must = {
    'README.md': [
      ['Everything free-text is dropped', '自由文を落とすこと'],
      ['QUERY_RULES', '正本の名前'],
      ["One `keydown` listener", 'x.com の listener の実態']
    ],
    'README.ja.md': [
      ['自由に書ける欄はすべて落とします', '自由文を落とすこと'],
      ['QUERY_RULES', '正本の名前']
    ],
    'PRIVACY.md': [
      ['Registers one `keydown` listener', 'x.com の listener の実態（英語）'],
      ['`keydown` を1つ登録し', '同（日本語）'],
      ['The same check is applied to the post text built from the page title, and to the raw title before it is shortened',
       '投稿本文と、変換前の生のタイトルも検査すること'],
      ['投稿本文と、切り詰める前の生のタイトルにも掛けます', '同（日本語）・変換前も見ること']
    ],
    'store/LISTING.md': [
      ['Search terms and a prepared pull\n  request\'s title and body are never shared',
       '検索語と下書きを共有しないこと'],
      ['registers a single keydown listener', 'x.com の listener の実態']
    ]
  };
  for (const [f, pairs] of Object.entries(must)) {
    const body = read(f);
    for (const [needle, why] of pairs) {
      assert.ok(body.includes(needle), `${f} に「${why}」が無い: ${needle}`);
    }
  }
});

test('文書が、もう残さない値を「残す」と書いていない（R13-002）', () => {
  const forbidden = {
    'README.md': ["the `quick_pull`/`title`/`body` of a prepared pull request",
                  '`QUERY_ALLOW`'],
    'README.ja.md': ['下書き中のプルリクエストの `quick_pull`/`title`/`body`', '`QUERY_ALLOW`'],
    'store/LISTING.md': ["prepared pull request's title and body are kept",
                         'listen for the Escape key so'],
    'PRIVACY.md': ['Listens for the Escape key, and nothing else', 'Escキーの検知だけを行います']
  };
  for (const [f, list] of Object.entries(forbidden)) {
    const body = read(f);
    for (const needle of list) {
      assert.ok(!body.includes(needle), `${f} に古い説明が残っている: ${needle}`);
    }
  }
});

/*
 * ============================================================
 * 第14回監査 R14-003 — 案内文と文書が実装とずれていた
 * ============================================================
 *
 *   ・案内は「このURLには」と言うが、止める理由はタイトル側のこともある
 *   ・README は機微なページで「何も起きません」と書くが、実際は案内が出る
 *   ・README の表が実拡張E2Eを「10テスト」と固定で書いていた（実際は増えている）
 */

test('拒否の案内が、タイトルとURLの両方を理由として言う（R14-003）', () => {
  const en = JSON.parse(read('_locales/en/messages.json'));
  const ja = JSON.parse(read('_locales/ja/messages.json'));

  assert.ok(/title or URL/i.test(en.noticeCredential.message),
    `英語の案内がURLだけを理由にしている: ${en.noticeCredential.message}`);
  assert.ok(en.noticeCredential.message.includes('Nothing was sent to X'),
    '何も送っていないことを言っていない');
  assert.ok(ja.noticeCredential.message.includes('タイトルまたはURL'),
    `日本語の案内がURLだけを理由にしている: ${ja.noticeCredential.message}`);
  assert.ok(ja.noticeCredential.message.includes('Xへは何も送っていません'),
    '何も送っていないことを言っていない');

  /* 値やURLそのものを混ぜる余地を残していないこと（差し込みは使わない） */
  for (const [lang, m] of [['en', en], ['ja', ja]]) {
    for (const key of ['noticeCredential', 'noticeUnsupported']) {
      assert.ok(!/\$\d|\$[A-Za-z]+\$/.test(m[key].message),
        `${lang}/${key} に差し込みがある: ${m[key].message}`);
      assert.ok(!m[key].placeholders, `${lang}/${key} に placeholders がある`);
    }
  }
});

test('README が、機微なページで「何も起きない」と書いていない（R14-003）', () => {
  /*
   * 実装は理由の語を送って案内を出し、届かなければバッジを出す。
   * 「何も起きない」と書いたままだと、利用者は壊れたと思う。
   */
  const en = read('README.md');
  const ja = read('README.ja.md');
  assert.ok(!/shortcut there does nothing/.test(en),
    'README.md にまだ「押しても何も起きない」がある');
  assert.ok(!/the button and the shortcut simply do nothing there/.test(en),
    'README.md にまだ「ボタンもショートカットも何もしない」がある');
  assert.ok(!/アイコンやショートカットを押しても何も起きません/.test(ja),
    'README.ja.md にまだ「押しても何も起きません」がある');
  assert.ok(!/ボタンもショートカットも何も起きません/.test(ja),
    'README.ja.md にまだ「ボタンもショートカットも何も起きません」がある');

  /* 代わりに、案内とバッジのことが書いてあること */
  assert.ok(/shows a short notice/.test(en) && /badge/.test(en),
    'README.md が案内とバッジを説明していない');
  assert.ok(/短い案内/.test(ja) && /`!`/.test(ja),
    'README.ja.md が案内とバッジを説明していない');
});

test('README の表が、E2Eの件数を固定の数で書いていない（R14-003）', () => {
  /*
   * 件数は毎回動く。表に数を書くと、書いた瞬間から古くなる
   * （1.1.8 では「10テスト」のまま実際は15件だった）。
   * 実測値は日付と版を添えた記録の行に置く。
   */
  for (const [file, row] of [['README.md', /\| Real-extension E2E \|[^|]*\|([^|]*)\|/],
                             ['README.ja.md', /\| 実拡張E2E \|[^|]*\|([^|]*)\|/]]) {
    const m = read(file).match(row);
    assert.ok(m, `${file}: 実拡張E2Eの行が見つからない`);
    assert.ok(!/\d+\s*(tests|テスト)/.test(m[1]),
      `${file}: 表に固定の件数が書いてある: ${m[1].trim().slice(0, 60)}`);
  }
});
