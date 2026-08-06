# Privacy Policy / プライバシーポリシー

**RepoShout** — Chrome extension
Last updated / 最終更新: 2026-08-05（1.1.3）

---

## English

### Where your data goes — the short version

RepoShout sends **nothing to the developer, and nothing to any server the developer operates**. There is no analytics, no telemetry, no advertising SDK, and no account.

It does, however, hand two values to X, because that is the whole point of the extension: **when you press Share, the title and the canonicalised URL of the GitHub page you are on are placed in an X Web Intent link and sent to X to pre-fill its composer.** This happens the moment the composer opens — before you decide whether to press Post. If you never press Post, X has still received the title and the URL.

RepoShout never posts on your behalf, and never stores the title or URL.

### Information we process

When — and only when — you activate the extension (by clicking the in-page **Share** button, clicking the toolbar icon, or pressing the keyboard shortcut), RepoShout reads two things from the tab you are currently viewing:

- the page URL
- the page title

They are used solely to build the post text and the `x.com` share link. The composing itself happens in your browser; the finished link is then opened on X, which is how the values reach X.

### Where data goes

RepoShout makes no background network requests, and contacts no server of its own. What it does is open the X (formerly Twitter) post composer in a new window, as an ordinary link navigation, with the text and URL already in the address. **The title and URL travel to X as part of that address.** Once the composer is open, **whether to actually post is entirely your decision, made on X's own screen** — the extension never posts on your behalf.

X, and your browser, then handle those values under their own policies.

**A caution.** The URL always contains a GitHub account name — `github.com/<account>/<repository>` — and so does the title of a profile page. If a GitHub page is private or confidential, do not press Share on it unless you intend its title and URL, including that account name, to reach X. From version 1.1.1 the extension refuses to share GitHub's authentication, account, settings and organisation-administration pages at all, but it cannot tell whether an ordinary repository is public or private from the URL alone.

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

### データがどこへ行くか（先に結論）

RepoShout は、**開発者にも、開発者が運営するサーバーにも、何も送りません**。解析ツールも、利用状況の送信も、広告SDKも、アカウントもありません。

一方で、**2つの値はXへ渡ります。それがこの拡張の目的そのものだからです**——Shareを押すと、見ているGitHubページのタイトルと正規化済みURLがXの投稿画面のURLに入り、下書きを埋めるためにXへ送られます。これは投稿画面が開いた時点で起きます。**あなたがPostを押すかどうかとは関係なく**、開いた時点でXはタイトルとURLを受け取っています。

RepoShout が代わりに投稿することはなく、タイトルとURLを保存することもありません。

### 処理する情報

拡張を操作したとき（画面内の **Share** ボタン、ツールバーアイコン、キーボードショートカットのいずれか）**に限り**、現在開いているタブから次の2つを読み取ります。

- ページのURL
- ページのタイトル

これらは投稿用の文面と `x.com` の共有リンクを組み立てるためだけに使われます。組み立て自体はブラウザ内で行われ、できあがったリンクをXで開くことで、値がXへ渡ります。

### 送信先

RepoShout はバックグラウンドでの通信を行わず、独自のサーバーとも通信しません。行うのは、文面とURLが入ったアドレスで X（旧Twitter）の投稿画面を新しいウィンドウで開くことだけです。通常のリンクを開く動作ですが、**タイトルとURLはそのアドレスの一部としてXへ渡ります**。投稿画面が開いたあと、**実際に投稿するかどうかは X の画面上で利用者が決めます**——拡張が代わりに投稿することはありません。

渡ったあとの取り扱いには、X およびブラウザそれぞれのポリシーが適用されます。

**注意。** 共有するURLには必ずGitHubのアカウント名が入ります（`github.com/<アカウント名>/<リポジトリ名>`）。プロフィールページではタイトルにも入ります。非公開・機密のGitHubページでは、そのアカウント名を含むタイトルとURLをXへ送る意図がある場合だけShareを押してください。バージョン1.1.1 から、GitHubの認証・アカウント・設定・組織管理の画面では拡張が共有そのものを拒否しますが、**通常のリポジトリが公開か非公開かはURLだけでは判別できません**。

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
