/*
 * fixtures.js — 期待値の表（テストの正本）
 *
 * ここに書く期待値は、すべて手で書く。
 * 本番の関数（weightedLength / canonicalUrl）で生成しない。
 * 生成すると「実装が変わったら期待値も一緒に変わる」ので、
 * 実装のバグをテストが追認するだけになる。
 *
 * 素の <script> として書いてあるので、Node（vm経由）と
 * ブラウザ（test/share.test.html）の両方から同じ表を読める。
 */
(function (root) {
  'use strict';

  /* ---- Xの重み付き文字数 ----
   * 出典: twitter-text v3 config
   *   既定の重み2 / 重み1は [0,0x10FF] [0x2000,0x200D] [0x2010,0x201F] [0x2032,0x2037]
   *   絵文字は1連結で2 / URLは長さによらず23 / 先にNFC正規化
   */
  var WEIGHT = [
    ['空文字', '', 0],
    ['ASCII 1文字', 'a', 1],
    ['ASCII 11文字', 'hello world', 11],
    ['ひらがな1文字', 'あ', 2],
    ['日本語8文字', '日本語のテキスト', 16],
    ['ハングル3文字', '한국어', 6],
    ['中文2文字', '中文', 4],
    ['U+1160 ハングル字母フィラー（既定重み2の代表）', 'ᅠ', 2],
    ['半角カタカナ（0xFF60より上）', 'ｱ', 2],
    ['全角カタカナ', 'ア', 2],
    ['右矢印 U+2192', '→', 2],
    ['星 U+2605', '★', 2],
    ['ラテン拡張追加 U+1EBD', 'ẽ', 2],
    ['同じ文字のNFD表記（正規化して2になる）', 'e\u0303', 2],
    ['ハングル音節のNFD表記（正規化しないと4になる）', '\u1100\u1161', 2],
    ['エヌダッシュ U+2013（重み1の範囲）', '–', 1],
    ['プライム U+2032（重み1の範囲）', '′', 1],
    ['エンスペース U+2002（重み1の範囲）', '\u2002', 1],
    ['三点リーダ U+2026（範囲外なので2）', '…', 2],
    ['著作権記号（文字表示なので1）', '\u00A9', 1],
    ['著作権記号+VS16（絵文字表示なので2）', '\u00A9\uFE0F', 2],
    ['単独の絵文字', '\u{1F44D}', 2],
    ['肌色つき絵文字', '\u{1F44D}\u{1F3FD}', 2],
    ['ZWJ家族絵文字（4人+ZWJ3個で1連結）', '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}', 2],
    ['国旗絵文字（地域表示記号2つで1連結）', '\u{1F1EF}\u{1F1F5}', 2],
    ['キーキャップ', '1\uFE0F\u20E3', 2],
    ['異体字セレクタつき記号', '\u2764\uFE0F', 2],
    ['ASCII+絵文字', 'a\u{1F44D}', 3],
    ['日本語200文字（全部重み2）', '日'.repeat(200), 400],
    ['バージョン番号はURLではない', 'Ver.1.2.3', 9],
    ['「e.g.」はURLではない', 'e.g.', 4],
    ['「1.5倍」はURLではない', '1.5倍', 5],
    ['BMPベース＋肌色修飾子', '\u270A\u{1F3FD}', 2],
    ['同上・別のベース', '\u261D\u{1F3FD}', 2],
  ];

  /* ---- URLを含む文面 ----
   * URLの重みは「Xがどこをリンクと見なすか」に依存して確定できないので、
   * 厳密値ではなく「最低これだけは数える」で押さえる。
   * 公式実装との突き合わせ（少なく数えない）は test/oracle.test.mjs が行う。
   */
  var WEIGHT_MIN = [
    ['スキーム付きURLは最低23', 'https://t.co/a', 23],
    ['スキーム無しドメインも最低23', 'example.com', 23],
    ['短いドメインも最低23', 'a.co', 23],
    ['多階層TLDも最低23', 'foo.co.jp', 23],
    ['Unicode TLD も最低23', 'foobar.みんな/', 23],
    ['URLの前に文字が付く場合は前の文字ぶんも数える', 'text:http://example.com', 28],
    ['無効なドメインは素の長さぶん数える', 'http://foo_bar.com/abcdefghijklmnopqrstuvwxyz', 45],
    ['1つの並びにURLが2つあれば両方数える', 'example.comてすとですtwitter.みんなです', 60],
    ['a.co を50個なら 23×50 + 空白49', Array(50).fill('a.co').join(' '), 50 * 23 + 49]
  ];

  /* ---- URL正規化 ---- */
  /* ---- 共有URL（型で決まるルートだけ・第15回監査 R15-001） ----
   * 3つ目が期待する共有URL。null は「共有しない」。
   * 期待値は手で書く。実装で生成すると、実装の間違いを追認するだけになる。
   */
  var URLS = [
    /* 残るルート */
    ['リポジトリトップ', 'https://github.com/octocat/Hello-World', 'https://github.com/octocat/Hello-World'],
    ['末尾スラッシュを落とす', 'https://github.com/octocat/Hello-World/', 'https://github.com/octocat/Hello-World'],
    ['リポジトリトップの tab= は落とす', 'https://github.com/octocat/Hello-World?tab=readme-ov-file', 'https://github.com/octocat/Hello-World'],
    ['Issue', 'https://github.com/o/r/issues/12', 'https://github.com/o/r/issues/12'],
    ['PR', 'https://github.com/o/r/pull/45', 'https://github.com/o/r/pull/45'],
    ['Discussion', 'https://github.com/o/r/discussions/7', 'https://github.com/o/r/discussions/7'],
    ['Issue一覧', 'https://github.com/o/r/issues', 'https://github.com/o/r/issues'],
    ['PR一覧', 'https://github.com/o/r/pulls', 'https://github.com/o/r/pulls'],
    ['Discussion一覧', 'https://github.com/o/r/discussions', 'https://github.com/o/r/discussions'],
    ['リリース一覧', 'https://github.com/o/r/releases', 'https://github.com/o/r/releases'],
    ['コミット（40桁の16進）', 'https://github.com/o/r/commit/' + 'a'.repeat(40), 'https://github.com/o/r/commit/' + 'a'.repeat(40)],

    /* 型に合う値だけ残す */
    ['Issue一覧の state は残す', 'https://github.com/o/r/issues?state=open', 'https://github.com/o/r/issues?state=open'],
    ['PR一覧のページは残す', 'https://github.com/o/r/pulls?page=2', 'https://github.com/o/r/pulls?page=2'],
    ['PRのdiff指定は残す', 'https://github.com/o/r/pull/12?diff=split&w=1', 'https://github.com/o/r/pull/12?diff=split&w=1'],
    ['検索語は落とす（自由文）', 'https://github.com/o/r/issues?q=is%3Aopen+label%3Abug', 'https://github.com/o/r/issues'],
    ['知らないクエリも落とす', 'https://github.com/o/r/issues?unknown=1&state=open', 'https://github.com/o/r/issues?state=open'],
    ['識別子っぽい値も落とす', 'https://github.com/o/r/issues?labels=bug&state=open', 'https://github.com/o/r/issues?state=open'],
    ['通知由来のIDは落とす', 'https://github.com/o/r/issues/12?notification_referrer_id=NT_abc', 'https://github.com/o/r/issues/12'],
    ['型に合わない値は落とす', 'https://github.com/o/r/issues?page=abc&state=weird', 'https://github.com/o/r/issues'],

    /* フラグメントは種類によらず落とす */
    ['READMEのアンカーも落とす', 'https://github.com/o/r#readme', 'https://github.com/o/r'],
    ['コメントのアンカーも落とす', 'https://github.com/o/r/issues/12#issuecomment-99', 'https://github.com/o/r/issues/12'],
    ['資格情報の形のハッシュはもちろん落とす', 'https://github.com/o/r#access_token=abc', 'https://github.com/o/r'],

    /* 型で決まらないルートは共有しない */
    ['ファイル表示', 'https://github.com/o/r/blob/main/a.js', null],
    ['行アンカー付きのファイル表示', 'https://github.com/o/r/blob/main/README.md?plain=1#L14', null],
    ['ツリー', 'https://github.com/o/r/tree/main/src', null],
    ['比較', 'https://github.com/o/r/compare/main...feature', null],
    ['コミット一覧（refは任意の文字列）', 'https://github.com/o/r/commits/main', null],
    ['コミット（40桁でない）', 'https://github.com/o/r/commit/abc123', null],
    ['コミット（大文字の16進は受けない）', 'https://github.com/o/r/commit/' + 'A'.repeat(40), null],
    ['Actions', 'https://github.com/o/r/actions', null],
    ['Wiki', 'https://github.com/o/r/wiki', null],
    ['GitHub検索', 'https://github.com/search?q=chrome+extension', null],
    ['ユーザーページ', 'https://github.com/octocat', null],
    ['トップページ', 'https://github.com/', null],
    ['Issueの番号が0', 'https://github.com/o/r/issues/0', null],
    ['Issueの番号が数でない', 'https://github.com/o/r/issues/abc', null],
    ['セグメントが5つ', 'https://github.com/o/r/pull/45/files', null],
    ['予約語が所有者の位置', 'https://github.com/orgs/community/discussions/123', null],

    /* 認証・設定・管理画面 */
    ['設定', 'https://github.com/settings/tokens', null],
    ['二重エンコードした設定', 'https://github.com/%2573ettings/tokens', null],
    ['組織の管理', 'https://github.com/orgs/acme/settings/secrets', null],
    ['ログイン', 'https://github.com/login/oauth/authorize', null]
  ];

  /* ---- buildShare の総合ケース（URL → 投稿内容・第15回監査 R15-001） ----
   * **ページのタイトルは使わない。** 第2引数に何を渡しても結果は変わらない。
   */
  var BUILD = [
    ['リポジトリトップ', 'https://github.com/octocat/Hello-World',
      { kind: 'repo', text: 'octocat/Hello-World', url: 'https://github.com/octocat/Hello-World' }],
    ['Issue', 'https://github.com/anthropics/claude-code/issues/82809',
      { kind: 'issue', text: 'Issue #82809 \u00b7 anthropics/claude-code',
        url: 'https://github.com/anthropics/claude-code/issues/82809' }],
    ['PR', 'https://github.com/anthropics/claude-code/pull/69226',
      { kind: 'pr', text: 'PR #69226 \u00b7 anthropics/claude-code',
        url: 'https://github.com/anthropics/claude-code/pull/69226' }],
    ['Discussion', 'https://github.com/o/r/discussions/7',
      { kind: 'discussion', text: 'Discussion #7 \u00b7 o/r',
        url: 'https://github.com/o/r/discussions/7' }],
    ['Issue一覧', 'https://github.com/o/r/issues?state=open',
      { kind: 'issue-list', text: 'Issues \u00b7 o/r',
        url: 'https://github.com/o/r/issues?state=open' }],
    ['PR一覧', 'https://github.com/o/r/pulls',
      { kind: 'pr-list', text: 'Pull requests \u00b7 o/r', url: 'https://github.com/o/r/pulls' }],
    ['Discussion一覧', 'https://github.com/o/r/discussions',
      { kind: 'discussion-list', text: 'Discussions \u00b7 o/r',
        url: 'https://github.com/o/r/discussions' }],
    ['リリース一覧', 'https://github.com/o/r/releases',
      { kind: 'releases', text: 'Releases \u00b7 o/r', url: 'https://github.com/o/r/releases' }],
    ['コミット（短縮して7桁だけ出す）',
      'https://github.com/o/r/commit/0123456789abcdef0123456789abcdef01234567',
      { kind: 'commit', text: 'Commit 0123456 \u00b7 o/r',
        url: 'https://github.com/o/r/commit/0123456789abcdef0123456789abcdef01234567' }],
    ['ファイル表示は共有しない', 'https://github.com/o/r/blob/main/a.js', { isNull: true }],
    ['設定画面は共有しない', 'https://github.com/settings/tokens', { isNull: true }],
    ['github.com 以外は共有しない', 'https://example.com/o/r', { isNull: true }]
  ];

  root.GXS_FIXTURES = { WEIGHT: WEIGHT, WEIGHT_MIN: WEIGHT_MIN, URLS: URLS, BUILD: BUILD };
})(typeof globalThis !== 'undefined' ? globalThis : self);
