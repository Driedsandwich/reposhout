/*
 * background.js — ツールバーアイコンとキーボードショートカットの入口
 *
 * ログイン状態のIssue/PRページには、GitHubの新UIにFork/Star等のボタン行が
 * そもそも存在しない（2026-07-31実測）。そこへボタンを差し込むことはできないため、
 * ページのHTMLに一切依存しないこの入口を用意する。
 *
 * ここは tab.url と tab.title しか使わない。DOMを読まないので、
 * GitHubがUIをどう作り替えても影響を受けない。
 */
'use strict';

importScripts('/src/share.js');

// Xの共有ポップアップ相当のサイズ
var POPUP_WIDTH = 560;
var POPUP_HEIGHT = 640;

/*
 * ツールバー / ショートカット経由で開いた共有用ウィンドウのIDを覚えておく。
 * x.com 側の esc-close.js が「このウィンドウは閉じてよいか」を照合するために使う。
 *
 * service worker が停止すると失われるが、それで壊れるのは
 * 「Esc が効かない」だけで、誤って他のウィンドウを閉じる方向には倒れない。
 * content script から window.open で開いた経路は window.name で判定できるため、
 * この記録に依存しない。
 */
var shareWindowIds = new Set();

async function shareActiveTab() {
  var tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    return;
  }

  var tab = tabs && tabs[0];
  // activeTab 権限はユーザー操作（アイコン押下・ショートカット）で付与される。
  // それでも url が取れない場合は何もしない。
  if (!tab || !tab.url) return;

  // 文面の組み立てで例外が出ても無反応にせず、URLだけの共有にフォールバックする
  var share = null;
  var threw = false;
  try {
    share = self.GXS.buildShare(tab.url, tab.title);
  } catch (e) {
    threw = true;
  }
  if (!share && !threw) return; // github.com 以外では何もしない
  if (!share) {
    var bare = tab.url.split('#')[0].split('?')[0];
    share = { intentUrl: 'https://x.com/intent/post?url=' + encodeURIComponent(bare) };
  }

  try {
    var win = await chrome.windows.create({
      url: share.intentUrl,
      type: 'popup',
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT
    });
    // Esc で閉じてよいウィンドウとして記録する（esc-close.js からの照合用）
    if (win && typeof win.id === 'number') shareWindowIds.add(win.id);
  } catch (e) {
    // ポップアップが作れない環境では通常のタブで開く
    try {
      await chrome.tabs.create({ url: share.intentUrl });
    } catch (e2) {
      // ここまで失敗したら諦める。ブラウザ側の状態は壊さない。
    }
  }
}

// MV3のservice workerは停止と再開を繰り返すため、リスナーは必ずトップレベルで登録する
chrome.action.onClicked.addListener(function () {
  shareActiveTab();
});

chrome.commands.onCommand.addListener(function (command) {
  if (command === 'share-to-x') shareActiveTab();
});

/*
 * x.com 上の esc-close.js からの照会に答える。
 * 「そのウィンドウを自分が共有用に開いたか」だけを返し、
 * 覚えのないウィンドウには常に false を返す（利用者の通常のXタブを守る）。
 */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !sender || !sender.tab) return false;
  var windowId = sender.tab.windowId;

  if (msg.type === 'gxs:is-share-window') {
    sendResponse({ isShareWindow: shareWindowIds.has(windowId) });
    return false;
  }

  if (msg.type === 'gxs:close-share-window') {
    // window.close() が拒否された場合のフォールバック。
    // ここでも記録に無いウィンドウは閉じない。
    if (shareWindowIds.has(windowId)) {
      chrome.windows.remove(windowId).catch(function () {});
    }
    return false;
  }

  return false;
});

// 閉じられたウィンドウのIDを捨てる（IDは再利用されうるため放置しない）
chrome.windows.onRemoved.addListener(function (windowId) {
  shareWindowIds.delete(windowId);
});
