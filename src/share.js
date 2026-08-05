/*
 * share.js — 共有テキストとX投稿URLの組み立て
 *
 * 設計方針: DOMを一切見ない。URL と document.title だけで動く。
 * これにより GitHub のUI改修・ログイン状態の違いの影響を受けない。
 * content script と service worker の両方から同じ実装を使う。
 */
(function (root) {
  'use strict';

  /* ============================================================
   * 1. Xの重み付き文字数（twitter-text v3 config 準拠）
   * ============================================================
   *
   * 公式の数え方は「既定の重みは2。下記の範囲だけ1」であって、
   * 「既定1・CJKだけ2」ではない。旧実装は後者だったため、
   * 半角カタカナ・矢印・記号・ラテン拡張などを1と数えて**少なく**見積もり、
   * 280を超える文面を作りうる状態だった（2026-08-04の監査で再現）。
   *
   * 出典: twitter-text v3 config
   *   defaultWeight = 200 / scale = 100 → 実効2
   *   weight 100（実効1）の範囲は下の WEIGHT_ONE_RANGES と同一
   *   maxWeightedTweetLength = 280 / transformedURLLength = 23
   *   emojiParsingEnabled = true → 絵文字は1連結ぶんで重み2
   */
  var MAX_WEIGHTED_TWEET = 280;   // 本文全体の上限
  var URL_WEIGHT = 23;            // t.co 変換後の固定長
  var DEFAULT_WEIGHT = 2;
  var WEIGHT_ONE_RANGES = [
    [0x0000, 0x10FF],
    [0x2000, 0x200D],
    [0x2010, 0x201F],
    [0x2032, 0x2037]
  ];

  /*
   * 本文に使える上限。
   * Xの投稿画面は「本文 + 半角空白 + URL」で構成されるので、
   * 使える重みは 280 - 1(空白) - 23(URL) = 256。
   *
   * 256ではなく250にしているのは、絵文字の区切り方（grapheme cluster）が
   * twitter-text の絵文字正規表現と完全一致する保証がないため。
   * 1つずれても最大2しか動かないので、6の余白で3連結ぶんを吸収する。
   * 余白が正しいことは test/share.test.mjs の「合計280以下」で機械的に検査している。
   */
  var MAX_WEIGHT = 250;

  /*
   * github.com/<第1セグメント> のうち、ユーザー/組織名ではなくGitHubの機能ページであるもの。
   * これを弾かないと /orgs/community/discussions/123 を
   * 「orgs/community というリポジトリのDiscussion」と誤判定し、
   * 存在しないリポジトリ名を投稿してしまう。
   */
  var RESERVED_OWNERS = [
    'orgs', 'settings', 'notifications', 'marketplace', 'features', 'topics',
    'sponsors', 'collections', 'explore', 'trending', 'search', 'apps',
    'codespaces', 'new', 'about', 'pricing', 'enterprise', 'login', 'logout',
    'join', 'site', 'account', 'dashboard', 'stars', 'watching', 'issues',
    'pulls', 'discussions', 'security', 'events', 'sessions', 'organizations'
  ];

  /*
   * 認証・アカウント系。ここのURLはクエリもハッシュも共有しない。
   * 例: /login/oauth/authorize?client_id=...&state=...
   *     /settings/tokens?token=...
   * 「共有される可能性がある形」で残さないことを優先する。
   */
  var SENSITIVE_FIRST_SEGMENTS = [
    'login', 'logout', 'session', 'sessions', 'settings', 'account', 'user',
    'signup', 'join', 'password_reset', 'auth', 'oauth', 'authorize', 'devices',
    'sudo', 'two_factor', 'verify', 'billing', 'organizations', 'enterprises',
    'invitations', 'account_verifications', 'password', 'security'
  ];

  /* /orgs/<org>/... のうち管理系。組織トップやDiscussionは対象外 */
  var SENSITIVE_ORG_SECTIONS = [
    'settings', 'billing', 'security', 'people', 'teams', 'sso', 'saml',
    'audit-log', 'secrets', 'security-analysis', 'oauth_application_policy'
  ];

  /*
   * 値の中身に関わらず、名前だけで落とすパラメータ（多重防御）。
   * allowlistに載っていない名前はどのみち落ちるので、ここは保険。
   *
   * code / state はOAuthで使われるが、GitHubのIssue一覧の state=open のように
   * 普通の意味でも使う名前なので入れない。認証系URLは route='sensitive' 側で
   * クエリごと落としており、そちらが本線。
   */
  var SENSITIVE_PARAM_RE =
    /(^|[-_])(token|secret|password|passwd|pwd|session|signature|sig|apikey|key|credential|auth|otp|jwt|nonce|client_id|client_secret)([-_]|$)/i;

  /* 追跡・通知由来のノイズ。allowlistに載っていないので実際は保険 */
  var TRACKING_PARAMS = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'gclid', 'fbclid', 'mc_cid', 'mc_eid', '_gl',
    'ref', 'ref_src', 'ref_url', 'referrer',
    'notification_referrer_id', 'email_source', 'email_token', 'tab'
  ];

  /*
   * ページ種別ごとに「意味を持つので残すクエリ」。
   * ここに無い名前はすべて落とす（unknown は落とす、が方針）。
   * null は「クエリもハッシュも落とす」を意味する。
   */
  var QUERY_ALLOW = {
    'sensitive': null,
    'root': [],
    'user': ['tab'],
    'search': ['q', 'type', 's', 'o', 'l', 'p'],
    'repo': [],
    'issue-list': ['q', 'page', 'sort', 'direction', 'state', 'labels', 'milestone', 'assignee', 'author', 'type'],
    'pr-list': ['q', 'page', 'sort', 'direction', 'state', 'labels', 'milestone', 'assignee', 'author'],
    'discussion-list': ['discussions_q', 'category', 'q', 'page'],
    'issue': [],
    'pr': ['diff', 'w'],
    'discussion': [],
    'blob': ['plain'],
    'tree': [],
    'compare': ['quick_pull', 'title', 'body', 'labels', 'milestone', 'assignees', 'projects', 'template', 'expand', 'diff', 'w'],
    'commits': ['author', 'since', 'until', 'path', 'branch'],
    'commit': ['diff', 'w'],
    'actions': ['query', 'page'],
    'releases': ['page'],
    'wiki': [],
    'repo-sub': [],
    'other': []
  };

  /* ハッシュ自体が資格情報を運ぶ形（implicit OAuth 等）なら捨てる */
  var SENSITIVE_HASH_RE = /(^|[#&])(access_token|id_token|token|code|state)=/i;

  function inWeightOneRange(cp) {
    for (var i = 0; i < WEIGHT_ONE_RANGES.length; i++) {
      if (cp >= WEIGHT_ONE_RANGES[i][0] && cp <= WEIGHT_ONE_RANGES[i][1]) return true;
    }
    return false;
  }

  function codePointWeight(cp) {
    return inWeightOneRange(cp) ? 1 : DEFAULT_WEIGHT;
  }

  var VS16 = 0xFE0F;
  var KEYCAP = 0x20E3;
  var RI_START = 0x1F1E6;
  var RI_END = 0x1F1FF;
  var EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

  /*
   * 1つの grapheme cluster が「絵文字1個」として重み2で数えられるか。
   *
   * © (U+00A9) のように、絵文字表現にも文字表現にもなる文字があるため、
   * 単に Extended_Pictographic を見るだけでは判定できない。
   *  - VS16(U+FE0F) が付く      → 絵文字表示なので2
   *  - キーキャップ(U+20E3)      → 2
   *  - 地域表示記号2つ（国旗）    → 2
   *  - BMP外の絵文字            → 2（ZWJ連結・肌色つきも1連結で2）
   * それ以外は文字として1コードポイントずつ数える（© は1のまま）。
   */
  function isEmojiCluster(cluster) {
    var cps = [];
    for (var ch of cluster) cps.push(ch.codePointAt(0));
    if (cps.indexOf(VS16) !== -1) return true;
    if (cps.indexOf(KEYCAP) !== -1) return true;
    if (cps.length >= 2 && cps[0] >= RI_START && cps[0] <= RI_END) return true;
    for (var i = 0; i < cps.length; i++) {
      var cp = cps[i];
      /*
       * BMP内の絵文字も見る。以前は `cp > 0xFFFF` を条件にしていたため、
       * ✊🏽（U+270A + 肌色修飾子）や ☝🏽 を「絵文字ではない2文字」として
       * 4と数えていた（2026-08-05の再監査で再現）。
       *
       * 肌色修飾子そのものを条件に足すことも考えたが、ベース側が
       * Extended_Pictographic なので結果が変わらない（＝死にコードになる）。
       * 変異テストで検出できなかったので置いていない。
       */
      if (EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(cp))) {
        // © のように単独では文字として表示されるものは、重み1のまま
        if (cps.length === 1 && inWeightOneRange(cp)) return false;
        return true;
      }
    }
    return false;
  }

  var segmenter = null;
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    }
  } catch (e) {
    segmenter = null;
  }

  /* 書記素（見た目の1文字）単位に分ける。使えない環境ではコードポイント単位に落ちる */
  function graphemes(text) {
    if (segmenter) {
      var out = [];
      for (var seg of segmenter.segment(text)) out.push(seg.segment);
      return out;
    }
    return Array.from(text);
  }

  function normalizeNFC(text) {
    try {
      return (text || '').normalize('NFC');
    } catch (e) {
      return text || '';
    }
  }

  /*
   * 本文中の「URLとして数えるべきトークン」を切り出す。
   * Xは長さによらずURLを23として数えるので、ここも23で数える。
   *
   * ⚠️ スキームの無いドメインもXはリンクとして扱う。
   * 旧実装は http(s):// と www. だけを見ていたため、`a.co` を50個並べた文面を
   * 249と数えて切り詰めず、X側では1199相当になって投稿できなかった
   * （2026-08-05の再監査で再現）。
   *
   * 有効なTLDの一覧は持たない。「ドットを含み、最後がアルファベット2文字以上」なら
   * すべてURLとして数える。公式より**多めに数えることはあっても、少なく数えない**。
   * 少なく数える方向だけが「Xに弾かれる文面を作る」事故につながるため。
   * 例: `index.js` は公式なら8だがここでは23。切り詰めが少し早まるだけで害はない。
   */
  var URL_TOKEN_RE = /^(?:https?:\/\/)?[^\s.@][^\s]*\.[A-Za-z]{2,}(?:[:\/?#][^\s]*)?$/;
  var LEADING_PUNCT_RE = /^[([<「（【“"'‘]*/;
  var TRAILING_PUNCT_RE = /[)\]>」）】”"'’.,;:!?、。…]+$/;

  function splitUrls(text) {
    var parts = [];
    var last = 0;
    var re = /\S+/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var raw = m[0];
      var lead = raw.match(LEADING_PUNCT_RE)[0].length;
      var core = raw.slice(lead).replace(TRAILING_PUNCT_RE, '');
      if (!core || !URL_TOKEN_RE.test(core)) continue;
      var start = m.index + lead;
      if (start > last) parts.push({ type: 'text', value: text.slice(last, start) });
      parts.push({ type: 'url', value: core });
      last = start + core.length;
    }
    if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
    return parts;
  }

  /* 公式準拠の重み付き文字数 */
  function weightedLength(text) {
    var s = normalizeNFC(text);
    var parts = splitUrls(s);
    var w = 0;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === 'url') {
        w += URL_WEIGHT;
        continue;
      }
      var gs = graphemes(parts[i].value);
      for (var g = 0; g < gs.length; g++) {
        if (isEmojiCluster(gs[g])) {
          w += DEFAULT_WEIGHT;
          continue;
        }
        for (var ch of gs[g]) w += codePointWeight(ch.codePointAt(0));
      }
    }
    return w;
  }

  var ELLIPSIS = '…';

  /*
   * 重み budget に収まるところまで取り出す（末尾の「…」は付けない）。
   *
   * 切る単位は書記素（grapheme cluster）。コードポイント単位で切ると
   * 肌色つき絵文字やZWJ連結の途中で割れて、見た目が壊れた文字が残る。
   * さらにUTF-16単位（text.slice）で切るとサロゲートペアが分断され、
   * encodeURIComponent が URIError を投げて共有機能が丸ごと無反応になる
   * （v1.0.0 で実測した事故。ここは絶対に戻さない）。
   *
   * URLは23として数えるので、途中で切らず「丸ごと入るか入らないか」で扱う。
   */
  function takeToWeight(text, budget) {
    var parts = splitUrls(text);
    var acc = 0;
    var out = '';

    outer:
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === 'url') {
        if (acc + URL_WEIGHT > budget) break outer;
        acc += URL_WEIGHT;
        out += parts[i].value;
        continue;
      }
      var gs = graphemes(parts[i].value);
      for (var g = 0; g < gs.length; g++) {
        var w = 0;
        if (isEmojiCluster(gs[g])) {
          w = DEFAULT_WEIGHT;
        } else {
          for (var ch of gs[g]) w += codePointWeight(ch.codePointAt(0));
        }
        if (acc + w > budget) break outer;
        acc += w;
        out += gs[g];
      }
    }
    return out;
  }

  function truncate(text) {
    var s = normalizeNFC(text);
    if (weightedLength(s) <= MAX_WEIGHT) return s;
    return takeToWeight(s, MAX_WEIGHT - weightedLength(ELLIPSIS)).replace(/\s+$/, '') + ELLIPSIS;
  }

  /*
   * 可変のタイトルと、固定のサフィックス「 (Issue #123 · owner/repo)」を分けて扱う。
   *
   * 旧実装は連結してから末尾を切っていたので、長いタイトルでは
   * 識別に最も効くサフィックス（種別・番号・リポジトリ名）が真っ先に消えていた
   * （2026-08-05の再監査で再現）。サフィックスぶんを先に確保してから、
   * 可変のタイトル側だけを削る。
   */
  function truncateWithSuffix(title, suffix) {
    var t = normalizeNFC(title);
    var sfx = normalizeNFC(suffix || '');
    var sw = weightedLength(sfx);
    if (weightedLength(t) + sw <= MAX_WEIGHT) return t + sfx;
    // サフィックス単独で上限に達する異常時は、サフィックス側を優先して切り詰める
    if (sw + weightedLength(ELLIPSIS) >= MAX_WEIGHT) return truncate(sfx.replace(/^\s+/, ''));
    var budget = MAX_WEIGHT - sw - weightedLength(ELLIPSIS);
    return takeToWeight(t, budget).replace(/\s+$/, '') + ELLIPSIS + sfx;
  }

  /* ============================================================
   * 2. URLの正規化（ページ種別ごとの方針）
   * ============================================================ */

  /* URLからページ種別を判定する。github.com 以外は null を返す。 */
  function parseLocation(rawUrl) {
    var u;
    try {
      u = new URL(rawUrl);
    } catch (e) {
      return null;
    }
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') return null;

    var seg = u.pathname.split('/').filter(Boolean);
    if (seg.length < 2) return { kind: 'other', repo: null, number: null };
    if (RESERVED_OWNERS.indexOf(seg[0].toLowerCase()) !== -1) {
      return { kind: 'other', repo: null, number: null };
    }

    var repo = seg[0] + '/' + seg[1];
    if (seg.length === 2) return { kind: 'repo', repo: repo, number: null };

    var third = seg[2];
    var num = seg[3] || '';
    if (third === 'issues' && /^\d+$/.test(num)) return { kind: 'issue', repo: repo, number: num };
    if (third === 'pull' && /^\d+$/.test(num)) return { kind: 'pr', repo: repo, number: num };
    if (third === 'discussions' && /^\d+$/.test(num)) return { kind: 'discussion', repo: repo, number: num };
    if (third === 'releases') return { kind: 'release', repo: repo, number: null };
    return { kind: 'repo-sub', repo: repo, number: null };
  }

  /*
   * クエリの扱いを決めるためのルート判定。
   * parseLocation（投稿文面のための種別）とは目的が違うので分けている。
   * 例: /o/r/issues は文面上は repo-sub だが、クエリ方針では issue-list。
   */
  function routeOf(u) {
    var seg = u.pathname.split('/').filter(Boolean);
    if (!seg.length) return 'root';

    var s0 = seg[0].toLowerCase();
    if (SENSITIVE_FIRST_SEGMENTS.indexOf(s0) !== -1) return 'sensitive';
    // /orgs/<org>/settings のような組織の管理画面
    if (s0 === 'orgs' && seg.length >= 3 &&
        SENSITIVE_ORG_SECTIONS.indexOf(seg[2].toLowerCase()) !== -1) return 'sensitive';
    if (s0 === 'search') return 'search';
    if (seg.length === 1) return RESERVED_OWNERS.indexOf(s0) !== -1 ? 'other' : 'user';
    if (RESERVED_OWNERS.indexOf(s0) !== -1) return 'other';
    if (seg.length === 2) return 'repo';

    var s2 = seg[2].toLowerCase();
    var n3 = seg[3] || '';
    if (s2 === 'settings') return 'sensitive';
    if (s2 === 'issues') return /^\d+$/.test(n3) ? 'issue' : 'issue-list';
    if (s2 === 'pull') return 'pr';
    if (s2 === 'pulls') return 'pr-list';
    if (s2 === 'discussions') return /^\d+$/.test(n3) ? 'discussion' : 'discussion-list';
    if (s2 === 'labels' || s2 === 'milestones' || s2 === 'projects') return 'issue-list';
    if (s2 === 'blob') return 'blob';
    if (s2 === 'tree') return 'tree';
    if (s2 === 'compare') return 'compare';
    if (s2 === 'commits') return 'commits';
    if (s2 === 'commit') return 'commit';
    if (s2 === 'actions') return 'actions';
    if (s2 === 'releases' || s2 === 'tags') return 'releases';
    if (s2 === 'wiki') return 'wiki';
    return 'repo-sub';
  }

  /*
   * 認証・設定・管理画面かどうか。
   *
   * これらのページはクエリを落としてもタイトルとパスが残り、
   * 「Personal access tokens」「Actions secrets」といった文字列を
   * Xの下書きへ送ることになる。共有機能の通常の目的から外れるので、
   * 何も開かない（＝判断がつかないときは共有しない側へ倒す）。
   */
  function isSensitiveUrl(rawUrl) {
    var u;
    try {
      u = new URL(rawUrl);
    } catch (e) {
      return false;
    }
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') return false;
    return routeOf(u) === 'sensitive';
  }

  function keepParam(route, name) {
    var allow = QUERY_ALLOW[route];
    if (!allow) return false;                                   // null（機微）と未定義は全落とし
    if (SENSITIVE_PARAM_RE.test(name)) return false;            // 多重防御
    if (TRACKING_PARAMS.indexOf(name.toLowerCase()) !== -1 && route !== 'user') return false;
    return allow.indexOf(name) !== -1;
  }

  /*
   * 共有するURLを整える。
   *
   * 方針（QUERY_ALLOW が正本）:
   *  - 各ページ種別で「意味を持つクエリ」だけ残す。知らないクエリは落とす
   *  - 認証・設定系はクエリもハッシュも落とす
   *  - リポジトリトップはクエリ・ハッシュとも落として正規形にする
   *  - #L10-L20 や #issuecomment-123 は共有したい情報そのものなので残す
   *  - 資格情報の形をしたハッシュは落とす
   *
   * 第2引数 info は後方互換のために受け取るが、判定には使わない
   * （フォールバック経路が別実装にならないよう、入口を1つに保つため）。
   */
  function canonicalUrl(rawUrl, info) {
    var u;
    try {
      u = new URL(rawUrl);
    } catch (e) {
      // 解析できないものは、クエリ・ハッシュを機械的に落とすだけに留める
      return String(rawUrl).split('#')[0].split('?')[0];
    }

    // github.com 以外（http、他ホスト）は素の形だけ返す
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') {
      return u.origin + u.pathname;
    }

    var route = routeOf(u);
    var path = u.pathname;
    if (route === 'repo' || route === 'root') path = path.replace(/\/$/, '');

    var kept = [];
    if (QUERY_ALLOW[route]) {
      u.searchParams.forEach(function (value, name) {
        if (keepParam(route, name)) kept.push([name, value]);
      });
    }

    var qs = '';
    if (kept.length) {
      var sp = new URLSearchParams();
      kept.forEach(function (kv) { sp.append(kv[0], kv[1]); });
      qs = '?' + sp.toString();
    }

    var hash = u.hash || '';
    if (route === 'repo' || route === 'root' || route === 'sensitive') hash = '';
    if (hash && SENSITIVE_HASH_RE.test(hash)) hash = '';

    return u.origin + path + qs + hash;
  }

  /*
   * 文面の組み立てが失敗したときに使う、URLだけの共有先。
   * content script と service worker の両方がこれを呼ぶ。
   * ここで split('?')[0] のような独自処理を書くと方針が二重化するので書かない。
   */
  function fallbackUrl(rawUrl) {
    if (isSensitiveUrl(rawUrl)) return null;   // 例外時の逃げ道から機微ページが漏れないようにする
    try {
      return canonicalUrl(rawUrl, null);
    } catch (e) {
      return String(rawUrl).split('#')[0].split('?')[0];
    }
  }

  function intentUrlFor(text, url) {
    var base = 'https://x.com/intent/post?';
    if (!text) return base + 'url=' + encodeURIComponent(url);
    return base + 'text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(url);
  }

  /* ============================================================
   * 3. 文面の組み立て
   * ============================================================ */

  /*
   * 区切り文字より前を取り出す。
   * split[0] ではなく lastIndexOf を使う理由: タイトル自体が
   * " · Issue #" のような文字列を含んでいても途中で切れないようにするため。
   */
  function cutBefore(text, marker) {
    var i = text.lastIndexOf(marker);
    return i === -1 ? text : text.slice(0, i);
  }

  function stripGitHubSuffix(text) {
    return text.replace(/\s*·\s*GitHub\s*$/, '').trim();
  }

  /* document.title からページ種別ごとに本文を取り出す。 */
  function cleanTitle(kind, rawTitle) {
    var t = (rawTitle || '').trim();
    if (!t) return '';

    switch (kind) {
      case 'repo':
      case 'repo-sub':
      case 'release':
        // "GitHub - owner/repo: 説明 · GitHub"
        return stripGitHubSuffix(t.replace(/^GitHub\s+-\s+/, ''));

      case 'issue':
        // "タイトル · Issue #123 · owner/repo"
        return stripGitHubSuffix(cutBefore(t, ' · Issue #'));

      case 'pr':
        // "タイトル by author · Pull Request #123 · owner/repo"
        return stripGitHubSuffix(cutBefore(t, ' · Pull Request #').replace(/\s+by\s+[^\s]+\s*$/, ''));

      case 'discussion':
        // "タイトル · Discussion #123 · owner/repo"
        return stripGitHubSuffix(cutBefore(t, ' · Discussion #'));

      default:
        return stripGitHubSuffix(t);
    }
  }

  /*
   * 本体。url と title から投稿用の文面とXのURLを作る。
   * github.com 以外なら null。
   *
   * 注: Open / Merged / Closed の状態ラベルは意図的に含めない。
   * ログイン状態とログアウト状態で取得値が食い違う（同一PRが Merged / Open）
   * 事象を実測しており、誤った状態を投稿するリスクを避けるため。
   */
  function buildShare(rawUrl, rawTitle) {
    var info = parseLocation(rawUrl);
    if (!info) return null;
    if (isSensitiveUrl(rawUrl)) return null;   // 認証・設定・管理画面は共有しない

    var url = canonicalUrl(rawUrl, info);
    var title = cleanTitle(info.kind, rawTitle);
    var suffix = '';

    if (info.kind === 'issue') {
      suffix = ' (Issue #' + info.number + ' · ' + info.repo + ')';
    } else if (info.kind === 'pr') {
      suffix = ' (PR #' + info.number + ' · ' + info.repo + ')';
    } else if (info.kind === 'discussion') {
      suffix = ' (Discussion #' + info.number + ' · ' + info.repo + ')';
    }

    // タイトルが取れなかった場合は repo 名、それも無ければURLで代替する
    var base = title.trim();
    if (!base && !suffix) base = info.repo || url;
    var text = base ? truncateWithSuffix(base, suffix) : truncate(suffix.trim());

    return {
      kind: info.kind,
      repo: info.repo,
      number: info.number,
      text: text,
      url: url,
      intentUrl: intentUrlFor(text, url)
    };
  }

  root.GXS = {
    buildShare: buildShare,
    parseLocation: parseLocation,
    cleanTitle: cleanTitle,
    canonicalUrl: canonicalUrl,
    fallbackUrl: fallbackUrl,
    isSensitiveUrl: isSensitiveUrl,
    truncateWithSuffix: truncateWithSuffix,
    intentUrlFor: intentUrlFor,
    routeOf: routeOf,
    weightedLength: weightedLength,
    truncate: truncate,
    MAX_WEIGHT: MAX_WEIGHT,
    MAX_WEIGHTED_TWEET: MAX_WEIGHTED_TWEET,
    URL_WEIGHT: URL_WEIGHT
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
