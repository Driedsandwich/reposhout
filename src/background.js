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
 * ここは tab.url しか使わない。DOMもページのタイトルも読まないので、
 * GitHubがUIをどう作り替えても影響を受けない。
 *
 * 第16回監査 R16-003 以降、**外へ何を出すかを決めるのはこの file だけ**。
 * 画面内Shareボタンも「押されました」だけを送ってきて、URLも投稿文も
 * ここで組み立てる。content script は判断を持たない。
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

/*
 * 理由の語だけを content script へ送る。**届いたかどうかを返す**
 * （第14回監査 R14-003。届かなかったときにバッジへ回すため）。
 */
async function notifyTab(tabId, reason) {
  if (typeof tabId !== 'number') return false;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'gxs-notice', reason: reason || 'unsupported' });
    return true;
  } catch (e) {
    /* content script がいないページでは届かない。追加の権限は求めない */
    return false;
  }
}

/*
 * 案内が画面へ届かないとき（GitHub以外のページ、拡張を更新した直後の
 * 未再読込タブなど）の代わり（第14回監査 R14-003）。
 * ツールバーのアイコンに `!` を出し、少ししてから消す。
 * **値もURLもパラメータ名も出さない**——出せる場所ではないため。
 */
var BADGE_MS = 6000;
var badgeTimers = {};

/* 理由ごとの定型文。値もURLも入れない */
function titleFor(reason) {
  if (reason === 'credential_like') return chrome.i18n.getMessage('noticeCredential');
  if (reason === 'open_failed') return chrome.i18n.getMessage('noticeOpenFailed');
  if (reason === 'reload_required') return chrome.i18n.getMessage('noticeReloadRequired');
  return chrome.i18n.getMessage('noticeUnsupported');
}

async function flagTab(tabId, reason) {
  if (typeof tabId !== 'number') return false;
  var key = String(tabId);
  try {
    await chrome.action.setBadgeText({ tabId: tabId, text: '!' });
    if (chrome.action.setBadgeBackgroundColor) {
      await chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#B42318' });
    }
    await chrome.action.setTitle({ tabId: tabId, title: titleFor(reason) });
  } catch (e) {
    return false;                       // バッジも出せない相手なら、そこで終わり
  }
  if (badgeTimers[key]) clearTimeout(badgeTimers[key]);
  badgeTimers[key] = setTimeout(function () {
    delete badgeTimers[key];
    /*
     * 元へ戻す。**空文字ではなく既定の説明文を明示的に入れる**
     * （第15回監査 R15-005。空にすると、既定へ戻るかは実装依存になる）。
     */
    Promise.resolve(chrome.action.setBadgeText({ tabId: tabId, text: '' })).catch(function () {});
    Promise.resolve(chrome.action.setTitle({
      tabId: tabId, title: chrome.i18n.getMessage('actionTitle')
    })).catch(function () {});
  }, BADGE_MS);
  return true;
}

/* 画面内の案内を試し、届かなければバッジへ回す */
async function announceRefusal(tabId, reason) {
  var delivered = await notifyTab(tabId, reason);
  if (delivered) return 'notice';
  return (await flagTab(tabId, reason)) ? 'badge' : 'none';
}

/*
 * ツールバーの押下・ショートカットは、Chrome が**そのとき対象になったタブ**を
 * 渡してくる。第13回監査 R13-003 まではそれを捨てて chrome.tabs.query で
 * 引き直していたので、
 *
 *   ・渡されたタブは正常なのに query の結果に url が無く、何も起きない
 *   ・渡されたタブ A と query の結果 B が違い、**B のほうを共有する**
 *
 * ということが起きえた（activeTab は「操作されたタブ」にだけ付く）。
 * 渡されたタブをそのまま使い、無いときだけ引き直す。
 */
async function shareTab(tab) {
  /*
   * 第14回監査 R14-002。以前は `!tab || !tab.url` で引き直していたので、
   * **タブは渡されているのに url だけ取れなかった**とき、別のタブ B を
   * 引き直して B を共有し、B へ案内を送っていた（実測）。
   * タブが渡されたら、そのタブ以外へは行かない。
   */
  if (tab !== undefined && tab !== null) {
    if (!tab.url) {
      /* activeTab はユーザー操作で付くが、それでも取れないことはある。
         別のタブで代替せず、そのタブへ理由を伝えて終わる */
      await announceRefusal(tab.id, 'unsupported');
      return;
    }
    return shareResolvedTab(tab);
  }

  var fallback = await queryActiveTab();
  if (!fallback || !fallback.url) return;
  return shareResolvedTab(fallback);
}

/* 送信元が github.com のタブか（他サイトからの依頼で窓を開かない） */
function isGitHubTab(tab) {
  try {
    return !!(tab && tab.url) && new URL(tab.url).origin === 'https://github.com';
  } catch (e) {
    return false;
  }
}

/* ここから先は、渡された1つのタブだけを見る（URL・案内先・判断） */
async function shareResolvedTab(tab) {
  // 文面の組み立てで例外が出ても無反応にせず、URLだけの共有にフォールバックする
  var share = null;
  var threw = false;
  var reason = null;
  try {
    /* タイトルは渡さない（第15回監査 R15-001 で使わなくなった・第16回監査 R16-004） */
    var res = self.GXS.buildShareResult(tab.url);
    if (res && res.ok) share = res.share;
    else if (res) reason = res.reason;
  } catch (e) {
    threw = true;
  }
  if (!share && !threw) {
    /*
     * 開かなかった理由を、そのタブの content script へ**語だけ**送る
     * （第12回監査 R12-002）。値もURLも送らない。届かない場合（GitHub以外の
     * ページなど content script がいない）は、ツールバーのバッジで伝える
     * （第14回監査 R14-003。以前はここで黙って終わっていた）。
     */
    await announceRefusal(tab.id, reason);
    return { opened: false, reason: reason };
  }
  if (!share) {
    // フォールバックも本体と同じURL方針を使う（別実装を残さない）。
    // null が返るのは機微なページなので、その場合も何も開かない。
    var bare = self.GXS.fallbackUrl(tab.url);
    if (!bare) return { opened: false, reason: 'unsupported' };
    share = { intentUrl: self.GXS.intentUrlFor('', bare) };
  }

  /*
   * 第15回監査 R15-005。戻り値を捨てていたので、ポップアップもタブも開けなかった
   * とき（どちらの API も例外）に、**何も起きないまま終わって**いた。
   */
  var opened = await openShareWindow(share.intentUrl);
  if (!opened || opened.opened === 'none') {
    await announceRefusal(tab.id, 'open_failed');
    return { opened: false, reason: 'open_failed' };
  }
  return { opened: true };
}

/* 渡されなかったときだけ、いまのタブを引き直す */
async function queryActiveTab() {
  try {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0];
  } catch (e) {
    return null;
  }
}

// MV3のservice workerは停止と再開を繰り返すため、リスナーは必ずトップレベルで登録する
// Chrome が渡してくるタブをそのまま使う（第13回監査 R13-003）
chrome.action.onClicked.addListener(function (tab) {
  shareTab(tab);
});

chrome.commands.onCommand.addListener(function (command, tab) {
  if (command === 'share-to-x') shareTab(tab);
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

  /*
   * 画面内Shareボタンからの依頼（第16回監査 R16-003）。
   *
   * **渡されるのは「押されました」だけ。** 何を出すかはここで決める。
   * 送信元のタブのURLへ、いまの方針（GXS.buildShareResult）をその場で当てる。
   * ツールバー・ショートカットと同じ shareResolvedTab を通るので、
   * 3つの入口で方針が食い違うことがない。
   */
  if (msg.type === 'gxs:request-share') {
    if (!isGitHubTab(sender.tab)) {
      sendResponse({ ok: false });
      return false;
    }
    shareResolvedTab(sender.tab).then(function (r) {
      try { sendResponse({ ok: !!(r && r.opened), reason: r && r.reason }); } catch (e) {}
    }, function () {
      try { sendResponse({ ok: false }); } catch (e) {}
    });
    return true; // 非同期応答
  }

  /*
   * 1.1.8以前の content script が送ってくる形。**渡されたURLは使わない。**
   *
   * 以前はここで msg.url をそのまま開いていた。確かめていたのは
   * 「送信元が github.com」と「x.com/intent で始まる」の2つだけで、中身は
   * 見ていない。監査は実配布ZIPで、資格情報を載せた完成品がそのまま開くことを
   * 再現している。
   *
   * 返す ok:true は「開いた」ではなく「**こちらで処理したので、そちらで
   * window.open するな**」の意味。古い content script は !res.ok で素の
   * window.open へ倒れる作りなので、ここで false を返すと、止めたはずの
   * 古い方針のURLがかえって開いてしまう。
   */
  if (msg.type === 'gxs:open-share') {
    var legacyTab = sender.tab;
    var answer = function () {
      try { sendResponse({ ok: true, opened: 'none', legacy: true }); } catch (e) {}
    };
    if (legacyTab && typeof legacyTab.id === 'number') {
      announceRefusal(legacyTab.id, 'reload_required').then(answer, answer);
      return true; // 非同期応答
    }
    answer();
    return false;
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
  notifyTab: notifyTab,
  flagTab: flagTab,
  titleFor: titleFor,
  BADGE_MS: BADGE_MS,
  announceRefusal: announceRefusal,
  shareTab: shareTab,
  shareResolvedTab: shareResolvedTab,
  queryActiveTab: queryActiveTab,
  openShareWindow: openShareWindow,
  shareActiveTab: shareTab,   // 旧名（E2Eと互換）
  rememberShareWindow: rememberShareWindow,
  forgetShareWindow: forgetShareWindow,
  isShareWindow: isShareWindow,
  readRecords: readRecords,
  STORE_KEY: STORE_KEY,
  MAX_AGE_MS: MAX_AGE_MS
};
