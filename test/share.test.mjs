/*
 * share.js の単体テスト＋X文字数の適合テスト
 *
 * 実行: node --test test/share.test.mjs   （または npm test）
 *
 * 期待値は test/fixtures.js に手で書いてある。
 * 本番の weightedLength / canonicalUrl で期待値を作らないこと。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadShare } from './helpers/load.mjs';

const { GXS, FIX } = loadShare();

/* 孤立サロゲート（絵文字が割れた跡）が残っていないか */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/;

test('重み付き文字数が twitter-text v3 の定義と一致する', () => {
  for (const [label, input, want] of FIX.WEIGHT) {
    assert.equal(GXS.weightedLength(input), want, `${label} / 入力=${JSON.stringify(input)}`);
  }
});

test('URLの正規化がページ種別ごとの方針どおり', () => {
  for (const [label, input, want] of FIX.URLS) {
    assert.equal(GXS.canonicalUrl(input, null), want, label);
  }
});

test('フォールバック経路も同じURL方針を使う', () => {
  for (const [label, input, want] of FIX.URLS) {
    // 機微ルートは共有そのものをしないので null になる
    const expected = GXS.isSensitiveUrl(input) ? null : want;
    assert.equal(GXS.fallbackUrl(input), expected, `フォールバック: ${label}`);
  }
});

test('認証・設定・管理画面は共有しない（RA-003の回帰）', () => {
  const blocked = [
    'https://github.com/settings/tokens?token=ghp_x',
    'https://github.com/settings/profile',
    'https://github.com/login/oauth/authorize?client_id=a&state=b',
    'https://github.com/sessions/two-factor',
    'https://github.com/o/r/settings/secrets/actions',
    'https://github.com/o/r/settings/keys',
    'https://github.com/orgs/acme/settings/profile',
    'https://github.com/orgs/acme/billing',
    'https://github.com/orgs/acme/people',
    'https://github.com/enterprises/e/settings/profile',
    'https://github.com/organizations/acme/settings/profile',
    'https://github.com/account/billing'
  ];
  for (const url of blocked) {
    assert.equal(GXS.isSensitiveUrl(url), true, `機微と判定されない: ${url}`);
    assert.equal(GXS.buildShare(url, 'Personal access tokens'), null, `共有されてしまう: ${url}`);
    assert.equal(GXS.fallbackUrl(url), null, `フォールバックで漏れる: ${url}`);
  }
  // 対照: 通常のページは共有できる（検査が全部nullを返しているだけではないこと）
  for (const url of ['https://github.com/o/r', 'https://github.com/o/r/issues/1', 'https://github.com/o/r/settings-like']) {
    assert.equal(GXS.isSensitiveUrl(url), false, url);
    assert.ok(GXS.buildShare(url, 'T · GitHub'), url);
    assert.ok(GXS.fallbackUrl(url), url);
  }
});

test('固定サフィックスは可変タイトルより優先して残す（RA-004の回帰）', () => {
  const cases = [
    ['https://github.com/owner/repo/issues/123', 'A'.repeat(400) + ' · Issue #123 · owner/repo', '(Issue #123 · owner/repo)'],
    ['https://github.com/owner/repo/pull/45', 'あ'.repeat(400) + ' by x · Pull Request #45 · owner/repo', '(PR #45 · owner/repo)'],
    ['https://github.com/o/r/discussions/7', '\u{1F600}'.repeat(300) + ' · Discussion #7 · o/r', '(Discussion #7 · o/r)']
  ];
  for (const [url, title, suffix] of cases) {
    const s = GXS.buildShare(url, title);
    assert.ok(s.text.endsWith(suffix), `末尾にサフィックスが無い: ${JSON.stringify(s.text.slice(-40))}`);
    assert.ok(s.text.includes('…'), '切り詰めの印が無い');
    assert.ok(GXS.weightedLength(s.text) <= GXS.MAX_WEIGHT, `重み超過: ${GXS.weightedLength(s.text)}`);
  }
});

test('サフィックスだけで上限を超える異常時も壊れない', () => {
  const long = ' (Issue #1 · ' + 'x'.repeat(400) + '/y)';
  const out = GXS.truncateWithSuffix('タイトル', long);
  assert.ok(GXS.weightedLength(out) <= GXS.MAX_WEIGHT, `重み超過: ${GXS.weightedLength(out)}`);
  assert.doesNotThrow(() => encodeURIComponent(out));
});

test('スキーム無しドメインを少なく数えない（RA-001の回帰）', () => {
  assert.equal(GXS.weightedLength('example.com'), 23);
  assert.equal(GXS.weightedLength('a.co'), 23);
  const many = Array(50).fill('a.co').join(' ');
  assert.equal(GXS.weightedLength(many), 50 * 23 + 49);
  const out = GXS.truncate(many);
  assert.ok(GXS.weightedLength(out) <= GXS.MAX_WEIGHT, `切り詰められていない: ${GXS.weightedLength(out)}`);
});

test('機微なルートではクエリもハッシュも共有しない', () => {
  const sensitive = [
    'https://github.com/settings/tokens?token=ghp_x#t=1',
    'https://github.com/login/oauth/authorize?client_id=a&state=b',
    'https://github.com/sessions/two-factor?x=1',
    'https://github.com/o/r/settings/secrets/actions?name=API_KEY'
  ];
  for (const url of sensitive) {
    const out = GXS.canonicalUrl(url, null);
    assert.ok(!out.includes('?'), `クエリが残っている: ${out}`);
    assert.ok(!out.includes('#'), `ハッシュが残っている: ${out}`);
  }
});

test('タイトルの整形', () => {
  for (const [kind, input, want] of FIX.TITLES) {
    assert.equal(GXS.cleanTitle(kind, input), want, `${kind} / ${input}`);
  }
});

test('ページ種別の判定', () => {
  for (const [url, kind, repo, number] of FIX.LOCATIONS) {
    const got = GXS.parseLocation(url);
    assert.equal(got.kind, kind, url);
    assert.equal(got.repo, repo, url);
    assert.equal(got.number, number, url);
  }
});

test('github.com 以外は共有対象にしない', () => {
  for (const url of ['https://example.com/a/b', 'http://github.com/a/b', 'https://gist.github.com/a/b', 'ftp://github.com/a/b']) {
    assert.equal(GXS.buildShare(url, 'x'), null, url);
  }
});

test('buildShare の総合ケース', () => {
  for (const [label, url, title, want] of FIX.BUILD) {
    const got = GXS.buildShare(url, title);
    if (want.isNull) {
      assert.equal(got, null, label);
      continue;
    }
    assert.ok(got, `${label}: null が返った`);
    if (want.kind) assert.equal(got.kind, want.kind, label);
    if (want.repo) assert.equal(got.repo, want.repo, label);
    if (want.text) assert.equal(got.text, want.text, label);
    if (want.url) assert.equal(got.url, want.url, label);
    if (want.endsWith) assert.ok(got.text.endsWith(want.endsWith), `${label}: 末尾が違う`);
    if (want.notContains) assert.ok(!got.text.includes(want.notContains), `${label}: 含んではいけない語がある`);
    if (want.weightMax) assert.ok(GXS.weightedLength(got.text) <= want.weightMax, `${label}: 重み超過`);
    if (want.xTotalMax) {
      const total = GXS.weightedLength(got.text) + 1 + GXS.URL_WEIGHT;
      assert.ok(total <= want.xTotalMax, `${label}: 合計 ${total} > ${want.xTotalMax}`);
    }
  }
});

test('切り詰めても重みが上限を超えない', () => {
  const samples = [
    '日'.repeat(400),
    'a'.repeat(600),
    '\u{1F44D}'.repeat(300),
    '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'.repeat(200),
    'ｱ'.repeat(400),
    ('https://github.com/octocat/Hello-World ').repeat(30)
  ];
  for (const s of samples) {
    const out = GXS.truncate(s);
    assert.ok(GXS.weightedLength(out) <= GXS.MAX_WEIGHT, `重み超過: ${GXS.weightedLength(out)}`);
    assert.ok(!LONE_SURROGATE.test(out), '孤立サロゲートが残った');
    assert.doesNotThrow(() => encodeURIComponent(out), 'encodeURIComponent が投げた');
  }
});

test('絵文字を境界へ動かしても壊れない（全位置を走査）', () => {
  // 絵文字を1文字ずつずらして、切り詰め境界のあらゆる位置に置く
  let checked = 0;
  for (let i = 0; i <= 300; i++) {
    const s = 'a'.repeat(i) + '\u{1F44D}' + 'b'.repeat(400);
    const out = GXS.truncate(s);
    assert.ok(!LONE_SURROGATE.test(out), `位置 ${i} で孤立サロゲート`);
    assert.doesNotThrow(() => encodeURIComponent(out), `位置 ${i} で URIError`);
    assert.ok(GXS.weightedLength(out) <= GXS.MAX_WEIGHT, `位置 ${i} で重み超過`);
    checked++;
  }
  assert.equal(checked, 301);
});

test('ZWJ連結の途中で切らない', () => {
  for (let i = 0; i <= 120; i++) {
    const out = GXS.truncate('a'.repeat(i) + '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'.repeat(60));
    assert.ok(!/\u200D\u2026?$/.test(out), `位置 ${i}: ZWJ で終わっている`);
  }
});

test('投稿全体（本文+空白+URL）が280以下に収まる', () => {
  const cases = [
    ['https://github.com/o/r', 'GitHub - o/r: ' + '日'.repeat(400) + ' · GitHub'],
    ['https://github.com/o/r/issues/1', 'あ'.repeat(400) + ' · Issue #1 · o/r'],
    ['https://github.com/o/r/pull/1', '\u{1F44D}'.repeat(300) + ' by me · Pull Request #1 · o/r'],
    ['https://github.com/o/r', 'GitHub - o/r: ' + 'ｱ'.repeat(400) + ' · GitHub'],
    ['https://github.com/o/r', 'GitHub - o/r: ' + '→★✓'.repeat(150) + ' · GitHub']
  ];
  for (const [url, title] of cases) {
    const s = GXS.buildShare(url, title);
    const total = GXS.weightedLength(s.text) + 1 + GXS.URL_WEIGHT;
    assert.ok(total <= GXS.MAX_WEIGHTED_TWEET, `合計 ${total} > 280 (${title.slice(0, 20)})`);
  }
});

test('境界値 279 / 280 / 281 の判定', () => {
  const bodyWeight = (n) => 'a'.repeat(n);          // 1文字=重み1
  const totalOf = (text) => GXS.weightedLength(text) + 1 + GXS.URL_WEIGHT;
  assert.equal(totalOf(bodyWeight(255)), 279);
  assert.equal(totalOf(bodyWeight(256)), 280);
  assert.equal(totalOf(bodyWeight(257)), 281);
  // 上限256に対し MAX_WEIGHT は余白つきで250
  assert.ok(GXS.MAX_WEIGHT <= 256, 'MAX_WEIGHT が本文上限を超えている');
});

test('NFC と NFD が同じ重みになる', () => {
  assert.equal(GXS.weightedLength('\u1EBD'), GXS.weightedLength('e\u0303'));
});

test('タイトルが空でもURLだけは共有できる', () => {
  const s = GXS.buildShare('https://github.com/o/r', '');
  assert.equal(s.text, 'o/r');
  assert.ok(s.intentUrl.startsWith('https://x.com/intent/post?'));
});

test('組み立てたintentUrlがそのままパースできる', () => {
  const s = GXS.buildShare('https://github.com/o/r/issues/12?utm_source=x#issuecomment-1', 'T · Issue #12 · o/r');
  const u = new URL(s.intentUrl);
  assert.equal(u.searchParams.get('text'), 'T (Issue #12 · o/r)');
  assert.equal(u.searchParams.get('url'), 'https://github.com/o/r/issues/12#issuecomment-1');
});
