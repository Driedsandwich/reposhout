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
    event.preventDefault();
    event.stopPropagation();

    /*
     * 文面の組み立てで例外が出ても「押しても何も起きない」で終わらせない。
     * 最低限URLだけは共有できるようフォールバックする。
     */
    var share = null;
    var threw = false;
    try {
      share = window.GXS && window.GXS.buildShare(location.href, document.title);
    } catch (e) {
      threw = true;
    }
    // 対象外ページ（buildShareがnullを返した）なら何もしない
    if (!share && !threw) return;
    // 例外が出た場合だけ、URLだけの共有にフォールバックする
    if (!share) {
      var bare = location.origin + location.pathname;
      share = { intentUrl: 'https://x.com/intent/post?url=' + encodeURIComponent(bare) };
    }

    // Xの共有ポップアップ相当のサイズ。投稿ボタンはX側で本人が押す。
    window.open(
      share.intentUrl,
      'gxs-share-window',
      'width=560,height=640,noopener,noreferrer,scrollbars=yes,resizable=yes'
    );
  }

  function buildButton() {
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.title = 'このページをXに投稿する';
    btn.setAttribute('aria-label', 'Share on X');
    btn.innerHTML = X_ICON + '<span>Share</span>';
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
