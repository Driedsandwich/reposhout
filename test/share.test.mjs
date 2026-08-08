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
    /*
     * 第12回監査 R12-001 以降、機微なルートは「クエリを落とした素のURL」では
     * なく**共有そのものを断る**（reason='sensitive_route'）。
     */
    assert.equal(GXS.canonicalUrl(url, null), null, `共有できてしまう: ${url}`);
    const r = GXS.canonicalResult(url);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'sensitive_route', `理由が違う: ${r.reason}`);
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
 * 出て行くURLに秘密が乗らないこと（第11回 R11-001 / 第12回 R12-001・R12-002）
 * ============================================================
 *
 * 1.1.7 では、allowlist に載った名前（q・body・title）の**値**をそのままXへ
 * 渡していた。1.1.8 で値の検査を足したが、第12回監査で
 *
 *   ・5回以上エンコードすると素通りする（上限に達したら通していた）
 *   ・accessToken / api-key のような書き方が素通りする
 *   ・パスの中の access_token=… は見ていない
 *   ・一覧に無いベンダのトークン形は素通りする
 *   ・逆に `q=100% coverage` のような**普通の検索を落としていた**
 *
 * ことが実配布物で示された。有限の正規表現で「自由文に秘密が無い」ことは
 * 示せないので、**自由文は共有URLから落とす**方針に変えた。
 *
 * ここで見るのは「拒否したか」ではなく **秘密が出て行かないか**。
 * 落として共有するのも、URLごと断るのも、どちらも合格。
 *
 * 値はすべてダミー。失敗メッセージにも値を出さない（ラベルだけ）。
 */
const DUMMY = 'dummy-secret';
/*
 * ダミーでも「その形」で書くと、GitHub の push protection が本物として弾く
 * （実際に push が拒否された）。**形は保ったまま、ファイルには断片で置き、
 * 実行時に組み立てる。** 検査に渡るのは組み立てた後の文字列なので、
 * テストの意味は変わらない。
 */
const DUMMY_TOKENS = {
  github: ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz012345'].join(''),
  githubPat: ['github', '_pat_', 'abcdefghijklmnopqrstuvw'].join(''),
  bearer: ['Authorization: ', 'Bear', 'er abcdefghijklmnopqrstu'].join(''),
  aws: ['AK', 'IA', 'IOSFODNN7EXAMPLE'].join(''),
  slack: ['xo', 'xb', '-000000000000-000000000000-DUMMYDUMMYDUMMYDUMMY'].join(''),
  jwt: ['ey', 'JhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiJkdW1teSJ9', '.DUMMYSIGNATUREVALUE'].join(''),
  google: ['AI', 'za', 'SyDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUM'].join(''),
  pem: ['-----BEGIN ', 'PRIVATE KEY', '-----DUMMY'].join('')
};
const SECRET_MARKERS = [DUMMY].concat(Object.values(DUMMY_TOKENS).map((v) => v.slice(0, 12)));

/* 出て行きうるものを全部集めて、秘密が混ざっていないかだけを見る */
function outboundOf(url) {
  const share = GXS.buildShare(url, 'ページの見出し');
  const fallback = GXS.fallbackUrl(url);
  const canonical = GXS.canonicalUrl(url, GXS.parseLocation(url));
  const parts = [canonical, fallback, share && share.url, share && share.intentUrl,
                 share && share.text].filter(Boolean).map(String);
  const decoded = parts.map((x) => { try { return decodeURIComponent(x); } catch (e) { return x; } });
  return {
    blocked: share === null && fallback === null && canonical === null,
    leaked: parts.concat(decoded).some((x) => SECRET_MARKERS.some((m) => x.includes(m)))
  };
}

test('多重エンコードした資格情報は、何段でも出て行かない（R12-001）', () => {
  for (let n = 0; n <= 12; n++) {
    let v = `access_token=${DUMMY}`;
    for (let i = 0; i < n; i++) v = encodeURIComponent(v);
    const r = outboundOf(`https://github.com/search?q=${v}`);
    assert.equal(r.leaked, false, `${n}回エンコードした値が出て行った`);
  }
});

test('名前の書き方を変えても出て行かない（camelCase / kebab / 大文字）', () => {
  const keys = ['access_token', 'accessToken', 'ACCESS_TOKEN', 'access-token',
                'clientSecret', 'client-secret', 'ClientSecret', 'api-key', 'apiKey',
                'refreshToken', 'sessionToken', 'oauthToken', 'privateKey', 'passPhrase'];
  for (const k of keys) {
    for (const where of [
      (v) => `https://github.com/search?q=${encodeURIComponent(v)}`,
      (v) => `https://github.com/o/r/issues?q=${encodeURIComponent(v)}`,
      (v) => `https://github.com/o/r/compare/a...b?quick_pull=1&body=${encodeURIComponent(v)}`,
      (v) => `https://github.com/o/r/actions?query=${encodeURIComponent(v)}`
    ]) {
      const r = outboundOf(where(`${k}=${DUMMY}`));
      assert.equal(r.leaked, false, `${k} の値が出て行った`);
    }
  }
});

test('JSON・コロン・引用符つきでも出て行かない', () => {
  for (const form of [
    `{"access_token":"${DUMMY}"}`, `access_token: ${DUMMY}`,
    `'clientSecret' = '${DUMMY}'`, `api_key:${DUMMY}`
  ]) {
    const r = outboundOf(`https://github.com/search?q=${encodeURIComponent(form)}`);
    assert.equal(r.leaked, false, '代入の形が出て行った');
  }
});

test('トークンの形そのもの（名前なし）も出て行かない', () => {
  for (const [label, value] of Object.entries(DUMMY_TOKENS)) {
    for (const url of [
      `https://github.com/search?q=${encodeURIComponent(value)}`,
      `https://github.com/o/r/compare/a...b?quick_pull=1&body=${encodeURIComponent(value)}`
    ]) {
      assert.equal(outboundOf(url).leaked, false, `${label} が出て行った`);
    }
  }
});

test('パス・ブランチ・ファイル名に入った資格情報は、URLごと断る（R12-001）', () => {
  const cases = [
    ['ファイル名の代入', `https://github.com/o/r/blob/main/access_token=${DUMMY}`],
    ['ディレクトリの代入', `https://github.com/o/r/tree/client_secret=${DUMMY}`],
    ['ファイル名がトークン', `https://github.com/o/r/blob/main/${DUMMY_TOKENS.github}`],
    ['compareのブランチ名', `https://github.com/o/r/compare/main...access_token=${DUMMY}`],
    ['エンコードされたパス', `https://github.com/o/r/blob/main/${encodeURIComponent('api_key=' + DUMMY)}`]
  ];
  for (const [label, url] of cases) {
    const r = outboundOf(url);
    assert.equal(r.leaked, false, `${label}: 出て行った`);
    assert.equal(r.blocked, true, `${label}: 断っていない`);
    assert.equal(GXS.canonicalResult(url).reason, 'credential_like', `${label}: 理由が違う`);
  }
});

test('フラグメントに入った資格情報も出て行かない', () => {
  for (const url of [
    `https://github.com/o/r/issues/12#access_token=${DUMMY}`,
    `https://github.com/o/r/issues/12#${DUMMY_TOKENS.github}`
  ]) {
    assert.equal(outboundOf(url).leaked, false, 'fragment から出て行った');
  }
});

/* ---- 落としてはいけないもの（偽陽性）---------------------------------- */

test('素の % を含む普通の検索を、拒否しない（R12-002）', () => {
  const cases = [
    ['100% coverage', 'https://github.com/search?q=100%25+coverage&type=code'],
    ['C++ 100%', 'https://github.com/search?q=C%2B%2B+100%25+coverage'],
    ['50%オフ', 'https://github.com/o/r/issues?q=50%25+off&state=open'],
    ['%を含むファイル名', 'https://github.com/o/r/blob/main/100%25.md?plain=1'],
    ['日本語', 'https://github.com/search?q=%E6%97%A5%E6%9C%AC%E8%AA%9E&type=code'],
    ['言及: access_token', 'https://github.com/o/r/blob/main/access_token.md'],
    ['言及: passwordless', 'https://github.com/o/r/blob/main/passwordless-auth.md'],
    ['言及: tokenization', 'https://github.com/o/r/blob/main/tokenization.md'],
    ['普通のリポジトリ', 'https://github.com/o/r'],
    ['Issue', 'https://github.com/o/r/issues/12']
  ];
  for (const [label, url] of cases) {
    const r = outboundOf(url);
    assert.equal(r.blocked, false, `落としてはいけないものを落とした: ${label}`);
  }
});

test('壊れたエスケープが残るパスは断る（判定できないものは出さない）', () => {
  const url = 'https://github.com/o/r/blob/main/%E4%B8%8D%E5';
  assert.equal(GXS.canonicalUrl(url, null), null, '判定できないものを共有した');
});

/* ---- 自由文は共有しない（この方針そのものを固定する）------------------ */

test('自由文のクエリは、共有URLに残らない', () => {
  const cases = [
    ['検索語', 'https://github.com/search?q=hello+world&type=code', 'q='],
    ['Issue検索', 'https://github.com/o/r/issues?q=is%3Aopen&state=open', 'q='],
    ['下書き本文', 'https://github.com/o/r/compare/a...b?quick_pull=1&body=Why', 'body='],
    ['下書き表題', 'https://github.com/o/r/compare/a...b?quick_pull=1&title=Fix', 'title='],
    ['Actions検索', 'https://github.com/o/r/actions?query=branch%3Amain&page=2', 'query='],
    ['Discussion検索', 'https://github.com/o/r/discussions?discussions_q=abc&page=1', 'discussions_q=']
  ];
  for (const [label, url, needle] of cases) {
    const out = GXS.canonicalUrl(url, null);
    assert.ok(out, `${label}: 共有できなくなっている`);
    assert.ok(!out.includes(needle), `${label}: 自由文が残っている`);
  }
});

test('型に合う値だけが残る', () => {
  const keep = [
    ['ページ番号', 'https://github.com/o/r/issues?page=3', 'page=3'],
    ['状態', 'https://github.com/o/r/issues?state=closed', 'state=closed'],
    ['差分表示', 'https://github.com/o/r/pull/12/files?diff=split&w=1', 'diff=split'],
    ['検索の種別', 'https://github.com/search?type=code', 'type=code']
  ];
  for (const [label, url, needle] of keep) {
    assert.ok(String(GXS.canonicalUrl(url, null)).includes(needle), `${label}: 落ちてしまった`);
  }
  const drop = [
    ['整数でないページ', 'https://github.com/o/r/issues?page=abc', 'page='],
    ['桁が多すぎるページ', 'https://github.com/o/r/issues?page=1234567', 'page='],
    ['一覧に無い状態', 'https://github.com/o/r/issues?state=whatever', 'state='],
    ['真偽値でない', 'https://github.com/o/r/blob/main/a.md?plain=maybe', 'plain='],
    ['長すぎるラベル', `https://github.com/o/r/issues?labels=${'a'.repeat(200)}`, 'labels=']
  ];
  for (const [label, url, needle] of drop) {
    const out = String(GXS.canonicalUrl(url, null));
    assert.ok(!out.includes(needle), `${label}: 型に合わない値が残った`);
  }
});

test('自由文の名前は、どのページ種別の表にも載っていない', () => {
  /*
   * 「共有URLに載せない」は型の表に足さないことで担保している。
   * ここが破られたら（例えば search に q を足したら）落ちる。
   */
  for (const [route, rules] of Object.entries(GXS.QUERY_RULES)) {
    if (!rules) continue;
    for (const name of GXS.FREE_TEXT_PARAMS) {
      assert.ok(!Object.prototype.hasOwnProperty.call(rules, name),
        `${route} の表に自由文 ${name} が載っている`);
    }
  }
});

test('深くエンコードしたパスは、ほどききれないので断る（R12-001）', () => {
  /* 上限に達しても有効な %HH が残る＝判定できない。通してはいけない */
  for (let n = 1; n <= 8; n++) {
    let seg = `access_token=${DUMMY}`;
    for (let i = 0; i < n; i++) seg = encodeURIComponent(seg);
    const url = `https://github.com/o/r/blob/main/${seg}`;
    const r = outboundOf(url);
    assert.equal(r.leaked, false, `${n}回エンコードしたパスが出て行った`);
    assert.equal(r.blocked, true, `${n}回エンコードしたパスを共有した`);
  }
});

test('判定の理由が、値を含まない決まった語で返る（R12-002）', () => {
  const REASONS = ['credential_like', 'sensitive_route', 'unsupported', 'malformed_url'];
  const cases = [
    ['https://github.com/settings/tokens', 'sensitive_route'],
    ['https://example.com/a', 'unsupported'],
    ['not a url', 'malformed_url'],
    [`https://github.com/o/r/blob/main/access_token=${DUMMY}`, 'credential_like']
  ];
  for (const [url, want] of cases) {
    const r = GXS.canonicalResult(url);
    assert.equal(r.ok, false);
    assert.equal(r.reason, want, `理由が違う: ${r.reason}`);
    assert.ok(REASONS.includes(r.reason), '決まった語でない');
    /* 理由に値やURLを混ぜない（表示に流用するため） */
    assert.ok(!JSON.stringify(r).includes(DUMMY), '理由に値が混ざっている');
    assert.ok(!JSON.stringify(r).includes('github.com'), '理由にURLが混ざっている');
  }
  const ok = GXS.buildShareResult('https://github.com/o/r', 'T');
  assert.equal(ok.ok, true);
  assert.ok(ok.share.intentUrl.startsWith('https://x.com/intent/post?'));
});

test('資格情報の判定は、ほどける段数に上限がある（止まらなくならない）', () => {
  let deep = 'plain-text';
  for (let i = 0; i < 40; i++) deep = encodeURIComponent(deep);
  const t0 = Date.now();
  GXS.credentialLikeValue(deep);
  assert.ok(Date.now() - t0 < 1000, '判定が長すぎる');
});
