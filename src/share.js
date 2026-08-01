/*
 * share.js — 共有テキストとX投稿URLの組み立て
 *
 * 設計方針: DOMを一切見ない。URL と document.title だけで動く。
 * これにより GitHub のUI改修・ログイン状態の違いの影響を受けない。
 * content script と service worker の両方から同じ実装を使う。
 */
(function (root) {
  'use strict';

  /*
   * Xの本文上限は280。ただし「文字数」ではなく重み付きで数えられ、
   * 日本語（ひらがな・カタカナ・漢字）や全角記号は1文字=2として計算される。
   * URLはt.coで23、本文との区切り空白が1なので、本文に使えるのは 280-24=256。
   * 末尾の「…」ぶんと余白を見て250にする。
   *
   * 単純な文字数(200)で切っていた版は、日本語だと約120文字で280を超えて
   * 投稿できなくなっていた（レビューで実測して判明）。
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
   * Xの重み付き文字数。twitter-text の weighted ranges に準拠し、
   * CJK・ハングル・全角記号を2、BMP外（絵文字など）を2として数える。
   */
  function charWeight(cp) {
    if (cp > 0xFFFF) return 2;                        // 絵文字などBMP外
    if (cp >= 0x1100 && cp <= 0x115F) return 2;       // ハングル字母
    if (cp >= 0x2E80 && cp <= 0x303E) return 2;       // CJK部首・記号
    if (cp >= 0x3041 && cp <= 0x33FF) return 2;       // ひらがな・カタカナ・CJK互換
    if (cp >= 0x3400 && cp <= 0x4DBF) return 2;       // CJK拡張A
    if (cp >= 0x4E00 && cp <= 0x9FFF) return 2;       // CJK統合漢字
    if (cp >= 0xA000 && cp <= 0xA48F) return 2;       // イ文字
    if (cp >= 0xAC00 && cp <= 0xD7A3) return 2;       // ハングル音節
    if (cp >= 0xF900 && cp <= 0xFAFF) return 2;       // CJK互換漢字
    if (cp >= 0xFE30 && cp <= 0xFE4F) return 2;       // CJK互換形
    if (cp >= 0xFF00 && cp <= 0xFF60) return 2;       // 全角英数・記号
    if (cp >= 0xFFE0 && cp <= 0xFFE6) return 2;       // 全角記号
    return 1;
  }

  function weightedLength(text) {
    var chars = Array.from(text); // コードポイント単位
    var w = 0;
    for (var i = 0; i < chars.length; i++) w += charWeight(chars[i].codePointAt(0));
    return w;
  }

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

  /*
   * 重み付き250に収まるよう切り詰める。
   *
   * 必ず Array.from でコードポイント単位に分解してから切ること。
   * text.slice() はUTF-16コードユニット単位なので、絵文字が境界に来ると
   * サロゲートペアが分断され、後段の encodeURIComponent が URIError を投げる。
   * その例外で共有機能が丸ごと無反応になる事故が実測で確認されている。
   */
  function truncate(text) {
    var chars = Array.from(text);
    if (weightedLength(text) <= MAX_WEIGHT) return text;

    var budget = MAX_WEIGHT - 1; // 末尾に付ける「…」のぶん
    var acc = 0;
    var out = [];
    for (var i = 0; i < chars.length; i++) {
      var w = charWeight(chars[i].codePointAt(0));
      if (acc + w > budget) break;
      acc += w;
      out.push(chars[i]);
    }
    return out.join('').replace(/\s+$/, '') + '…';
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
    MAX_WEIGHT: MAX_WEIGHT
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
