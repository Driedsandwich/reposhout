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
    ['エンコードされたパス', `https://github.com/o/r/blob/main/${encodeURIComponent('api_key=' + DUMMY)}`],
    ['ドット区切りの名前', `https://github.com/o/r/blob/main/api.key=${DUMMY}`],
    ['ドット区切り・別名', `https://github.com/o/r/blob/main/client.secret=${DUMMY}`]
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
    ['ラベル（値の集合を数えられない）', 'https://github.com/o/r/issues?labels=bug', 'labels='],
    ['作成者', 'https://github.com/o/r/commits/main?author=octocat', 'author='],
    ['ブランチ', 'https://github.com/o/r/commits/main?branch=main', 'branch=']
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

/* ============================================================
 * 第13回監査 R13-001 — 出て行くのはURLだけではない
 * ============================================================
 *
 * 1.1.8 の配布ZIPで、次が X の投稿画面の text に載ることを実測した。
 * URLは検査していたが、**document.title から作る投稿本文**は素通りだった。
 *
 *   Issue の表題が `access_token=<dummy>` → 本文にそのまま載る
 *   リポジトリの説明にトークンの形    → 本文にそのまま載る
 *
 * また、識別子のつもりで残していた値（labels・author・branch・path など）に
 * `sk_live_…` `npm_…` `glpat-…` を入れられた。**値の集合を数えられないものは
 * 残さない**方針へ変え、int / bool / enum だけにした。
 */
const VENDOR_TOKENS = {
  gitlab: ['gl', 'pat-', 'abcdefghijklmnopqrst'].join(''),
  openai: ['sk-', 'proj-', 'abcdefghijklmnopqrstuvwx'].join(''),
  stripe: ['sk_', 'live_', 'abcdefghijklmnopqrstuvwx'].join(''),
  npmToken: ['npm', '_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(''),
  shopify: ['shp', 'at_', 'abcdefghijklmnopqrstuvwx'].join(''),
  sendgrid: ['SG', '.', 'abcdefghijklmnop', '.', 'qrstuvwxyz012345'].join('')
};

/* 出て行くもの全部（URL・本文・intent）を1つに集める */
function outboundParts(url, title) {
  const s = GXS.buildShare(url, title);
  if (!s) return null;
  const parts = [s.url, s.text, s.intentUrl].map(String);
  const decoded = parts.map((x) => { try { return decodeURIComponent(x); } catch (e) { return x; } });
  return parts.concat(decoded).join('\n');
}

test('投稿本文に資格情報の形があれば、共有しない（R13-001）', () => {
  const cases = [
    ['Issueの表題が代入', 'https://github.com/o/r/issues/1', `access_token=${DUMMY} · Issue #1 · o/r`],
    ['PRの表題がコロン', 'https://github.com/o/r/pull/1', `client_secret:${DUMMY} · Pull Request #1 · o/r`],
    ['Discussionの表題', 'https://github.com/o/r/discussions/3', `api_key=${DUMMY} · Discussion #3 · o/r`],
    ['リポジトリ説明がトークン', 'https://github.com/o/r', `GitHub - o/r: ${DUMMY_TOKENS.github} · GitHub`],
    ['表題にGitLabのトークン', 'https://github.com/o/r/issues/2', `${VENDOR_TOKENS.gitlab} · Issue #2 · o/r`],
    ['表題にJWT', 'https://github.com/o/r/issues/3', `${DUMMY_TOKENS.jwt} · Issue #3 · o/r`]
  ];
  for (const [label, url, title] of cases) {
    assert.equal(GXS.buildShare(url, title), null, `共有できてしまう: ${label}`);
    const r = GXS.buildShareResult(url, title);
    assert.equal(r.ok, false, `${label}: ok になっている`);
    assert.equal(r.reason, 'credential_like', `${label}: 理由が違う`);
  }
});

test('普通の表題は、これまでどおり共有できる（対照）', () => {
  const keep = [
    ['普通のIssue', 'https://github.com/o/r/issues/12', 'Fix the parser · Issue #12 · o/r'],
    ['言及だけ', 'https://github.com/o/r/issues/13', 'How to use access_token · Issue #13 · o/r'],
    ['リポジトリ', 'https://github.com/o/r', 'GitHub - o/r: A small tool · GitHub'],
    ['記号を含む', 'https://github.com/o/r/issues/14', 'Support C++ 100% coverage · Issue #14 · o/r']
  ];
  for (const [label, url, title] of keep) {
    assert.ok(GXS.buildShare(url, title), `落としてはいけないものを落とした: ${label}`);
  }
});

test('ベンダのトークンの形は、URLでも本文でも出て行かない', () => {
  for (const [label, token] of Object.entries(VENDOR_TOKENS)) {
    const inPath = outboundParts(`https://github.com/o/r/blob/main/${token}`, 'T');
    assert.equal(inPath, null, `${label}: パスから出て行った`);
    const inTitle = outboundParts('https://github.com/o/r/issues/9', `${token} · Issue #9 · o/r`);
    assert.equal(inTitle, null, `${label}: 本文から出て行った`);
  }
});

test('値の集合を数えられないクエリは残さない（R13-001）', () => {
  /*
   * 以前は「識別子っぽい文字種」だけを見て残していたので、
   * labels=sk_live_… や author=npm_… がそのまま共有URLに載った。
   */
  const drop = [
    ['labels', `https://github.com/o/r/issues?labels=${VENDOR_TOKENS.stripe}`, 'labels='],
    ['author', `https://github.com/o/r/commits/main?author=${VENDOR_TOKENS.npmToken}`, 'author='],
    ['branch', `https://github.com/o/r/commits/main?branch=${VENDOR_TOKENS.gitlab}`, 'branch='],
    ['path', `https://github.com/o/r/commits/main?path=${VENDOR_TOKENS.openai}`, 'path='],
    ['milestone', 'https://github.com/o/r/issues?milestone=v1', 'milestone='],
    ['category', 'https://github.com/o/r/discussions?category=general', 'category='],
    ['template', 'https://github.com/o/r/compare/a...b?quick_pull=1&template=bug.md', 'template=']
  ];
  for (const [label, url, needle] of drop) {
    const out = String(GXS.canonicalUrl(url, null));
    assert.ok(!out.includes(needle), `${label} が残っている: ${out}`);
    assert.ok(!out.includes('sk_') && !out.includes('npm_') && !out.includes('glpat-'),
      `${label}: トークンが残っている`);
  }
  /* 数えられるものは残る（対照） */
  for (const [url, needle] of [
    ['https://github.com/o/r/issues?page=2&state=open', 'page=2'],
    ['https://github.com/o/r/pull/12/files?diff=split&w=1', 'diff=split'],
    ['https://github.com/search?type=code', 'type=code']
  ]) {
    assert.ok(String(GXS.canonicalUrl(url, null)).includes(needle), `落ちてはいけない: ${needle}`);
  }
});

test('型の表に残っているのは int / bool / enum だけ', () => {
  for (const [route, rules] of Object.entries(GXS.QUERY_RULES)) {
    if (!rules) continue;
    for (const [name, rule] of Object.entries(rules)) {
      assert.ok(['int', 'bool', 'enum'].includes(rule.type),
        `${route}.${name} の型が数えられない: ${rule.type}`);
    }
  }
});

test('資格情報の判定は、ほどける段数に上限がある（止まらなくならない）', () => {
  let deep = 'plain-text';
  for (let i = 0; i < 40; i++) deep = encodeURIComponent(deep);
  const t0 = Date.now();
  GXS.credentialLikeValue(deep);
  assert.ok(Date.now() - t0 < 1000, '判定が長すぎる');
});

/*
 * ============================================================
 * 第14回監査 R14-001 — 変換の前も見る／正規化してから照合する
 * ============================================================
 *
 * 1.1.8 の配布ZIP（inner SHA-256 5ecec372…）で、次がXの投稿画面まで届いた。
 * 値はすべてダミーで、実在の資格情報は使っていない。
 *
 *   ・Basic 認証つきURLを表題に置く
 *   ・;jsessionid= / PHPSESSID= / X-Amz-Signature= をパスに置く
 *   ・全角の ＝ ： や全角英字で書く
 *   ・長い表題の末尾にトークンを置き、**切り詰めでトークンを短くする**
 *   ・既知の形の途中にゼロ幅スペースを入れる
 */

/* 見えない文字。ソースにそのまま書くと読めないのでコードポイントで組み立てる */
const ZWSP = String.fromCharCode(0x200B);
const GH_TOKEN = ['gh', 'p_', 'a'.repeat(24)].join('');

test('Basic 認証つきURLを表題に置いても共有しない（R14-001）', () => {
  const title = `https://user:${DUMMY}@example.com · Issue #1 · o/r`;
  assert.equal(GXS.buildShare('https://github.com/o/r/issues/1', title), null);
  assert.equal(GXS.buildShareResult('https://github.com/o/r/issues/1', title).reason,
    'credential_like');
  /* 対照: 合言葉のない userinfo と、ただの @ を含むパスは共有できる */
  assert.ok(GXS.buildShare('https://github.com/o/r/issues/1',
    `https://user@example.com の話 · Issue #1 · o/r`), 'user@ だけで拒否している');
  assert.ok(GXS.buildShare('https://github.com/o/r/blob/main/a@b.txt', 'r/a@b.txt at main · o/r'),
    'a@b.txt を拒否している');
});

test('セッションIDと署名付きURLの名前をパスに置いても共有しない（R14-001）', () => {
  /* X-Amz-Signature は区切りを落とすと xamzsignature で、'signature' には当たらない */
  for (const seg of [`foo;jsessionid=${DUMMY}`, `PHPSESSID=${DUMMY}`,
                     `X-Amz-Signature=${DUMMY}`, `X-Amz-Credential=${DUMMY}`,
                     `AWSAccessKeyId=${DUMMY}`]) {
    const url = `https://github.com/o/r/blob/main/${seg}`;
    assert.equal(GXS.canonicalUrl(url, null), null, `パスが通ってしまう: ${seg}`);
    assert.equal(outboundParts(url, 'r/o at main · GitHub'), null, `共有できてしまう: ${seg}`);
  }
});

test('全角・ゼロ幅で崩した書き方も、正規化してから照合する（R14-001）', () => {
  const cases = [
    ['全角の等号', `access_token＝${DUMMY}`],
    ['全角のコロン', `access_token：${DUMMY}`],
    ['小字形の等号', `access_token﹦${DUMMY}`],
    ['全角の英字', `ａｃｃｅｓｓ＿ｔｏｋｅｎ=${DUMMY}`],
    ['トークンをゼロ幅で割る', `gh${ZWSP}p_${'a'.repeat(24)}`]
  ];
  for (const [label, payload] of cases) {
    const title = `${payload} · Issue #1 · o/r`;
    assert.equal(GXS.buildShare('https://github.com/o/r/issues/1', title), null,
      `共有できてしまう: ${label}`);
  }
  /* 対照: 全角のコロンを含む普通の日本語の表題は共有できる */
  assert.ok(GXS.buildShare('https://github.com/o/r/issues/1', '全角の日本語：コロン · Issue #1 · o/r'),
    '普通の日本語の表題を拒否している');
});

test('切り詰めでトークンが短くなっても、断片をXへ渡さない（R14-001）', () => {
  /*
   * 検査が切り詰めのあとだけだと、こちらの変換そのものが検出を外す。
   * 1.1.8 では prefix 211〜226 文字の16通りで断片が最終本文に残った（実測）。
   */
  const routes = [
    ['issue', 'https://github.com/o/r/issues/1', ' · Issue #1 · o/r'],
    ['repo', 'https://github.com/o/r', ' · GitHub'],
    ['discussion', 'https://github.com/o/r/discussions/1', ' · Discussion #1 · o/r']
  ];
  for (const [label, url, tail] of routes) {
    const leaks = [];
    for (let n = 150; n <= 280; n++) {
      const s = GXS.buildShare(url, `${'x'.repeat(n)} ${GH_TOKEN}${tail}`);
      if (s && s.text.includes(GH_TOKEN.slice(0, 4))) leaks.push(n);
    }
    assert.deepEqual(leaks, [], `${label}: 切り詰め後に断片が残る長さ ${leaks.length} 通り`);
  }
  /* 対照: 同じ長さでトークンを含まない表題は、これまでどおり共有できる */
  const plain = GXS.buildShare('https://github.com/o/r/issues/1',
    `${'x'.repeat(211)} ふつうの続き · Issue #1 · o/r`);
  assert.ok(plain && plain.text.length > 0, '長いだけの表題まで拒否している');
});

test('変換前の生のタイトルを見る入口がある（R14-001）', () => {
  assert.equal(GXS.credentialLikeInbound(`access_token=${DUMMY}`), 'credential_like');
  assert.equal(GXS.credentialLikeInbound('ふつうの表題'), null);
  assert.equal(GXS.credentialLikeInbound(''), null);
  assert.equal(GXS.credentialLikeInbound(null), null);
});

test('走査用の正規化は、出て行く文面を変えない（R14-001）', () => {
  /* 正規化はあくまで照合のため。全角の表題はそのままXへ渡す */
  const s = GXS.buildShare('https://github.com/o/r/issues/1', 'ＡＢＣ 全角の表題 · Issue #1 · o/r');
  assert.ok(s, '共有できていない');
  assert.ok(s.text.includes('ＡＢＣ'), `本文が正規化されてしまっている: ${s.text}`);
  assert.equal(GXS.normalizeForScan('ＡＢＣ'), 'ABC');
  assert.equal(GXS.normalizeForScan(`gh${ZWSP}p_x`), 'ghp_x');
});

test('普通のGitHubページは、これまでどおり共有できる（R14-001の逆方向の対照）', () => {
  const ordinary = [
    ['https://github.com/facebook/react', 'GitHub - facebook/react: The library · GitHub'],
    ['https://github.com/nodejs/node/issues/12345', 'Segfault in native module · Issue #12345 · nodejs/node'],
    ['https://github.com/rust-lang/rust/pull/9876', 'Fix ICE by ferris · Pull Request #9876 · rust-lang/rust'],
    ['https://github.com/o/r/blob/main/README.md?plain=1#L14', 'r/README.md at main · o/r · GitHub'],
    ['https://github.com/o/r/issues?state=open&page=2', 'Issues · o/r · GitHub'],
    ['https://github.com/o/r/issues/4', 'Add https://example.com to the docs · Issue #4 · o/r'],
    ['https://github.com/o/r/issues/5', 'git@github.com:o/r.git does not clone · Issue #5 · o/r'],
    ['https://github.com/o/r/issues/2', 'Emoji 🎉 in the title · Issue #2 · o/r']
  ];
  for (const [url, title] of ordinary) {
    assert.ok(GXS.buildShare(url, title), `共有できなくなっている: ${url}`);
  }
});
