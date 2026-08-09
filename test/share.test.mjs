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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers/load.mjs';
function readShareSource() {
  return readFileSync(join(ROOT, 'src/share.js'), 'utf8');
}


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

/* ============================================================
 * 出て行くものを、型で決める（第15回監査 R15-001）
 * ============================================================
 *
 * 第14回まで: タイトルとパスをそのままXへ渡し、資格情報の形を検出器で止める。
 * 第15回の実測でこの方式が両側から破れた（配布ZIP 376338a3… で再現）——
 * 定義の外にある現実的な形が37件通り、同時に普通の開発者向け表題4件を誤拒否した。
 *
 * 以下は新しい境界の検査。**タイトルは送らない／型で決まるルートだけ共有する。**
 */

test('共有URLが期待どおり（型で決まるルートだけ）', () => {
  for (const [label, input, want] of FIX.URLS) {
    assert.equal(GXS.canonicalUrl(input, null), want, `${label} / 入力=${input}`);
  }
});

test('フォールバック経路も同じ方針を使う', () => {
  for (const [label, input, want] of FIX.URLS) {
    assert.equal(GXS.fallbackUrl(input), want, `${label} / 入力=${input}`);
  }
});

test('buildShare の総合ケース', () => {
  for (const [label, url, want] of FIX.BUILD) {
    const got = GXS.buildShare(url);
    if (want.isNull) {
      assert.equal(got, null, `${label}: 共有できてしまう`);
      continue;
    }
    assert.ok(got, `${label}: 共有できていない`);
    assert.equal(got.kind, want.kind, label);
    assert.equal(got.text, want.text, label);
    assert.equal(got.url, want.url, label);
  }
});

test('ページのタイトルは、何を渡してもXへ渡らない（R15-001の核心）', () => {
  /*
   * 第2引数は受け取るが使わない。1.1.8 までは、ここに入った値が
   * そのまま投稿本文になっていた。
   */
  const url = 'https://github.com/o/r/issues/1';
  const base = GXS.buildShareResult(url);
  assert.ok(base.ok);
  const titles = [
    'Segfault when requiring native module · Issue #1 · o/r',
    'X-Api-Key: dummy-secret-value-1234567890 · Issue #1 · o/r',
    ['gh', 'p_', 'a'.repeat(24)].join('') + ' · Issue #1 · o/r',
    'How to parse key=value pairs · Issue #1 · o/r',
    '',
    null,
    undefined
  ];
  for (const t of titles) {
    const r = GXS.buildShareResult(url, t);
    assert.ok(r.ok, `共有できない: ${JSON.stringify(t)}`);
    assert.equal(r.share.text, base.share.text,
      `タイトルで本文が変わっている: ${JSON.stringify(t)}`);
    assert.equal(r.share.text, 'Issue #1 · o/r');
  }
});

test('本文に出てよいのは、リポジトリ名と整数・16進だけ（R15-001）', () => {
  const seen = [
    ['https://github.com/o/r', 'o/r'],
    ['https://github.com/o/r/issues/12', 'Issue #12 · o/r'],
    ['https://github.com/o/r/pull/12', 'PR #12 · o/r'],
    ['https://github.com/o/r/discussions/12', 'Discussion #12 · o/r'],
    ['https://github.com/o/r/issues', 'Issues · o/r'],
    ['https://github.com/o/r/pulls', 'Pull requests · o/r'],
    ['https://github.com/o/r/discussions', 'Discussions · o/r'],
    ['https://github.com/o/r/releases', 'Releases · o/r'],
    ['https://github.com/o/r/commit/' + 'ab'.repeat(20), 'Commit ababab a· o/r'.replace('ababab a', 'ababababab'.slice(0, 7) + ' ')]
  ];
  for (const [url, want] of seen) {
    const s = GXS.buildShare(url);
    assert.ok(s, `共有できていない: ${url}`);
    if (want) assert.equal(s.text, want, url);
    /* 本文に出てくる文字は、リポジトリ名の文字種・数字・16進・決まった語だけ */
    assert.ok(/^[A-Za-z0-9._\/#\- ·]+$/.test(s.text), `想定外の文字がある: ${s.text}`);
  }
});

test('認証・設定・管理画面は共有しない（RA-003 / R4-003 / T3-003 の回帰）', () => {
  const refuse = [
    'https://github.com/settings/tokens',
    'https://github.com/settings/applications',
    'https://github.com/login/oauth/authorize?client_id=abc&state=xyz',
    'https://github.com/orgs/acme/settings/secrets/actions',
    'https://github.com/account/billing',
    'https://github.com/sessions/two-factor',
    'https://github.com/%73ettings/tokens',
    'https://github.com/%2573ettings/tokens',
    'https://github.com/%25%32%35settings/tokens'
  ];
  for (const u of refuse) {
    assert.equal(GXS.canonicalUrl(u, null), null, `共有できてしまう: ${u}`);
    assert.equal(GXS.buildShare(u), null, `共有できてしまう: ${u}`);
    assert.equal(GXS.fallbackUrl(u), null, `フォールバックで漏れる: ${u}`);
  }
});

test('解けない・壊れたパスは共有しない（R8-003の回帰）', () => {
  for (const u of ['https://github.com/o/r/issues/%E4%B8%8D%E5',
                   'https://github.com/o/%ZZ/issues/1',
                   'https://github.com/o/r/issues/1%2F2']) {
    assert.equal(GXS.buildShare(u), null, `共有できてしまう: ${u}`);
  }
});

test('github.com 以外は共有対象にしない', () => {
  for (const u of ['https://example.com/o/r', 'http://github.com/o/r',
                   'https://github.com.evil.test/o/r', 'https://gist.github.com/o/r',
                   'not a url']) {
    assert.equal(GXS.buildShare(u), null, `共有できてしまう: ${u}`);
  }
});

test('組み立てたintentUrlがそのままパースできる', () => {
  for (const [, url, want] of FIX.BUILD) {
    if (want.isNull) continue;
    const s = GXS.buildShare(url);
    const u = new URL(s.intentUrl);
    assert.equal(u.origin + u.pathname, 'https://x.com/intent/post');
    assert.equal(u.searchParams.get('text'), s.text);
    assert.equal(u.searchParams.get('url'), s.url);
  }
});

test('投稿全体（本文+空白+URL）が280以下に収まる（切り詰めずに守る）', () => {
  /*
   * 本文は構造だけなので、最長でも上限に届かない。
   * 所有者39文字＋リポジトリ100文字＋いちばん長い前置き（Pull requests）で確かめる。
   */
  const owner = 'a'.repeat(39);
  const name = 'b'.repeat(100);
  const worst = [
    `https://github.com/${owner}/${name}/pulls`,
    `https://github.com/${owner}/${name}/discussions`,
    `https://github.com/${owner}/${name}/issues/1234567890`,
    `https://github.com/${owner}/${name}/commit/${'a'.repeat(40)}`
  ];
  let max = 0;
  for (const u of worst) {
    const s = GXS.buildShare(u);
    assert.ok(s, `最大の長さで共有できていない: ${u}`);
    const total = GXS.weightedLength(s.text) + 1 + GXS.URL_WEIGHT;
    max = Math.max(max, total);
    assert.ok(total <= GXS.MAX_WEIGHTED_TWEET, `${total} > ${GXS.MAX_WEIGHTED_TWEET}: ${u}`);
  }
  /* 余裕がありすぎて検査が形骸化していないかも見る（最大でも半分以下なら、その事実を残す） */
  assert.ok(max > 0 && max < GXS.MAX_WEIGHTED_TWEET,
    `最大 ${max} / 上限 ${GXS.MAX_WEIGHTED_TWEET}`);
});

test('上限を超えるなら、切り詰めずに共有しない', () => {
  /*
   * いまの型では到達しないが、境界の扱いを固定しておく。
   * 「超えたら切り詰める」に戻すと、その変換がまた検査を外しうる（R14-001の型）。
   */
  const src = readShareSource();
  assert.ok(/weightedLength\(text\) \+ 1 \+ URL_WEIGHT > MAX_WEIGHTED_TWEET\) return null;/.test(src),
    '上限を超えたときに共有しない、という書き方になっていない');
  assert.ok(!/function truncate\b/.test(src), '切り詰めが復活している');
});

test('資格情報の検出は、多層防御として残っている', () => {
  /*
   * 型で絞ったあとに残る自由度は、所有者名とリポジトリ名だけ。
   * リポジトリ名はトークンの形を取りうるので、出口の検査はここで効く。
   */
  const tokenLike = ['gh', 'p_', 'a'.repeat(24)].join('');
  const u = `https://github.com/o/${tokenLike}`;
  assert.equal(GXS.buildShare(u), null, 'トークンの形のリポジトリ名が出て行く');
  assert.equal(GXS.buildShareResult(u).reason, 'credential_like');
  /* 対照: 普通のリポジトリ名は共有できる */
  assert.ok(GXS.buildShare('https://github.com/o/my-repo_v2.0'), '普通の名前を拒否している');
});

test('判定の理由が、値を含まない決まった語で返る（R12-002）', () => {
  const cases = [
    ['https://example.com/o/r', 'unsupported'],
    ['not a url', 'malformed_url'],
    ['https://github.com/settings/tokens', 'sensitive_route'],
    ['https://github.com/o/r/blob/main/a.js', 'unsupported']
  ];
  const allowed = ['credential_like', 'sensitive_route', 'unsupported', 'malformed_url'];
  for (const [u, want] of cases) {
    const r = GXS.buildShareResult(u);
    assert.equal(r.ok, false, u);
    assert.equal(r.reason, want, u);
    assert.ok(allowed.includes(r.reason), `決まった語でない: ${r.reason}`);
    /* 理由にURLや値が混ざらない */
    assert.ok(!/[:/.]/.test(r.reason), `理由に記号が混ざっている: ${r.reason}`);
  }
});

test('自由文の名前は、どのページ種別の表にも載っていない', () => {
  for (const name of GXS.FREE_TEXT_PARAMS) {
    for (const [route, rules] of Object.entries(GXS.QUERY_RULES)) {
      if (!rules) continue;
      assert.ok(!(name in rules), `${route} に自由文 ${name} が載っている`);
    }
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

test('クエリの表に、共有できないルートが残っていない', () => {
  /*
   * 表にだけ残っていると「まだ共有できる」と読めてしまう。
   * 表のキーは、実際に共有できるルートと一致していること。
   */
  const reachable = ['repo', 'issue-list', 'pr-list', 'discussion-list', 'releases',
                     'issue', 'pr', 'discussion', 'commit'];
  assert.deepEqual(Object.keys(GXS.QUERY_RULES).sort(), reachable.slice().sort());
});

test('資格情報の判定は、ほどける段数に上限がある（止まらなくならない）', () => {
  let deep = 'plain-text';
  for (let i = 0; i < 40; i++) deep = encodeURIComponent(deep);
  const t0 = Date.now();
  GXS.credentialLikeValue(deep);
  assert.ok(Date.now() - t0 < 1000, '判定が長すぎる');
});

test('走査用の正規化は、出て行く文面を変えない', () => {
  assert.equal(GXS.normalizeForScan('ＡＢＣ'), 'ABC');
  assert.equal(GXS.normalizeForScan('gh' + String.fromCharCode(0x200B) + 'p_x'), 'ghp_x');
});

/* ============================================================
 * 第15回監査の46件を、そのまま当てる
 * ============================================================ */

const D15 = 'dummy-secret-value-1234567890';
const J = (...p) => p.join('');

/* 監査が「通過した」と報告した37件。値が最終出力へ出ないことを見る */
const R15_TITLE_PAYLOADS = [
  `X-Api-Key: ${D15}`, `Private-Token: ${D15}`, `personal_access_token=${D15}`,
  `AWS_SECRET_ACCESS_KEY=${D15}`, `AWS_SESSION_TOKEN=${D15}`, `AccountKey=${D15}`,
  `SharedAccessSignature=${D15}`, `SAMLResponse=${D15}`, `client_assertion=${D15}`,
  `authorization_code=${D15}`, `code_verifier=${D15}`, `Proxy-Authorization: Basic ${D15}`,
  `Set-Cookie: session=${D15}`, `remember_token=${D15}`, 'otp=123456',
  `recovery_code=${D15}`, `https://${D15}@example.com/private`,
  J('ya29', '.', D15), J('1//', D15), J('hf', '_', 'abcdefghijklmnopqrstuvwx'),
  J('rk', '_live_', 'abcdefghijklmnopqrstuvwx'), J('whsec', '_', 'abcdefghijklmnopqrstuvwx'),
  J('sq0atp', '-', 'abcdefghijklmnopqrstuvwx'),
  J('gh', String.fromCharCode(0xFE0F), 'p_', 'a'.repeat(24)),
  J('gh', String.fromCharCode(0x180B), 'p_', 'a'.repeat(24)),
  `access_token${String.fromCharCode(0x2236)}${D15}`,
  `access_token${String.fromCharCode(0xA789)}${D15}`,
  `access_token${String.fromCharCode(0x2254)}${D15}`,
  /* 既知の形（第14回までの対照） */
  `access_token=${D15}`, `https://user:${D15}@example.com`, `foo;jsessionid=${D15}`,
  J('gh', 'p_', 'a'.repeat(24))
];

test('タイトルに何を入れても、値は最終出力へ出ない（R15-001・監査の37件）', () => {
  const url = 'https://github.com/o/r/issues/1';
  for (const payload of R15_TITLE_PAYLOADS) {
    const r = GXS.buildShareResult(url, `${payload} · Issue #1 · o/r`);
    assert.ok(r.ok, `共有できない（誤拒否）: ${payload.slice(0, 30)}`);
    const surface = r.share.text + '\n' + r.share.intentUrl;
    const decoded = (() => {
      try { return decodeURIComponent(surface); } catch (e) { return surface; }
    })();
    for (const probe of [D15, 'abcdefghijklmnopqrstuvwx', 'a'.repeat(24), '123456']) {
      assert.ok(!surface.includes(probe) && !decoded.includes(probe),
        `値が出ている: ${payload.slice(0, 30)} → ${r.share.text}`);
    }
  }
});

test('パスに入れた資格情報のルートは、そもそも共有しない（R15-001・監査の9件）', () => {
  const segs = [`X-Api-Key=${D15}`, `Private-Token=${D15}`, `AWS_SECRET_ACCESS_KEY=${D15}`,
                `SAMLResponse=${D15}`, `client_assertion=${D15}`, `authorization_code=${D15}`,
                J('ya29', '.', D15), J('hf', '_', 'abcdefghijklmnopqrstuvwx'),
                J('whsec', '_', 'abcdefghijklmnopqrstuvwx')];
  for (const seg of segs) {
    for (const u of [`https://github.com/o/r/blob/main/${seg}`,
                     `https://github.com/o/r/tree/main/${seg}`,
                     `https://github.com/o/r/commits/${seg}`]) {
      assert.equal(GXS.buildShare(u), null, `共有できてしまう: ${u.slice(0, 60)}`);
    }
  }
});

test('普通の開発者向け表題を、誤って拒否しない（R15-001の逆方向）', () => {
  /*
   * 1.1.8 は次の4件を拒否していた。検出器を主たる境界にしていたため。
   * タイトルを見なくなったので、拒否する理由が無くなる。
   */
  const benign = ['How to parse key=value pairs', 'Token=placeholder in documentation',
                  'Fix signature= mismatch in parser', 'Support auth=none mode',
                  'Improve the retry logic'];
  for (const t of benign) {
    const r = GXS.buildShareResult('https://github.com/o/r/issues/1', `${t} · Issue #1 · o/r`);
    assert.ok(r.ok, `誤って拒否した: ${t}`);
  }
});

test('共有URLは、検査したパーツから組み直している（元のパスを素通ししない）', () => {
  /*
   * パーセントエンコードした形で来ても、出て行くのは組み直した素の形。
   * ここが素通しだと、型検査を通ったあとに元の文字列が復活する。
   */
  const s = GXS.buildShare('https://github.com/o/r/issues/%31%32');
  assert.ok(s, '共有できていない');
  assert.equal(s.url, 'https://github.com/o/r/issues/12', `素通ししている: ${s.url}`);
  assert.equal(s.text, 'Issue #12 · o/r');
  /* 大文字小文字や余分なスラッシュも、組み直した形になる */
  assert.equal(GXS.canonicalUrl('https://github.com/o/r/', null), 'https://github.com/o/r');
});

test('セグメントの数と型を1つずつ崩すと、共有できなくなる', () => {
  const ok = 'https://github.com/o/r/issues/12';
  assert.ok(GXS.buildShare(ok), '前提が崩れている');
  const broken = [
    'https://github.com/o/r/issues/12/timeline',   // セグメントが5つ
    'https://github.com/o/r/issue/12',             // 語が違う
    'https://github.com/o/r/issues/012',           // 先頭ゼロ
    'https://github.com/o/r/issues/-1',            // 負
    'https://github.com/o/r/issues/12345678901',   // 桁が多すぎる
    'https://github.com/o/r/commit/' + 'g'.repeat(40),  // 16進でない
    'https://github.com/o/r/commit/' + 'a'.repeat(39),  // 桁が足りない
    'https://github.com/-o/r/issues/12',           // 所有者名がハイフン始まり
    'https://github.com/o/r@x/issues/12'           // リポジトリ名に @
  ];
  for (const u of broken) assert.equal(GXS.buildShare(u), null, `共有できてしまう: ${u}`);
});

test('素の % を含む普通のページを、拒否しない（R12-002の回帰）', () => {
  /*
   * 第12回で、`?q=100%25 coverage` のような素の % を含む検索を拒否していた
   * （decodeURIComponent が投げるため）。クエリを型で絞ったいまも、
   * 「解けない % があるとページごと拒否する」に戻っていないことを見る。
   * 第15回の書き換えでこの回帰テストを落としていたので、新しい形で戻した。
   */
  for (const u of ['https://github.com/o/r/issues?q=100%25+coverage',
                   'https://github.com/o/r/issues?q=100%+coverage',
                   'https://github.com/o/r/issues?state=open&q=50%25']) {
    const s = GXS.buildShare(u);
    assert.ok(s, `拒否している: ${u}`);
    assert.ok(!s.url.includes('%25') && !s.url.includes('q='), `検索語が残っている: ${s.url}`);
  }
  /* 対照: パスの側で解けない % は、いまも拒否する */
  assert.equal(GXS.buildShare('https://github.com/o/r/issues/%ZZ'), null,
    'パスの壊れたエスケープを通している');
});
