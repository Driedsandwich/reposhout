/*
 * background.js — 共有ウィンドウの生成と所有権の管理
 *
 * ここが唯一の「共有ウィンドウを開く場所」。
 * ツールバー・ショートカット・画面内Shareボタンの3経路とも、最終的に
 * この service worker の openShareWindow() を通る。
 *
 * こうしている理由は、Escで閉じてよいウィンドウの判定を
 * chrome.windows.create() が返す windowId ただ1つに一本化するため。
 * v1.0.1 までは content script が window.open(..., 'gxs-share-window', ...)
 * で開き、x.com 側は window.name がその固定文字列かどうかで判定していた。
 * 名前は公開リポジトリに書かれた定数で、どのページからでも同じ名前の
 * ウィンドウを作れるため、所有権の根拠にならない（2026-08-04の監査で指摘）。
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
 * 共有ウィンドウの記録。
 *
 * MV3 の service worker は数十秒で停止し、次のイベントで作り直される。
 * メモリ上の Set に置くと、その間に記録が消えて Esc が効かなくなる
 * （v1.0.1 の実挙動。誤って他を閉じる方向ではないが、機能としては壊れている）。
 * chrome.storage.session は service worker の再起動をまたいで残り、
 * ブラウザを閉じると消える。ディスクにも残らないので共有履歴が溜まらない。
 *
 * 既定でアクセスできるのは信頼されたコンテキスト（この service worker）だけで、
 * content script からは読めない。setAccessLevel は呼ばない。
 */
var STORE_KEY = 'shareWindows';
var MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12時間で失効（消し忘れ・ID再利用への保険）

/* 直列化して read-modify-write の競合を避ける */
var queue = Promise.resolve();
function serialize(fn) {
  var next = queue.then(fn, fn);
  queue = next.catch(function () {});
  return next;
}

async function readRecords() {
  try {
    var got = await chrome.storage.session.get(STORE_KEY);
    var rec = (got && got[STORE_KEY]) || {};
    return typeof rec === 'object' && rec !== null ? rec : {};
  } catch (e) {
    return {};
  }
}

async function writeRecords(rec) {
  try {
    var obj = {};
    obj[STORE_KEY] = rec;
    await chrome.storage.session.set(obj);
  } catch (e) {
    // 保存できない場合、Escが効かなくなるだけで誤爆側には倒れない
  }
}

function prune(rec, now) {
  var out = {};
  Object.keys(rec).forEach(function (id) {
    if (typeof rec[id] === 'number' && now - rec[id] <= MAX_AGE_MS) out[id] = rec[id];
  });
  return out;
}

function rememberShareWindow(windowId) {
  return serialize(async function () {
    var now = Date.now();
    var rec = prune(await readRecords(), now);
    rec[String(windowId)] = now;
    await writeRecords(rec);
  });
}

function forgetShareWindow(windowId) {
  return serialize(async function () {
    var rec = await readRecords();
    if (Object.prototype.hasOwnProperty.call(rec, String(windowId))) {
      delete rec[String(windowId)];
      await writeRecords(rec);
    }
  });
}

function isShareWindow(windowId) {
  return serialize(async function () {
    var now = Date.now();
    var rec = await readRecords();
    var at = rec[String(windowId)];
    if (typeof at !== 'number') return false;
    if (now - at > MAX_AGE_MS) {
      delete rec[String(windowId)];
      await writeRecords(rec);
      return false;
    }
    return true;
  });
}

/*
 * 共有ウィンドウを開く。
 *
 * ポップアップが作れない環境では通常タブで開くが、そのタブは記録しない
 * ＝ Esc では閉じない。利用者が自分で開いたタブと見分けがつかない場所に
 * 出るものを、キー1つで閉じる対象にしないための線引き。
 */
async function openShareWindow(intentUrl) {
  try {
    var win = await chrome.windows.create({
      url: intentUrl,
      type: 'popup',
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT
    });
    if (win && typeof win.id === 'number') {
      await rememberShareWindow(win.id);
      return { opened: 'popup', windowId: win.id };
    }
    return { opened: 'popup', windowId: null };
  } catch (e) {
    try {
      await chrome.tabs.create({ url: intentUrl });
      return { opened: 'tab', windowId: null };  // 記録しない＝Esc対象外
    } catch (e2) {
      return { opened: 'none', windowId: null };
    }
  }
}

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
  if (!share && !threw) return; // github.com 以外・認証や設定の画面では何もしない
  if (!share) {
    // フォールバックも本体と同じURL方針を使う（別実装を残さない）。
    // null が返るのは機微なページなので、その場合も何も開かない。
    var bare = self.GXS.fallbackUrl(tab.url);
    if (!bare) return;
    share = { intentUrl: self.GXS.intentUrlFor('', bare) };
  }

  await openShareWindow(share.intentUrl);
}

// MV3のservice workerは停止と再開を繰り返すため、リスナーは必ずトップレベルで登録する
chrome.action.onClicked.addListener(function () {
  shareActiveTab();
});

chrome.commands.onCommand.addListener(function (command) {
  if (command === 'share-to-x') shareActiveTab();
});

/*
 * メッセージの入口。
 *  gxs:open-share       … 画面内Shareボタン（content script）からの依頼
 *  gxs:is-share-window  … x.com の esc-close.js からの照会
 *  gxs:close-share-window … window.close() が拒否されたときのフォールバック
 *
 * 所有権の根拠は「自分が chrome.windows.create で開いた windowId」だけ。
 * 覚えのないウィンドウには常に false を返す（利用者の通常のXタブを守る）。
 */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !sender) return false;

  if (msg.type === 'gxs:open-share') {
    // 送信元が github.com のタブであることを確かめる（他サイトからの依頼で窓を開かない）
    var from = sender.tab && sender.tab.url;
    var okOrigin = false;
    try {
      okOrigin = !!from && new URL(from).origin === 'https://github.com';
    } catch (e) {
      okOrigin = false;
    }
    if (!okOrigin || typeof msg.url !== 'string' || msg.url.indexOf('https://x.com/intent/') !== 0) {
      sendResponse({ ok: false });
      return false;
    }
    openShareWindow(msg.url).then(function (r) {
      try { sendResponse({ ok: r.opened !== 'none', opened: r.opened }); } catch (e) {}
    });
    return true; // 非同期応答
  }

  if (msg.type === 'gxs:is-share-window') {
    if (!sender.tab) { sendResponse({ isShareWindow: false }); return false; }
    var wid = sender.tab.windowId;
    isShareWindow(wid).then(function (ours) {
      try { sendResponse({ isShareWindow: !!ours }); } catch (e) {}
    });
    return true; // 非同期応答
  }

  if (msg.type === 'gxs:close-share-window') {
    if (!sender.tab) return false;
    var id = sender.tab.windowId;
    isShareWindow(id).then(function (ours) {
      if (!ours) return;
      chrome.windows.remove(id).catch(function () {});
    });
    return false;
  }

  return false;
});

// 閉じられたウィンドウの記録を捨てる（IDは再利用されうるため放置しない）
chrome.windows.onRemoved.addListener(function (windowId) {
  forgetShareWindow(windowId);
});

// 拡張の更新・再読み込み直後に古い記録が残らないようにする
chrome.runtime.onInstalled.addListener(function () {
  serialize(function () { return writeRecords({}); });
});

// テスト（実拡張E2E）から実装そのものを呼べるようにする。公開APIではない。
self.GXS_BG = {
  openShareWindow: openShareWindow,
  shareActiveTab: shareActiveTab,
  rememberShareWindow: rememberShareWindow,
  forgetShareWindow: forgetShareWindow,
  isShareWindow: isShareWindow,
  readRecords: readRecords,
  STORE_KEY: STORE_KEY,
  MAX_AGE_MS: MAX_AGE_MS
};
