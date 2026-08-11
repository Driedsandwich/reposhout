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

  /*
   * 外へ出るURLの長さの上限（第16回監査 R16-002）。
   *
   * **正直に書く: いまの文法では、この2つに届かない。** 所有者39文字・
   * リポジトリ100文字・整数10桁・クエリは表にある名前が1回ずつ、という
   * 上限が全部かかるので、実際の最大は測ると 200 文字前後にしかならない。
   * 長さを本当に縛っているのは文法のほうで、ここは2層目でしかない。
   *
   * それでも置くのは、文法をゆるめたときに「上限が消えたこと」に気づけない
   * のを避けるため。効いていることは
   * 「9種別すべての最大寸法を実際に作って測る」テストのほうで見る
   * （この定数を外しても落ちないテストを、効いている証拠として数えない）。
   */
  var MAX_SHARE_URL_BYTES = 512;
  var MAX_INTENT_URL_BYTES = 1024;
  var DEFAULT_WEIGHT = 2;
  var WEIGHT_ONE_RANGES = [
    [0x0000, 0x10FF],
    [0x2000, 0x200D],
    [0x2010, 0x201F],
    [0x2032, 0x2037]
  ];


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

  /*
   * 第16回監査 R16-001。上の2つは**同じ1つの境界**を別々の配列で持っていた。
   * routeOf は SENSITIVE_FIRST_SEGMENTS を見るのに、出荷の判定をする
   * structuralRoute は RESERVED_OWNERS しか見ていなかったので、片方にしか
   * 載っていない語（enterprises・oauth・user・billing など）が「所有者名」として
   * 通り、`https://github.com/enterprises/acme` を「enterprises/acme という
   * リポジトリ」として投稿していた（配布ZIP 97bcf769… で再現）。
   *
   * **判定する場所は1つにする。** 語を足すときもここだけを見ればよい形にする。
   *
   * 限界も書いておく: これは**拒否する語の一覧**であって、「所有者名として実在する」
   * ことの証明ではない。GitHubが新しい機能ページを増やせば、その語は次の監査まで
   * 素通りする。ネットワークを見ずに所有者名を積極的に証明する手段が無いので、
   * 現状はこの形が上限——だからこそ2つに分けて持たない。
   */
  var NON_REPOSITORY_TOP_LEVEL = (function () {
    var extra = [
      'advisories', 'security-advisories', 'copilot', 'github-copilot',
      'contact', 'signin', 'sign_in', 'sign_up'
    ];
    var all = RESERVED_OWNERS.concat(SENSITIVE_FIRST_SEGMENTS).concat(extra);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var v = all[i].toLowerCase();
      if (out.indexOf(v) === -1) out.push(v);
    }
    return out;
  })();

  function isNonRepositoryTopLevel(name) {
    return typeof name === 'string' &&
      NON_REPOSITORY_TOP_LEVEL.indexOf(name.toLowerCase()) !== -1;
  }

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
   * ページ種別ごとに「共有URLへ残すクエリ」を、**名前と値の型**で決める。
   *
   * 第12回監査 R12-001。1.1.8 までは名前の allowlist だけで、値は
   * 「資格情報の形をしていないか」を正規表現で見ていた。しかし
   * q・body・title のような**自由文**を残す限り、有限の正規表現では
   * 「秘密が入っていない」ことを示せない（実際、5回以上エンコードした値・
   * camelCase の名前・一覧に無いベンダのトークン形は素通りした）。
   *
   * そこで**自由文は共有URLから落とす**。残すのは、値の形を機械的に
   * 確かめられるものだけにする。
   *
   *   int   1〜6桁の正の整数
   *   bool  1 / 0 / true / false
   *   enum  決めた語のどれか
   *   slug  英数と . _ - / , : だけの短い識別子（= を含めない・% を含めない）
   *
   * 落とす自由文: q / query / discussions_q / title / body
   * → 検索語や下書き本文は共有されない。README とストア文書もそう書く。
   */
  function enumRule(values) { return { type: 'enum', values: values }; }
  function intRule() { return { type: 'int' }; }
  function boolRule() { return { type: 'bool' }; }

  var SORT_VALUES = ['created', 'updated', 'comments', 'reactions', 'interactions',
                     'author-date', 'committer-date', 'best-match', 'stars', 'forks',
                     'help-wanted-issues', 'name', 'indexed'];
  var DIRECTION_VALUES = ['asc', 'desc'];
  var STATE_VALUES = ['open', 'closed', 'all', 'merged'];
  var DIFF_VALUES = ['split', 'unified'];
  var SEARCH_TYPE_VALUES = ['code', 'repositories', 'issues', 'pullrequests', 'discussions',
                            'users', 'commits', 'registrypackages', 'wikis', 'topics',
                            'marketplace'];
  var USER_TAB_VALUES = ['repositories', 'projects', 'packages', 'stars', 'followers',
                         'following', 'overview', 'achievements'];

  var QUERY_RULES = {
    'repo': {},
    'issue-list': {
      page: intRule(), sort: enumRule(SORT_VALUES), direction: enumRule(DIRECTION_VALUES),
      state: enumRule(STATE_VALUES)
    },
    'pr-list': {
      page: intRule(), sort: enumRule(SORT_VALUES), direction: enumRule(DIRECTION_VALUES),
      state: enumRule(STATE_VALUES)
    },
    'discussion-list': { page: intRule() },
    'releases': { page: intRule() },
    'issue': {},
    'pr': { diff: enumRule(DIFF_VALUES), w: boolRule() },
    'discussion': {},
    'commit': { diff: enumRule(DIFF_VALUES), w: boolRule() }
  };

  /*
   * 共有URLへ**載せない**自由文の名前。QUERY_RULES にこれらを足さないことが
   * 規約で、テストがそれを見張る（keepParam へ二重の判定を置いても、型の表に
   * 無い時点で落ちるので効かない＝変異させても落ちない行になる）。
   */
  var FREE_TEXT_PARAMS = ['q', 'query', 'discussions_q', 'title', 'body'];

  /*
   * 残せるのは int / bool / enum だけ。第13回監査 R13-001 で、識別子のつもりで
   * 残していた slug（labels・author・branch・path・milestone・template など）に
   * `sk_live_…` `npm_…` `glpat-…` のようなトークンをそのまま入れられることが
   * 実配布物で示された。**値の集合を数えられないものは残さない。**
   */
  function valueFitsRule(rule, value) {
    if (!rule) return false;
    if (typeof value !== 'string' || value === '') return false;
    if (rule.type === 'int') return /^[0-9]{1,6}$/.test(value) && Number(value) > 0;
    if (rule.type === 'bool') return ['0', '1', 'true', 'false'].indexOf(value) !== -1;
    if (rule.type === 'enum') return rule.values.indexOf(value) !== -1;
    return false;
  }

  /*
   * 型に合った値を、**決まった書き方**へ直してから出す（第16回監査 R16-002）。
   * `page=007` と `page=7`、`w=true` と `w=1` は同じ画面なのに、
   * そのまま出すと共有URLが2通りできる。同じ画面からは同じURLが出るようにする。
   */
  function canonicalValue(rule, value) {
    if (rule.type === 'int') return String(Number(value));
    if (rule.type === 'bool') return (value === '1' || value === 'true') ? '1' : '0';
    return value;                                   // enum は表に書いた文字列そのもの
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

  /* 経路を決めるのは先頭3つ（所有者 / リポジトリ / 種別）。ここだけ厳しく見る */
  var ROUTE_SEGMENT_COUNT = 3;

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
      // `.` と `..` は、どこに出てきても経路の判定を狂わせる。実在するファイル名でもない
      if (d === '.' || d === '..') return null;
      /*
       * 第8回監査 R8-003。経路を決めるのは先頭3つ（所有者・リポジトリ・種別）で、
       * そこに**解ききれないパーセント**が残っていたら、それが settings なのか
       * 別のものなのか判定できない。
       *
       *   /%2573ettings%2525ZZ/tokens
       *     → %73ettings%25ZZ → settings%ZZ で止まる（有効な %xx が無くなるため）
       *     → 「settings ではない」と判定され、リポジトリ名として共有できていた
       *
       * 判定できないものは共有しない。4つ目以降はファイル名なので、
       * `100%.md` のような正当な名前を壊さないよう、この規則は掛けない。
       */
      if (i < ROUTE_SEGMENT_COUNT && d.indexOf('%') !== -1) return null;
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
   * 合計は増える。狙いは、公式を下回らないこと（保証の範囲は下のコメントのとおり）。
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
  /* ============================================================
   * 2. URLの正規化（ページ種別ごとの方針）
   * ============================================================ */

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
    if (seg.length === 1) return isNonRepositoryTopLevel(s0) ? 'other' : 'user';
    if (isNonRepositoryTopLevel(s0)) return 'other';
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

  /*
   * 判定を「**名前**を載せてよいか」と「**値**が型に合うか」の2段に分ける
   * （第17回監査 R17-001）。
   *
   * 分ける理由は、**重複を数えるのが名前の側の仕事**だから。まとめて見ていたときは
   * 「型に合う値が2回」しか重複と数えられず、`?state=open&state=invalid` は
   * 1回として通って `state=open` を共有していた（配布ZIP `e628aaed…` で再現）。
   * 2回書いてあるのに1回として扱うと、利用者が見ている画面と共有URLの意味が
   * 黙って変わる。
   */
  function paramNameAllowed(route, name) {
    var rules = QUERY_RULES[route];
    if (!rules) return false;                                   // null（機微）と未定義は全落とし
    if (SENSITIVE_PARAM_RE.test(name)) return false;            // 多重防御
    if (TRACKING_PARAMS.indexOf(name.toLowerCase()) !== -1 && route !== 'user') return false;
    return Object.prototype.hasOwnProperty.call(rules, name);
  }

  function keepParam(route, name, value) {
    if (!paramNameAllowed(route, name)) return false;
    return valueFitsRule(QUERY_RULES[route][name], value);      // 値の形も見る
  }

  /* ------------------------------------------------------------
   * 許可したクエリの「値」に資格情報が入っていないか
   * ------------------------------------------------------------
   *
   * 第11回監査 R11-001。ここまでの判定はクエリの**名前**だけを見ていた。
   * 名前が allowlist に載っていれば（q・body・title など）値は中身を見ずに
   * そのまま残していたので、次がXへ渡っていた（1.1.7の配布ZIPで再現）。
   *
   *   /search?q=client_secret%3Ddummy-secret&type=code
   *   /compare/main...feature?quick_pull=1&body=access_token%3Ddummy-secret
   *   /issues?q=access_token%3Adummy-secret
   *
   * 値も境界として検査する。1つでも見つかったらそのURLは共有しない。
   * そのパラメータだけ黙って消す案は採らない——利用者が見ている画面と
   * 共有されるURLが別物になり、消したことにも気づけないため。
   */

  /* 資格情報とみなす名前。区切りと大文字小文字を落として突き合わせる */
  var CREDENTIAL_KEYS = [
    'accesstoken', 'refreshtoken', 'idtoken', 'oauthtoken', 'authtoken',
    'clientsecret', 'apikey', 'apisecret', 'secret', 'password', 'passwd', 'pwd',
    'sessiontoken', 'sessionid', 'authorization', 'credential', 'credentials',
    'privatekey', 'token', 'passphrase', 'sig', 'signature', 'key', 'apisecret',
    'clientid', 'bearer', 'auth',
    /*
     * 第14回監査 R14-001。セッションIDと署名付きURLの名前。
     * `X-Amz-Signature` は区切りを落とすと 'xamzsignature' になり、
     * 既にある 'signature' には**当たらない**（実測）ので個別に並べる。
     */
    'jsessionid', 'phpsessid', 'aspsessionid', 'sessid',
    'xamzsignature', 'xamzcredential', 'xamzsecuritytoken', 'awsaccesskeyid',
    'csrftoken', 'xsrftoken'
  ];

  /*
   * 「名前 = 値」「名前 : 値」の形をまとめて拾い、名前は正規化してから照合する。
   * 第12回監査 R12-001: 以前は 'access_token' のような書き方を並べていたので、
   * accessToken / api-key / ClientSecret が素通りしていた。
   */
  var ASSIGNMENT_RE = /(?:^|[^A-Za-z0-9])["']?([A-Za-z][A-Za-z0-9_-]{1,30})["']?[ \t]*[:=][ \t]*["']?([^\s"',&]+)/g;

  /*
   * 区切りと大文字小文字を落として照合する。
   * **名前に '.' は含めない**——含めると `main...access_token=` が
   * 「mainaccesstoken」という1語として読まれ、照合から外れる（実測）。
   * '.' は区切りとして扱い、`api.key=` は 'key' として当たる。
   */
  function normalizeKey(name) {
    return String(name).toLowerCase().replace(/[-_.]/g, '');
  }

  /*
   * 値そのものが資格情報の形をしているもの（名前が無くても分かる）。
   * ここに並ぶのは**こちらが定義した形**だけで、「あらゆる秘密を見つけられる」
   * という意味ではない（文書にもそう書く・第12回監査 R12-001）。
   */
  var CREDENTIAL_TOKEN_RES = [
    /gh[pousr]_[A-Za-z0-9]{16,}/,                          // GitHub
    /github_pat_[A-Za-z0-9_]{16,}/,                        // GitHub fine-grained
    /Bearer[ \t]+[A-Za-z0-9\-._~+\/]{16,}/i,                // Authorization ヘッダの形
    /AKIA[0-9A-Z]{12,}/,                                   // AWS アクセスキーの形
    /xox[baprs]-[A-Za-z0-9-]{10,}/i,                       // Slack
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}/,   // JWT
    /AIza[0-9A-Za-z_\-]{20,}/,                             // Google API キー
    /-----BEGIN[ A-Z]*PRIVATE KEY/,                        // PEM
    /glpat-[A-Za-z0-9_\-]{10,}/,                           // GitLab
    /sk-(?:proj-|ant-|live-)?[A-Za-z0-9_\-]{16,}/,         // OpenAI / Anthropic 等
    /sk_(?:live|test)_[A-Za-z0-9]{10,}/,                   // Stripe
    /npm_[A-Za-z0-9]{20,}/,                                // npm
    /shp(?:at|ss|pa)_[A-Za-z0-9]{16,}/,                    // Shopify
    /SG\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/         // SendGrid
  ];

  /* 制御文字。普通のURLには入らない */
  var CONTROL_RE = /[\u0000-\u001F\u007F]/;

  /*
   * `scheme://利用者:合言葉@ホスト` の形（第14回監査 R14-001）。
   * `//` の直後から `@` までに `/` を挟まないので、`/blob/main/a@b` のような
   * 普通のパスには当たらない。
   */
  var BASIC_URI_RE = /[A-Za-z][A-Za-z0-9+.\-]*:\/\/[^\s\/@]*:[^\s\/@]+@/;

  /*
   * **見えない文字**。表示上は同じに見えるのに、既知の形の途中へ入れると
   * パターンから外れる（GitHub トークンの接頭辞の間にゼロ幅スペースを入れると
   * 素通りした・実測）。ゼロ幅・方向制御・ソフトハイフン・BOM。
   */
  var IGNORABLE_RE = /[­͏؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;

  /*
   * **走査のためだけに整えた文字列**を返す（出力は一切変えない）。
   *
   * ・見えない文字を落とす……既知の形を割って隠せないようにする
   * ・NFKC……全角の `＝` `：` や全角英字を半角へ寄せる。
   *   `access_token＝<値>` `access_token：<値>` `ａｃｃｅｓｓ＿ｔｏｋｅｎ=<値>`
   *   はどれも 1.1.8 の配布ZIPで素通りしていた（実測）
   *
   * 元の文字列も別に見る。正規化は当てる幅を広げるためのもので、
   * 正規化した結果だけを見ると、逆に見落とす形を作りかねないため。
   */
  function normalizeForScan(text) {
    var s = String(text).replace(IGNORABLE_RE, '');
    try {
      s = s.normalize('NFKC');
    } catch (e) {
      /* normalize を持たない環境では素のまま照合する */
    }
    return s;
  }

  /* まだほどける（有効な %HH が残っている）か */
  var HAS_ESCAPE_RE = /%[0-9A-Fa-f]{2}/;

  /*
   * ほどく回数の上限。パスと値で別々に持つ（第12回監査 R12-004 の指摘に沿って、
   * 同じ定数を共有しない）。**上限に達しても、まだ有効な %HH が残っていれば
   * 判定できないので落とす。** 以前は上限に達すると素通りしていたので、
   * 5回以上エンコードした値が通っていた（1.1.8の配布ZIPで実測）。
   */
  var VALUE_MAX_DECODE_ROUNDS = 6;
  var PATH_MAX_DECODE_ROUNDS = 4;

  /* 1つの文字列そのものを見る。正規化はここでは行わない（呼び出し側の責任） */
  function matchesCredentialShape(text) {
    if (CONTROL_RE.test(text)) return true;
    if (BASIC_URI_RE.test(text)) return true;
    for (var i = 0; i < CREDENTIAL_TOKEN_RES.length; i++) {
      if (CREDENTIAL_TOKEN_RES[i].test(text)) return true;
    }
    ASSIGNMENT_RE.lastIndex = 0;
    var m;
    while ((m = ASSIGNMENT_RE.exec(text)) !== null) {
      if (CREDENTIAL_KEYS.indexOf(normalizeKey(m[1])) !== -1) return true;
    }
    return false;
  }

  /* 素のままと、走査用に整えた形の両方で見る（第14回監査 R14-001） */
  function looksLikeCredential(text) {
    if (matchesCredentialShape(text)) return true;
    var normalized = normalizeForScan(text);
    return normalized !== text && matchesCredentialShape(normalized);
  }

  /*
   * 多重エンコードをほどきながら各段階で見る。
   *
   * ・**ほどくのは有効な %HH があるときだけ。** 解いた結果に残る素の `%` は
   *   ただのデータで、`100% coverage` のような普通の検索を落とさない
   *   （第12回監査 R12-002。1.1.8 では落としていた）
   * ・decodeURIComponent が投げる＝壊れたエスケープなので落とす
   * ・上限まで解いてもまだ %HH が残る＝判定できないので落とす
   *
   * 戻り値は理由（null なら問題なし）。
   */
  function scanEncodedLayers(text, maxRounds) {
    if (typeof text !== 'string' || !text) return null;
    var layer = text;
    for (var i = 0; i <= maxRounds; i++) {
      if (looksLikeCredential(layer)) return 'credential_like';
      if (!HAS_ESCAPE_RE.test(layer)) return null;      // これ以上ほどけない
      if (i === maxRounds) return 'credential_like';    // まだ解ける＝判定できない
      var next;
      try {
        next = decodeURIComponent(layer);
      } catch (e) {
        return 'credential_like';                       // 壊れたエスケープ
      }
      if (next === layer) return null;
      layer = next;
    }
    return null;
  }

  function credentialLikeValue(value) {
    return scanEncodedLayers(value, VALUE_MAX_DECODE_ROUNDS) !== null;
  }

  function credentialLikeShareUrl(shareUrl) {
    var u;
    try {
      u = new URL(shareUrl);
    } catch (e) {
      return 'credential_like';                         // 読めないものは出さない
    }
    if (scanEncodedLayers(u.pathname, PATH_MAX_DECODE_ROUNDS)) return 'credential_like';
    if (u.hash && scanEncodedLayers(u.hash, VALUE_MAX_DECODE_ROUNDS)) return 'credential_like';
    var found = null;
    u.searchParams.forEach(function (value, name) {
      if (found) return;
      if (credentialLikeValue(value) || credentialLikeValue(name)) found = 'credential_like';
    });
    return found;
  }


  /* ============================================================
   * 2.5 出て行くものを、型で決める（第15回監査 R15-001）
   * ============================================================
   *
   * 第14回まではこうだった——利用者のページのタイトルとパスをそのままXへ渡し、
   * 「資格情報の形をしていないか」を有限のパターンで見て止める。
   *
   * 第15回の実測で、この方式が両側から破れることが分かった（配布ZIP 376338a3… で再現）。
   *
   *   ・定義の外にある**現実的な**形が37件そのまま投稿画面まで届いた
   *     （X-Api-Key: / Private-Token: / AWS_SECRET_ACCESS_KEY= / SAMLResponse= /
   *      client_assertion= / ya29. / hf_ / whsec_ / 異体字セレクタで割った形 …）
   *   ・同時に、普通の開発者向け表題4件を**誤って拒否**していた
   *     （"How to parse key=value pairs" / "Support auth=none mode" など）
   *
   * つまり検出器を厳しくすると製品が壊れ、緩めると漏れる。パターンを足す方向では
   * 閉じられないので、**出て行くものの決め方そのもの**を変える。
   *
   *   ・ページのタイトル（document.title）は**一切送らない**
   *   ・共有できるのは、**全セグメントが型で決まるルート**だけ
   *     （所有者名 / リポジトリ名 / 正の整数 / 40桁の16進）
   *   ・URLは**検査したパーツから組み直す**。元の pathname は使わない
   *   ・フラグメントは落とす。クエリは型に合う値だけ残す
   *
   * 資格情報の検出器は残すが、**主たる境界ではなく多層防御**として扱う。
   */

  /*
   * GitHub の所有者名・リポジトリ名として在りうる形。'=' や ':' は入らない。
   *
   * 所有者名は GitHub の規則に合わせる（第16回監査 R16-001）——英数字とハイフン、
   * 39文字まで、**ハイフンで終わらない・ハイフンを続けない**。以前は
   * `[A-Za-z0-9-]{0,38}` だったので `a--b` や `o-` まで所有者名として通していた。
   * ハイフンの後ろに英数字を要求することで、両方を1つの形で落とす。
   */
  var OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
  var REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
  var POSITIVE_INT_RE = /^[1-9][0-9]{0,9}$/;
  var SHA40_RE = /^[0-9a-f]{40}$/;

  /* 3つ目のセグメントだけで決まるもの（一覧・リリース） */
  var LIST_ROUTES = {
    issues: 'issue-list',
    pulls: 'pr-list',
    discussions: 'discussion-list',
    releases: 'releases'
  };

  /* 3つ目＋4つ目で決まるもの。4つ目の型を必ず指定する */
  var NUMBERED_ROUTES = {
    issues: { route: 'issue', type: 'int' },
    pull: { route: 'pr', type: 'int' },
    discussions: { route: 'discussion', type: 'int' },
    commit: { route: 'commit', type: 'sha40' }
  };

  /*
   * 型で決まるルートだけを認める。1つでも当てはまらなければ null（＝共有しない）。
   * 返すのは**検査済みのパーツ**だけで、元の pathname は持ち出さない。
   */
  function structuralRoute(u) {
    var seg = pathSegments(u);
    if (!seg || seg.length < 2 || seg.length > 4) return null;

    var owner = seg[0];
    var repo = seg[1];
    if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null;
    if (isNonRepositoryTopLevel(owner)) return null;      // 第16回監査 R16-001（判定は1か所）
    if (repo === '.' || repo === '..') return null;
    var full = owner + '/' + repo;

    if (seg.length === 2) {
      return { route: 'repo', owner: owner, name: repo, repo: full, number: null, sha: null,
               section: null };
    }

    var third = seg[2];
    if (seg.length === 3) {
      var listed = LIST_ROUTES[third];
      if (!listed) return null;
      return { route: listed, owner: owner, name: repo, repo: full, number: null, sha: null,
               section: third };
    }

    var rule = NUMBERED_ROUTES[third];
    if (!rule) return null;
    var fourth = seg[3];
    if (rule.type === 'int') {
      if (!POSITIVE_INT_RE.test(fourth)) return null;
      return { route: rule.route, owner: owner, name: repo, repo: full, number: fourth,
               sha: null, section: third };
    }
    if (!SHA40_RE.test(fourth)) return null;
    return { route: rule.route, owner: owner, name: repo, repo: full, number: null,
             sha: fourth, section: third };
  }

  /* 検査したパーツだけでパスを組み直す */
  function structuralPath(info) {
    var base = '/' + info.owner + '/' + info.name;
    if (!info.section) return base;
    if (info.number) return base + '/' + info.section + '/' + info.number;
    if (info.sha) return base + '/' + info.section + '/' + info.sha;
    return base + '/' + info.section;
  }

  /*
   * 投稿の本文。**ページのタイトルは使わない。**
   * 出てくるのはリポジトリ名と、正の整数または40桁の16進だけ。
   */
  function structuralText(info) {
    switch (info.route) {
      case 'repo': return info.repo;
      case 'issue': return 'Issue #' + info.number + ' \u00b7 ' + info.repo;
      case 'pr': return 'PR #' + info.number + ' \u00b7 ' + info.repo;
      case 'discussion': return 'Discussion #' + info.number + ' \u00b7 ' + info.repo;
      case 'issue-list': return 'Issues \u00b7 ' + info.repo;
      case 'pr-list': return 'Pull requests \u00b7 ' + info.repo;
      case 'discussion-list': return 'Discussions \u00b7 ' + info.repo;
      case 'releases': return 'Releases \u00b7 ' + info.repo;
      case 'commit': return 'Commit ' + info.sha.slice(0, 7) + ' \u00b7 ' + info.repo;
      default: return info.repo;
    }
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
    var r = canonicalResult(rawUrl);
    return r.ok ? r.url : null;
  }

  /*
   * 内部はこちらが本体。理由つきで返す（第12回監査 R12-002）。
   * reason は固定の語だけで、URLも値も入れない——表示に混ぜないため。
   *
   *   'credential_like'  資格情報の形が見つかった
   *   'sensitive_route'  認証・設定・組織管理の画面
   *   'unsupported'      github.com 以外
   *   'malformed_url'    URLとして読めない
   */
  function canonicalResult(rawUrl) {
    var u;
    try {
      u = new URL(rawUrl);
    } catch (e) {
      return { ok: false, reason: 'malformed_url' };
    }

    if (u.protocol !== 'https:' || u.hostname !== 'github.com') {
      return { ok: false, reason: 'unsupported' };
    }

    /*
     * 第15回監査 R15-001。**型で決まるルートだけ**を通す。
     * 認証・設定・組織管理の画面は、所有者名の予約語と型で自動的に外れる。
     */
    var info = structuralRoute(u);
    if (!info) {
      return { ok: false, reason: isSensitiveUrl(rawUrl) ? 'sensitive_route' : 'unsupported' };
    }

    /*
     * 型に合う値だけ残す。自由文も識別子っぽい値も、表に無いので落ちる。
     *
     * 第16回監査 R16-002。値を int / bool / enum に絞っても、**同じ名前が
     * 何回出てもすべて残していた**ので、`?state=open&state=closed&…` の
     * 並びで任意長のビット列をXへ渡せた（1,000回で12,029文字・配布ZIPで再現）。
     * 値の集合が有限でも、繰り返せる限り運べる量は有限にならない。
     *
     * 同じ名前が2回以上あればURLごと拒否する。黙って先頭/末尾を採ると、
     * 利用者が見ている画面と共有URLの意味が変わりうる。
     */
    var rules = QUERY_RULES[info.route];
    var kept = Object.create(null);
    var ambiguous = false;
    if (rules) {
      var seen = Object.create(null);
      u.searchParams.forEach(function (value, name) {
        /*
         * 順番が大事（第17回監査 R17-001）。
         * ①表に無い名前は落とす（重複していても数えない＝拒否しない）
         * ②**値を見る前に**、同じ名前が2回目かを数える
         * ③そのうえで、値が型に合わなければ落とす
         */
        if (!paramNameAllowed(info.route, name)) return;
        if (name in seen) { ambiguous = true; return; }
        seen[name] = true;
        if (!valueFitsRule(rules[name], value)) return;       // 名前は表にあるが値が型に合わない
        kept[name] = canonicalValue(rules[name], value);
      });
    }
    if (ambiguous) return { ok: false, reason: 'ambiguous_query' };

    /*
     * 出す順番は**表に書いてある順**に固定する（入力の並び順を持ち出さない）。
     * 順番用の表をもう1つ作らないのは、2つ持つと必ずずれるため——
     * それが R16-001 で起きたことそのものだった。
     */
    var qs = '';
    if (rules) {
      var names = Object.keys(rules);
      var parts = [];
      for (var qi = 0; qi < names.length; qi++) {
        if (names[qi] in kept) {
          parts.push(encodeURIComponent(names[qi]) + '=' + encodeURIComponent(kept[names[qi]]));
        }
      }
      if (parts.length) qs = '?' + parts.join('&');
    }

    /*
     * **パスは検査したパーツから組み直す**（元の pathname は使わない）。
     * フラグメントは落とす——#L10 のような行番号は共有したい情報だが、
     * 任意の文字列を運べる場所を1つでも残すと、この方式の意味が無くなる。
     */
    var url = 'https://github.com' + structuralPath(info) + qs;

    /* 2層目。長さの上限（第16回監査 R16-002。いまの文法では届かない） */
    if (url.length > MAX_SHARE_URL_BYTES) return { ok: false, reason: 'overlong_url' };

    /* 多層防御。ここまでで型は絞ってあるが、出て行くURLそのものも見る */
    var bad = credentialLikeShareUrl(url);
    if (bad) return { ok: false, reason: bad };

    return { ok: true, url: url, info: info };
  }

  /*
   * 文面の組み立てが失敗したときに使う、URLだけの共有先。
   * content script と service worker の両方がこれを呼ぶ。
   * ここで split('?')[0] のような独自処理を書くと方針が二重化するので書かない。
   */
  function fallbackUrl(rawUrl) {
    /*
     * 判定は canonicalResult だけが持つ。ここへ同じ判定をもう1つ置くと、
     * 変異させても落ちない＝効いているか分からない行になる。
     * 例外時に split('?')[0] のような独自処理を書くと、判定を通らない
     * 別経路ができるので書かない。落とすほうへ倒す。
     */
    try {
      return canonicalUrl(rawUrl, null);
    } catch (e) {
      return null;
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
   * 本体。url と title から投稿用の文面とXのURLを作る。
   * github.com 以外なら null。
   *
   * 注: Open / Merged / Closed の状態ラベルは意図的に含めない。
   * ログイン状態とログアウト状態で取得値が食い違う（同一PRが Merged / Open）
   * 事象を実測しており、誤った状態を投稿するリスクを避けるため。
   */
  /*
   * 理由つきの入口。呼び出し側（content script / service worker）は
   * reason を見て、値を含まない定型の案内を出す（第12回監査 R12-002）。
   */
  /*
   * 第2引数（ページのタイトル）は受け取るが**使わない**。呼び出し側の形を
   * 変えずに済ませるためだけに残してある。タイトルはXへ渡らない（R15-001）。
   */
  function buildShareResult(rawUrl) {
    var res = canonicalResult(rawUrl);
    if (!res.ok) return { ok: false, reason: res.reason };
    var share = buildShare(rawUrl);
    if (!share) return { ok: false, reason: 'credential_like' };
    return { ok: true, share: share };
  }

  function buildShare(rawUrl) {
    var res = canonicalResult(rawUrl);
    if (!res.ok) return null;                  // 理由つきが要るときは buildShareResult を使う

    var info = res.info;
    var url = res.url;
    /*
     * **ページのタイトルは使わない**（第15回監査 R15-001）。
     * 本文に出るのは、リポジトリ名と、正の整数または40桁の16進だけ。
     */
    var text = structuralText(info);

    /*
     * 上限は**切り詰めずに守る**。所有者39文字＋リポジトリ100文字の最大でも
     * 上限に届かない（テストで公式実装に照らして実測）。万一届いたら共有しない——
     * 切り詰めると、その変換がまた検査を外しうる（第14回監査 R14-001 で実際に起きた型）。
     */
    if (weightedLength(text) + 1 + URL_WEIGHT > MAX_WEIGHTED_TWEET) return null;

    /*
     * 本文は info（所有者名・リポジトリ名・整数・16進）だけから作るので、
     * URLに無い文字は入らない。**ここへ本文用の検査をもう1つ置いても、
     * 外しても何も落ちない行になる**（実際に変異で確かめた）ため置かない。
     * 資格情報の検査は canonicalResult が出て行くURLに対して1回だけ行う。
     */

    var intentUrl = intentUrlFor(text, url);
    /* 2層目。Xへ渡すURLの長さ（第16回監査 R16-002。いまの文法では届かない） */
    if (intentUrl.length > MAX_INTENT_URL_BYTES) return null;

    return {
      kind: info.route,
      repo: info.repo,
      number: info.number,
      text: text,
      url: url,
      intentUrl: intentUrl
    };
  }

  root.GXS = {
    buildShare: buildShare,
    canonicalUrl: canonicalUrl,
    fallbackUrl: fallbackUrl,
    isSensitiveUrl: isSensitiveUrl,
    buildShareResult: buildShareResult,
    canonicalResult: canonicalResult,
    credentialLikeShareUrl: credentialLikeShareUrl,
    normalizeForScan: normalizeForScan,
    QUERY_RULES: QUERY_RULES,
    FREE_TEXT_PARAMS: FREE_TEXT_PARAMS,
    credentialLikeValue: credentialLikeValue,
    intentUrlFor: intentUrlFor,
    routeOf: routeOf,
    weightedLength: weightedLength,
    MAX_WEIGHTED_TWEET: MAX_WEIGHTED_TWEET,
    URL_WEIGHT: URL_WEIGHT,
    MAX_SHARE_URL_BYTES: MAX_SHARE_URL_BYTES,
    MAX_INTENT_URL_BYTES: MAX_INTENT_URL_BYTES,
    NON_REPOSITORY_TOP_LEVEL: NON_REPOSITORY_TOP_LEVEL
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
