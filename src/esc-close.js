/*
 * esc-close.js — 共有用ポップアップを Esc で閉じる
 *
 * このスクリプトは x.com 上で動く。したがって最優先の要件は
 * **利用者が普通に開いている X のタブを絶対に閉じないこと**。
 *
 * そのため「たぶん共有用だろう」という推測（URLの形・ウィンドウの大きさ・
 * 履歴の長さ）は一切使わない。次の2つの同一性の確認だけを根拠にする。
 *
 *  1. window.name が拡張の付けた名前と一致する
 *     （content script から window.open で開いた経路。
 *      noopener を付けていても name は残ることを実測確認済み）
 *  2. service worker が「このウィンドウは自分が共有用に開いたものだ」と答える
 *     （ツールバー / ショートカット経路。windowId で照合する）
 *
 * どちらも満たさなければ何もしない。
 */
(function () {
  'use strict';

  var WINDOW_NAME = 'gxs-share-window';

  /* このウィンドウが拡張の開いた共有用ポップアップかを判定する */
  function isOurShareWindow(callback) {
    // 経路1: 名前が一致すれば、それだけで確定する
    if (window.name === WINDOW_NAME) {
      callback(true);
      return;
    }
    // 経路2: service worker に windowId で照合してもらう
    try {
      chrome.runtime.sendMessage({ type: 'gxs:is-share-window' }, function (res) {
        // 応答が無い（service worker が停止していた等）場合は false 扱い。
        // 判断がつかないときは「閉じない」側に倒す。
        if (chrome.runtime.lastError) {
          callback(false);
          return;
        }
        callback(!!(res && res.isShareWindow));
      });
    } catch (e) {
      callback(false);
    }
  }

  function closeThisWindow() {
    try {
      window.close();
    } catch (e) {
      // window.close() が拒否された場合に備えて、service worker 側からも閉じてもらう
    }
    // 閉じられなかったときのフォールバック（chrome.windows.remove は追加権限を要さない）
    setTimeout(function () {
      if (!window.closed) {
        try {
          chrome.runtime.sendMessage({ type: 'gxs:close-share-window' });
        } catch (e) {
          // ここまで失敗したら諦める。利用者は ⌘W で閉じられる。
        }
      }
    }, 120);
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    // 修飾キー付きの Esc は別操作なので拾わない
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    // 変換中（IME）の Esc は変換の取り消しなので拾わない
    if (event.isComposing || event.keyCode === 229) return;

    isOurShareWindow(function (ours) {
      if (!ours) return;
      closeThisWindow();
    });
  }

  /*
   * capture phase で登録する。X 自身も Esc でモーダルを閉じるハンドラを持っており
   * （preventDefault は呼ぶが stopPropagation は呼ばない）、
   * 先に捕まえないと「モーダルだけ閉じて空の X が残る」状態になりうるため。
   */
  window.addEventListener('keydown', onKeyDown, true);
})();
