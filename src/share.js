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

  /*
   * ハッシュ（fragment）の安全化。
   *
   * 以前は `access_token=` など決め打ちの名前だけを見ていたため、
   * `#client_secret=` `#password=` `#api_key=` `#session_token=`
   * `#oauth_token=` `#refresh_token=` が素通りしていた
   * （2026-08-05の第3回監査で再現）。fragment は通常のHTTP要求では
   * サーバーへ送られないが、この拡張はURL全体をXの投稿画面へ渡すので、
   * 残せばそのまま第三者へ送られる。
   *
   * 名前を数え上げる代わりに、**`=` を含むfragmentを名前によらず捨てる**。
   * GitHubが作る見出し・行番号・コメントのアンカー（#readme、#L10-L20、
   * #issuecomment-123、日本語見出しのパーセントエンコード）に `=` は出てこない。
   * クエリ側の資格情報判定より広く、取りこぼしが原理的に出ない。
   *
   * 長さの上限は、実用的なURL長（ブラウザ実装で概ね2000文字前後が下限）に対して
   * 十分に余裕を見た値。日本語の見出しはパーセントエンコードで1文字9バイト相当に
   * なるため、旧実装の64文字では「インストールと初期設定」（100文字）すら
   * 落ちていた。
   */
  var FRAGMENT_MAX = 512;

  function sanitizeFragment(hash) {
    if (!hash) return '';
    var raw = hash.charAt(0) === '#' ? hash.slice(1) : hash;
    if (!raw) return '';
    if (raw.length > FRAGMENT_MAX) return '';
    if (/[\u0000-\u001F\u007F\s]/.test(raw)) return '';
    var decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch (e) {
      return '';                                  // 壊れたエンコードは判定できない＝載せない
    }
    /*
     * 第7回監査 R7-001。1回解いた形だけで判定していたため、
     * `#client_secret%253Ddummy`（二重エンコード）は解いても `%3D` のままで、
     * 「= を含まない」と判定されてそのままXへ渡っていた。
     *
     * 解いた結果が**まだ解ける形**なら、中身が何なのかこちらでは判定できない。
     * 判定できないものは載せない。何重にエンコードされていても、この1つの規則で落ちる。
     * （パス側は同じ問題を第4回で塞いだのに、フラグメント側が残っていた）
     */
    if (decoded.indexOf('%') !== -1) {
      try {
        if (decodeURIComponent(decoded) !== decoded) return '';
      } catch (e) {
        return '';
      }
    }
    if (/[\u0000-\u001F\u007F\s]/.test(decoded)) return '';
    if (raw.indexOf('=') !== -1 || decoded.indexOf('=') !== -1) return '';
    return '#' + raw;
  }

  /*
   * パスのセグメントを、判定に使える形へ直す。
   *
   * ルート判定を生の文字列比較でやっていたため、`/%73ettings/tokens` が
   * 設定ページと見なされず共有できてしまっていた（同監査で再現）。
   * デコードしてから判定する。デコードできない・区切り文字や制御文字が
   * 出てくる場合は判定不能として null を返し、呼び出し側で共有しない側へ倒す。
   */
  var MAX_DECODE_ROUNDS = 5;

  function pathSegments(u) {
    var raw = u.pathname.split('/').filter(Boolean);
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      /*
       * 1回だけデコードしていたため、`/%2573ettings/tokens`（二重エンコード）が
       * `%73ettings` までしか戻らず、機微ページの拒否を素通りしていた
       * （2026-08-05の第4回監査で再現）。変化がなくなるまで解く。
       * 何度解いても終わらないものは、判定できないものとして扱う。
       */
      var d = raw[i];
      // 壊れたエンコード（%ZZ など）は、解ける形になっていない＝判定できない
      if (d.indexOf('%') !== -1) {
        try {
          decodeURIComponent(d);
        } catch (e) {
          return null;
        }
      }
      var rounds = 0;
      while (/%[0-9A-Fa-f]{2}/.test(d)) {
        if (rounds >= MAX_DECODE_ROUNDS) return null;
        var next;
        try {
          next = decodeURIComponent(d);
        } catch (e) {
          return null;
        }
        if (next === d) break;
        d = next;
        rounds++;
      }
      if (/[\u0000-\u001F\u007F\/\\]/.test(d)) return null;
      out.push(d);
    }
    return out;
  }

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
   * URLらしき最短の並び。ラベルとTLDだけを見て、パスやクエリは含めない。
   *
   * TLDを「2文字以上のUnicode文字」の最短一致にしているのは、
   * **短く見積もるほど安全**だから。Xは認識したURLを23として数えるので、
   * URLだと見なす範囲を短く取れば、残りを素の文字として数えるぶん
   * 合計は増える。公式より多く数える方向にしか外れない。
   */
  var URL_CANDIDATE_RE = /(?:https?:\/\/)?[^\s\/?#@:.]+\.\p{L}{2,}?/gu;

  /* 素の文字として数える（URLの扱いを一切しない） */
  function literalWeight(text) {
    var gs = graphemes(text);
    var w = 0;
    for (var g = 0; g < gs.length; g++) {
      if (isEmojiCluster(gs[g])) {
        w += DEFAULT_WEIGHT;
        continue;
      }
      for (var ch of gs[g]) w += codePointWeight(ch.codePointAt(0));
    }
    return w;
  }

  /*
   * Xの重み付き文字数。
   *
   * Xがどこをリンクと見なすかは、こちらからは確定できない。
   * そこで「URL候補の取りうる区切り方すべて」の中から、合計が最大になる
   * 解釈を選ぶ。狙いは、公式がどの解釈を採ってもこちらが下回らないようにすること。
   * 実際に確かめてあるのは、固定した公式コーパスの文字数対象節・手書きの期待値・
   * 生成した敵対的コーパスの範囲で過少計数が出ないことまで（全入力の証明ではない）。
   *
   *  - 公式がURLと見なす区間 → その区間は23。こちらも同じ区間を23で数えられる
   *  - 公式が素の文字と見なす → こちらは素で数える選択肢も持っている
   *  - 1つの並びにURLが2つ   → 区間を分けて両方数えられる
   *  - 候補が周囲の文字を巻き込む → より短い候補を選ぶ道も残してある
   *
   * 以前は「ドットを含むトークンは丸ごと23」としていたため、
   * `http://foo_bar.com/abcdefghijklmnopqrstuvwxyz`（公式45）を23、
   * `text:http://example.com`（公式28）を23、
   * `foobar.みんな/`（公式23）を14と数えていた。
   * どれも少なく見積もる方向で、Xに弾かれる文面を作りうる
   * （2026-08-05の第3回監査で再現）。
   *
   * 「公式より少なく数えない」ことは test/oracle.test.mjs が、
   * 公式実装 twitter-text と突き合わせて機械的に検査する。
   */
  function weightedLength(text) {
    var s = normalizeNFC(text);
    if (!s) return 0;

    var gs = graphemes(s);
    var n = gs.length;

    // 各書記素の重みと、その開始位置（UTF-16）
    var w = new Array(n);
    var start = new Array(n + 1);
    var offsetToIndex = {};
    var off = 0;
    for (var i = 0; i < n; i++) {
      start[i] = off;
      offsetToIndex[off] = i;
      w[i] = isEmojiCluster(gs[i]) ? DEFAULT_WEIGHT : 0;
      if (!w[i]) for (var ch of gs[i]) w[i] += codePointWeight(ch.codePointAt(0));
      off += gs[i].length;
    }
    start[n] = off;
    offsetToIndex[off] = n;

    // 各開始位置から伸びるURL候補（sticky で位置を固定して探す）
    var sticky = new RegExp(URL_CANDIDATE_RE.source, 'uy');
    var spans = [];
    for (var a = 0; a < n; a++) {
      sticky.lastIndex = start[a];
      var m = sticky.exec(s);
      if (!m || !m[0].length) continue;
      var endIndex = offsetToIndex[start[a] + m[0].length];
      if (typeof endIndex === 'number' && endIndex > a) spans.push([a, endIndex]);
    }

    // best[i] = 先頭から i 書記素までの、最大になる解釈
    var best = new Array(n + 1);
    best[0] = 0;
    for (var i = 1; i <= n; i++) best[i] = best[i - 1] + w[i - 1];
    for (var sp = 0; sp < spans.length; sp++) {
      var from = spans[sp][0];
      var to = spans[sp][1];
      /*
       * 素で数えた値との max は取らない。best[to] には既に
       * 「素で数えていく経路」の値が入っており、そちらが下限になっている。
       * max を書いても結果が1件も変わらないことを変異テストで確認したので置かない。
       */
      var v = best[from] + URL_WEIGHT;
      // 候補の右側は、この時点の best を使って後段で伸びる
      if (v > best[to]) {
        best[to] = v;
        for (var j = to + 1; j <= n; j++) {
          var lit = best[j - 1] + w[j - 1];
          if (lit > best[j]) best[j] = lit;
        }
      }
    }
    return best[n];
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
   * URLの扱いがトークン全体に依存するようになったので、
   * 部分を足し上げるのではなく「先頭からn文字の重み」を二分探索する。
   * 最後に必ず実測して、超えていたら1文字ずつ削る。
   */
  function takeToWeight(text, budget) {
    if (weightedLength(text) <= budget) return text;
    var gs = graphemes(text);
    var lo = 0;
    var hi = gs.length;
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      if (weightedLength(gs.slice(0, mid).join('')) <= budget) lo = mid; else hi = mid - 1;
    }
    var out = gs.slice(0, lo).join('');
    // 単調でない並びに備えた保険。二分探索の結果を必ず実測で確かめる。
    while (lo > 0 && weightedLength(out) > budget) {
      lo -= 1;
      out = gs.slice(0, lo).join('');
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

    var seg = pathSegments(u);
    if (!seg) return null;                       // 判定できないURLは共有対象にしない
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
    var seg = pathSegments(u);
    if (!seg) return 'sensitive';                // 判定できない＝共有しない側へ倒す
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

    var hash = (route === 'root' || route === 'sensitive') ? '' : sanitizeFragment(u.hash);

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
    sanitizeFragment: sanitizeFragment,
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
