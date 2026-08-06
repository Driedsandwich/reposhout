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

test('重み付き文字数（URLを含まない文面の厳密値）', () => {
  for (const [label, input, want] of FIX.WEIGHT) {
    assert.equal(GXS.weightedLength(input), want, `${label} / 入力=${JSON.stringify(input)}`);
  }
});

test('URLを含む文面は、公式が数える値を下回らない', () => {
  for (const [label, input, atLeast] of FIX.WEIGHT_MIN) {
    const got = GXS.weightedLength(input);
    assert.ok(got >= atLeast, `${label}: ${got} < ${atLeast}`);
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
  assert.ok(GXS.weightedLength('example.com') >= 23);
  assert.ok(GXS.weightedLength('a.co') >= 23);
  const many = Array(50).fill('a.co').join(' ');
  assert.ok(GXS.weightedLength(many) >= 50 * 23 + 49);
  const out = GXS.truncate(many);
  assert.ok(GXS.weightedLength(out) <= GXS.MAX_WEIGHT, `切り詰められていない: ${GXS.weightedLength(out)}`);
});

test('二重エンコードで機微ページの拒否を迂回できない（R4-003の回帰）', () => {
  const blocked = [
    'https://github.com/%2573ettings/tokens',
    'https://github.com/%25252573ettings/tokens',
    'https://github.com/o/r/%2573ettings/secrets',
    'https://github.com/settings%252Ftokens',
    'https://github.com/orgs/acme/%2573ettings/profile'
  ];
  for (const url of blocked) {
    assert.equal(GXS.isSensitiveUrl(url), true, `機微と判定されない: ${url}`);
    assert.equal(GXS.buildShare(url, 'T'), null, `共有できてしまう: ${url}`);
    assert.equal(GXS.fallbackUrl(url), null, `フォールバックで漏れる: ${url}`);
  }
  // 対照: 普通のページは共有できる
  for (const url of ['https://github.com/o/r', 'https://github.com/o/r/issues/1', 'https://github.com/o/r/blob/main/%E6%97%A5.md']) {
    assert.equal(GXS.isSensitiveUrl(url), false, url);
    assert.ok(GXS.buildShare(url, 'T · GitHub'), url);
  }
});

/*
 * 解いたあとに壊れたエスケープが残るパスを共有していた（第8回監査 R8-003）。
 *
 *   /%2573ettings%2525ZZ/tokens
 *     → %73ettings%25ZZ → settings%ZZ で止まる（有効な %xx が無くなるため）
 *     → 「settings ではない」と判定され、リポジトリ名として共有できていた
 *
 * 「デコードできないものは null へ倒す」と書いてあるのに、判定できないものを
 * 共有できる側に置いていた。経路を決める先頭3つに % が残ったら共有しない。
 */
test('解いたあとに壊れたエスケープが残るパスを共有しない（R8-003の回帰）', () => {
  const blocked = [
    'https://github.com/%2573ettings%2525ZZ/tokens',
    'https://github.com/%252573ettings%252525ZZ/tokens',
    'https://github.com/o/r/%2573ettings%2525ZZ/secrets',
    'https://github.com/%25ZZ/r',
    'https://github.com/o/%25ZZ',
    'https://github.com/o/r/%25ZZ',
    // 多重エンコードした .. も経路の判定を狂わせる
    'https://github.com/%252e%252e/settings/tokens',
    'https://github.com/o/r/%252e%252e/settings',
    'https://github.com/%2e%2e/settings'
  ];
  for (const url of blocked) {
    assert.equal(GXS.buildShare(url, 'T'), null, `共有できてしまう: ${url}`);
    assert.equal(GXS.fallbackUrl(url), null, `フォールバックで漏れる: ${url}`);
  }

  /*
   * 対照: 4つ目以降はファイル名なので、正当な % を含む名前を壊さない。
   * ここを落とすと `100%.md` のようなファイルが共有できなくなる。
   */
  const allowed = [
    'https://github.com/o/r',
    'https://github.com/o/r/issues/12',
    'https://github.com/o/r/blob/main/100%25.md',
    'https://github.com/o/r/blob/main/a%20b.md',
    'https://github.com/o/r/blob/main/%E6%97%A5.md',
    'https://github.com/o/r/tree/main/docs'
  ];
  for (const url of allowed) {
    assert.ok(GXS.buildShare(url, 'T · GitHub'), `落ちてはいけない: ${url}`);
  }
});

test('資格情報らしきハッシュを名前によらず落とす（T3-003の回帰）', () => {
  const keys = ['client_secret', 'password', 'api_key', 'api-key', 'session_token',
                'oauth_token', 'refresh_token', 'ACCESS_TOKEN', 'Code', 'x'];
  for (const k of keys) {
    for (const url of ['https://github.com/o/r/issues/12', 'https://github.com/o/r', 'https://github.com/o/r/blob/main/a.js']) {
      const out = GXS.canonicalUrl(`${url}#${k}=secretvalue`, null);
      assert.ok(!out.includes('#'), `残った: ${out}`);
      assert.ok(!out.includes('secretvalue'), `値が残った: ${out}`);
    }
  }
  // 対照: 普通のアンカーは残る（全部落としているだけではないこと）
  for (const h of ['#readme', '#L10-L20', '#issuecomment-99', '#' + encodeURIComponent('日本語の見出し')]) {
    assert.ok(GXS.canonicalUrl('https://github.com/o/r/issues/12' + h, null).endsWith(h), h);
  }
});

/*
 * 資格情報らしきハッシュは、何重にエンコードされていても落とす。
 *
 * 1回だけ解いて判定していたため、`#client_secret%253Ddummy`（二重エンコード）は
 * 1回解いても `%3D` のままで「= を含まない」と判定され、そのままXへ渡っていた
 * （第7回監査 R7-001）。パスの二重エンコードは第4回で塞いだのに、
 * フラグメント側は同じ穴が残っていた。
 */
test('何重にエンコードしても資格情報らしきハッシュは落とす（R7-001の回帰）', () => {
  const keys = ['client_secret', 'access_token', 'password', 'state', 'code', 'id_token'];
  const pages = ['https://github.com/o/r/issues/12', 'https://github.com/o/r',
                 'https://github.com/o/r/blob/main/a.js'];
  // = を1〜3回エンコードした形と、鍵の名前側もエンコードした形
  const encodings = [
    (k) => `${k}=secretvalue`,
    (k) => `${k}%3Dsecretvalue`,
    (k) => `${k}%253Dsecretvalue`,
    (k) => `${k}%25253Dsecretvalue`,
    (k) => `${encodeURIComponent(k).replace(/_/g, '%255F')}%253Dsecretvalue`
  ];
  let checked = 0;
  for (const k of keys) {
    for (const enc of encodings) {
      for (const page of pages) {
        const url = `${page}#${enc(k)}`;
        const out = GXS.canonicalUrl(url, null);
        assert.ok(!out.includes('#'), `ハッシュが残った: ${url} → ${out}`);
        assert.ok(!out.includes('secretvalue'), `値が残った: ${url} → ${out}`);
        // 共有そのものからも漏れないこと（canonicalUrl だけでなく最終形で見る）
        const s = GXS.buildShare(url, 'T · GitHub');
        assert.ok(!s || !s.url.includes('secretvalue'), `共有URLに値が残った: ${url}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 90, `検査した件数が少なすぎる: ${checked}`);

  // 対照: 正当なアンカーは何重エンコードでも落とさない（全部落としているだけではないこと）
  for (const h of ['#readme', '#L10-L20', '#issuecomment-99', '#user-content-x',
                   '#' + encodeURIComponent('日本語の見出し')]) {
    assert.ok(GXS.canonicalUrl('https://github.com/o/r/issues/12' + h, null).endsWith(h), h);
  }
});

test('解ききれないハッシュは載せない（判定できないものは共有しない）', () => {
  // 上限（5回）を超えて解ける形が残るものは、判定できないので落とす
  let deep = 'client_secret=x';
  for (let i = 0; i < 7; i++) deep = encodeURIComponent(deep);
  const out = GXS.canonicalUrl('https://github.com/o/r/issues/12#' + deep, null);
  assert.ok(!out.includes('#'), `解ききれないハッシュが残った: ${out}`);
  // 壊れたエンコードも落とす
  assert.ok(!GXS.canonicalUrl('https://github.com/o/r/issues/12#%ZZ', null).includes('#'));
});

test('エンコードされた機微パスを共有しない（T3-003の回帰）', () => {
  const blocked = [
    'https://github.com/%73ettings/tokens',
    'https://github.com/%53ettings/tokens',
    'https://github.com/o/r/%73ettings/secrets',
    'https://github.com/o/r/settings%2Ftokens',
    'https://github.com/orgs/acme/%73ettings/profile',
    'https://github.com/o/r/%ZZ'
  ];
  for (const url of blocked) {
    assert.equal(GXS.buildShare(url, 'T'), null, `共有できてしまう: ${url}`);
    assert.equal(GXS.fallbackUrl(url), null, `フォールバックで漏れる: ${url}`);
  }
  assert.ok(GXS.buildShare('https://github.com/o/r/settings-like', 'T · GitHub'), '対照が落ちている');
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

/* ============================================================
 * 第11回監査 R11-001 — 許可したクエリの「値」に入った資格情報
 * ============================================================
 *
 * 1.1.7 の配布ZIPで再現した穴。クエリの**名前**しか見ていなかったので、
 * allowlist に載っている名前（q・body・title など）の値に資格情報の形が
 * 入っていると、canonicalUrl も buildShare も fallbackUrl も、そのまま
 * Xの投稿画面へ渡していた。
 *
 * ここに置く値はすべて dummy で、実在の資格情報は入れない。
 * 失敗メッセージにも値を出さない（ラベルだけを出す）。
 */
const DUMMY = 'dummy-secret';

/* 落ちるべき組み合わせ: ルート × 書き方 × エンコード段数 */
const CREDENTIAL_CASES = [
  ['search / 等号',            `https://github.com/search?q=client_secret%3D${DUMMY}&type=code`],
  ['search / コロン',          `https://github.com/search?q=access_token%3A${DUMMY}`],
  ['search / 二重エンコード',   `https://github.com/search?q=access_token%253D${DUMMY}`],
  ['search / 三重エンコード',   `https://github.com/search?q=access_token%25253D${DUMMY}`],
  ['search / JSON',           'https://github.com/search?q=%7B%22access_token%22%3A%22' + DUMMY + '%22%7D'],
  ['search / 大文字混在',       `https://github.com/search?q=Access_Token%3D${DUMMY}`],
  ['search / 空白入り',        `https://github.com/search?q=password+%3D+${DUMMY}`],
  ['search / Bearer',         'https://github.com/search?q=Authorization%3A%20Bearer%20abcdefghijklmnopqrst'],
  ['search / ghp_',           'https://github.com/search?q=ghp_abcdefghijklmnopqrstuvwxyz012345'],
  ['search / gho_',           'https://github.com/search?q=gho_abcdefghijklmnopqrstuvwxyz012345'],
  ['search / github_pat_',    'https://github.com/search?q=github_pat_abcdefghijklmnopqrstuvw'],
  ['search / ほどけない%',      `https://github.com/search?q=access_token%ZZ${DUMMY}`],
  ['search / 改行が混ざる',      `https://github.com/search?q=${DUMMY}%0Aaccess_token%3Dx`],
  ['search / NULが混ざる',       `https://github.com/search?q=${DUMMY}%00`],
  ['issue一覧 / コロン',        `https://github.com/o/r/issues?q=access_token%3A${DUMMY}`],
  ['issue一覧 / 2つ目の欄',     `https://github.com/o/r/issues?page=1&q=api_key%3D${DUMMY}`],
  ['PR一覧 / 等号',            `https://github.com/o/r/pulls?q=password%3D${DUMMY}&page=1`],
  ['compare / body',          `https://github.com/o/r/compare/main...f?quick_pull=1&body=access_token%3D${DUMMY}`],
  ['compare / title',         `https://github.com/o/r/compare/main...f?quick_pull=1&title=client_secret%3D${DUMMY}`],
  ['discussion一覧',           `https://github.com/o/r/discussions?discussions_q=session_token%3D${DUMMY}`],
  ['actions / query',         `https://github.com/o/r/actions?query=private_key%3D${DUMMY}`],
  ['commits / author',        `https://github.com/o/r/commits/main?author=refresh_token%3D${DUMMY}`]
];

/* 残すべきもの（言及しているだけ・普通の検索・普通のページ） */
const BENIGN_CASES = [
  ['言及: how to use access_token', 'https://github.com/search?q=how+to+use+access_token'],
  ['言及: passwordless',            'https://github.com/search?q=passwordless+authentication'],
  ['言及: tokenization',            'https://github.com/o/r/compare/a...b?quick_pull=1&body=This+document+explains+tokenization'],
  ['言及: Authentication docs',      'https://github.com/o/r/compare/a...b?quick_pull=1&title=Authentication+documentation'],
  ['普通の検索',                     'https://github.com/o/r/issues?q=is%3Aopen+label%3Abug&page=2'],
  ['リポジトリ',                     'https://github.com/o/r'],
  ['Issue',                        'https://github.com/o/r/issues/12'],
  ['%を含むファイル名',               'https://github.com/o/r/blob/main/100%25.md?plain=1'],
  ['日本語の検索',                   'https://github.com/search?q=%E6%97%A5%E6%9C%AC%E8%AA%9E']
];

/* 3つの入口すべてで判定が同じであることを見る（片方だけ塞いでも意味がない） */
function shareOutcome(url) {
  const share = GXS.buildShare(url, 'ページの見出し');
  const fallback = GXS.fallbackUrl(url);
  const canonical = GXS.canonicalUrl(url, GXS.parseLocation(url));
  return {
    blocked: share === null && fallback === null && canonical === null,
    partly: [share, fallback, canonical].some((x) => x === null) &&
            [share, fallback, canonical].some((x) => x !== null),
    intent: share ? share.intentUrl : null
  };
}

test('許可したクエリの値に資格情報の形があれば、URLごと共有しない', () => {
  for (const [label, url] of CREDENTIAL_CASES) {
    const r = shareOutcome(url);
    assert.ok(!r.partly, `入口によって判定が違う: ${label}`);
    assert.ok(r.blocked, `共有できてしまう: ${label}`);
  }
});

test('Xへ渡すURLにも、投稿文にも、資格情報が出ていない', () => {
  for (const [label, url] of CREDENTIAL_CASES) {
    const r = shareOutcome(url);
    assert.equal(r.intent, null, `intentUrlが作られている: ${label}`);
  }
  // 念のため、拒否したURLの文字列がどこにも現れないことを直接見る
  for (const [label, url] of CREDENTIAL_CASES) {
    const share = GXS.buildShare(url, 'T');
    assert.equal(share, null, `buildShareがnullでない: ${label}`);
  }
});

test('ただ言及しているだけのクエリは、これまでどおり共有できる', () => {
  for (const [label, url] of BENIGN_CASES) {
    const r = shareOutcome(url);
    assert.ok(!r.blocked, `落としてはいけないものを落とした: ${label}`);
  }
});

test('落とす側の値でも、共有URLに残らないものは理由にしない', () => {
  /*
   * 名前で落ちるパラメータ（allowlist外・SENSITIVE_PARAM_RE）は共有URLに
   * 入らないので、それを理由にURLごと拒否しない。これまで共有できていた
   * ページが、無関係なパラメータのせいで共有できなくなるのを避けるため。
   */
  const url = `https://github.com/o/r/issues?q=is%3Aopen&access_token=${DUMMY}`;
  const out = GXS.canonicalUrl(url, GXS.parseLocation(url));
  assert.equal(out, 'https://github.com/o/r/issues?q=is%3Aopen');
  assert.ok(!String(out).includes(DUMMY), '落とすはずの値が残っている');
});

test('資格情報の判定は、ほどける段数に上限がある（止まらなくならない）', () => {
  // 何段でもほどける入力を与えても、必ず戻ってくる
  let deep = 'plain-text';
  for (let i = 0; i < 40; i++) deep = encodeURIComponent(deep);
  const t0 = Date.now();
  GXS.credentialLikeValue(deep);
  assert.ok(Date.now() - t0 < 1000, '判定が長すぎる');
});
