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
  var URLS = [
    ['リポジトリトップはそのまま', 'https://github.com/octocat/Hello-World', 'https://github.com/octocat/Hello-World'],
    ['末尾スラッシュを落とす', 'https://github.com/octocat/Hello-World/', 'https://github.com/octocat/Hello-World'],
    ['リポジトリトップの tab= は落とす', 'https://github.com/octocat/Hello-World?tab=readme-ov-file', 'https://github.com/octocat/Hello-World'],
    ['リポジトリトップのREADME節アンカーは残す', 'https://github.com/octocat/Hello-World#readme', 'https://github.com/octocat/Hello-World#readme'],
    ['日本語見出しのアンカーも残す', 'https://github.com/o/r#%E6%97%A5%E6%9C%AC%E8%AA%9E', 'https://github.com/o/r#%E6%97%A5%E6%9C%AC%E8%AA%9E'],
    ['リポジトリトップでも資格情報の形のハッシュは落とす', 'https://github.com/o/r#access_token=abc', 'https://github.com/o/r'],
    ['長すぎるハッシュは落とす', 'https://github.com/o/r#' + 'a'.repeat(80), 'https://github.com/o/r'],
    ['tab= は落としつつアンカーは残す', 'https://github.com/o/r?tab=readme-ov-file#readme', 'https://github.com/o/r#readme'],
    ['Issue一覧のフィルタは残す', 'https://github.com/o/r/issues?q=is%3Aopen+label%3Abug', 'https://github.com/o/r/issues?q=is%3Aopen+label%3Abug'],
    ['Issue一覧の state も残す', 'https://github.com/o/r/issues?state=open', 'https://github.com/o/r/issues?state=open'],
    ['PR一覧のフィルタとページを残す', 'https://github.com/o/r/pulls?q=is%3Apr&page=2', 'https://github.com/o/r/pulls?q=is%3Apr&page=2'],
    ['知らないクエリは落とす', 'https://github.com/o/r/issues?q=is%3Aopen&unknown=1', 'https://github.com/o/r/issues?q=is%3Aopen'],
    ['Markdownの plain=1 と行ハッシュを残す', 'https://github.com/o/r/blob/main/README.md?plain=1#L14', 'https://github.com/o/r/blob/main/README.md?plain=1#L14'],
    ['行範囲ハッシュとトラッキング除去の両立', 'https://github.com/o/r/blob/main/a.md?plain=1&utm_source=x#L10-L20', 'https://github.com/o/r/blob/main/a.md?plain=1#L10-L20'],
    ['Issueのコメントアンカーは残す', 'https://github.com/o/r/issues/12#issuecomment-99', 'https://github.com/o/r/issues/12'.concat('#issuecomment-99')],
    ['通知由来のIDは落とす', 'https://github.com/o/r/issues/12?notification_referrer_id=NT_abc', 'https://github.com/o/r/issues/12'],
    ['compareのPR下書きパラメータを残す', 'https://github.com/o/r/compare/main...feature?quick_pull=1&title=Fix&body=Why&labels=bug', 'https://github.com/o/r/compare/main...feature?quick_pull=1&title=Fix&body=Why&labels=bug'],
    ['PRのdiff表示指定を残す', 'https://github.com/o/r/pull/12/files?diff=split&w=1', 'https://github.com/o/r/pull/12/files?diff=split&w=1'],
    ['commitsのauthorを残す', 'https://github.com/o/r/commits/main?author=octocat', 'https://github.com/o/r/commits/main?author=octocat'],
    ['Actionsのqueryを残す', 'https://github.com/o/r/actions?query=branch%3Amain', 'https://github.com/o/r/actions?query=branch%3Amain'],
    ['GitHub検索のq/typeを残す', 'https://github.com/search?q=chrome+extension&type=repositories', 'https://github.com/search?q=chrome+extension&type=repositories'],
    ['ユーザーページのtabは残す', 'https://github.com/octocat?tab=repositories', 'https://github.com/octocat?tab=repositories'],
    ['設定ページはクエリを落とす', 'https://github.com/settings/tokens?token=ghp_example', 'https://github.com/settings/tokens'],
    ['OAuth認可URLはクエリを落とす', 'https://github.com/login/oauth/authorize?client_id=abc&state=xyz', 'https://github.com/login/oauth/authorize'],
    ['リポジトリ設定もクエリを落とす', 'https://github.com/o/r/settings/keys?x=1', 'https://github.com/o/r/settings/keys'],
    ['資格情報の形のハッシュは落とす', 'https://github.com/o/r/issues/12#access_token=abc', 'https://github.com/o/r/issues/12'],
    ['機微な名前のパラメータは落とす', 'https://github.com/o/r/issues?q=a&session_token=zzz', 'https://github.com/o/r/issues?q=a'],
    ['httpは素の形にする', 'http://github.com/o/r?x=1', 'http://github.com/o/r'],
    ['github以外は素の形にする', 'https://example.com/a?b=1#c', 'https://example.com/a'],
    ['URLとして壊れているものはクエリ以降を落とすだけ', 'not a url?x=1#y', 'not a url'],
    ['Wikiはクエリを落とす', 'https://github.com/o/r/wiki/Home?x=1', 'https://github.com/o/r/wiki/Home'],
    ['ファイル表示: 知らないクエリは落とし行ハッシュは残す', 'https://github.com/foo/bar/blob/main/a.js?x=1#L3', 'https://github.com/foo/bar/blob/main/a.js#L3']
  ];

  /* ---- タイトルの整形 ---- */
  var TITLES = [
    ['repo', 'GitHub - octocat/Hello-World: My first repository on GitHub! · GitHub', 'octocat/Hello-World: My first repository on GitHub!'],
    ['issue', 'Fix the crash · Issue #123 · octocat/Hello-World', 'Fix the crash'],
    ['pr', 'Add tests by octocat · Pull Request #45 · octocat/Hello-World', 'Add tests'],
    ['discussion', 'How do I use this? · Discussion #7 · octocat/Hello-World', 'How do I use this?'],
    ['issue', 'Title with · Issue # inside · Issue #9 · o/r', 'Title with · Issue # inside'],
    ['other', 'Notifications · GitHub', 'Notifications'],
    ['repo', '', '']
  ];

  /* ---- 種別判定 ---- */
  var LOCATIONS = [
    ['https://github.com/octocat/Hello-World', 'repo', 'octocat/Hello-World', null],
    ['https://github.com/o/r/issues/12', 'issue', 'o/r', '12'],
    ['https://github.com/o/r/pull/12', 'pr', 'o/r', '12'],
    ['https://github.com/o/r/discussions/3', 'discussion', 'o/r', '3'],
    ['https://github.com/orgs/community/discussions/123', 'other', null, null],
    ['https://github.com/o/r/blob/main/a.js', 'repo-sub', 'o/r', null],
    ['https://github.com/notifications', 'other', null, null],
    ['https://github.com/issues/assigned', 'other', null, null],
    ['https://github.com/marketplace/actions/checkout', 'other', null, null],
    ['https://github.com/topics/machine-learning', 'other', null, null],
    ['https://github.com/', 'other', null, null],
    ['https://github.com/octocat', 'other', null, null]
  ];

  /* ---- buildShare の総合ケース（URL+タイトル → 投稿内容） ----
   * v1.0.x のブラウザ版テストから引き継いだもの。
   * isNull は「共有対象外」、weightMax / xTotalMax は上限の検査。
   */
  var BUILD = [
    ['リポジトリトップ（日本語説明・ダッシュ含む）',
      'https://github.com/octocat/Hello-World',
      'GitHub - octocat/Hello-World: Intent Compiler — 曖昧な一文を、実行可能な指示書へ。 · GitHub',
      { kind: 'repo', text: 'octocat/Hello-World: Intent Compiler — 曖昧な一文を、実行可能な指示書へ。', url: 'https://github.com/octocat/Hello-World' }],
    ['Issue',
      'https://github.com/anthropics/claude-code/issues/82809',
      '[BUG] /ide says "No available IDEs detected" · Issue #82809 · anthropics/claude-code',
      { kind: 'issue', text: '[BUG] /ide says "No available IDEs detected" (Issue #82809 · anthropics/claude-code)', url: 'https://github.com/anthropics/claude-code/issues/82809' }],
    ['PR（著者名を除去）',
      'https://github.com/anthropics/claude-code/pull/69226',
      'Update frontend-design skill by williamqian12 · Pull Request #69226 · anthropics/claude-code',
      { kind: 'pr', text: 'Update frontend-design skill (PR #69226 · anthropics/claude-code)', url: 'https://github.com/anthropics/claude-code/pull/69226' }],
    ['Discussion',
      'https://github.com/foo/bar/discussions/42',
      'How do I use this? · Discussion #42 · foo/bar',
      { kind: 'discussion', text: 'How do I use this? (Discussion #42 · foo/bar)', url: 'https://github.com/foo/bar/discussions/42' }],
    ['ファイルの行指定ハッシュは残す',
      'https://github.com/foo/bar/blob/main/src/x.js#L10-L20', 'x · GitHub',
      { kind: 'repo-sub', url: 'https://github.com/foo/bar/blob/main/src/x.js#L10-L20' }],
    ['Issueのコメントアンカーは残す',
      'https://github.com/foo/bar/issues/7#issuecomment-999', 'T · Issue #7 · foo/bar',
      { kind: 'issue', url: 'https://github.com/foo/bar/issues/7#issuecomment-999' }],
    ['タイトル自体に " · Issue #" を含んでも切れない',
      'https://github.com/foo/bar/issues/5', 'Fix the " · Issue #" parser bug · Issue #5 · foo/bar',
      { kind: 'issue', text: 'Fix the " · Issue #" parser bug (Issue #5 · foo/bar)' }],
    ['タイトルが空ならrepo名で代替',
      'https://github.com/foo/bar', '', { kind: 'repo', text: 'foo/bar' }],
    ['PR番号が数字でなければ repo-sub 扱い',
      'https://github.com/foo/bar/pull/abc', 'x · GitHub', { kind: 'repo-sub' }],
    ['releases は release',
      'https://github.com/foo/bar/releases/tag/v1.0', 'Release v1.0 · foo/bar · GitHub', { kind: 'release' }],
    ['組織Discussionをリポジトリと誤判定しない',
      'https://github.com/orgs/community/discussions/1', 'Title · GitHub', { kind: 'other', notContains: 'orgs/community' }],
    ['予約語は大文字小文字を問わず弾く',
      'https://github.com/ORGS/community/discussions/1', 'x', { kind: 'other' }],
    ['/topics/... はリポジトリではない',
      'https://github.com/topics/chrome-extension', 'chrome-extension · GitHub Topics', { kind: 'other' }],
    ['個人設定ページは共有しない', 'https://github.com/settings/profile', 'Your Profile', { isNull: true }],
    ['アクセストークン画面は共有しない', 'https://github.com/settings/tokens?token=x', 'Personal access tokens', { isNull: true }],
    ['OAuth認可画面は共有しない', 'https://github.com/login/oauth/authorize?client_id=a&state=b', 'Authorize application', { isNull: true }],
    ['リポジトリのSecretsは共有しない', 'https://github.com/o/r/settings/secrets/actions', 'Actions secrets', { isNull: true }],
    ['組織の管理画面は共有しない', 'https://github.com/orgs/acme/settings/profile', 'Organization settings', { isNull: true }],
    ['Enterpriseの管理画面は共有しない', 'https://github.com/enterprises/e/settings/profile', 'Enterprise settings', { isNull: true }],
    ['組織のDiscussionは機微ではない（共有対象・ただしrepo扱いしない）',
      'https://github.com/orgs/community/discussions/12345', 'Title · GitHub', { kind: 'other' }],
    ['普通のユーザー名は誤って弾かない',
      'https://github.com/octocat/Hello-World', 'GitHub - octocat/Hello-World: x · GitHub', { kind: 'repo', repo: 'octocat/Hello-World' }],
    ['github.com 以外はnull', 'https://example.com/foo', 'Example', { isNull: true }],
    ['httpは拒否（httpsのみ）', 'http://github.com/foo/bar', 'x', { isNull: true }],
    ['gist.github.com は対象外', 'https://gist.github.com/foo/abc', 'x', { isNull: true }],
    ['壊れたURLはnull', 'not a url', 'x', { isNull: true }],
    ['長文は切り詰めて…を付ける',
      'https://github.com/foo/bar', 'GitHub - foo/bar: ' + 'あ'.repeat(400) + ' · GitHub',
      { kind: 'repo', weightMax: 250, endsWith: '…', xTotalMax: 280 }],
    ['日本語129字（旧実装が破綻していた長さ）でも収まる',
      'https://github.com/foo/bar', 'GitHub - foo/bar: ' + 'あ'.repeat(129) + ' · GitHub',
      { kind: 'repo', xTotalMax: 280 }],
    ['半角カタカナ400字でも収まる（旧実装は少なく数えていた）',
      'https://github.com/foo/bar', 'GitHub - foo/bar: ' + 'ｱ'.repeat(400) + ' · GitHub',
      { kind: 'repo', xTotalMax: 280 }],
    ['絵文字だけの長文でも壊れない',
      'https://github.com/foo/bar', 'GitHub - foo/bar: ' + '\u{1F600}'.repeat(200) + ' · GitHub',
      { kind: 'repo', weightMax: 250, xTotalMax: 280 }],
    ['長いIssueでも (Issue #N · owner/repo) が残る',
      'https://github.com/owner/repo/issues/123', 'A'.repeat(300) + ' · Issue #123 · owner/repo',
      { kind: 'issue', contains: '(Issue #123 · owner/repo)', weightMax: 250, xTotalMax: 280 }],
    ['長いPRでも (PR #N · owner/repo) が残る',
      'https://github.com/owner/repo/pull/45', 'あ'.repeat(300) + ' by octocat · Pull Request #45 · owner/repo',
      { kind: 'pr', contains: '(PR #45 · owner/repo)', weightMax: 250, xTotalMax: 280 }],
    ['長いDiscussionでも (Discussion #N · owner/repo) が残る',
      'https://github.com/o/r/discussions/7', '\u{1F600}'.repeat(200) + ' · Discussion #7 · o/r',
      { kind: 'discussion', contains: '(Discussion #7 · o/r)', weightMax: 250, xTotalMax: 280 }],
    ['スキーム無しドメインだらけのタイトルでも280に収まる',
      'https://github.com/foo/bar', 'GitHub - foo/bar: ' + Array(50).fill('a.co').join(' ') + ' · GitHub',
      { kind: 'repo', weightMax: 250, xTotalMax: 280 }]
  ];

  root.GXS_FIXTURES = { WEIGHT: WEIGHT, WEIGHT_MIN: WEIGHT_MIN, URLS: URLS, TITLES: TITLES, LOCATIONS: LOCATIONS, BUILD: BUILD };
})(typeof globalThis !== 'undefined' ? globalThis : self);
