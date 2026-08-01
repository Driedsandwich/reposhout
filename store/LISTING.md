# Chrome ウェブストア 提出用テキスト（草案）

作成: 2026-08-01 / 用途: デベロッパーダッシュボードの各欄にコピペする原稿
**提出（Submit）は人間が実行します。この文書は原稿のみです。**

---

## 基本情報

| 欄 | 入力する値 |
|---|---|
| Name（manifestから自動） | `RepoShout — Share GitHub repos, issues & PRs to X`（49文字） |
| short_name（狭い場所での表示） | `RepoShout`（9文字） |
| Category | Social & Communication |
| Language | English（日本語を追加する場合は後述） |

**名前欄の上限は75文字です**（[公式ドキュメント](https://developer.chrome.com/docs/extensions/reference/manifest/name)で確認）。2024-02-22に45文字から引き上げられており、[Chromium拡張のアナウンス](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/mpDvFpT0KJM/m/WWFFQZFyAAAJ)に「a universal limit of 75 characters for an extension's name field in their manifest.json」と記載があります。古い資料には45文字と書かれていることがあるので注意してください。

この枠を使って「固有名 — 機能説明」の形にしています。固有名だけでは誰も検索しませんし、機能語だけでは他社商標が名前の主役になってしまうためです。`short_name` は狭い表示領域用で、12文字以内が推奨されます。

## Short description（132文字以内 / manifest の description と同一）

```
Share GitHub repos, issues and PRs to X with a pre-filled post. You press Post on X. Not affiliated with X or GitHub.
```

現在117文字。

## Detailed description（ストア掲載の本文）

```
RepoShout adds a Share button to GitHub, so you can post a repository, issue,
or pull request to X without copying and pasting.

Click it and X's post composer opens with the title and link already filled in.
Edit it however you like, then press Post yourself. RepoShout never posts for you.

── What you get ──

• A Share button on repository pages, placed to the left of Pin / Watch / Fork / Star
• A toolbar icon and a keyboard shortcut (Alt+Shift+X, or Option+Shift+X on macOS)
  that work on issues, pull requests, and anywhere else on GitHub
• Post text tailored to the page:
    Repository   →  owner/repo: description
    Issue        →  Title (Issue #123 · owner/repo)
    Pull request →  Title (PR #123 · owner/repo)
• Tracking parameters GitHub appends are stripped; line and comment anchors are kept
• Correct character counting for Japanese, Chinese and Korean text, which X counts
  as two characters each
• Light and dark mode follow GitHub's own theme automatically

── Privacy ──

RepoShout requests one permission: activeTab. It reads the current tab's URL and
title only at the moment you invoke it, purely to build the post text. It makes
no network requests of its own, stores nothing, and sends nothing anywhere.

Full policy: https://github.com/Driedsandwich/reposhout/blob/main/PRIVACY.md

── Open source ──

MIT licensed. Source, tests and full verification notes:
https://github.com/Driedsandwich/reposhout

── Trademarks ──

This extension is not affiliated with, endorsed by, or sponsored by X Corp. or
GitHub, Inc. X and the X logo are trademarks of X Corp. GitHub is a trademark of
GitHub, Inc.
```

## Single purpose（単一目的の記述）

```
RepoShout has one purpose: to open X's post composer pre-filled with the title
and URL of the GitHub page the user is currently viewing.
```

## Permission justification（権限の正当化）

### activeTab

```
RepoShout needs the URL and title of the tab the user is currently viewing in
order to compose the post text (for example "owner/repo: description" or
"Title (Issue #123 · owner/repo)") and to build the x.com share link.

activeTab was chosen deliberately over host permissions or the "tabs" permission
because it grants access only at the moment the user explicitly invokes the
extension — by clicking the toolbar icon or pressing the keyboard shortcut — and
only for that one tab. It cannot be used to observe browsing in the background.

The URL and title are used solely to construct the share URL. They are not
stored, logged, or transmitted anywhere by the extension.
```

### content_scripts on https://github.com/*

```
The in-page Share button is injected into GitHub's repository header so that
sharing takes one click from where the user already is. The content script is
limited to github.com, reads the page only to locate the button row, and adds a
single <li> element. It never modifies or removes any existing GitHub element,
and does nothing at all if the expected container is not found.
```

## Privacy practices（Privacyタブの回答）

| 質問 | 回答 |
|---|---|
| Does your item collect or use personally identifiable information? | **No** |
| Health information | No |
| Financial and payment information | No |
| Authentication information | No |
| Personal communications | No |
| Location | No |
| Web history | **No** — the extension reads the active tab's URL only at the moment of user invocation and does not record or transmit it |
| User activity | No |
| Website content | **No** — only the page title, read at the moment of user invocation |
| 収集データを第三者に販売しないことの証明 | 同意（該当なし） |
| 承認された用途以外に使用・転送しないことの証明 | 同意 |
| 信用力判断・融資目的に使用しないことの証明 | 同意 |

> **注意**: 「Web history」「Website content」の回答は判断が分かれうる項目です。本拡張はURLとタイトルを**ユーザー操作の瞬間にのみ**読み、保存も送信もしません。ただし審査側がより広く解釈する可能性はあります。**No で提出して差し戻された場合は、Yes に変更し「ユーザー操作時のみ・端末内処理のみ」と説明を添えて再提出**するのが安全です。プライバシーポリシーは既に用意してあるので、どちらの回答でも要件は満たせます。

## プライバシーポリシーURL

```
https://github.com/Driedsandwich/reposhout/blob/main/PRIVACY.md
```

GitHub Pages を使う場合は `https://driedsandwich.github.io/reposhout/privacy.html` などに差し替えてください。

## スクリーンショット（同梱済み・1280×800）

| ファイル | 内容 |
|---|---|
| `store/screenshot-1-repo.png` | リポジトリページ。Notifications / Fork / Star の左に Share ボタン |
| `store/screenshot-2-issue.png` | Issueページ。同じ位置にボタン |
| `store/screenshot-3-dark.png` | ダークモード。GitHubのボタンと同じ配色に追従 |

いずれも `octocat/Hello-World`（GitHub公式のサンプルリポジトリ）で撮影しており、個人のリポジトリは写っていません。

**生成方法**: ヘッドレスChromeで実際のGitHubを開き、`src/share.js` と `src/content.js` の実ファイルをそのまま読み込ませて撮影。ヘッドレスChromeが `--load-extension` でcontent scriptを実行しなかったため注入方式を採ったが、**同一のコードなので描画結果は拡張が動作した場合と同じ**。再生成は `scratchpad/shot.js` で可能。

## 日本語の掲載を追加する場合

`_locales/en/messages.json` と `_locales/ja/messages.json` を作り、`manifest.json` の `name` / `description` を `__MSG_...__` 形式に変えると、ストア掲載が言語ごとに切り替わります。初版は英語のみで提出し、必要になってから追加するのが簡単です。

## 競合状況（掲載文を書くときの前提）

ストアに近い領域の拡張が1件あります。掲載時に差別化を意識するための参考です。

| 項目 | 実測（2026-08-01） |
|---|---|
| 名称 | [RepoCast — GitHub repo share copy & cards](https://chromewebstore.google.com/detail/lpkhpmjlkjgdlnajljaipakcnhgdodfe) |
| バージョン / 更新 | v1.0.5 / 2026-07-18 |
| 利用者 | **3人**（評価5.0・1件） |
| 機能 | GitHubリポジトリページにボタンを追加し、サイドパネルで X / LinkedIn / Reddit / WhatsApp / Discord 向けの共有文と共有カードを生成 |

RepoShout は宛先をXに絞り、サイドパネルもカード生成も持ちません。掲載文では「多機能さ」ではなく次の3点で差別化してください（いずれも実測に基づく事実です）。

1. ログイン状態とログアウト状態の**両方**に対応（GitHubはこの2つで実装が別物。ログイン時のIssue/PRにはボタン行自体が無いため、ツールバー/ショートカットで補っている）
2. 文面生成に**104件の自動テスト**（うち71件は絵文字の切り詰め境界の網羅、CJKの重み付き文字数を含む）
3. Open / Merged / Closed の状態を**意図的に出さない**（ログイン状態で読み取り値が食い違う事象を実測したため）

なお、それ以前の同種拡張（2015 / 2018 / 2021）はいずれも更新停止かつManifest V2世代で、現在は動作しません。

## 提出前の最終確認

- [ ] デベロッパー登録が有効か（$5は支払い済みとのことだが、**AIからは確認不可**）
- [ ] `manifest.json` の `homepage_url` が実在するリポジトリURLになっているか
  （現在 `https://github.com/Driedsandwich/reposhout` を仮置き。リポジトリ名を変える場合は要修正）
- [ ] PRIVACY.md のURLが公開後に到達可能か
- [ ] ZIP化する際、`store/` と `test/` を含めるかどうか（含めても動作に影響はないが、配布物は小さいほうが良い）
