# Privacy Policy / プライバシーポリシー

**RepoShout** — Chrome extension
Last updated / 最終更新: 2026-08-11（1.1.8）

---

## English

### Where your data goes — the short version

RepoShout sends **nothing to the developer, and nothing to any server the developer operates**. There is no analytics, no telemetry, no advertising SDK, and no account.

It does, however, hand two values to X, because that is the whole point of the extension: **when you press Share, a line generated from the page's route (`owner/repo`, `Issue #123 · owner/repo` and the like) and the canonicalised URL are placed in an X Web Intent link and sent to X to pre-fill its composer.** The page title is not among them. This happens the moment the composer opens — before you decide whether to press Post. If you never press Post, X has still received that line and the URL.

RepoShout never posts on your behalf, and never stores what it sends.

### Information we process

RepoShout processes information at **two different moments**, and they are not the same.

**1. While a GitHub page is open — placing the Share button.** The in-page part of the
extension looks for the small toolbar that GitHub draws next to a repository, issue or pull
request heading, so it can put its own **Share** button there. It does this when the page
loads, again about once a second, and again when you switch back to the tab (GitHub swaps
pages without a full reload, so the button can otherwise disappear). This check reads
**only whether a few specific layout elements exist, and how tall the neighbouring button
is**. It does not read the page text, the URL, the page title, form fields, or anything you
type. The result of this check is never stored, and never leaves your browser.

**2. When you activate the extension** (by clicking the in-page **Share** button, clicking the
toolbar icon, or pressing the keyboard shortcut) — and only then — RepoShout reads **one
thing** from the tab you are currently viewing:

- the page URL

**The page title is not read at all.** <!-- HISTORICAL_CLAIM:start reason="1.1.8より前の版の挙動。現在の仕様ではない" -->(Versions before 1.1.8 did read it.)<!-- HISTORICAL_CLAIM:end --> The URL is read by the extension's background service worker, which decides whether the page may be shared and, if so, rebuilds a link from the validated parts of that URL. The in-page Share button reads nothing: pressing it sends the service worker a message that carries no data. The composing itself happens in your browser; the finished link is then opened on X, which is how the values reach X.

### Where data goes

RepoShout makes no background network requests, and contacts no server of its own. What it does is open the X (formerly Twitter) post composer in a new window, as an ordinary link navigation, with the text and URL already in the address. **The generated line and the URL travel to X as part of that address.** Once the composer is open, **whether to actually post is entirely your decision, made on X's own screen** — the extension never posts on your behalf.

X, and your browser, then handle those values under their own policies.

**A caution.** From 1.1.8 onwards **the page title is never sent**. What reaches X is a line generated from the route (`owner/repo`, `Issue #123 · owner/repo`, `Commit 0123456 · owner/repo` and the like) together with a URL rebuilt from validated parts. That line still contains the GitHub owner and repository name, so if a repository is private or confidential, do not press Share on it unless you intend its owner and repository name to reach X. A page is shareable only when every path segment is an owner name, a repository name, a positive integer or a 40-character hex commit SHA; files, trees, comparisons, wikis, search results and profiles are refused. Fragments are dropped and query strings keep only values whose set can be enumerated. A credential detector still runs over what is about to leave, but as a second layer — it covers the patterns it defines and is not a claim that every possible secret is detected, which is why nothing free-form is carried at all.

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
| `activeTab` | Read the URL of the tab you are on — the page title is not read at all since 1.1.8. Granted only at the moment you explicitly invoke the extension, and only for that tab. It does not allow continuous monitoring of your browsing. |
| `storage` | Keep the window list described above. Added in 1.1.0. |

RepoShout also runs content scripts on two sites:

| Site | What the script does |
|---|---|
| `https://github.com/*` | Adds the Share button. It reads the page only to locate the button row. **When you press it (a trusted click), it sends the service worker one message that carries no data — literally "the button was pressed"** — and reads neither the address bar nor the page title nor the page body. The service worker decides what may leave, working from the URL of the tab the message came from. It adds one `<style>` element and one wrapper holding one button (an `<li>` or a `<div>`, matching the container) and modifies nothing else. It deletes and replaces nothing of GitHub's own. |
| `https://x.com/*` | **Registers one `keydown` listener and looks at `event.key` on each key press; anything other than an unmodified Escape is ignored immediately.** It closes the share window this extension opened. It does not read field values or page content, and does not store, aggregate or transmit anything from X. |

The X script is deliberately blind to page content. Before closing anything it asks the service worker whether this window is one the extension itself opened, and the only evidence accepted is the window ID recorded at creation time. **If it does not match — which is the case for every X tab you opened yourself — it does nothing.** It cannot close your normal X tabs.

### Compliance with the Chrome Web Store User Data Policy

RepoShout's use of information received from Google APIs, and any user data it handles,
**adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.**

Concretely:

- The generated line and the URL are used **only** to provide the extension's single purpose —
  opening X's post composer pre-filled with the page you are on.
- The only transfer to a third party is to X, and only to the extent required to open the
  composer you asked for. There is no other transfer.
- This data is **never** used for advertising, sold to anyone, or used to determine
  creditworthiness or for lending purposes.
- **RepoShout does not make what it sends available for human review by the developer or
  anyone acting on the developer's behalf.** There is no developer-operated backend — the
  developer receives nothing because no server of the developer's exists to receive it.
  As described above, X receives that line and the URL solely to open the composer you asked
  for, and handles them under X's own policies. What X does on its side is X's to state,
  not something this extension can promise.
- Nothing is used to build a profile. **What is sent is not retained** by the
  extension; the only things it stores are the window ID and timestamp described under
  Storage above.

### Changes to this policy

Any change will be reflected in this file with an updated date.

### Contact

See [SUPPORT.md](SUPPORT.md). For suspected security problems, see [SECURITY.md](SECURITY.md).

---

## 日本語

### データがどこへ行くか（先に結論）

RepoShout は、**開発者にも、開発者が運営するサーバーにも、何も送りません**。解析ツールも、利用状況の送信も、広告SDKも、アカウントもありません。

一方で、**2つの値はXへ渡ります。それがこの拡張の目的そのものだからです**——Shareを押すと、見ているページのルートから生成した1行（`owner/repo`・`Issue #123 · owner/repo` など）と正規化済みURLがXの投稿画面のURLに入り、下書きを埋めるためにXへ送られます。**ページのタイトルは含みません。** これは投稿画面が開いた時点で起きます。**あなたがPostを押すかどうかとは関係なく**、開いた時点でXはその1行とURLを受け取っています。

RepoShout が代わりに投稿することはなく、送ったものを保存することもありません。

### 処理する情報

RepoShout が情報を扱う場面は**2つ**あり、内容が違います。

**1. GitHubのページを開いている間 — Share ボタンを置くため。** 拡張の画面側は、GitHubが
リポジトリ名やIssueの見出しの横に描く小さな操作列を探して、そこへ自分の **Share** ボタンを
置きます。ページを開いたとき・**約1秒ごと**・タブを表示に戻したときに確認します
（GitHubはページ全体を読み込み直さずに画面を切り替えるため、放っておくとボタンが消えるからです）。
このとき見るのは**決まった数個の要素があるかどうかと、隣のボタンの高さだけ**です。
ページの本文も、入力欄の値も、URLも、タイトルも読みません。この確認の結果は、保存されることも、ブラウザの外へ出ることもありません。

**2. 拡張を操作したとき**（画面内の **Share** ボタン、ツールバーアイコン、キーボード
ショートカットのいずれか）——**そのときに限り**、現在開いているタブから読み取るのは**1つだけ**です。

- ページのURL

**ページのタイトルは読みません。**<!-- HISTORICAL_CLAIM:start reason="1.1.8より前の版の挙動。現在の仕様ではない" -->（1.1.7 までは読んでいました。）<!-- HISTORICAL_CLAIM:end -->URLを読むのは拡張のバックグラウンド（service worker）で、そのページを共有してよいかを判定し、共有できる場合は**URLの検査済みの部分からリンクを組み直します**。画面内の Share ボタンは何も読みません——押すと、データを持たないメッセージを service worker へ送るだけです。組み立て自体はブラウザ内で行われ、できあがったリンクをXで開くことで、値がXへ渡ります。

### 送信先

RepoShout はバックグラウンドでの通信を行わず、独自のサーバーとも通信しません。行うのは、文面とURLが入ったアドレスで X（旧Twitter）の投稿画面を新しいウィンドウで開くことだけです。通常のリンクを開く動作ですが、**生成した1行とURLは、そのアドレスの一部としてXへ渡ります**。投稿画面が開いたあと、**実際に投稿するかどうかは X の画面上で利用者が決めます**——拡張が代わりに投稿することはありません。

渡ったあとの取り扱いには、X およびブラウザそれぞれのポリシーが適用されます。

**注意。** 1.1.8 以降、**ページのタイトルは送りません**。Xへ渡るのは、ルートから生成した1行（`owner/repo`・`Issue #123 · owner/repo`・`Commit 0123456 · owner/repo` など）と、検査したパーツから組み直したURLだけです。この1行にはGitHubの所有者名とリポジトリ名が入るので、**非公開・機密のリポジトリでは、その名前をXへ送る意図がある場合だけShareを押してください**。共有できるのは、パスの全セグメントが所有者名・リポジトリ名・正の整数・40桁の16進のどれかで決まるページだけで、ファイル・ツリー・比較・Wiki・検索結果・プロフィールは拒否します。フラグメントは落とし、クエリは値の集合を数えられるものだけ残します。出て行く直前の検査は今も走りますが、**2層目**です——見ているのは定義した形だけで、あらゆる秘密を検出できるという意味ではありません。だからこそ、自由に書けるものは最初から運びません。

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
| `activeTab` | 見ているタブのURLを読むため（1.1.8 以降、ページのタイトルは読みません）。利用者が拡張を明示的に操作した瞬間に、そのタブに対してのみ付与されます。閲覧の常時監視はできません |
| `storage` | 上記のウィンドウ一覧を保持するため。1.1.0で追加 |

あわせて、次の2つのサイトでコンテンツスクリプトが動きます。

| サイト | スクリプトがすること |
|---|---|
| `https://github.com/*` | Share ボタンを追加します。ページを読むのはボタン行の位置を探すためだけです。**押された時点（利用者の操作によるクリック）で service worker へ送るのは、データを何も持たないメッセージ1つ——「押されました」だけ**で、アドレスもページのタイトルもページ本文も読みません。何を外へ出すかは、そのメッセージが来たタブのURLを見て service worker が決めます。`<style>` を1つとボタン1個を包む要素を1つ足す以外は何も変更しません（包む要素はコンテナに合わせて `<li>` または `<div>`）。GitHub側の要素は消しも置き換えもしません。 |
| `https://x.com/*` | **`keydown` を1つ登録し、押されたキーの `event.key` を毎回見ます。修飾なしの Escape 以外は直ちに無視します。** 拡張が開いた共有用ウィンドウを閉じるためです。入力欄の値やページの中身は読まず、保存も集計も送信もしません。 |

X側のスクリプトは、意図的にページの中身を見ません。閉じる前に、service worker へ「このウィンドウは拡張が開いたものか」とだけ尋ねます。根拠として使うのは、開いた時点で記録したウィンドウIDだけです。**一致しない場合（＝あなたが自分で開いたXのタブはすべてこれに当たります）、何もしません。** 通常のXのタブを閉じることはできません。

### Chrome ウェブストアのユーザーデータポリシーの遵守

RepoShout が Google API から受け取った情報の利用、および取り扱うすべての利用者データは、
**Chrome ウェブストアのユーザーデータポリシー（Limited Use の要件を含む）に従います。**

具体的には次のとおりです。

- 生成した1行とURLは、この拡張の唯一の目的——見ているページでXの投稿画面を開くこと——
  **のためだけ**に使います。
- 第三者へ渡るのはXだけで、利用者が求めた投稿画面を開くために必要な範囲に限ります。
  それ以外の転送はありません。
- このデータを広告に使うことも、誰かに販売することも、信用力の判断や融資の目的に
  使うことも**ありません**。
- **RepoShout は、タイトルやURLを開発者または開発者のために行動する者の人手閲覧に供しません。**
  開発者が運営するサーバー（backend）はありません——受け取れるサーバーが存在しないので、
  開発者は何も受け取りません。上記のとおり、Xは利用者が要求した投稿画面を開くために
  その1行とURLを受け取り、そのあとはXのポリシーに従って取り扱います。X側で何が起きるかは
  Xが述べることで、この拡張が約束できることではありません。
- プロフィールの作成には使いません。**送ったものを、拡張側では保存しません。**
  保存するのは上の「保存」に書いたウィンドウIDと時刻だけです。

### 本ポリシーの変更

変更があった場合は、このファイルに日付を更新して反映します。

### 問い合わせ

[SUPPORT.md](SUPPORT.md) を参照してください。セキュリティ上の問題と思われる場合は [SECURITY.md](SECURITY.md) を先に読んでください。

---

This extension is not affiliated with, endorsed by, or sponsored by X Corp. or GitHub, Inc.
X and the X logo are trademarks of X Corp. GitHub is a trademark of GitHub, Inc.

本拡張は X Corp. および GitHub, Inc. とは無関係で、両社による承認・後援を受けていません。
