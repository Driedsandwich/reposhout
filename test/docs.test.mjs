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
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, loadShare, stripComments } from './helpers/load.mjs';

const sha256 = (t) => createHash('sha256').update(t).digest('hex');

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
test('content script の表が、押されたときに何を送るかを書いている（R16-003）', () => {
  /*
   * 文書のどこかにあるか、ではなく**その行にあるか**を見る。英語の行から消しても
   * 日本語の行に同じ語が残っていて通ってしまった（この検査を作ったときの変異で実測）。
   *
   * 第16回監査 R16-003 まで、この検査は「押されたら location.href と document.title を
   * 読む」と書いてあることを求めていた。**画面側が読まなくなったあとも要求が残ると、
   * 文書に嘘を書かせる検査になる。** いま求めるのは、送るのがデータの無い合図1つで、
   * 何を出すかは service worker が決める、と書いてあること。
   */
  const rows = read('PRIVACY.md').split('\n')
    .filter((l) => l.startsWith('| `https://github.com/*`'));
  assert.equal(rows.length, 2, `GitHub側の行が2つ（英日）でない: ${rows.length}`);
  for (const row of rows) {
    assert.ok(!row.includes('document.title'),
      `画面側がタイトルを読むと書いたままになっている: ${row.slice(0, 80)}…`);
    assert.ok(/service worker/.test(row),
      `判断が service worker 側にあると書いていない: ${row.slice(0, 80)}…`);
  }
  assert.ok(rows.some((r) => r.includes('trusted click')), '英語の行に trusted click が無い');
  assert.ok(rows.some((r) => r.includes('the button was pressed')),
    '英語の行に、送るのが合図1つだと書いていない');
  assert.ok(rows.some((r) => r.includes('利用者の操作によるクリック')), '日本語の行に同じ説明が無い');
  assert.ok(rows.some((r) => r.includes('押されました')),
    '日本語の行に、送るのが合図1つだと書いていない');
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

test('アカウント名は「必ず入る」と書いてある（第15回監査 R15-001 で逆になった）', () => {
  /*
   * 第14回まで、投稿本文はページのタイトルだったので、アカウント名は
   * 「入る場合がある」だった（検索ページなどは入らない）。
   * 第15回で本文をルートから生成するようにしたので、**共有できるページでは
   * 所有者名とリポジトリ名が必ず入る**。弱い書き方のままだと過少申告になる。
   */
  const en = read('PRIVACY.md');
  assert.match(en, /still contains the GitHub owner and repository name/,
    'PRIVACY.md（英語）が「必ず入る」と書いていない');
  assert.match(en, /所有者名とリポジトリ名が入る/,
    'PRIVACY.md（日本語）が「必ず入る」と書いていない');
  assert.ok(!/may contain a GitHub username or organisation identifier/.test(en),
    'PRIVACY.md に古い「入る場合がある」が残っている');

  const pii = DISCLOSURE.categories.find((c) => c.id === 'personally_identifiable_information');
  assert.match(pii.codeFact, /必ず/, '正本が「必ず入る」と書いていない');
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

  /*
   * 第18回監査 R18-001。この検査は `location.href` と `document.title` が
   * **書いてあること**を求めていた。第16回で画面側がどちらも読まなくなったあとも
   * 要求が残っていたので、**事実でないことを書き続けるよう強制していた**
   * （第14回の noticeCredential、第16回の R16-006 と同じ型で、これで3件目）。
   * いま求めるのは、実装どおりの説明が書いてあること。
   */
  const must = {
    'action row': 'どこを探すのか',
    '<style>': '足す style 要素',
    'wrapper': 'ボタンを包む要素',
    '<li> or a <div>': 'コンテナによって li か div になること',
    'carries no data': '押しても画面側は何も読まないこと',
    'service worker': '外へ出すものを決めるのは service worker であること',
    'event.isTrusted': '合成クリックを拒否すること',
    'activeTab': 'ツールバー/ショートカットは別経路であること'
  };
  for (const [needle, why] of Object.entries(must)) {
    assert.ok(section.includes(needle), `github.com の権限説明に「${why}」が書いていない: ${needle}`);
  }

  // 旧文の言い回しが残っていないこと
  for (const stale of ['adds a single <li> element', 'reads\nthe page only to locate',
                       'location.href', 'document.title']) {
    assert.ok(!section.includes(stale), `旧い説明が残っている: ${stale}`);
  }
});

test('権限説明の検査が効いているかの対照', () => {
  const old = "The content script reads location.href and document.title in order to build the X Web Intent.";
  for (const needle of ['<style>', 'carries no data', 'service worker', 'event.isTrusted']) {
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
      ['the page title is never sent', 'タイトルを送らないこと（第15回監査 R15-001）'],
      ['ページのタイトルは送りません', '同（日本語）'],
      ['every path segment is an owner name, a repository name, a positive integer or a 40-character hex commit SHA',
       '型で決まるルートだけ共有すること'],
      ['所有者名・リポジトリ名・正の整数・40桁の16進のどれかで決まるページだけ', '同（日本語）']
    ],
    'store/LISTING.md': [
      ['The page title is never sent', 'タイトルを送らないこと（第15回監査 R15-001）'],
      ['every path segment is typed', '型で決まるルートだけ共有すること'],
      ['registers a single keydown listener', 'x.com の listener の実態']
    ]
  };
  /* 第16回監査で足した境界も、文書から消えたら落ちるようにする */
  must['README.md'].push(
    ['at most once', '同じクエリを1回までにしたこと（R16-002）'],
    ['/enterprises/', 'GitHubの機能ページを拒否すること（R16-001）'],
    ['single list', '拒否する語を1つの一覧にしたこと（R16-001）']);
  must['README.ja.md'].push(
    ['同じ名前のクエリは1回まで', '同じクエリを1回までにしたこと（R16-002）'],
    ['単一の一覧', '拒否する語を1つの一覧にしたこと（R16-001）']);
  must['PRIVACY.md'].push(
    ['the button was pressed', '画面側が合図しか送らないこと（R16-003）'],
    ['押されました', '同（日本語）']);
  must['SECURITY.md'] = [
    ['the service worker', '出口の判断が service worker にあること（R16-003）'],
    ['いまの方針を service worker が当てないまま', '同（日本語）']
  ];
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
    'PRIVACY.md': ['Listens for the Escape key, and nothing else', 'Escキーの検知だけを行います',
                   /* 第15回監査 R15-001。タイトルを送る前提の説明が残っていないこと */
                   'the title and the canonicalised URL of the GitHub page you are on are placed',
                   'the raw title before it is shortened']
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

test('拒否の案内が、何も送っていないことを言う（R14-003）', () => {
  /*
   * この検査は第14回に「タイトルとURLの両方を理由として言う」ことを求めていた。
   * 当時は本文がページのタイトルだったので正しかったが、第15回 R15-001 で
   * **タイトルを送らなくなったあとも要求が残っていた**ので、
   * 「タイトルを送る」と言い続けることを検査が強制していた（第16回に自分で気づいた）。
   * いまは逆向きに——**送っていないものを送ると言っていないこと**を見る。
   */
  const en = JSON.parse(read('_locales/en/messages.json'));
  const ja = JSON.parse(read('_locales/ja/messages.json'));

  assert.ok(en.noticeCredential.message.includes('Nothing was sent to X'),
    '何も送っていないことを言っていない');
  assert.ok(ja.noticeCredential.message.includes('Xへは何も送っていません'),
    '何も送っていないことを言っていない');

  /* 値やURLそのものを混ぜる余地を残していないこと（差し込みは使わない） */
  for (const [lang, m] of [['en', en], ['ja', ja]]) {
    for (const key of ['noticeCredential', 'noticeUnsupported', 'noticeReloadRequired']) {
      assert.ok(!/\$\d|\$[A-Za-z]+\$/.test(m[key].message),
        `${lang}/${key} に差し込みがある: ${m[key].message}`);
      assert.ok(!m[key].placeholders, `${lang}/${key} に placeholders がある`);
    }
  }
});

test('拡張自身のUIが、送らないもの（タイトル）を送ると言っていない（R16-006）', () => {
  /*
   * 第16回の確認中に自分で見つけた。監査の一覧には無い。
   *
   * 第15回 R15-001 でページのタイトルを送らなくなったのに、ツールバーの説明・
   * ショートカットの説明・画面内ボタンのツールチップ・資格情報の案内が
   * 「このページの**タイトルと**URLを送ります」のままだった（出荷ZIP 97bcf769… で確認）。
   * 実装より広く申告している状態で、chrome://extensions/shortcuts にも出る。
   */
  for (const lang of ['en', 'ja']) {
    const m = JSON.parse(read(`_locales/${lang}/messages.json`));
    for (const [key, val] of Object.entries(m)) {
      const text = val.message;
      assert.ok(!/title and URL/i.test(text), `${lang}/${key} がタイトル送信を約束している: ${text}`);
      assert.ok(!/タイトルとURL/.test(text), `${lang}/${key} がタイトル送信を約束している: ${text}`);
      assert.ok(!/タイトルまたはURL/.test(text), `${lang}/${key} がタイトルを理由にしている: ${text}`);
      assert.ok(!/title or URL/i.test(text), `${lang}/${key} がタイトルを理由にしている: ${text}`);
    }
  }
  /* 対照: 検査が空振りしていないこと（同じ当て方で、旧文なら必ず落ちる） */
  const old = "Send this page's title and URL to X's composer";
  assert.ok(/title and URL/i.test(old), '検査そのものが効いていない');
});

test('ストアへ貼る文面が、送らないタイトルを「送る」と言っていない（R17・自己発見）', () => {
  /*
   * 第16回では `_locales` だけを直し、**ストアへ貼る文面を見ていなかった**。
   * 第17回の作業中に見つけた: store/LISTING.md と STORE_DASHBOARD_CHANGES.md には
   * 「タイトルとリンクが入力済みで開く」「Title (Issue #123 · owner/repo)」
   * 「URL and title を読む」が残っていて、**同じファイルの数行下で
   * 「The page title is never sent」と書いていた**。
   *
   * ここはダッシュボードへ貼る原稿で、審査で読まれる場所なので、
   * 実装より広い申告をそのまま出すことになる。
   */
  const stale = [
    /title and URL/i, /URL and title/i, /title and link/i,
    /Title \(Issue #/, /Title \(PR #/, /owner\/repo: description/,
    /タイトルとURL/, /ページのタイトルが、?(同じく)?第?三?者?.{0,4}Xへ渡る/
  ];
  for (const f of ['store/LISTING.md', 'store/STORE_DASHBOARD_CHANGES.md']) {
    const body = read(f);
    for (const line of body.split('\n')) {
      /* 「昔こう書いていた」と引用している行は対象外（履歴を書けなくなるため） */
      if (/以前|旧文|書いてありました|書いていました|1\.0\.1 は|掲載中の説明文に/.test(line)) continue;
      for (const re of stale) {
        assert.ok(!re.test(line), `${f} が送らないタイトルを送ると言っている: ${line.trim().slice(0, 90)}`);
      }
    }
  }
  /* 対照: 旧文はこの検査を通らない */
  assert.ok(stale.some((re) => re.test('    Issue        →  Title (Issue #123 · owner/repo)')),
    '対照が成立していない＝旧文でも通ってしまう');
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

/* ============================================================
 * 主張の一覧表（第18回監査 R18-001）
 * ============================================================
 *
 * 第16回・第17回・第18回と、**同じ誤りが別のファイルに残っている**指摘が3回続いた。
 * 第16回で `_locales` と README を、第17回でストア文書の一部を直したが、
 * PRIVACY・Single purpose・権限説明・申告の理由・コードのコメントが別々に残った。
 *
 * 原因は2つある。
 *   ① 直す場所を**記憶で列挙**していた（最近見たファイルに偏る）
 *   ② 検査を**1行ずつ**当てていたので、`the title\nand URL` のように
 *      改行をまたいだ旧表現を見つけられなかった
 *
 * そこで「主張」を一覧にし、**すべての面へ、空白をつぶしてから**当てる。
 * ここが増えるたびに、次から全面が守られる。
 */

/* ============================================================
 * 履歴の除外は、**明示した目印だけ**で行う（第19回監査 R19-001）
 * ============================================================
 *
 * 第18回では「以前」「までは」「until 1.1.8」などの語を含む塊を、
 * 履歴とみなして丸ごと検査から外していた。これが逆に働いた——
 * **現在の仕様を述べた段落が、自分の中の履歴表現のせいで検査を免れる。**
 *
 *   PRIVACY.md  「タイトルは読みません（1.1.8 までは読んでいました）」
 *               → 「までは」で段落ごと除外。中身は誰も見ていなかった
 *   PRIVACY.md  保存の表が「Until the window is closed」で除外
 *   LISTING.md  「それ以前の同種拡張（2015 / 2018 / 2021）」で除外
 *               → 競合の話で、こちらの履歴とは何の関係もない
 *   share.js    §2.5 の設計説明ぜんぶが「第14回まではこうだった」で除外
 *
 * 実測すると、除外された9塊のうち**本当に履歴だけなのは1つ**だった。
 * 語句から推測するのをやめ、書き手が明示的に囲った範囲だけを外す。
 * 囲いは**文字の範囲として取り除く**ので、文の途中の括弧書きも囲える。
 */
const HISTORY_RE =
  /(?:<!--\s*|\*\s*)HISTORICAL_CLAIM:start\s+reason="([^"]*)"\s*(?:-->)?[\s\S]*?(?:<!--\s*|\*\s*)HISTORICAL_CLAIM:end\s*(?:-->)?/g;
const HISTORY_START = /HISTORICAL_CLAIM:start/g;
const HISTORY_END = /HISTORICAL_CLAIM:end/g;

/* 空白（改行を含む）をすべて1つの空白へつぶす＝改行で検査を迂回できなくする */
const squash = (s) => s.replace(/\s+/g, ' ');

/*
 * 区切り文字を1つに揃える。第19回で見つかった素通りの形——
 * `URL・タイトル`（中黒）は `URLとタイトル` を探す検査に当たらなかった。
 * 「と」「・」「/」「，」「、」全角スペースを同じ物として扱う。
 */
const SEPARATORS = /[・\/,，、]|\s+(?:or|and)\s+|\s*(?:と|または)\s*/gi;
const normalizeSeparators = (s) => s.replace(SEPARATORS, '＋');

/* 明示的に囲われた履歴を**取り除いた**本文を返す */
function activeText(file) {
  return read(file).replace(HISTORY_RE, ' ');
}

/* 履歴を外したうえで、空行区切りの塊にし、空白をつぶす */
function activeBlocks(file) {
  return activeText(file).split(/\n\s*\n/).map(squash).filter((b) => b.trim());
}

/*
 * 主張ごとの「書いてはいけない言い回し」。
 * すべて**実際に残っていたもの**で、思いついた例ではない。
 *
 * `stale` は区切りを揃えたうえで当てる（`normalizeSeparators`）。
 * `staleRaw` は原文のまま当てる（区切りを揃えると壊れる形のため）。
 */
const CLAIMS = [
  { id: 'title_read_or_sent',
    why: 'ページのタイトルは読みも送りもしない（第15回監査 R15-001）',
    /* 区切りを＋へ揃えてから当てる＝「と」「・」「/」「改行」のどれでも当たる */
    stale: [/title＋URL/i, /URL＋title/i, /title＋link/i,
            /タイトル＋URL/, /URL＋タイトル/,
            /location\.href＋document\.title/i,
            /ページのタイトル＋正規化済みURL/],
    staleRaw: [/ページのタイトルを読み/, /ページのタイトルが[^。]{0,12}Xへ渡る/,
               /reads two things/i, /次の2つを読み取ります/,
               /共有するURL[^。|]{0,8}タイトル/,
               /タイトル[^。|]{0,8}URLは保存しない/] },

  { id: 'version_boundary_unambiguous',
    why: '現在の版を「まで／until」の境界に使わない（第19回監査 R19-001）。'
       + '1.1.8 は**もう読んでいない**版なので、「1.1.8 までは読んでいた」は'
       + '「1.1.8 も読んでいた」と読めてしまう。版の番号は manifest から取る',
    /* 版が上がっても勝手に効き続けるよう、番号は正本から作る（下で組み立てる） */
    versionBoundary: true },

  { id: 'title_pii_reason',
    why: 'PIIの理由は「必ず入る」。共有できるルートを型で絞ったので「場合がある」は過少申告',
    only: ['store/LISTING.md', 'store/STORE_DASHBOARD_CHANGES.md', 'store/DATA_DISCLOSURE.json'],
    staleRaw: [/ユーザー名または組織名が入る場合がある/, /アカウント名が入る場合がある/] },

  { id: 'source_never_touches_title',
    why: '出荷するコードは document.title に触れない（コメントを外した本体で見る）',
    only: ['src/share.js', 'src/content.js', 'src/background.js'],
    onCode: true,                       // コメントを外してから当てる
    staleRaw: [/document\.title/, /tab\.title/] },

  { id: 'source_comments_describe_now',
    why: '出荷コードのコメントが、いまの作りを説明している（第19回監査 R19-003）',
    only: ['src/share.js', 'src/content.js', 'src/background.js'],
    staleRaw: [/url と title から/, /第2引数（ページのタイトル）/,
               /content script と service worker の両方/,
               /#L10-L20 [^*]{0,20}残す/, /issuecomment-123 [^*]{0,20}残す/,
               /*
                * 行頭アンカー（^…/m）で書いていたが、当てる前に空白をつぶすので
                * **一度も発火しない検査**になっていた。変異で見つけた（第19回 M12）。
                * 「slug を廃止した」という現行の説明には当たらない形にする。
                */
               /slug\s+英数/,
               /URL と document\.title だけで動く/] },

  { id: 'post_text_shape',
    why: '本文はルートから生成する（タイトル入りの旧形式を書かない）',
    staleRaw: [/Title \(Issue #/, /Title \(PR #/, /Title \(Discussion #/,
               /owner\/repo: description/, /タイトル \(Issue #/] },

  { id: 'content_script_has_no_policy',
    why: '画面側は合図を送るだけで、URLも投稿文も組み立てない（第16回監査 R16-003）',
    staleRaw: [/Post this page to X/, /QUERY_ALLOW/] },

  /*
   * 第22回監査 R22-001。**読む範囲と足す要素の説明が、実挙動より狭かった。**
   * 「〜以外は何もしない」「要素は1個」という全称が、面ごとに取り残されていた
   * （権限の表だけ第21回で直し、冒頭の要約・README・出荷コメントが古いまま）。
   */
  { id: 'dom_scope_and_added_elements',
    why: '読むのは決まった範囲、足すのは <style>・入れ物・拒否の案内の3種（第22回監査 R22-001）',
    staleRaw: [/only whether a few specific layout elements exist/i,
               /決まった数個の要素があるかどうかと[^。]{0,24}高さだけ/,
               /one wrapper holding one button, and changes nothing else/i,
               /ボタン1個を包む要素を1つ足す以外は何も変[更え]/,
               /anchor element isn't found, it does nothing/i,
               /目印が見つからなければ何もしない/,
               /DOM を読み、要素を1つ足す/,
               /追加する要素は1個/,
               /* 第23回監査 R23-001 の作業中に見つけた素通り。
                  「変更しない」の**別の言い回し**が一覧に無く、M17 が
                  帳簿係のテストだけで落ちていた（守りたい検査は無傷だった） */
               /It modifies nothing else/i,
               /modifies nothing else/i] },

  /*
   * 第22回監査 R22-002。保存の説明も同じ形で狭かった——
   * 「利用者に関する情報は保存しない」（時刻を保存している）、
   * 「いずれにせよ12時間で失効」（消える期限ではない）、
   * 「ブラウザを終了すると消える」（消える契機は他にもある）。
   */
  { id: 'storage_scope_and_expiry',
    why: '保存するのはIDと時刻。12時間は論理的な失効で、消える契機は3つ（第22回監査 R22-002）',
    staleRaw: [/nothing about the user/i,
               /expire after 12 hours in any case/i,
               /12時間で失効/,
               /list of window IDs described above, in memory, until you quit the browser/i,
               /上記のウィンドウIDだけで、ブラウザを終了すると消え/,
               /ウィンドウIDと開いた時刻だけで、URLもページ内容も履歴も入りません。\*\*この記録を外部へ送ることはありません。\*\*\s*$/m] },

  { id: 'routes_are_typed_only',
    why: '検索・explore・topics・プロフィールは共有できない（第15回監査 R15-001）',
    staleRaw: [/プロフィールページを共有した場合/,
               /github\.com\/explore[^)]{0,40}は共有でき/,
               /github\.com\/topics[^)]{0,40}は共有でき/] }
];

/*
 * 主張を当てる面。**正本は store/DATA_FLOW_CLAIMS.json の claimSurfaces**
 * （第20回監査 R20-003）。ここは実際に検査へ渡す一覧で、下のテストが
 * 正本と**並べ替えたうえで完全一致**することを要求する。
 *
 * それまでは `SURFACES.length >= 14` としか見ていなかったので、
 * **15面のうち1面を外しても14面で通り**、その面のclaim検査が黙って止まった。
 * ストアへ貼る原稿と Privacy は第18回で漏れていたので、必ず入れる。
 */
const SURFACES = [
  'README.md', 'README.ja.md', 'PRIVACY.md', 'SECURITY.md',
  'store/LISTING.md', 'store/STORE_DASHBOARD_CHANGES.md',
  'store/DATA_DISCLOSURE.json', 'store/WEB_INTENT_POLICY_DECISION.json',
  'store/DATA_FLOW_CLAIMS.json',
  '_locales/en/messages.json', '_locales/ja/messages.json',
  'src/share.js', 'src/content.js', 'src/background.js',
  'manifest.json'
];

/*
 * 「現在の版を境界に使っていないか」の形を、manifest の版から組み立てる。
 * ここを固定の文字列で書くと、版が上がった瞬間に検査が空振りになる。
 */
function versionBoundaryPatterns() {
  const v = JSON.parse(read('manifest.json')).version;
  const esc = v.replace(/\./g, '\\.');
  return [
    new RegExp(`until\\s+${esc}`, 'i'),
    new RegExp(`was until.{0,12}${esc}`, 'i'),
    new RegExp(`${esc}\\s*まで`),
    new RegExp(`${esc}\\s*以前は`)
  ];
}

test('主張の一覧が、すべての面で守られている（R18-001 / R19-001）', () => {
  const found = [];
  for (const file of SURFACES) {
    for (const claim of CLAIMS) {
      if (claim.only && !claim.only.includes(file)) continue;
      if (claim.versionBoundary) {
        for (const block of activeBlocks(file)) {
          for (const re of versionBoundaryPatterns()) {
            if (re.test(block)) {
              found.push(`${file} [${claim.id}] ${re} → ${block.slice(0, 90)}`);
            }
          }
        }
        continue;
      }
      /* コードの主張は、コメントを外した本体だけを見る */
      const source = claim.onCode
        ? [squash(stripComments(activeText(file)))]
        : activeBlocks(file);
      for (const block of source) {
        for (const re of (claim.stale || [])) {
          if (re.test(normalizeSeparators(block))) {
            found.push(`${file} [${claim.id}] ${re} → ${block.slice(0, 90)}`);
          }
        }
        for (const re of (claim.staleRaw || [])) {
          if (re.test(block)) {
            found.push(`${file} [${claim.id}] ${re} → ${block.slice(0, 90)}`);
          }
        }
      }
    }
  }
  assert.deepEqual(found, [], '古い主張が残っている:\n' + found.join('\n'));
});

/* ------------------------------------------------------------
 * 履歴の目印そのものを検査する（ごまかしを防ぐ）
 * ------------------------------------------------------------ */

test('履歴の目印が、対になっていて入れ子でない（R19-001）', () => {
  for (const file of SURFACES) {
    const raw = read(file);
    const starts = (raw.match(HISTORY_START) || []).length;
    const ends = (raw.match(HISTORY_END) || []).length;
    assert.equal(starts, ends, `${file}: 目印の数が合わない（start=${starts} end=${ends}）`);
    /* 入れ子・閉じ忘れ・逆順を、位置を追って確かめる */
    let depth = 0;
    const marks = [...raw.matchAll(/HISTORICAL_CLAIM:(start|end)/g)];
    for (const m of marks) {
      depth += m[1] === 'start' ? 1 : -1;
      assert.ok(depth === 0 || depth === 1,
        `${file}: 目印が入れ子か、閉じる前に閉じている（位置 ${m.index}）`);
    }
    assert.equal(depth, 0, `${file}: 閉じていない目印がある`);
    /* start は必ず理由を名乗る。無ければ HISTORY_RE に当たらず、除外もされない */
    const withReason = (raw.match(/HISTORICAL_CLAIM:start\s+reason="[^"]+"/g) || []).length;
    assert.equal(withReason, starts,
      `${file}: 理由の無い履歴目印がある（${starts - withReason} 件）。reason="…" を書く`);
  }
});

test('履歴で囲って検査を逃れていない——囲いの数と大きさを縛る（R19-001）', () => {
  /*
   * 目印を「都合の悪い段落を黙らせる道具」に使わせない。
   * 囲った数をファイルごとに固定し、増えたらここが落ちる（＝レビューに出る）。
   * 第18回の語句推測では、9塊が**誰にも見えないまま**外れていた。
   */
  const EXPECTED = {
    'PRIVACY.md': 2,
    'README.md': 1,
    'README.ja.md': 1,
    'store/LISTING.md': 2,
    'store/STORE_DASHBOARD_CHANGES.md': 3,
    'src/share.js': 1
  };
  const actual = {};
  for (const file of SURFACES) {
    const n = (read(file).match(HISTORY_START) || []).length;
    if (n) actual[file] = n;
  }
  assert.deepEqual(actual, EXPECTED,
    '履歴で囲った箇所が変わった。増やすなら、それが本当に履歴か確かめてからここを直す');

  /* 1つの囲いが大きくなりすぎない（章ごと黙らせるのを防ぐ） */
  for (const file of Object.keys(EXPECTED)) {
    const raw = read(file);
    for (const m of raw.matchAll(HISTORY_RE)) {
      assert.ok(m[0].length <= 900,
        `${file}: 履歴の囲いが大きすぎる（${m[0].length}文字）。囲うのは履歴の文だけにする`);
      assert.ok(m[1] && m[1].length >= 6, `${file}: 履歴の理由が短すぎる: "${m[1]}"`);
    }
    /* 囲いの合計がファイルの2割を超えない */
    const hidden = [...raw.matchAll(HISTORY_RE)].reduce((a, m) => a + m[0].length, 0);
    assert.ok(hidden / raw.length <= 0.2,
      `${file}: 全体の ${Math.round(hidden / raw.length * 100)}% を履歴として外している`);
  }
});

test('履歴で外している範囲が、正本と1文字も違わない（R23-001）', () => {
  /*
   * ⚠️ **囲いの数と大きさだけでは、動かされたことに気づけない。**
   *
   * 既存の囲いを**別の現在の文へ移す**変異（M09）は、数も大きさも変わらないので
   * 素通りしていた——落ちていたのは「変異の定義と実物が一致しているか」という
   * **帳簿係のテストの副作用**だけで、守りたい検査は無傷だった
   * （第23回監査 R23-001 の作業中に、失敗の理由を見るようにして初めて分かった）。
   *
   * 囲った範囲そのものをハッシュで固定する。動かす・広げる・別の文へ移すと落ちる。
   */
  const C = JSON.parse(read('store/DATA_FLOW_CLAIMS.json'));
  const declared = C.historicalClaimSpans;
  assert.ok(Array.isArray(declared) && declared.length >= 10,
    `履歴の囲いが正本に無い（または少なすぎる）: ${declared && declared.length}`);

  const actual = [];
  for (const file of SURFACES) {
    const raw = read(file);
    for (const m of raw.matchAll(HISTORY_RE)) {
      actual.push({ file, reason: m[1], chars: m[0].length, sha256: sha256(m[0]) });
    }
  }
  /* 取りこぼしていないこと（start の数と、取れた数が合う） */
  const starts = SURFACES.reduce((a, f) => a + (read(f).match(HISTORY_START) || []).length, 0);
  assert.equal(actual.length, starts,
    `囲いを取りこぼしている（start=${starts} / 取れた=${actual.length}）`);

  assert.deepEqual(actual, declared,
    '履歴で外している範囲が正本と違う。動かした・広げたなら、それが本当に履歴か確かめてから正本を直す');
});

test('主張の検査そのものが効いている（対照）', () => {
  const catches = (sample) => CLAIMS.some((c) =>
    (c.stale || []).some((re) => re.test(normalizeSeparators(squash(sample)))) ||
    (c.staleRaw || []).some((re) => re.test(squash(sample))));

  /* ① 区切りが何であっても当たること（第19回で素通りした形を含む） */
  for (const sample of [
    'pre-filled with the title\nand URL of the GitHub page',   // 改行（第17回の穴）
    '共有するURL・タイトルに、ユーザー名が入る',                 // 中黒（第19回の穴）
    'タイトル　と　URL を読みます',                             // 全角スペース
    'ページのタイトル/URLを読み取ります',                        // スラッシュ
    'reads location.href and document.title'
  ]) {
    assert.ok(catches(sample), `検査が空振りしている: ${sample.slice(0, 60)}`);
  }

  /* ② 1行に収まっている旧表現も捕まえること */
  for (const sample of [
    '    Issue        →  Title (Issue #123 · owner/repo)',
    "btn.title = t('shareButtonTooltip', 'Post this page to X');",
    'プロフィールページを共有した場合、そのユーザー名は本人を指します',
    "This page's title or URL may contain sensitive authentication information",
    ' * 設計方針: DOMを一切見ない。URL と document.title だけで動く。',
    '| Xへ渡るか | 渡る。ページのタイトルと正規化済みURLが、リンクに入って届く |',
    'ユーザー名または組織名が入る場合がある',
    /* 変異で見つけた素通り（第19回 M12）——行頭アンカーは空白をつぶすと効かない */
    '   *   slug  英数と . _ - / , : だけの短い識別子',
    /* 第22回で撤回した全称（R22-001 / R22-002）。実際に残っていた文そのもの */
    'This check reads only whether a few specific layout elements exist, and how tall',
    'このとき見るのは決まった数個の要素があるかどうかと、隣のボタンの高さだけです。',
    'adds one <style> element and one wrapper holding one button, and changes nothing else.',
    '`<style>` を1つとボタン1個を包む要素を1つ足す以外は何も変更しません',
    "- If the anchor element isn't found, it does nothing. No error, no fallback",
    '- 目印が見つからなければ何もしない。 エラーも出さず、代替のDOM操作もせず',
    ' *  3. 追加する要素は1個。失敗しても影響がそこで閉じる',
    'ボタンを差し込む位置を探すために DOM を読み、要素を1つ足す。',
    'No URLs, no page content, no browsing history, nothing about the user.',
    'Entries are removed as soon as the window closes, and expire after 12 hours in any case.',
    'ウィンドウIDと時刻だけ（chrome.storage.session・メモリ上・12時間で失効）',
    'The only thing the extension itself stores is the list of window IDs described above, in memory, until you quit the browser.',
    '拡張自身が保存するのは上記のウィンドウIDだけで、ブラウザを終了すると消えます。'
  ]) {
    assert.ok(catches(sample), `検査が空振りしている: ${sample.slice(0, 60)}`);
  }

  /* ③ ふつうの現行の文を、誤って捕まえないこと */
  for (const ok of [
    'RepoShout reads the page URL.',
    'The page title is not read or sent.',
    'ページのタイトルは読みません。',
    'それ以前の同種拡張（2015 / 2018 / 2021）はいずれも更新停止',   // 第19回の誤除外
    'Until the window is closed, or 12 hours, whichever comes first', // 同上
    /*
     * 区切りを揃える処理を作った直後に出た誤検知。`or` を語の途中でも
     * 区切りとみなしていたので、**JSONのキー名**が旧主張に見えていた。
     * 英字の区切りは前後に空白がある時だけ数える。
     */
    '"persistentStorageOfTitleOrUrl": "無い"'
  ]) {
    assert.ok(!catches(ok), `現行の文を古い主張として捕まえている: ${ok.slice(0, 60)}`);
  }

  /*
   * ④ 現在の版を「まで」の境界に使う形を捕まえること。
   * 第19回の変異でここが素通りした——履歴の囲いを外に出すだけで、
   * 「タイトルは読みません（1.1.8 までは読んでいました）」が復活できた。
   */
  const vp = versionBoundaryPatterns();
  for (const sample of ['(it was until 1.1.8)', '1.1.8 までは読んでいました',
                        'The page title is not read (was until 1.1.8).']) {
    assert.ok(vp.some((re) => re.test(sample)), `版の境界を捕まえられない: ${sample}`);
  }
  /* 過去の版を境界に使うのは正しいので、捕まえないこと */
  for (const ok of ['1.1.7 までは読んでいました', 'before 1.1.8 it was read']) {
    assert.ok(!vp.some((re) => re.test(ok)), `正しい書き方を捕まえている: ${ok}`);
  }

  /*
   * ⑤ 履歴の除外が、語句の推測へ戻っていないこと。
   * 文字列で書くと、検査の都合で語を足したときに誤って落ちる（実際に一度落ちた）。
   * **振る舞いで見る**——語句だけの文は外れず、目印を書いた文だけが外れる。
   */
  const guessyText = '以前はこう書いていました。1.1.8 までは title and URL を送っていました。';
  assert.ok(!new RegExp(HISTORY_RE.source).test(guessyText),
    '語句だけで履歴として外れている（第19回 R19-001 の原因）');
  const markedText =
    '<!-- HISTORICAL_CLAIM:start reason="経緯のため" -->title and URL<!-- HISTORICAL_CLAIM:end -->';
  assert.equal(markedText.replace(new RegExp(HISTORY_RE.source, 'g'), ' ').trim(), '',
    '目印で囲った範囲が外れていない');
  /* 目印はあっても理由が無ければ外れない（黙らせる近道を作らない） */
  const noReason = '<!-- HISTORICAL_CLAIM:start -->title and URL<!-- HISTORICAL_CLAIM:end -->';
  assert.ok(new RegExp(HISTORY_RE.source).test(noReason) === false,
    '理由の無い目印で検査を外せている');

  /*
   * ⑥ 面の一覧が、正本と**1つ残らず**一致すること（第20回監査 R20-003）。
   * `>= 14` で見ていたので、15面のうち1面を外しても通った——
   * その面へのclaim検査が黙って止まり、誰も気づかない。
   */
  const claims = JSON.parse(read('store/DATA_FLOW_CLAIMS.json'));
  assert.deepEqual([...SURFACES].sort(), [...claims.claimSurfaces].sort(),
    '検査する面と、正本の claimSurfaces がずれている');
  for (const f of ['PRIVACY.md', 'store/STORE_DASHBOARD_CHANGES.md', 'store/LISTING.md',
                   'manifest.json', 'store/WEB_INTENT_POLICY_DECISION.json']) {
    assert.ok(SURFACES.includes(f), `面の一覧に ${f} が無い`);
  }
});

/* ------------------------------------------------------------
 * 正本（DATA_FLOW_CLAIMS.json）を、実際のコードへ縛る
 * ------------------------------------------------------------
 * ここが無いと、正本そのものが古くなっても誰も気づかない。
 * 第18回で学んだ形——正本の外へ出した値は、指す先が変わっても取り残される。
 */

test('正本の主張が、実際のコードと一致している（R19-001）', () => {
  const C = JSON.parse(read('store/DATA_FLOW_CLAIMS.json'));
  const { GXS } = loadShare();

  /* タイトル: コメントを外した本体に document.title が無い */
  for (const f of ['src/share.js', 'src/content.js', 'src/background.js']) {
    const code = stripComments(read(f));
    assert.ok(!/document\.title|tab\.title/.test(code),
      `${f} がタイトルを読んでいるのに、正本は titleRead=${C.titleRead}`);
  }
  assert.equal(C.titleRead, false);
  assert.equal(C.titleSent, false);

  /* 画面側は合図だけ。URLも投稿文も組み立てない */
  const content = stripComments(read('src/content.js'));
  assert.equal(C.contentScriptSendsData, false);
  assert.ok(!/x\.com\/intent/.test(content), 'content.js がXのURLを組んでいる');
  assert.ok(!/location\.href/.test(content), 'content.js がURLを読んでいる');
  assert.equal(C.contentScriptReadsUrl, false);

  /* 出口は service worker だけ */
  assert.equal(C.serviceWorkerBuildsIntent, true);
  assert.ok(/intentUrlFor|intentUrl/.test(stripComments(read('src/background.js'))));

  /* ルート: 実際に呼んで確かめる */
  const probe = {
    repo: 'https://github.com/o/r', 'issue-list': 'https://github.com/o/r/issues',
    'pr-list': 'https://github.com/o/r/pulls', 'discussion-list': 'https://github.com/o/r/discussions',
    releases: 'https://github.com/o/r/releases', issue: 'https://github.com/o/r/issues/12',
    pr: 'https://github.com/o/r/pull/12', discussion: 'https://github.com/o/r/discussions/12',
    commit: `https://github.com/o/r/commit/${'a'.repeat(40)}`,
    blob: 'https://github.com/o/r/blob/main/a.js', tree: 'https://github.com/o/r/tree/main',
    compare: 'https://github.com/o/r/compare/a...b', 'commits/<ref>': 'https://github.com/o/r/commits/main',
    search: 'https://github.com/search?q=a', wiki: 'https://github.com/o/r/wiki',
    actions: 'https://github.com/o/r/actions', profile: 'https://github.com/o',
    root: 'https://github.com/', 'pull/<n>/files': 'https://github.com/o/r/pull/12/files'
  };
  const shareable = (u) => GXS.buildShareResult(u).ok;
  for (const name of C.supportedRoutes) {
    assert.ok(probe[name], `正本が知らないルート名を書いている: ${name}`);
    assert.ok(shareable(probe[name]), `正本は共有できると言うが、実際は拒否される: ${name}`);
  }
  for (const name of C.unsupportedRoutes) {
    assert.ok(probe[name], `正本が知らないルート名を書いている: ${name}`);
    assert.ok(!shareable(probe[name]), `正本は共有できないと言うが、実際は通る: ${name}`);
  }
  assert.equal(C.supportedRoutes.length + C.unsupportedRoutes.length,
    Object.keys(probe).length, '正本のルート一覧に、試した物が全部載っていない');

  /* フラグメントは全部落ちる */
  assert.equal(C.fragmentPolicy, 'drop_all');
  for (const frag of ['#L10-L20', '#issuecomment-123', '#anything']) {
    const r = GXS.buildShareResult(`https://github.com/o/r/issues/12${frag}`);
    assert.ok(r.ok && !r.share.url.includes('#'),
      `正本は全部落とすと言うが、${frag} が残った: ${r.ok ? r.share.url : r.reason}`);
  }

  /* クエリの型は int / bool / enum だけ */
  const types = new Set(Object.values(GXS.QUERY_RULES)
    .flatMap((o) => Object.values(o).map((r) => r.type)));
  assert.deepEqual([...types].sort(), ['bool', 'enum', 'int'],
    `正本の書いた型と実際が違う: ${[...types].join(' / ')}`);

  /* 所有者名とリポジトリ名は必ず出て行く */
  assert.equal(C.ownerRepoAlwaysTransferred, true);
  for (const u of C.supportedRoutes.map((n) => probe[n])) {
    const r = GXS.buildShareResult(u);
    assert.ok(r.share.url.includes('/o/r') || r.share.url.endsWith('/o/r'),
      `所有者名とリポジトリ名が出て行かないルートがある: ${u}`);
  }

  /*
   * 第20回監査 R20-002。**画面側は、操作していない間もDOMを見ている。**
   * それまで Privacy の要約は「操作したときに限り読む」だけを言っており、
   * GitHubのページを開いている間ずっと動く確認（1秒ごと）を説明していなかった。
   * 正本へ書いた以上、それがコードと合っていることをここで測る。
   */
  assert.equal(C.contentScriptReadsDom, true);
  assert.match(content, /querySelector/, '正本はDOMを見ると言うが、見ていない');
  assert.match(C.domReadTiming, /1秒|1000/, '見る間隔が正本に書かれていない');
  assert.match(content, /setInterval\(\s*inject\s*,\s*1000\s*\)/,
    `正本の間隔（${C.domReadTiming}）とコードが合っていない`);
  assert.match(C.domReadTiming, /visibilitychange|表示に戻/, '復帰時の確認が正本に無い');
  assert.match(content, /visibilitychange/, '正本は復帰時にも見ると言うが、見ていない');
  /* 逆に「読まない」と書いたものは、本当に読んでいないこと */
  assert.equal(C.contentScriptReadsPageText, false);
  assert.ok(!/=\s*[\w.]*\.textContent/.test(content) && !/innerText/.test(content),
    '正本は本文を読まないと言うが、読んでいる');
  assert.equal(C.contentScriptReadsFormValues, false);
  assert.ok(!/(input|textarea)[^;]{0,40}\.value/.test(content),
    '正本は入力欄を読まないと言うが、読んでいる');
  assert.equal(C.domReadLeavesBrowser, false);

  /*
   * 第21回監査 R21-001。**読む範囲は「有無と高さだけ」ではなかった。**
   * 子構造・要素の種別・computed style・寸法も読み、拒否のときは
   * 画面へ通知要素を1つ足す。正本に書いた以上、実物と合っていることを測る。
   */
  const domReads = {
    'children': /children/, 'tagName': /\.tagName/, 'computed style': /getComputedStyle/,
    'cssFloat': /cssFloat/, 'marginRight': /marginRight/, 'display': /\.display/,
    '寸法': /getBoundingClientRect/
  };
  for (const [what, re] of Object.entries(domReads)) {
    assert.ok(re.test(content), `content.js が ${what} を読んでいない（正本の説明が古い）`);
  }
  /* 正本の説明が、その読み取りを覆っていること */
  for (const word of ['children', 'tagName', 'display', 'cssFloat', 'marginRight']) {
    assert.ok(C.domReadScope.includes(word),
      `正本の domReadScope が ${word} を説明していない`);
  }
  /* 再測定のタイミングも、コードの値と合っていること */
  const delays = [...content.matchAll(/\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]\.forEach/g)][0];
  assert.ok(delays, 'ボタン挿入後の再測定が見つからない');
  for (const d of delays.slice(1)) {
    assert.ok(C.domReadTiming.includes(d),
      `正本の domReadTiming に ${d}ms の再測定が書かれていない`);
  }

  /* 通知要素を足すことを、正本が認めていること */
  assert.equal(C.contentScriptMayInsertNotice, true);
  assert.match(content, /createElement\('div'\)/, 'content.js が要素を作っていない');
  assert.match(content, /body\.appendChild/, 'content.js が body へ足していない');
  assert.ok(C.contentScriptInsertsInto.includes('gxs-notice'),
    '正本が、足す通知要素を説明していない');
  for (const k of ['noticePurpose', 'noticeData', 'noticeLifetime']) {
    assert.ok(C[k] && C[k].length >= 10, `正本に ${k} が無い`);
  }

  /*
   * 第22回監査 R22-001。**案内は、操作列が無いページでも足す。**
   * 「目印が無ければ何もしない」はボタンの話だけだった。
   * 案内を出す経路が、目印を探す経路と分かれていることをコードで確かめる。
   */
  assert.ok(C.noticeIndependentOfActionRow && C.noticeIndependentOfActionRow.length >= 20,
    '正本が「操作列が無くても案内を出す」ことを説明していない');
  const noticeListener = content.match(/onMessage\.addListener\([\s\S]{0,200}?\}\);/);
  assert.ok(noticeListener, '拒否の案内を受ける入口が見つからない');
  assert.ok(!/findContainer|CONTAINERS/.test(noticeListener[0]),
    '案内の経路が、操作列を探す処理に依存している（正本の説明と食い違う）');

  /*
   * 第22回監査 R22-002。保存の説明を、service worker の実装へ縛る。
   * **12時間は論理的な失効**であって、その時刻に起こして消すタイマーではない。
   */
  const bg = stripComments(read('src/background.js'));
  assert.ok(Array.isArray(C.storageStores) && C.storageStores.length === 2,
    '正本が「保存する2つ」を挙げていない');
  assert.ok(Array.isArray(C.storageDoesNotStore) && C.storageDoesNotStore.length >= 6,
    '正本が「保存しない物」を挙げていない');
  assert.match(bg, /12 \* 60 \* 60 \* 1000/, '12時間の定数がコードに無い');
  /* 「その時刻に起こす」仕掛けが**無い**こと（alarms を使っていない） */
  assert.ok(!/chrome\.alarms/.test(bg),
    '正本はタイマーが無いと言うが、alarms を使っている');
  assert.ok(C.storageNoExpiryTimer && /タイマー/.test(C.storageNoExpiryTimer),
    '正本が「起こして消すタイマーは無い」と書いていない');
  /*
   * ⚠️ 第23回監査 R23-001 の作業中に見つけた素通り。
   * `storageLogicalExpiry` の**中身**を誰も見ていなかったので、
   * 「12時間で保存の上限に達して消える」と書き戻す変異（N13）が当たらなかった。
   * 論理的な失効と物理的な削除を、また混ぜていないことを見る。
   */
  assert.ok(/根拠として/.test(C.storageLogicalExpiry),
    '正本の storageLogicalExpiry が「根拠として数えない」と言っていない');
  assert.ok(/保存の上限ではな/.test(C.storageLogicalExpiry),
    '正本の storageLogicalExpiry が、保存の上限との違いを打ち消していない');
  assert.ok(Array.isArray(C.storagePhysicalDeletion) && C.storagePhysicalDeletion.length === 3,
    `正本の「実際に消える契機」が3つでない: ${(C.storagePhysicalDeletion || []).length}`);
  /* 3つの契機が、それぞれコードに実在すること */
  assert.match(bg, /windows\.onRemoved/, '窓を閉じたときに消す処理が無い');
  assert.match(bg, /storage\.session/, 'session storage を使っていない');
  assert.ok(/isShareWindow/.test(bg) && /prune/i.test(bg),
    '失効した記録を読んだときに消す処理が無い');
  /*
   * ⚠️ 根拠を「ID再利用」へ戻していないこと（第21回監査 R21-002）。
   * 語の有無では見られない——**その語が誤りだと書いた訂正文**にも当たってしまう
   * （実際に当たった）。「打ち消しと一緒に出てくるか」で見る。
   */
  const bgRaw = read('src/background.js');
  for (const m of bgRaw.matchAll(/再利用/g)) {
    const around = bgRaw.slice(Math.max(0, m.index - 300), m.index + 300);
    assert.ok(/誤り|作れない/.test(around),
      `ウィンドウIDの再利用を根拠として書いている（位置 ${m.index}）`);
  }
  /* 正しい根拠のほうが、消えずに残っていること */
  assert.match(bgRaw, /Esc の許可として使わない/,
    '12時間の正しい根拠（古い記録を Esc の許可に使わない）が消えている');

  /* 保留中の判断は、それぞれの正本と一致している */
  const wi = JSON.parse(read('store/WEB_INTENT_POLICY_DECISION.json'));
  assert.equal(C.webIntentStatus, wi.status, 'Web Intent の状態が2か所で食い違っている');
  const dd = JSON.parse(read('store/DATA_DISCLOSURE.json'));
  for (const [id, expected] of Object.entries(C.ownerConfirmationStatus)) {
    const cat = (dd.categories || dd.disclosures || []).find((c) => c.id === id);
    assert.ok(cat, `申告の正本に ${id} が無い`);
    const state = cat.requiresOwnerConfirmation ? cat.confirmationStatus : cat.answer;
    assert.equal(state, expected, `${id} の状態が2か所で食い違っている`);
  }
});

test('言うべきことを、言っている（主張の裏返し）', () => {
  /* 「書いてはいけない」だけだと、何も書かなければ通ってしまう */
  const must = {
    'PRIVACY.md': ['The page title is not read at all', 'ページのタイトルは読みません'],
    'store/LISTING.md': ['carries no data', 'The page title is not read or sent'],
    'README.md': ['never its title'],
    'README.ja.md': ['タイトルではありません'],
    'store/STORE_DASHBOARD_CHANGES.md': ['ページのタイトルは読まず、渡らない']
  };
  /*
   * 第22回監査 R22-001 / R22-002。撤回した全称の**代わりに何を書いたか**を
   * 面ごとに固定する。消しただけでは、説明が消えたのか直ったのか分からない。
   */
  const mustAlso = {
    'PRIVACY.md': ['gxs-notice', 'cssFloat', 'stops counting',
                   'として数えなくなり', 'タイマーはありません'],
    'README.md': ['gxs-notice', 'cssFloat', 'no button is inserted',
                  'not a delete timer'],
    'README.ja.md': ['gxs-notice', 'cssFloat', 'ボタンを置きません',
                     '消す期限ではなく'],
    'store/LISTING.md': ['status message', 'not a delete timer'],
    'store/DATA_DISCLOSURE.json': ['gxs-notice', '保存の上限ではない'],
    'store/STORE_DASHBOARD_CHANGES.md': ['gxs-notice', '消す期限ではない'],
    'src/content.js': ['gxs-notice', 'ボタンを置かない'],
    'store/DATA_FLOW_CLAIMS.json': ['storageLogicalExpiry', 'storagePhysicalDeletion',
                                    'noticeIndependentOfActionRow']
  };
  for (const [file, phrases] of Object.entries(mustAlso)) {
    const body = activeText(file);
    for (const p of phrases) {
      assert.ok(body.includes(p),
        `${file} に「${p}」が無い（全称を消しただけで、代わりの説明が無い）`);
    }
  }

  /*
   * ⚠️ **第23回監査 R23-001 の作業中に見つけた素通り。**
   * 「保存するのはIDと**時刻**」「案内をもう1つ足す」を落とす変異が、
   * どの検査にも当たらず、**帳簿係のテスト（変異の定義と実物の一致）が
   * 副作用で落ちていただけ**だった。守りたいことを、面ごとに名指しで要求する。
   */
  const mustSay = {
    'README.md': ['the time each was opened', 'status message'],
    'README.ja.md': ['入るのはウィンドウIDと開いた時刻だけで', '一時的な案内'],
    'PRIVACY.md': ['status message', 'the time the extension opened it', '開いた時刻'],
    'store/LISTING.md': ['the time that window was opened', 'status message']
  };
  for (const [file, phrases] of Object.entries(mustSay)) {
    const body = activeText(file);
    for (const p of phrases) {
      assert.ok(body.includes(p), `${file} に「${p}」が無い（第23回 R23-001）`);
    }
  }
  for (const [file, phrases] of Object.entries(must)) {
    const body = activeText(file);        // 履歴の中に書いて済ませられないようにする
    for (const p of phrases) {
      assert.ok(body.includes(p), `${file} に「${p}」が無い（履歴の囲いの外に書く）`);
    }
  }
});

/* ============================================================
 * 第22回監査 R22-003 — 文書が挙げるURLを、実物へ通す
 * ============================================================ */

test('文書のルート例が、出荷するコードの判定と一致する（R22-003）', () => {
  /*
   * README は `/user/keys` を「拒否するGitHubの機能ページ」の例に挙げていた。
   * だが `user` は**実在する所有者名**で、`github.com/user/keys` はふつうの
   * リポジトリのルート——**共有できる**。第20回でテストの前提は直したのに、
   * 文書の例だけが誤ったまま残っていた。
   *
   * 例を文章の中だけで持つと、実物と食い違っても誰も気づかない。
   * 正本へ集め、1件ずつ実際に buildShare() へ通す。
   */
  const C = JSON.parse(read('store/DATA_FLOW_CLAIMS.json'));
  const { GXS } = loadShare();
  const examples = C.documentedRouteExamples;
  assert.ok(Array.isArray(examples) && examples.length >= 6,
    `文書のルート例が正本に無い（または少なすぎる）: ${examples && examples.length}`);

  /* ★対照が入っていること。拒否例だけ並べても「全部拒否」の実装で通ってしまう */
  assert.ok(examples.some((e) => e.shareable === true), '共有できる対照が1件も無い');
  assert.ok(examples.some((e) => e.shareable === false), '拒否する例が1件も無い');

  const wrong = [];
  for (const e of examples) {
    const got = GXS.buildShare(e.url) !== null;
    if (got !== e.shareable) {
      wrong.push(`${e.url}: 正本は ${e.shareable ? '共有できる' : '拒否'} と言うが、実物は ${got ? '共有できる' : '拒否'}`);
    }
  }
  assert.deepEqual(wrong, [], '文書のルート例が実物と食い違っている:\n' + wrong.join('\n'));
});

test('文書のルート例が、挙げた文書に実際に載っている（R22-003）', () => {
  /*
   * 正本だけ直して文書を直し忘れる形を塞ぐ。**両方向**を縛る——
   * ①正本の例は、appearsIn の文書に literal で載っている
   * ②誤りと分かった `/user/keys` は、どの文書にも「拒否する例」として残っていない
   */
  const C = JSON.parse(read('store/DATA_FLOW_CLAIMS.json'));
  for (const e of C.documentedRouteExamples) {
    assert.ok(e.docToken, `${e.url}: 文書に載せる形（docToken）が宣言されていない`);
    for (const file of e.appearsIn) {
      assert.ok(read(file).includes(e.docToken),
        `${file} に ${e.docToken} が無い（正本だけ直して文書を直し忘れている）`);
    }
  }
  /*
   * ⚠️ 「文書のどこにも書くな」にはしない。**共有できる**という現行の事実として
   * 書くのは正しく、実際そう書いてある（上の突合が実物で確かめている）。
   * 縛るのは**置き場所**——拒否例を並べた段落に混ざっていないこと。
   * どの段落かは正本が名指しする（語句から推測しない）。
   */
  const anchors = C.refusedExampleAnchors;
  assert.ok(anchors && Object.keys(anchors).length >= 2, '拒否例の段落が正本で名指しされていない');
  for (const [file, anchor] of Object.entries(anchors)) {
    const blocks = activeBlocks(file).filter((b) => b.includes(squash(anchor)));
    assert.equal(blocks.length, 1,
      `${file}: 拒否例の段落を1つに特定できない（${blocks.length}件）。正本の目印が古い`);
    /* 対照: その段落が、本当に拒否例を並べた段落であること */
    assert.ok(blocks[0].includes('/oauth/authorize'),
      `${file}: 目印の段落に拒否例が無い＝この検査は空振りする`);
    /* 共有できると分かっている例が、その段落に混ざっていないこと */
    for (const e of C.documentedRouteExamples.filter((x) => x.shareable)) {
      assert.ok(!blocks[0].includes(e.docToken),
        `${file}: 共有できる ${e.docToken} が、拒否例の段落に並んでいる`);
    }
  }
});

/* ============================================================
 * 第19回監査 R19-002 — 名前空間の台帳を、実測とコードへ縛る
 * ============================================================ */

test('拒否する語の一覧と、台帳の deny が1語も違わない（R19-002）', () => {
  const inv = JSON.parse(read('store/GITHUB_NAMESPACE_INVENTORY.json'));
  const { GXS } = loadShare();
  const runtime = [...GXS.NON_REPOSITORY_TOP_LEVEL].sort();
  const ledger = inv.namespaces.filter((e) => e.decision === 'deny')
    .map((e) => e.namespace).sort();
  assert.deepEqual(ledger, runtime,
    '台帳とコードがずれている。片方だけ直すと、次に見た人はどちらを信じるか分からなくなる');
  assert.equal(inv.runtimeDenylistCount, runtime.length, '台帳が数えている語数が違う');

  /* allow と決めた語が、拒否の一覧に紛れていないこと */
  for (const e of inv.namespaces.filter((x) => x.decision === 'allow')) {
    assert.ok(!runtime.includes(e.namespace),
      `${e.namespace} は allow と決めたのに拒否している（実在のリポジトリを巻き込む）`);
  }
});

test('台帳が、APIで見た事実と browser で見た事実を分けている（R19-002）', () => {
  const inv = JSON.parse(read('store/GITHUB_NAMESPACE_INVENTORY.json'));
  const REQUIRED = ['namespace', 'measuredAt', 'discoverySource', 'accountApi',
    'repositoryProbe', 'browserPathProbe', 'redirectChain', 'routeShadow',
    'decision', 'reason', 'evidence'];
  for (const e of inv.namespaces) {
    for (const k of REQUIRED) {
      assert.ok(k in e, `${e.namespace}: ${k} が無い`);
    }
    assert.ok(e.reason && e.reason.length >= 20, `${e.namespace}: 理由が短すぎる`);

    /*
     * **アカウントの有無だけで「案内ページが覆っている」と断定しない**
     * （第19回監査 R19-002 の核心）。shadow と言うなら、
     * browser で実際にリポジトリを開こうとした記録が要る。
     */
    if (e.routeShadow === true) {
      assert.equal(e.accountApi.present, true,
        `${e.namespace}: アカウントが無いのに「覆っている」と書いている`);
      assert.ok(e.repositoryProbe && 'repositoryUiRendered' in e.repositoryProbe,
        `${e.namespace}: browser でリポジトリを開いた記録が無いのに shadow と断定している`);
      assert.equal(e.repositoryProbe.repositoryUiRendered, false,
        `${e.namespace}: リポジトリUIが出ているのに shadow と書いている`);
    }
    /* allow は、実際に開けることを見てから決めている */
    if (e.decision === 'allow') {
      assert.equal(e.repositoryProbe.repositoryUiRendered, true,
        `${e.namespace}: 開けることを確かめずに allow にしている`);
    }
  }
});

test('実在のリポジトリを巻き込む拒否が、台帳に明記してある（R19-002）', () => {
  /*
   * 第19回で初めて測って分かったこと——認証系を守るための3語が、
   * **実在して browser でも開けるリポジトリ**を拒否している。
   * 落とすほうへ倒す判断は変えないが、代償を数えずに済ませない。
   */
  const inv = JSON.parse(read('store/GITHUB_NAMESPACE_INVENTORY.json'));
  const suppressing = inv.namespaces
    .filter((e) => e.decision === 'deny' && e.suppressesReachableRepo)
    .map((e) => e.namespace).sort();
  /*
   * 第20回監査 R20-001 で `user` `devices` `password` を owner単位の拒否から外したので、
   * **いまは0件**。ここが増えたら、実在のリポジトリを巻き込む拒否をまた足したということ。
   * そのときは代償を測って、本当に必要かを示してからこの数字を直す。
   */
  assert.deepEqual(suppressing, [],
    `実在のリポジトリを巻き込む拒否が増えている: ${suppressing.join(' / ')}`);

  /* 外した3語が、allow として実測つきで記録されていること */
  for (const n of ['user', 'devices', 'password']) {
    const e = inv.namespaces.find((x) => x.namespace === n);
    assert.ok(e, `台帳に ${n} の記録が無い`);
    assert.equal(e.decision, 'allow', `${n} が allow になっていない`);
    assert.equal(e.repositoryProbe.repositoryUiRendered, true,
      `${n}: 開けることを確かめずに allow にしている`);
    assert.match(e.reason, /R20-001/, `${n}: 外した理由が記録されていない`);
  }
  /* 経緯の文書からも、この判断が読めること */
  const md = read('store/NAMESPACE_INVENTORY.md');
  for (const n of ['user', 'devices', 'password']) {
    assert.ok(md.includes(n), `NAMESPACE_INVENTORY.md に ${n} の判断が書かれていない`);
  }
});

test('台帳の説明が、名前と判定を書き写していない（R19-002）', () => {
  /*
   * 同じ境界を2つの一覧で持たない。Markdown 側へ表を戻すと、
   * 片方だけ直る形ができる（第18回 R18-002 で直したばかりの型）。
   */
  const md = read('store/NAMESPACE_INVENTORY.md');
  assert.ok(md.includes('GITHUB_NAMESPACE_INVENTORY.json'),
    '経緯の文書が、正本のJSONを指していない');
  const { GXS } = loadShare();
  /*
   * 説明のために出てよい語だけを許す。それ以外の拒否語が並んでいたら表が戻っている。
   * `login` `settings` は、第20回監査 R20-001 で3語を外したあとも
   * **本物の認証ルートを守り続ける語**として、判断の説明にどうしても要る。
   * 増やすときは「表を書き戻していないか」を確かめること（許す語＝守られない語）。
   */
  const ALLOWED_IN_PROSE = new Set(['customer-stories', 'trust-center',
    'user', 'devices', 'password', 'login', 'settings']);
  const listed = GXS.NON_REPOSITORY_TOP_LEVEL.filter(
    (n) => !ALLOWED_IN_PROSE.has(n) && new RegExp(`\`${n}\`|\\| *${n} *\\|`).test(md));
  assert.deepEqual(listed, [],
    `経緯の文書へ一覧が書き戻されている: ${listed.join(' / ')}`);
});

test('Privacy が、操作していない間のDOM確認も説明している（R20-002）', () => {
  /*
   * 第20回監査 R20-002。要約が「操作したときに限り読む」だけだと、
   * GitHubのページを開いている間ずっと動く確認（1秒ごと・タブ復帰時）が
   * 説明されないまま残る。**2つの場面を分けて書く**ことを要求する。
   */
  const body = activeText('PRIVACY.md');
  for (const phrase of [
    'two different moments',                // 英語: 2つの場面があるという宣言
    'While a GitHub page is open',          // 英語: 表示中の場面
    'about once a second',                  // 英語: 頻度
    'When you activate the extension',      // 英語: 操作時の場面
    '情報を扱う場面は**2つ**',                  // 日本語: 2つの場面があるという宣言
    'GitHubのページを開いている間',              // 日本語: 表示中の場面
    '約1秒ごと',                              // 日本語: 頻度
    '拡張を操作したとき'                        // 日本語: 操作時の場面
  ]) {
    assert.ok(body.includes(phrase), `PRIVACY.md に「${phrase}」が無い（R20-002）`);
  }
  /*
   * 「操作したときだけ読む」という**1段階の要約**へ戻していないこと。
   * 変異で見つけた素通り——2段階の説明を残したまま冒頭に1段階の要約を足すと、
   * 上の「書いてあるべき」検査は全部通ってしまう（矛盾は捕まらない）。
   */
  const ONE_STAGE = [
    /reads information only when you activate/i,
    /only when you activate .{0,20}does RepoShout read/i,
    /操作したときだけ.{0,10}読み/,
    /読み取るのは.{0,6}操作したときだけ/
  ];
  for (const re of ONE_STAGE) {
    assert.ok(!re.test(body),
      `PRIVACY.md に「操作時だけ」の1段階の要約が戻っている: ${re}`);
  }
  /* 「読まない」ものを、表示中の説明の中でも명示していること */
  for (const phrase of ['It does not read the page text', 'ページの本文も、入力欄の値も、URLも、タイトルも読みません']) {
    assert.ok(body.includes(phrase), `PRIVACY.md に「${phrase}」が無い`);
  }
});

test('提出候補の note に、可変な事実を書き写していない（R20-004）', () => {
  /*
   * 第20回監査 R20-004。構造化された欄は正しく差し替わっていたのに、
   * `note` だけ前回の run 番号・外側のバイト数・「第12回〜第18回」という
   * 古い範囲を抱えたまま残っていた。**同じ事実を2か所に書けば、片方が必ず古くなる。**
   * 数える対象を「一致するか」ではなく「いくつ書いてあるか」にする。
   */
  const cand = JSON.parse(read('store/SUBMISSION_CANDIDATE.json'));
  const note = String(cand.note || '');
  const MUTABLE = [
    [/\b\d{9,}\b/, 'run 番号のような長い数字'],
    [/\b[0-9a-f]{7,}\b/i, 'コミットSHAやハッシュ'],
    [/\b\d{1,3}(,\d{3})+\s*B\b/, 'バイト数'],
    [/\b\d{4,}\s*B\b/, 'バイト数'],
    [/第\d+回〜第\d+回/, '監査の回次の範囲（増えるたびに古くなる）'],
    [/reposhout-(package|1\.)/, '成果物の名前']
  ];
  const found = MUTABLE.filter(([re]) => re.test(note)).map(([, label]) => label);
  assert.deepEqual(found, [],
    `note に可変な事実が書き写されている: ${found.join(' / ')}\n  note: ${note.slice(0, 160)}`);

  /* 対照: この検査が本当に効くこと（実際に残っていた旧 note で確かめる） */
  const stale = 'main への push で走った CI（run 31456006836）が作ったもの。外側は 40,621 B で、'
    + 'digest と一致。第12回〜第18回で却下した成果物は提出しない';
  const caught = MUTABLE.filter(([re]) => re.test(stale)).length;
  assert.ok(caught >= 3,
    `対照が成立していない＝この検査は旧 note を捕まえられない（${caught} 件しか当たらない）`);

  /* 構造化された欄のほうは、空でないこと（note を消しただけにしない） */
  if (cand.status === 'ready') {
    for (const k of ['artifactName', 'innerSha256', 'innerBytes', 'innerFiles']) {
      assert.ok(cand[k], `${k} が空。note を消した代わりが無い`);
    }
  }
});

test('却下の記録が、実在した指摘IDを漏れなく持っている（R21-003）', () => {
  /*
   * 第21回監査 R21-003。`rejected_by_R20` の理由文には R20-002〜005 しか無く、
   * **実在した R20-001 が抜けていた**。自由文で管理すると、書き忘れても誰も気づかない。
   * 指摘IDを配列で持ち、回次と突き合わせる。
   */
  const cand = JSON.parse(read('store/SUBMISSION_CANDIDATE.json'));
  const rejected = cand.history.filter(
    (h) => typeof h.status === 'string' && h.status.startsWith('rejected_by_'));
  assert.ok(rejected.length >= 9, `却下の記録が少なすぎる: ${rejected.length}`);

  for (const h of rejected) {
    const round = Number(h.status.replace('rejected_by_R', ''));
    assert.ok(Number.isInteger(round), `回次が読めない: ${h.status}`);
    assert.equal(h.auditRound, round, `${h.status}: auditRound が status と食い違う`);
    assert.ok(Array.isArray(h.findingIds) && h.findingIds.length,
      `${h.status}: findingIds が無い`);
    /* IDの重複が無く、すべてその回次のものであること */
    assert.equal(new Set(h.findingIds).size, h.findingIds.length,
      `${h.status}: findingIds が重複している`);
    for (const id of h.findingIds) {
      assert.match(id, new RegExp(`^R${round}-\\d{3}$`),
        `${h.status}: 別の回次のIDが混ざっている: ${id}`);
    }
  }

  /* 第20回は5件そろっていること（R20-001 が抜けていたのが今回の指摘） */
  const r20 = rejected.find((h) => h.status === 'rejected_by_R20');
  assert.ok(r20, 'rejected_by_R20 の記録が無い');
  assert.deepEqual(r20.findingIds,
    ['R20-001', 'R20-002', 'R20-003', 'R20-004', 'R20-005'],
    'PR #20 で直した指摘の集合と一致していない');
});

test('「それ以外は変更しない」という全称が撤回されている（R21-001）', () => {
  /*
   * 第21回監査 R21-001。Privacy とストア原稿は
   * 「`<style>` 1つとボタンの入れ物1つ**以外は何も変更しない**」と書いていたが、
   * 共有できないときは **body へ通知要素をもう1つ足す**（実測）。
   * 全称の言い切りをやめ、足すものを数え上げる。
   */
  const priv = activeText('PRIVACY.md');
  const listing = activeText('store/LISTING.md');
  for (const [file, body, stale] of [
    ['PRIVACY.md', priv, [/and modifies nothing else/i, /以外は何も変更しません/]],
    ['store/LISTING.md', listing, [/and modifies nothing else/i]]
  ]) {
    for (const re of stale) {
      assert.ok(!re.test(body), `${file} に「それ以外は変更しない」が残っている: ${re}`);
    }
  }
  /* 代わりに、通知要素を足すことが書いてあること */
  for (const [file, body, phrases] of [
    ['PRIVACY.md', priv, ['status message', '画面の隅に小さな案内']],
    ['store/LISTING.md', listing, ['status message near the corner']]
  ]) {
    for (const p of phrases) {
      assert.ok(body.includes(p), `${file} に通知要素の説明が無い: ${p}`);
    }
  }
  /* 「GitHubの要素は消さない」は事実なので、残っていること */
  assert.ok(/deletes and replaces nothing/i.test(priv), 'PRIVACY.md から事実の記述まで消えている');
  assert.ok(/消しも置き換えもしません/.test(priv), 'PRIVACY.md（日本語）から事実の記述まで消えている');
});

test('通知は、操作列が無いページでも出る（R21-001の再現）', () => {
  /*
   * ストア原稿は「expected container が無ければ何もしない」と書いていたが、
   * 通知は container の有無と関係なく body へ足される。
   * ここでは content.js の構造から、通知が container を必要としないことを見る。
   */
  const src = stripComments(read('src/content.js'));
  const notice = src.match(/function showNotice\([\s\S]*?\n  \}/);
  assert.ok(notice, 'showNotice が見つからない');
  assert.ok(!/findContainer|CONTAINERS/.test(notice[0]),
    '通知が操作列の有無に依存している（実装が変わったなら文書も直す）');
  assert.match(notice[0], /body\.appendChild/, '通知が body へ足されていない');
  /* 通知に値が入らないこと（定型文だけ） */
  assert.ok(!/location\.href|document\.title|tab\.url/.test(notice[0]),
    '通知にURLや値が入っている');
});

/* ============================================================
 * 第21回監査 R21-004 — 変異ランナー自身の検査
 * ============================================================
 *
 * 第20回に、変異15件が全件「素通り」と表示されたが、実は**一度も適用されて
 * いなかった**。ランナーが壊れていると、検査の結果そのものが読めなくなる。
 * ランナーをリポジトリへ置いたうえで、**ランナーが正しく区別すること**を測る。
 */

test('変異の定義が、落ちるはずのテストを宣言していて、それが実在する（R23-001）', () => {
  /*
   * 第23回監査 R23-001。落ちた理由を見ずに「検知」と数えていたので、
   * 各変異へ「どのテストが落ちるはずか」を宣言させた。
   * ⚠️ **宣言した名前が実在しないと、必ず `wrong_test_failure` になって止まる。**
   * テストの名前を変えたときに気づけるよう、ここで突き合わせる
   * （実際、ランナーの自己検査を書き直したとき9件がずれた）。
   */
  const spec = JSON.parse(read('test/mutations.json'));
  const namesOf = (() => {
    const cache = new Map();
    return (file) => {
      if (!cache.has(file)) {
        const src = read(file);
        cache.set(file, [...src.matchAll(/(?:^|\s)(?:it|test)\(\s*(['`])((?:\\.|(?!\1).)*)\1/gm)]
          .map((m) => m[2]));
      }
      return cache.get(file);
    };
  })();
  const bad = [];
  for (const m of spec.mutations) {
    const want = m.expectedFailure && m.expectedFailure.testName;
    if (typeof want !== 'string' || !want.trim()) { bad.push(`${m.id}: 宣言が無い`); continue; }
    if (!namesOf(m.test).includes(want)) bad.push(`${m.id}: 「${want}」が ${m.test} に無い`);
  }
  assert.deepEqual(bad, [], '変異の宣言と、実在するテスト名がずれている:\n' + bad.join('\n'));

  /* 対照: この突合が空振りしていないこと（実在しない名前は必ず見つからない） */
  assert.ok(!namesOf('test/docs.test.mjs').includes('この名前のテストは存在しない_R23'),
    '対照が壊れている（何でも実在すると答えている）');
  assert.ok(namesOf('test/docs.test.mjs').length >= 30,
    `テスト名を取り出せていない: ${namesOf('test/docs.test.mjs').length} 件`);
});

test('変異の定義が、対象ファイルの実物と一致している（R21-004）', () => {
  const spec = JSON.parse(read('test/mutations.json'));
  assert.ok(spec.mutations.length >= 40, `変異が少なすぎる: ${spec.mutations.length}`);
  const seen = new Set();
  for (const m of spec.mutations) {
    assert.ok(!seen.has(m.id), `変異IDが重複している: ${m.id}`);
    seen.add(m.id);
    for (const k of ['file', 'test', 'desc', 'find', 'replace']) {
      assert.ok(k in m, `${m.id}: ${k} が無い`);
    }
    /* find が、期待した回数だけ実在すること＝**変異が当たることの事前証明** */
    const body = read(m.file);
    const n = body.split(m.find).length - 1;
    const expected = m.expectMatches === undefined ? 1 : m.expectMatches;
    assert.equal(n, expected,
      `${m.id} (${m.file}): find の一致数が ${n}、期待は ${expected}。` +
      `当たらない変異は「素通り」と見分けがつかない`);
    /* 置換で中身が実際に変わること */
    assert.notEqual(body.replace(m.find, m.replace), body,
      `${m.id}: 置換しても中身が変わらない`);
  }
});

test('変異ランナーが、当たらなかった変異を素通りと数えない（R21-004の対照）', () => {
  /*
   * ランナーの分類そのものを見る。`not_applied` を `survived` へ寄せる書き方に
   * 戻すと、第20回と同じ読み違いがまた起きる。
   */
  const src = stripComments(read('scripts/run-mutations.mjs'));
  for (const outcome of ['applied_and_killed', 'applied_but_survived', 'not_applied', 'runner_error']) {
    assert.ok(src.includes(outcome), `ランナーが ${outcome} を区別していない`);
  }
  /* 一致数とハッシュで適用を証明していること */
  assert.match(src, /actualMatches/, 'ランナーが一致数を数えていない');
  assert.match(src, /beforeSha256[\s\S]{0,200}afterSha256/, 'ランナーが前後のハッシュを記録していない');
  assert.match(src, /restore/, 'ランナーが復旧していない');
  /* 素通り・不適用・ランナー失敗のどれかがあれば、終了コードが0にならないこと */
  assert.match(src, /survived\.length === 0[\s\S]{0,160}notApplied\.length === 0/,
    'ランナーが、当たらなかった変異を成功として終えている');
});
