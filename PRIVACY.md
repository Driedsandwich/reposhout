# Privacy Policy / プライバシーポリシー

**RepoShout** — Chrome extension
Last updated / 最終更新: 2026-08-05（1.1.0）

---

## English

### Information we collect

**None.** RepoShout does not collect, store, or transmit any user information.

### Information we process

When — and only when — you activate the extension (by clicking the in-page **Share** button, clicking the toolbar icon, or pressing the keyboard shortcut), RepoShout reads two things from the tab you are currently viewing:

- the page URL
- the page title

These are used solely to compose the post text and the `x.com` share URL. All processing happens locally in your browser.

### Where data goes

RepoShout makes **no network requests of its own**. When you activate it, it opens the X (formerly Twitter) post composer in a new window with the text and URL pre-filled. This is an ordinary link navigation. **Whether to actually post is entirely your decision, made on X's own screen.** The extension never posts on your behalf.

### Storage

From version 1.1.0 RepoShout stores one thing: **the identifiers of the windows it opened itself**, together with the time each was opened.

| | |
|---|---|
| What is stored | Chrome's internal window ID (a number) and a timestamp |
| What is **not** stored | URLs, page titles, page content, browsing history, anything about you |
| Where | `chrome.storage.session` — held in memory, never written to disk |
| How long | Until the window is closed, until you quit the browser, or 12 hours, whichever comes first |
| Who can read it | The extension's own service worker. Content scripts cannot read it (Chrome's default access level for session storage, which this extension does not change) |
| Sent anywhere | No |

This exists so that pressing Escape closes the share window the extension opened **and nothing else**. Before 1.1.0 the extension identified that window by a fixed name written in its public source code, which any web page could copy.

### Permissions

| Permission | Why |
|---|---|
| `activeTab` | Read the URL and title of the tab you are on. Granted only at the moment you explicitly invoke the extension, and only for that tab. It does not allow continuous monitoring of your browsing. |
| `storage` | Keep the window list described above. Added in 1.1.0. |

RepoShout also runs content scripts on two sites:

| Site | What the script does |
|---|---|
| `https://github.com/*` | Adds the Share button. Reads the page only to locate the button row; adds a single element (an `<li>` or a `<div>`, matching the container) and modifies nothing else. |
| `https://x.com/*` | **Listens for the Escape key, and nothing else.** It closes the share window this extension opened. It does not read, store, or transmit anything from X. |

The X script is deliberately blind to page content. Before closing anything it asks the service worker whether this window is one the extension itself opened, and the only evidence accepted is the window ID recorded at creation time. **If it does not match — which is the case for every X tab you opened yourself — it does nothing.** It cannot close your normal X tabs.

### Changes to this policy

Any change will be reflected in this file with an updated date.

### Contact

See [SUPPORT.md](SUPPORT.md). For suspected security problems, see [SECURITY.md](SECURITY.md).

---

## 日本語

### 収集する情報

**ありません。** RepoShout は利用者の情報を収集・保存・送信しません。

### 処理する情報

拡張を操作したとき（画面内の **Share** ボタン、ツールバーアイコン、キーボードショートカットのいずれか）**に限り**、現在開いているタブから次の2つを読み取ります。

- ページのURL
- ページのタイトル

これらは投稿用の文面と `x.com` の共有URLを組み立てるためだけに使われ、処理はすべて利用者のブラウザ内で完結します。

### 送信先

RepoShout は**独自の通信を一切行いません**。操作すると、文面とURLが入力済みの状態でX（旧Twitter）の投稿画面を新しいウィンドウで開きます。これは通常のリンクを開く動作です。**実際に投稿するかどうかは、X の画面上で利用者が決めます。** 拡張が代わりに投稿することはありません。

### 保存

バージョン1.1.0から、**拡張自身が開いたウィンドウの識別子**と、開いた時刻だけを保存します。

| | |
|---|---|
| 保存するもの | Chrome内部のウィンドウID（数値）と時刻 |
| 保存**しない**もの | URL・ページタイトル・ページの中身・閲覧履歴・利用者に関する情報 |
| 保存先 | `chrome.storage.session`（メモリ上のみ・ディスクには書きません） |
| 保存期間 | そのウィンドウを閉じるまで／ブラウザを終了するまで／12時間、のいずれか早い方 |
| 読める相手 | この拡張の service worker のみ。コンテンツスクリプトからは読めません（Chromeのセッションストレージの既定設定で、本拡張はこれを変更していません） |
| 外部送信 | しません |

これは、Escで閉じる対象を「拡張が開いたウィンドウ**だけ**」に限るためのものです。1.1.0より前は、公開されているソースに書かれた固定の名前でそのウィンドウを見分けており、その名前はどのWebページでも真似できました。

### 権限

| 権限 | 用途 |
|---|---|
| `activeTab` | 見ているタブのURLとタイトルを読むため。利用者が拡張を明示的に操作した瞬間に、そのタブに対してのみ付与されます。閲覧の常時監視はできません |
| `storage` | 上記のウィンドウ一覧を保持するため。1.1.0で追加 |

あわせて、次の2つのサイトでコンテンツスクリプトが動きます。

| サイト | スクリプトがすること |
|---|---|
| `https://github.com/*` | Share ボタンを追加します。ページを読むのはボタン行の位置を探すためだけで、要素を1つ足す以外は何も変更しません（コンテナに合わせて `<li>` または `<div>`）。 |
| `https://x.com/*` | **Escキーの検知だけを行います。** 拡張が開いた共有用ウィンドウを閉じるためです。Xから何かを読み取ることも、保存することも、送信することもありません。 |

X側のスクリプトは、意図的にページの中身を見ません。閉じる前に、service worker へ「このウィンドウは拡張が開いたものか」とだけ尋ねます。根拠として使うのは、開いた時点で記録したウィンドウIDだけです。**一致しない場合（＝あなたが自分で開いたXのタブはすべてこれに当たります）、何もしません。** 通常のXのタブを閉じることはできません。

### 本ポリシーの変更

変更があった場合は、このファイルに日付を更新して反映します。

### 問い合わせ

[SUPPORT.md](SUPPORT.md) を参照してください。セキュリティ上の問題と思われる場合は [SECURITY.md](SECURITY.md) を先に読んでください。

---

This extension is not affiliated with, endorsed by, or sponsored by X Corp. or GitHub, Inc.
X and the X logo are trademarks of X Corp. GitHub is a trademark of GitHub, Inc.

本拡張は X Corp. および GitHub, Inc. とは無関係で、両社による承認・後援を受けていません。
