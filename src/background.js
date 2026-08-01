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
    await chrome.windows.create({
      url: share.intentUrl,
      type: 'popup',
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT
    });
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
