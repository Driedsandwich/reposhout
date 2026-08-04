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
      if (cps[i] > 0xFFFF && EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(cps[i]))) return true;
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
   * 本文中のURLを取り出す。twitter-text はURLを t.co 長（23）に置き換えて数えるため、
   * 長いURLでも短いURLでも一律23になる。
   * GitHubのタイトル・説明が対象なので、スキーム付きと www. 始まりだけを見る。
   */
  var URL_IN_TEXT_RE = /(https?:\/\/[^\s<>"'）」]+)|((?:^|[\s(（])www\.[^\s<>"'）」]+)/gi;

  function splitUrls(text) {
    var parts = [];
    var last = 0;
    var m;
    URL_IN_TEXT_RE.lastIndex = 0;
    while ((m = URL_IN_TEXT_RE.exec(text)) !== null) {
      var raw = m[0];
      var offset = m.index;
      // www. 側は直前の空白/括弧を含めて拾っているので、URL本体まで進める
      var lead = raw.search(/https?:\/\/|www\./i);
      if (lead > 0) {
        offset += lead;
        raw = raw.slice(lead);
      }
      if (offset > last) parts.push({ type: 'text', value: text.slice(last, offset) });
      parts.push({ type: 'url', value: raw });
      last = offset + raw.length;
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
   * 重み MAX_WEIGHT に収まるよう切り詰める。
   *
   * 切る単位は書記素（grapheme cluster）。コードポイント単位で切ると
   * 肌色つき絵文字やZWJ連結の途中で割れて、見た目が壊れた文字が残る。
   * さらにUTF-16単位（text.slice）で切るとサロゲートペアが分断され、
   * encodeURIComponent が URIError を投げて共有機能が丸ごと無反応になる
   * （v1.0.0 で実測した事故。ここは絶対に戻さない）。
   *
   * URLは23として数えるので、途中で切らず「丸ごと入るか入らないか」で扱う。
   */
  function truncate(text) {
    var s = normalizeNFC(text);
    if (weightedLength(s) <= MAX_WEIGHT) return s;

    var budget = MAX_WEIGHT - weightedLength(ELLIPSIS);
    var parts = splitUrls(s);
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
    return out.replace(/\s+$/, '') + ELLIPSIS;
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
   * 共有するURLを整える。
   * - リポジトリトップ: クエリもハッシュも落として正規形にする
   *   （GitHubが付ける ?tab=readme-ov-file 等のノイズを除去）
   * - それ以外: クエリだけ落としてハッシュは残す
   *   （#L10 の行指定や #issuecomment-123 は共有したい情報そのものなので消さない）
   */
  function canonicalUrl(rawUrl, info) {
    var u;
    try {
      u = new URL(rawUrl);
    } catch (e) {
      return rawUrl;
    }
    if (info && info.kind === 'repo') {
      return u.origin + u.pathname.replace(/\/$/, '');
    }
    return u.origin + u.pathname + (u.hash || '');
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

    var url = canonicalUrl(rawUrl, info);
    var title = cleanTitle(info.kind, rawTitle);
    var text;

    if (info.kind === 'issue') {
      text = title + ' (Issue #' + info.number + ' · ' + info.repo + ')';
    } else if (info.kind === 'pr') {
      text = title + ' (PR #' + info.number + ' · ' + info.repo + ')';
    } else if (info.kind === 'discussion') {
      text = title + ' (Discussion #' + info.number + ' · ' + info.repo + ')';
    } else {
      text = title;
    }

    // タイトルが取れなかった場合は repo 名、それも無ければURLで代替する
    if (!text.trim()) text = info.repo || url;
    text = truncate(text.trim());

    return {
      kind: info.kind,
      repo: info.repo,
      number: info.number,
      text: text,
      url: url,
      intentUrl: 'https://x.com/intent/post?text=' + encodeURIComponent(text) +
                 '&url=' + encodeURIComponent(url)
    };
  }

  root.GXS = {
    buildShare: buildShare,
    parseLocation: parseLocation,
    cleanTitle: cleanTitle,
    canonicalUrl: canonicalUrl,
    weightedLength: weightedLength,
    truncate: truncate,
    MAX_WEIGHT: MAX_WEIGHT,
    MAX_WEIGHTED_TWEET: MAX_WEIGHTED_TWEET,
    URL_WEIGHT: URL_WEIGHT
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
