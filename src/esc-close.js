/*
 * esc-close.js — 共有用ポップアップを Esc で閉じる
 *
 * このスクリプトは x.com 上で動く。したがって最優先の要件は
 * **利用者が普通に開いている X のタブを絶対に閉じないこと**。
 *
 * そのため「たぶん共有用だろう」という推測（URLの形・ウィンドウの大きさ・
 * 履歴の長さ・ウィンドウの名前）は一切使わない。根拠は1つだけにする。
 *
 *   拡張の service worker が chrome.windows.create() で開いたときに
 *   記録した windowId と、いまこのタブが属する windowId が一致すること。
 *
 * v1.0.1 までは window.name が 'gxs-share-window' であることも根拠にしていた。
 * これは公開リポジトリに書かれた固定文字列で、どのページからでも
 * window.open(url, 'gxs-share-window') で同じ名前のウィンドウを作れるため、
 * 所有権の証明にならない（2026-08-04の監査で指摘・修正）。
 *
 * windowId は拡張の内部にしか無く、ページ側からは観測も詐称もできない。
 */
(function () {
  'use strict';

  /* このウィンドウが拡張の開いた共有用ポップアップかを service worker に照会する */
  function isOurShareWindow(callback) {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        callback(false);
        return;
      }
      /*
       * MV3 の service worker は停止していることがあるが、
       * このメッセージ自体が起動のきっかけになり、
       * 起動後は chrome.storage.session から記録を読み直して答える。
       * （メモリ上の記録だけに頼っていた版では、ここで答えが失われていた）
       */
      chrome.runtime.sendMessage({ type: 'gxs:is-share-window' }, function (res) {
        // 応答が無い（拡張が更新された等）場合は false 扱い。
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
