# Privacy Policy / プライバシーポリシー

**RepoShout** — Chrome extension
Last updated / 最終更新: 2026-08-01

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

RepoShout stores nothing. It does not request the `storage` permission.

### Permissions

RepoShout requests a single API permission: **`activeTab`**. It is granted only at the moment you explicitly invoke the extension, and only for the tab you are on. It does not allow continuous monitoring of your browsing.

RepoShout also runs content scripts on two sites:

| Site | What the script does |
|---|---|
| `https://github.com/*` | Adds the Share button to repository pages. Reads the page only to locate the button row; adds a single `<li>` and modifies nothing else. |
| `https://x.com/*` | **Listens for the Escape key, and nothing else.** It closes the share window this extension opened. It does not read, store, or transmit anything from X. |

The X script is deliberately blind to page content. Before closing anything it confirms the window's identity in one of two ways: the window name this extension assigned when opening it, or a windowId the extension recorded. **If neither matches — which is the case for every X tab you opened yourself — it does nothing.** It cannot close your normal X tabs.

### Changes to this policy

Any change will be reflected in this file with an updated date.

### Contact

Please open an issue on the GitHub repository.

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

RepoShout はデータを保存しません（`storage` 権限を要求していません）。

### 権限

要求するAPI権限は **`activeTab`** の1つだけです。利用者が拡張を明示的に操作した瞬間に、そのタブに対してのみ付与されます。閲覧の常時監視はできません。

あわせて、次の2つのサイトでコンテンツスクリプトが動きます。

| サイト | スクリプトがすること |
|---|---|
| `https://github.com/*` | リポジトリページに Share ボタンを追加します。ページを読むのはボタン行の位置を探すためだけで、`<li>` を1つ足す以外は何も変更しません。 |
| `https://x.com/*` | **Escキーの検知だけを行います。** 拡張が開いた共有用ウィンドウを閉じるためです。Xから何かを読み取ることも、保存することも、送信することもありません。 |

X側のスクリプトは、意図的にページの中身を見ません。閉じる前に、次のどちらかでウィンドウの同一性を確認します——拡張が開くときに付けた名前か、拡張が記録したウィンドウID。**どちらとも一致しない場合（＝あなたが自分で開いたXのタブはすべてこれに当たります）、何もしません。** 通常のXのタブを閉じることはできません。

### 本ポリシーの変更

変更があった場合は、このファイルに日付を更新して反映します。

### 問い合わせ

GitHub リポジトリの Issue でお願いします。

---

This extension is not affiliated with, endorsed by, or sponsored by X Corp. or GitHub, Inc.
X and the X logo are trademarks of X Corp. GitHub is a trademark of GitHub, Inc.

本拡張は X Corp. および GitHub, Inc. とは無関係で、両社による承認・後援を受けていません。
