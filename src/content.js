/*
 * content.js — GitHubのボタン群の左端に共有ボタンを足す
 *
 * 設計方針（壊れにくさを最優先）:
 *  1. 依存する目印は3つだけ。見つからなければ「黙って何もしない」
 *  2. GitHubの既存DOMは読むだけ。書き換え・削除は一切しない
 *  3. 追加する要素は1個。失敗しても影響がそこで閉じる
 *  4. ボタンの個数・種類（Pin/Watch/Notifications等）は一切見ない。
 *     見ないことでログイン/ログアウトの差と将来の増減を吸収する
 */
(function () {
  'use strict';

  var LI_ID = 'gxs-share-li';
  var BTN_ID = 'gxs-share-btn';
  var STYLE_ID = 'gxs-share-style';

  /*
   * 挿入先の候補。実測（2026-07-31、2026-08-02にIssue/PRを追加）に基づく。
   *  - リポジトリ・ログイン時 : React新UI。data-testid はGitHubの自動テスト用の名前で、
   *                             見た目のクラス名（prc-Button-ButtonBase-9n-Xk 等のハッシュ）と違い
   *                             ビルドごとに変わらない
   *  - リポジトリ・ログアウト時: 旧UI。pagehead-actions はPrimer由来の長寿クラス
   *  - Issue / PR             : Primer PageHeader のアクション枠。data-component も
   *                             ハッシュ化されない安定した名前
   * 実測ではこの3つはページ種別ごとに排他で、同時に存在しない。
   * PH_Actions が出るのは /issues、/issues/N、/pull/N のみで、
   * リポジトリ直下・Actions・ファイル表示・通知・設定には存在しない（2026-08-02実測）。
   */
  var CONTAINERS = [
    { sel: 'ul[data-testid="repo-header-actions"]', drillIn: false },
    { sel: 'ul.pagehead-actions', drillIn: false },
    { sel: '[data-component="PH_Actions"]', drillIn: true }
  ];

  // X のロゴ（24x24）
  var X_ICON =
    '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false">' +
    '<path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path>' +
    '</svg>';

  /*
   * Issue/PRの PH_Actions は横幅いっぱいの外枠で、実際のボタンは
   * 内側の右寄せ行（justify-content:flex-end）に入っている。外枠へ足すと
   * ボタン群ではなくタイトルの隣に浮いてしまうため、内側の行を使う。
   * 構造が変わって条件に合わなければ外枠のまま扱う（何もしないよりは安全側）。
   * この掘り下げは PH_Actions だけに適用する。ul 側で同じことをすると、
   * ボタンが1個しかないリポジトリでその <li> の中に潜り込んでしまうため。
   */
  function drillIntoActionRow(el) {
    try {
      if (el.children.length !== 1) return el;
      var inner = el.children[0];
      if (!inner || inner.tagName !== 'DIV' || inner.children.length === 0) return el;
      if (window.getComputedStyle(inner).display.indexOf('flex') === -1) return el;
      return inner;
    } catch (e) {
      return el;
    }
  }

  function findContainer() {
    for (var i = 0; i < CONTAINERS.length; i++) {
      var el = document.querySelector(CONTAINERS[i].sel);
      if (el) return CONTAINERS[i].drillIn ? drillIntoActionRow(el) : el;
    }
    return null;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    /*
     * 色は GitHub が公開しているテーマ変数を使う。
     * これでライト/ダーク、および配色テーマの切替に自動で追従する。
     * 変数が無い環境向けにライトテーマの実測値をフォールバックに置く。
     */
    style.textContent = [
      '#' + LI_ID + '{list-style:none;}',
      '#' + BTN_ID + '{',
      'display:inline-flex;align-items:center;gap:4px;',
      // 高さは既定28px（両状態での実測値）。実際には隣のボタンを測って上書きする
      'box-sizing:border-box;height:28px;padding:0 12px;',
      'font-family:inherit;font-size:12px;font-weight:500;line-height:20px;',
      'color:var(--button-default-fgColor-rest,#25292e);',
      'background-color:var(--button-default-bgColor-rest,#f6f8fa);',
      'border:1px solid var(--button-default-borderColor-rest,#d1d9e0);',
      'border-radius:6px;cursor:pointer;white-space:nowrap;',
      '-webkit-appearance:none;appearance:none;text-decoration:none;',
      '}',
      '#' + BTN_ID + ':hover{background-color:var(--button-default-bgColor-hover,#eff2f5);}',
      '#' + BTN_ID + ':focus-visible{outline:2px solid var(--focus-outlineColor,#0969da);outline-offset:-1px;}',
      '#' + BTN_ID + ' svg{fill:currentColor;flex-shrink:0;}'
    ].join('');
    (document.head || document.documentElement).appendChild(style);
  }

  function firstSibling(container) {
    for (var i = 0; i < container.children.length; i++) {
      if (container.children[i].id !== LI_ID) return container.children[i];
    }
    return null;
  }

  /*
   * 隣のボタンの並び方に合わせる。
   * ログイン時のコンテナは flex(gap:8px) なので li に余白は不要だが、
   * ログアウト時は float:left + margin-right:8px の旧レイアウト。
   * どちらかを決め打ちせず、実際の兄弟要素の計算済みスタイルを見て真似る。
   */
  function matchSiblingLayout(li, container) {
    var sibling = firstSibling(container);
    if (!sibling) return;
    try {
      var cs = window.getComputedStyle(sibling);
      if (cs.cssFloat && cs.cssFloat !== 'none') li.style.cssFloat = cs.cssFloat;
      if (cs.marginRight && cs.marginRight !== '0px') li.style.marginRight = cs.marginRight;
    } catch (e) {
      // 取得できなくても致命的ではないので黙って諦める
    }
  }

  /*
   * 隣のボタンの実際の高さに合わせる。
   * 高さを決め打ちしないのは、ログイン時（React）とログアウト時（旧UI）で
   * 高さの作り方が違ううえ、ボーダー幅が 0.5556px に解決される環境があり、
   * padding計算では1px弱ずれるため。実測して合わせるほうが確実で、
   * 将来GitHubがボタンサイズを変えても自動で追従する。
   */
  function matchSiblingHeight(container) {
    var btn = document.getElementById(BTN_ID);
    var sibling = firstSibling(container);
    if (!btn || !sibling) return;
    try {
      var target = sibling.querySelector('button, a') || sibling;
      var h = target.getBoundingClientRect().height;
      // レイアウト前(0)や異常値は無視し、CSS既定の28pxのままにする
      if (h >= 16 && h <= 64) btn.style.height = h.toFixed(3) + 'px';
    } catch (e) {
      // 測れなければ既定値のままで問題ない
    }
  }

  function onClick(event) {
    /*
     * 利用者が実際に押したときだけ動かす。
     * ページ側のスクリプトから `btn.click()` を呼べば投稿画面を開けてしまう
     * 状態だった（2026-08-05の第4回監査で指摘）。実害は「勝手に投稿される」
     * ではなく「勝手に投稿画面が開く」だが、利用者の操作を起点にする設計
     * そのものが崩れるので塞ぐ。
     * isTrusted が読めない環境では、従来どおり動かす（機能を壊さない）。
     */
    if (event && event.isTrusted === false) return;
    event.preventDefault();
    event.stopPropagation();

    /*
     * 文面の組み立てで例外が出ても「押しても何も起きない」で終わらせない。
     * 最低限URLだけは共有できるようフォールバックする。
     */
    var share = null;
    var threw = false;
    var reason = null;
    try {
      var res = window.GXS && window.GXS.buildShareResult(location.href, document.title);
      if (res && res.ok) share = res.share;
      else if (res) reason = res.reason;
    } catch (e) {
      threw = true;
    }
    /*
     * 対象外・機微・資格情報の疑いで開かなかったときは、**理由だけ**を
     * 伝える（第12回監査 R12-002）。以前は黙って何も起きず、利用者には
     * 壊れているのか意図的なのか分からなかった。
     * 表示するのは決まった文だけで、URLも値も出さない。
     */
    if (!share && !threw) {
      showNotice(reason);
      return;
    }
    /*
     * 例外が出た場合だけ、URLだけの共有にフォールバックする（URL方針は本体と同じものを使う）。
     * 方針が使えない・機微ページと判定された場合は何も開かない。
     * 判断がつかないときは共有しない側へ倒す。
     */
    if (!share) {
      var bare = window.GXS ? window.GXS.fallbackUrl(location.href) : null;
      if (!bare) return;
      share = { intentUrl: 'https://x.com/intent/post?url=' + encodeURIComponent(bare) };
    }

    openShareWindow(share.intentUrl);
  }

  /* ------------------------------------------------------------
   * 開かなかった理由を、値を出さずに伝える（第12回監査 R12-002）
   * ------------------------------------------------------------
   * ・出すのは決まった文だけ。URL・パラメータ名・値は出さない
   * ・role="status" で読み上げに乗せ、focus は奪わない
   * ・数秒で消す
   */
  var NOTICE_ID = 'gxs-notice';
  var NOTICE_MS = 6000;

  function noticeTextFor(reason) {
    if (reason === 'credential_like') {
      /*
       * 予備の文言も翻訳ファイルと同じにしておく（第15回監査の確認中に、
       * ここだけ「このURLには」の旧文のまま残っているのを見つけた）。
       */
      return t('noticeCredential',
        "This page's title or URL may contain sensitive authentication information, " +
        'so the X composer was not opened. Nothing was sent to X.');
    }
    if (reason === 'open_failed') {
      /* 開こうとしたが開けなかった（第15回監査 R15-005）。黙って終わらない */
      return t('noticeOpenFailed',
        'The X composer could not be opened. Nothing was sent to X.');
    }
    return t('noticeUnsupported', 'This page cannot be shared. Nothing was sent to X.');
  }

  function showNotice(reason) {
    var text = noticeTextFor(reason);
    var el = document.getElementById(NOTICE_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = NOTICE_ID;
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.style.cssText = [
        'position:fixed', 'z-index:2147483647', 'right:16px', 'bottom:16px',
        'max-width:min(92vw,380px)', 'padding:10px 14px', 'border-radius:8px',
        'font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'background:#1f2328', 'color:#fff', 'box-shadow:0 4px 16px rgba(0,0,0,.3)'
      ].join(';');
      document.body.appendChild(el);
    }
    el.textContent = text;          // 文字列として入れる（HTMLとして解釈させない）
    if (el.gxsTimer) clearTimeout(el.gxsTimer);
    el.gxsTimer = setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, NOTICE_MS);
  }

  /*
   * ツールバー・ショートカットから開けなかったときも、同じ案内を出す。
   * service worker からは**理由の語だけ**を送る（値は送らない）。
   */
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === 'gxs-notice') showNotice(msg.reason);
    });
  }

  /*
   * 共有ウィンドウは service worker に開いてもらう。
   *
   * ここで window.open すると、開いたウィンドウを拡張が識別する手段が
   * window.name（＝どのページからでも詐称できる固定文字列）しか無くなる。
   * service worker 経由なら chrome.windows.create が返す windowId を
   * 所有権の根拠にでき、Esc の判定が推測でなくなる。
   *
   * 依頼が届かない場合（拡張の更新直後など）は素の window.open で開く。
   * その窓は記録されないので Esc では閉じない＝安全側に倒れる。
   */
  function openShareWindow(intentUrl) {
    var fellBack = false;
    function fallback() {
      if (fellBack) return;
      fellBack = true;
      window.open(intentUrl, '_blank', 'width=560,height=640,noopener,noreferrer,scrollbars=yes,resizable=yes');
    }
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        fallback();
        return;
      }
      chrome.runtime.sendMessage({ type: 'gxs:open-share', url: intentUrl }, function (res) {
        if (chrome.runtime.lastError || !res || !res.ok) fallback();
      });
    } catch (e) {
      fallback();
    }
  }

  /*
   * 表示する文字は言語ファイル（_locales）から取る。
   * ツールチップが日本語で固定されていたため、英語圏の利用者には
   * 意味の分からない文字列が出ていた（アナリティクスで米国・Windowsからの
   * 利用を確認したのがきっかけ・2026-08-05）。
   * 取得できない場合に備えて英語を既定にしておく。
   */
  function t(key, fallback) {
    try {
      var s = chrome && chrome.i18n && chrome.i18n.getMessage ? chrome.i18n.getMessage(key) : '';
      return s || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function buildButton() {
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.title = t('shareButtonTooltip', 'Post this page to X');
    btn.setAttribute('aria-label', t('shareButtonAria', 'Share on X'));
    btn.innerHTML = X_ICON + '<span></span>';
    // 文字は textContent で入れる（言語ファイルの中身をHTMLとして解釈させない）
    btn.querySelector('span').textContent = t('shareButtonLabel', 'Share');
    btn.addEventListener('click', onClick);
    return btn;
  }

  function inject() {
    var container = findContainer();
    if (!container) return false;                      // 目印が無い＝何もしない
    if (document.getElementById(LI_ID)) return true;   // 既にある＝二重注入しない

    try {
      ensureStyle();
      /*
       * 器のタグはコンテナに合わせる。リポジトリ側は <ul> なので <li>、
       * Issue/PR側は <div> の flex 行なので <div>。<ul> 以外に <li> を置くのは
       * 不正なHTMLで、ブラウザによって扱いが変わりうるため合わせている。
       */
      var isList = container.tagName === 'UL' || container.tagName === 'OL';
      var li = document.createElement(isList ? 'li' : 'div');
      li.id = LI_ID;
      if (!isList) {
        // flex行の中で、隣のボタンと縦位置を揃える
        li.style.display = 'flex';
        li.style.alignItems = 'center';
      }
      li.appendChild(buildButton());
      matchSiblingLayout(li, container);
      container.prepend(li);                           // prepend＝ボタン群の左端
      matchSiblingHeight(container);
      // 隣のボタンのレイアウトが遅れて確定する場合に備えて数回だけ測り直す
      [100, 500, 1500].forEach(function (delay) {
        setTimeout(function () {
          var c = findContainer();
          if (c && document.getElementById(BTN_ID)) matchSiblingHeight(c);
        }, delay);
      });
      return true;
    } catch (e) {
      return false;                                    // 何があってもGitHubの画面は壊さない
    }
  }

  /*
   * GitHubはページ全体を読み込み直さずに画面を切り替える（Turbo）。
   * 実測ではボタンは遷移後も生き残ったが、リポジトリをまたぐ移動などで
   * 消える可能性は残るため、1秒ごとに存在を確認して必要なら入れ直す。
   * 処理は querySelector 2回ぶんなので負荷は無視できる。
   *
   * ただしChromeは非表示タブのタイマーを凍結する（実測: hidden状態では
   * 9秒間で発火0回、visible状態では9回）。裏に回っている間に消されると
   * 復帰が遅れるため、タブが表示に戻った時点でも即座に入れ直す。
   */
  function start() {
    inject();
    setInterval(inject, 1000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') inject();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
