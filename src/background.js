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
/*
 * 12時間で**失効**させる（第21回監査 R21-002 で根拠を書き直した）。
 *
 * ⚠️ これは「12時間で消える」という意味ではない。**物理的に消えるのは**
 *   ・その窓を閉じたとき（windows.onRemoved）
 *   ・Chrome が session storage を消したとき
 *     （ブラウザ終了／拡張の無効化・再読み込み・更新。公式仕様）
 *   ・失効した記録を、次に誰かが読んだとき（isShareWindow / prune）
 * の3つだけで、**12時間の時点で起きて消すタイマーは置いていない**。
 *
 * 以前ここには「ID再利用への保険」と書いていたが、これは根拠として誤り。
 * ウィンドウIDは同じブラウザセッション内で一意で、session storage は
 * ブラウザを再起動すれば消えるので、再利用と衝突する場面が作れない。
 * **正しい根拠は「古い記録を、いつまでも Esc の許可として使わない」こと。**
 */
var MAX_AGE_MS = 12 * 60 * 60 * 1000;

/* 直列化して read-modify-write の競合を避ける */
var queue = Promise.resolve();
function serialize(fn) {
  var next = queue.then(fn, fn);
  queue = next.catch(function () {});
  return next;
}

/*
 * ⚠️ **読めたかどうかと、読めた中身を分けて返す。**（第23回監査 R23-003）
 *
 * 前は読み取りに失敗すると `{}` を返していた。すると呼び出し側から見て
 * 「台帳が空だった」と区別がつかず、`rememberShareWindow` が
 * **既にある記録を消して**新しい1件だけを書いていた（実測）。
 * 読めなかったのなら、書いてはいけない。
 */
async function readRecords() {
  try {
    var got = await chrome.storage.session.get(STORE_KEY);
    var rec = got ? got[STORE_KEY] : undefined;
    if (rec === undefined || rec === null) return { ok: true, records: {}, errorKind: null };
    if (typeof rec !== 'object' || Array.isArray(rec)) {
      /* 形が壊れている。読めてはいるので、空として扱い直す（誤爆側へ倒さない） */
      return { ok: true, records: {}, errorKind: 'malformed' };
    }
    return { ok: true, records: rec, errorKind: null };
  } catch (e) {
    return { ok: false, records: null, errorKind: 'read_failed' };
  }
}

/* 書けたかどうかを返す。握り潰すと、Escが効かないことに誰も気づけない */
async function writeRecords(rec) {
  try {
    var obj = {};
    obj[STORE_KEY] = rec;
    await chrome.storage.session.set(obj);
    return { ok: true, errorKind: null };
  } catch (e) {
    return { ok: false, errorKind: 'write_failed' };
  }
}

function prune(rec, now) {
  var out = {};
  Object.keys(rec).forEach(function (id) {
    if (typeof rec[id] === 'number' && now - rec[id] <= MAX_AGE_MS) out[id] = rec[id];
  });
  return out;
}

/* 覚えられたかどうかを返す（Escが使えるかは、これで決まる） */
function rememberShareWindow(windowId) {
  return serialize(async function () {
    var now = Date.now();
    var read = await readRecords();
    /*
     * ⚠️ **読めなかったときは書かない。**（第23回監査 R23-003）
     * 読み取り失敗を「空の台帳」に変えていたので、直後の書き込みが
     * **他の共有ウィンドウの記録を消して**いた。消えた窓は Esc で閉じられなくなる。
     */
    if (!read.ok) return { ok: false, errorKind: read.errorKind };
    var rec = prune(read.records, now);
    rec[String(windowId)] = now;
    var wrote = await writeRecords(rec);
    return wrote.ok ? { ok: true, errorKind: null } : { ok: false, errorKind: wrote.errorKind };
  });
}

function forgetShareWindow(windowId) {
  return serialize(async function () {
    var read = await readRecords();
    if (!read.ok) return { ok: false, errorKind: read.errorKind };
    var rec = read.records;
    if (Object.prototype.hasOwnProperty.call(rec, String(windowId))) {
      delete rec[String(windowId)];
      var wrote = await writeRecords(rec);
      return { ok: wrote.ok, errorKind: wrote.errorKind };
    }
    return { ok: true, errorKind: null };
  });
}

function isShareWindow(windowId) {
  return serialize(async function () {
    var now = Date.now();
    var read = await readRecords();
    /* 読めない＝「拡張が開いた窓だ」と言える根拠が無い＝閉じない */
    if (!read.ok) return false;
    var rec = read.records;
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
  /*
   * ⚠️ **「開いた」と「Escで閉じられる」は別。**（第23回監査 R23-003）
   *
   * 前は3つの結果を `opened: 'popup' | 'tab' | 'none'` へ畳んでいたので:
   *   ・`windows.create` が **undefined を返した**とき（公式仕様上ありうる）も
   *     `opened: 'popup'` ＝成功として返していた。開いたかどうかも分からないのに
   *   ・記録に失敗しても成功として返していたので、**Escが効かない**ことに
   *     呼び出し側が気づけなかった（実測: isShareWindow が false）
   *
   * 状態を分けて返す:
   * ⚠️ 「開かなかった」を表す `opened: false` は **refuse() の中だけ**に置く
   *    （第19回監査 R19-004 で出口を1つに縛ってある）。ここは内部の状態なので
   *    `windowOpened` という別の名前にしてある——同じ名前にすると、出口を
   *    数える検査が「出口が増えた」と読んでしまう。
   *
   *   popup_confirmed_tracked    窓が開き、記録できた（Escで閉じられる）
   *   popup_confirmed_untracked  窓は開いたが、記録できなかった（Escは効かない）
   *   creation_unknown           開いたかどうか分からない（IDが返らなかった）
   *   tab_confirmed              ポップアップを作れずタブで開いた（Esc対象外）
   *   failed                     どちらも開けなかった
   */
  var win = null;
  try {
    win = await chrome.windows.create({
      url: intentUrl,
      type: 'popup',
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT
    });
  } catch (e) {
    try {
      await chrome.tabs.create({ url: intentUrl });
      /* 記録しない＝Esc対象外。利用者が自分で開いたタブと見分けがつかないため */
      return { state: 'tab_confirmed', windowOpened: true, escAvailable: false, windowId: null };
    } catch (e2) {
      return { state: 'failed', windowOpened: false, escAvailable: false, windowId: null };
    }
  }
  if (!win || typeof win.id !== 'number') {
    /*
     * ⚠️ ここでタブを開かない。窓が実際には開いていた場合、**二重に開く**。
     * 開いたかどうかを言えないので、その通りに伝える（利用者へは案内を出す）。
     */
    return { state: 'creation_unknown', windowOpened: null, escAvailable: false, windowId: null };
  }
  var remembered = await rememberShareWindow(win.id);
  return remembered.ok
    ? { state: 'popup_confirmed_tracked', windowOpened: true, escAvailable: true, windowId: win.id }
    : { state: 'popup_confirmed_untracked', windowOpened: true, escAvailable: false,
        windowId: win.id, errorKind: remembered.errorKind };
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
  if (reason === 'open_unknown') return chrome.i18n.getMessage('noticeOpenUnknown');
  if (reason === 'reload_required') return chrome.i18n.getMessage('noticeReloadRequired');
  if (reason === 'esc_unavailable') return chrome.i18n.getMessage('noticeEscUnavailable');
  return chrome.i18n.getMessage('noticeUnsupported');
}

/*
 * 出したバッジを消す予約を入れる（第22回監査 R22-005 で本体から切り出した）。
 * 付け直したときは前の予約を捨てる——**前の予約が新しいバッジを消さない**ため。
 */
function scheduleBadgeCleanup(tabId) {
  var key = String(tabId);
  if (badgeTimers[key]) clearTimeout(badgeTimers[key]);
  badgeTimers[key] = setTimeout(function () {
    /*
     * 先に消す。**この後の API が失敗しても、次の付け直しが前の予約を
     * 消し損ねない**（世代の管理は API の成否と切り離す）。
     */
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
}

async function flagTab(tabId, reason) {
  if (typeof tabId !== 'number') return false;
  /*
   * ⚠️ **本体は「!」の文字だけ。色と説明文は見た目の補助。**（第22回監査 R22-005）
   *
   * 以前は3つを同じ try に入れ、消去の予約はその後ろに置いていた。すると
   * **色か説明文が失敗したときだけ**、`!` は画面に出ているのに消す予約が
   * 入らず、呼び出し元には「通知できなかった」と返っていた——
   * バッジは残り続け、しかも別の案内がもう1つ出る。
   *
   * 直し方は「本体が成功したか」で判定を分けること:
   *   ① `!` を出す。ここが失敗したときだけ通知の失敗とする
   *   ② 出せたら**その場で**消去を予約する（後続の失敗に巻き込まれない）
   *   ③ 色と説明文は個別に試し、失敗しても握って先へ進む
   */
  try {
    await chrome.action.setBadgeText({ tabId: tabId, text: '!' });
  } catch (e) {
    return false;                       // バッジも出せない相手なら、そこで終わり
  }
  scheduleBadgeCleanup(tabId);          // ★ 出した直後。色/説明文より前
  if (chrome.action.setBadgeBackgroundColor) {
    try {
      await chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#B42318' });
    } catch (e) { /* 色が付かないだけ。通知は成立している */ }
  }
  try {
    await chrome.action.setTitle({ tabId: tabId, title: titleFor(reason) });
  } catch (e) { /* 説明文が既定のままなだけ。通知は成立している */ }
  return true;
}

/*
 * 画面内の案内を試し、届かなければバッジへ回す。
 * **利用者に見えるものを出す唯一の場所**——1回の呼び出しで notice か badge の
 * どちらか一方だけを出す。第24回監査 R24-003 で「開いたが Esc が効かない」でも
 * 使うようになったので、名前から Refusal を外した（拒否専用ではない）。
 */
async function announceOnce(tabId, reason) {
  var delivered = await notifyTab(tabId, reason);
  if (delivered) return 'notice';
  return (await flagTab(tabId, reason)) ? 'badge' : 'none';
}

/*
 * **開かずに終わるときの、唯一の出口**（第19回監査 R19-004）。
 *
 * それまでは、拒否の理由が言える経路だけが案内を出し、
 *   ・buildShareResult が例外を投げ、かつ fallbackUrl が null を返した
 *   ・fallbackUrl 自体が例外を投げた（GXS が読み込めていない等）
 * という重なりのときだけ、**案内もバッジも出さずに終わって**いた（実測）。
 * 利用者からは「押しても何も起きない」と見える。
 *
 * false を返す経路は必ずここを通す。ここを通らない `opened: false` を
 * 書かないこと——test/background.test.mjs が経路を数えて落とす。
 * 案内は1回だけ（announceOnce の中で notice → badge の順に1つ選ぶ）。
 */
async function refuse(tab, reason) {
  var why = reason || 'unsupported';
  var how = await announceOnce(tab && tab.id, why);
  return { opened: false, reason: why, notified: how !== 'none' };
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
      return refuse(tab, 'unsupported');
    }
    return shareResolvedTab(tab);
  }

  /*
   * タブが渡されなかったときだけ引き直す。ここで何も取れなければ、
   * **案内を届ける先が無い**（タブIDが無いので画面にもバッジにも出せない）。
   * refuse を通して notified:false を返し、「黙って終わった」ことを
   * 呼び出し側と試験から見えるようにする（第19回監査 R19-004）。
   */
  var fallback = await queryActiveTab();
  if (!fallback || !fallback.url) return refuse(fallback, 'unsupported');
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
    return refuse(tab, reason);
  }
  if (!share) {
    /*
     * ここへ来るのは buildShareResult が例外を投げたときだけ。
     * フォールバックも本体と同じURL方針を使う（別実装を残さない）。
     * null が返るのは機微なページなので、その場合も何も開かない。
     * **fallbackUrl 自体が投げることもある**（share.js を読み込めていない等）。
     * 投げたまま抜けると案内も出ないので、ここで受けて拒否へ倒す（R19-004）。
     */
    var bare = null;
    try {
      bare = self.GXS.fallbackUrl(tab.url);
      /*
       * 第20回監査 R20-005。**Xのアドレスを組み立てるところまで同じ try に入れる。**
       * それまで intentUrlFor はこの外にあり、ここが投げると例外がそのまま
       * shareTab の外へ抜けて、案内もバッジも出ないまま終わっていた（実測）。
       */
      if (bare) share = { intentUrl: self.GXS.intentUrlFor('', bare) };
    } catch (e) {
      share = null;
    }
    if (!share || !share.intentUrl) return refuse(tab, 'unsupported');
  }

  /*
   * 第15回監査 R15-005。戻り値を捨てていたので、ポップアップもタブも開けなかった
   * とき（どちらの API も例外）に、**何も起きないまま終わって**いた。
   */
  var opened = await openShareWindow(share.intentUrl);
  if (!opened || opened.state === 'failed') return refuse(tab, 'open_failed');
  /*
   * 開いたかどうかを言えないときは、そう伝える（第23回監査 R23-003）。
   * ここで黙って成功を返すと、何も出ていない画面の前で利用者が待つことになる。
   */
  if (opened.state === 'creation_unknown') return refuse(tab, 'open_unknown');
  /*
   * 開いた。ただし Esc で閉じられるかは別（記録に失敗していることがある）。
   *
   * 第24回監査 R24-003。`popup_confirmed_untracked` は第23回で**内部的には**
   * 分けたが、3つの入口のどれも利用者へ伝えていなかった（実測: notice 0・badge 0）。
   * 利用者から見ると「Esc で閉じられる窓」と区別がつかず、閉じ方を探して詰まる。
   * ここは3入口が必ず通る唯一の場所なので、**ここで1回だけ**伝える。
   * 窓そのものは開いているので、記録に入れない・閉じない・開き直さない。
   */
  if (opened.state === 'popup_confirmed_untracked') {
    var how = await announceOnce(tab && tab.id, 'esc_unavailable');
    return { opened: true, state: opened.state, escAvailable: false,
             notified: how !== 'none' };
  }
  return { opened: true, state: opened.state, escAvailable: opened.escAvailable === true,
           notified: false };
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

/*
 * 第20回監査 R20-005。**リスナーは Promise を捨てていた。**
 * shareTab の中で予期しない例外が出ると、拒否は未処理の rejection になって
 * 消え、利用者からは「押しても何も起きない」と見えた（実測）。
 * ここで受けて、最後の砦としてバッジを出す。
 */
function runShare(tab) {
  Promise.resolve()
    .then(function () { return shareTab(tab); })
    .catch(function () {
      /* ここまで来る＝shareTab の中で拒否へ倒せなかった。
         理由は名乗れないので、値を含まない既定の案内を**同じ出口から**出す */
      return refuse(tab, 'unsupported');
    })
    .catch(function () { /* 案内すら出せない相手なら、そこで終わり */ });
}

// MV3のservice workerは停止と再開を繰り返すため、リスナーは必ずトップレベルで登録する
// Chrome が渡してくるタブをそのまま使う（第13回監査 R13-003）
chrome.action.onClicked.addListener(function (tab) {
  runShare(tab);
});

chrome.commands.onCommand.addListener(function (command, tab) {
  if (command === 'share-to-x') runShare(tab);
});

/*
 * メッセージの入口。
 *  gxs:request-share    … 画面内Shareボタンからの依頼（データを持たない合図だけ）
 *  gxs:open-share       … **1.1.8以前の古い content script** が送ってくる形。
 *                         渡されたURLは使わず、再読み込みを促す（第16回監査 R16-003）
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
    /*
     * 第20回監査 R20-005。**notified を返す。**
     * それまで拒否のときは `{ok:false}` を返すだけで、service worker が
     * 案内を出せたかどうかを画面側が知る手段が無かった。中で予期しない例外が
     * 出た場合（下の rejection 側）は案内も出ず、画面側も何も出さないので、
     * 利用者からは「押しても何も起きない」と見えた。
     */
    shareResolvedTab(sender.tab).then(function (r) {
      try {
        sendResponse({ ok: !!(r && r.opened), reason: r && r.reason,
                       state: r && r.state, escAvailable: r && r.escAvailable,
                       notified: !!(r && r.notified) });
      } catch (e) {}
    }, function () {
      /* 例外で倒れたときも、同じ出口から案内を出してから返す */
      refuse(sender.tab, 'unsupported').then(function (r) {
        try { sendResponse({ ok: false, reason: r.reason, notified: r.notified }); } catch (e) {}
      }, function () {
        try { sendResponse({ ok: false, notified: false }); } catch (e) {}
      });
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
      /* 案内を出す口は refuse ひとつに寄せる（第19回監査 R19-004）。
         戻り値は使わない——ここでの返事は上の answer が持つ */
      refuse(legacyTab, 'reload_required').then(answer, answer);
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

// 閉じられたウィンドウの記録を捨てる（古い記録を Esc の許可として残さない・R21-002）
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
  announceOnce: announceOnce,
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
