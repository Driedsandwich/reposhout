# Chrome ウェブストア 提出手順書

更新: 2026-08-05 / 対象: RepoShout **1.1.0**（未提出。ストアで公開中なのは 1.0.1・2026-08-03通過）
**この文書は原稿と手順です。提出（Submit for review）はあなたが実行します。**
初回提出と更新提出の両方でこの文書を使います。更新のときは §1 のアップロードと、変えた機能に関わる §2 の掲載文だけを直せば足ります。

デベロッパーダッシュボードの画面順に並べてあります。上から順に進めてください。
各欄はコードブロックをそのままコピペできます。

- 提出用ZIP: リポジトリで `npm run package` を実行すると `dist/reposhout-<版>.zip` ができます（9ファイル・allowlist方式）。同じ内容なら何度作っても同じZIPになるので、`dist/*.zip.sha256` の値で手元と提出物の一致を確かめられます
- 公開リポジトリ: https://github.com/Driedsandwich/reposhout
- ダッシュボード: https://chrome.google.com/webstore/devconsole

---

## 0. 事前確認

- [ ] デベロッパー登録が有効か（$5 は支払い済みとのことですが、**AIからは確認できません**）。ダッシュボードに入って「新しいアイテム」が押せれば有効です
- [ ] Googleアカウントが意図したものか（公開者名として表示されます）

---

## 1. パッケージのアップロード

**「新しいアイテムを追加」→ ZIPをドラッグ**

```
dist/reposhout-1.1.0.zip
```

同梱物は13ファイル。`store/` と `test/` は動作に不要なので除外済みです。
アップロード後、名前は `manifest.json` から自動で入ります（入力欄はありません）。

| 自動で入る値 | 内容 |
|---|---|
| Name | `RepoShout — Share GitHub repos, issues & PRs to X`（49文字 / 上限75） |
| Version | `1.1.0`（manifest の値。前回より大きくないと弾かれます） |
| Short description | 下の §2 と同一（manifest の `description`・117文字 / 上限132） |

---

## 2. Store listing タブ

### Product details

**Detailed description**（掲載本文）

```
RepoShout adds a Share button to GitHub, so you can post a repository, issue,
or pull request to X without copying and pasting.

Click it and X's post composer opens with the title and link already filled in.
Edit it however you like, then press Post yourself. RepoShout never posts for you.
Changed your mind? Press Escape in the share window to dismiss it.

── What you get ──

• A Share button on repository pages, placed to the left of Pin / Watch / Fork / Star
• A Share button on issues and pull requests, placed to the left of New issue / Code
• A toolbar icon and a keyboard shortcut (Alt+Shift+X, or Option+Shift+X on macOS)
  that work on every other GitHub page too
• Post text tailored to the page:
    Repository   →  owner/repo: description
    Issue        →  Title (Issue #123 · owner/repo)
    Pull request →  Title (PR #123 · owner/repo)
• Authentication, account, settings and organisation admin pages are never shared
• Query strings are handled per page type: filters on issue lists, ?plain=1 on a
  Markdown file and a prepared pull request's title and body are kept, while
  tracking parameters are dropped. Line and comment anchors are kept
• Character counting follows X's published rules, including Japanese, Chinese and
  Korean text, emoji and links, so a long title is trimmed to something X accepts
• Light and dark mode follow GitHub's own theme automatically
• Press Escape in the share window to dismiss it if you change your mind

── Privacy ──

RepoShout requests two API permissions: activeTab and storage. activeTab lets it
read the current tab's URL and title, only at the moment you invoke it, purely to
build the post text. storage holds one thing: the identifiers of the windows the
extension itself opened, kept in memory and cleared when you quit the browser.
The extension makes no network requests of its own and sends nothing anywhere.

It runs a script on x.com for one reason only: to listen for the Escape key so
you can dismiss the share window. That script reads nothing from X, and it will
only close a window this extension itself opened -- never a tab you opened.

Full policy: https://github.com/Driedsandwich/reposhout/blob/main/PRIVACY.md

── Open source ──

MIT licensed. Source, tests and full verification notes:
https://github.com/Driedsandwich/reposhout

── Trademarks ──

This extension is not affiliated with, endorsed by, or sponsored by X Corp. or
GitHub, Inc. X and the X logo are trademarks of X Corp. GitHub is a trademark of
GitHub, Inc.
```

**Primary category**

```
仕事効率化 ＞ デベロッパー ツール
（英語UIなら Productivity ＞ Developer Tools）
```

同種の [RepoCast](https://chromewebstore.google.com/detail/lpkhpmjlkjgdlnajljaipakcnhgdodfe) も Developer Tools に入っていることを実測で確認（2026-08-01）。投稿先はXだが、使うのはGitHubで作業している開発者なので、「ソーシャル ネットワーク」（消費者向けSNSツールの棚）ではなくここが正しい。

> 2026-08-01時点の実際の選択肢は次のとおり。古い資料にある「Social & Communication」は**存在しない**。
> **仕事効率化**: コミュニケーション / ツール / デベロッパー ツール / ワークフローと計画 / 教育
> **ライフスタイル**: アート＆デザイン / エンタテイメント / ゲーム / ショッピング / ソーシャル ネットワーク / ニュース＆天気

**Language**

```
English (United States)
```

日本語の掲載を足したくなったら §6 を参照してください。初版は英語のみで問題ありません。

### Graphic assets

| 欄 | 要件 | 用意したファイル | 実測 |
|---|---|---|---|
| Store icon | 128×128 | `icons/icon128.png` | ✅ 128×128 |
| Screenshots | 1280×800・最大5枚 | `store/screenshot-1-repo.png`<br>`store/screenshot-2-issue.png`<br>`store/screenshot-3-dark.png` | ✅ 3枚とも 1280×800 |
| Small promo tile | 440×280 | `store/promo-tile-440x280.png` | ✅ 440×280 |
| Marquee promo tile | 1400×560（任意） | 未作成 | — |
| YouTube video | 任意 | 無し | — |

スクリーンショットは推奨順に並べてあります。1枚目（リポジトリページ）を先頭にしてください。
すべて `octocat/Hello-World` で撮影しており、個人のリポジトリは写っていません。

> 公式ドキュメントの表記では Small promo tile と YouTube video に「required」と読める記述がありますが、
> 実際には動画なしで公開されている拡張が多数あります。**画面上で必須マークが付いている欄だけ埋めれば十分**です。
> 迷ったら空欄のまま進み、弾かれたら埋めてください。

### Additional fields

| 欄 | 値 |
|---|---|
| Official URL | 空欄のまま（Search Console での所有権確認が必要なため） |
| Homepage URL | `https://github.com/Driedsandwich/reposhout` |
| Support URL | `https://github.com/Driedsandwich/reposhout/issues` |
| Mature content | オフのまま |

---

## 3. Privacy practices タブ

### Single purpose

```
RepoShout has one purpose: to open X's post composer pre-filled with the title
and URL of the GitHub page the user is currently viewing.
```

### Permission justification

**activeTab**

```
RepoShout needs the URL and title of the tab the user is currently viewing in
order to compose the post text (for example "owner/repo: description" or
"Title (Issue #123 · owner/repo)") and to build the x.com share link.

activeTab was chosen deliberately over host permissions or the "tabs" permission
because it grants access only at the moment the user explicitly invokes the
extension -- by clicking the toolbar icon or pressing the keyboard shortcut --
and only for that one tab. It cannot be used to observe browsing in the
background.

The URL and title are used solely to construct the share URL. They are not
stored, logged, or transmitted anywhere by the extension.
```

**storage**

```
RepoShout opens the X composer in a window it creates itself, and lets the user
dismiss that window with the Escape key. To do that safely it has to know which
window it opened, so that Escape can never close a window the user opened.

The only thing written to storage is the window identifier returned by
chrome.windows.create(), together with the time it was opened. No URLs, no page
content, no browsing history, nothing about the user.

It is written to chrome.storage.session, which is held in memory, is cleared when
the browser closes, is never written to disk, and is not readable by content
scripts. Entries are removed as soon as the window closes, and expire after 12
hours in any case.

This replaces the previous approach of identifying the window by a fixed name,
which any web page could copy.
```

**Host permission: github.com**（content script の欄がある場合）

```
The in-page Share button is injected into GitHub's repository header so that
sharing takes one click from where the user already is. The content script reads
the page only to locate the button row, and adds a single <li> element. It never
modifies or removes any existing GitHub element, and does nothing at all if the
expected container is not found.
```

**Host permission: x.com**

```
This script has exactly one job: listen for the Escape key so the user can
dismiss the share window the extension just opened, if they change their mind.

It reads no page content from X. This script itself stores nothing and transmits
nothing; the extension's storage permission is used only by its service worker,
to remember the identifiers of windows it opened.

Before closing anything it asks the extension's service worker whether this
window is one the extension opened itself. The only evidence accepted is the
window identifier returned by chrome.windows.create. A web page cannot read or
forge that identifier. If it does not match -- which is the case for every X tab
the user opened themselves -- the script does nothing. It cannot close the
user's own X tabs. This is covered by end-to-end tests in the repository that
load the extension into a real browser (test/extension.e2e.mjs), including one
that opens a window imitating the previous version's fixed window name and
asserts that Escape leaves it alone.

Narrowing the match pattern to https://x.com/intent/* was considered and
rejected: Chrome rounds permission warnings to the host, so the narrower pattern
shows the user the same warning while breaking the feature whenever X redirects
the popup (for example to /i/flow/login when the user is signed out).
```

### Data usage

| 質問 | 回答 |
|---|---|
| Personally identifiable information | **No** |
| Health information | No |
| Financial and payment information | No |
| Authentication information | No |
| Personal communications | No |
| Location | No |
| Web history | **No** |
| User activity | No |
| Website content | **No** |

3つの証明にすべてチェック（該当なし・遵守）:

- [ ] 収集データを承認された用途以外に使用・転送しない
- [ ] 収集データを第三者に販売しない
- [ ] 信用力判断・融資目的に使用・転送しない

> **【実績】この回答のまま 1.0.0（2026-08-02）と 1.0.1（2026-08-03）の2回とも審査を通過しました。**
> 以下は当初の懸念の記録で、対応は不要です。差し戻された場合にだけ読んでください。
>
> **ここだけ判断が割れます。** 本拡張はURLとタイトルを**ユーザー操作の瞬間にのみ**読み、保存も送信もしません。
> ただし審査側が「Web history」「Website content」をより広く解釈する可能性があります。
> **No で弾かれたら Yes に変え、「ユーザー操作時のみ・端末内処理のみ・保存も送信もなし」と補足して再提出**してください。
> プライバシーポリシーは用意済みなので、どちらの回答でも要件は満たせます。

### Privacy policy URL

```
https://github.com/Driedsandwich/reposhout/blob/main/PRIVACY.md
```

到達性は 2026-08-01 に HTTP 200 で確認済みです。

---

## 4. Distribution タブ

| 欄 | 値 |
|---|---|
| Payments | Free（課金なし） |
| Visibility | Public |
| Distribution regions | All regions（絞る理由がないため） |

---

## 5. Submit for review

- [ ] 左メニューの各タブに赤い未入力マークが残っていないか確認
- [ ] **Submit for review** を押す
- [ ] 確認ダイアログで「審査通過後すぐ公開」か「手動で公開」かを選ぶ
      （初回は**手動公開**にしておくと、通過後に自分のタイミングで出せます）

審査は通常数日です。差し戻された場合は理由が記載されたメールが届くので、その文面を共有していただければ原因を特定して直します。

**実績**: 1.0.0 は 2026-08-01提出 → 08-02通過。1.0.1 は 08-02提出 → 08-03通過。いずれも1日で、差し戻しはありません。

**1.1.0 は権限を1つ増やします**（`storage`）。Chromeの画面上で新しい警告は出ない種類の権限ですが、権限が増える更新は審査が長くなることがあります。上の「storage」の正当化文をそのまま貼ってください。

---

## 6. あとから日本語の掲載を足す場合

`_locales/en/messages.json` と `_locales/ja/messages.json` を作り、`manifest.json` の `name` / `description` を `__MSG_...__` 形式に変えると、ストア掲載が言語ごとに切り替わります。初版は英語のみで提出し、必要になってから追加するのが簡単です。作業はこちらで実施できます。

---

## 競合状況（掲載文を書くときの前提）

ストアに近い領域の拡張が1件あります。

| 項目 | 実測（2026-08-01） |
|---|---|
| 名称 | [RepoCast — GitHub repo share copy & cards](https://chromewebstore.google.com/detail/lpkhpmjlkjgdlnajljaipakcnhgdodfe) |
| バージョン / 更新 | v1.0.5 / 2026-07-18 |
| 利用者 | **3人**（評価5.0・1件） |
| 機能 | GitHubリポジトリページにボタンを追加し、サイドパネルで X / LinkedIn / Reddit / WhatsApp / Discord 向けの共有文と共有カードを生成 |

RepoShout は宛先をXに絞り、サイドパネルもカード生成も持ちません。差別化は次の3点です（いずれも実測に基づく事実で、README にも記載済み）。

1. ログイン状態とログアウト状態の**両方**に対応（GitHubはこの2つで実装が別物。ログイン時のIssue/PRにはボタン行自体が無いため、ツールバー/ショートカットで補っている）
2. 文字数の数え方を**Xの規則に沿わせ、ずれるときは必ず多めに数える**（半角カタカナ・絵文字・スキーム無しドメインを含む）。単体・適合テスト40件と、実際のChromeへ拡張を読み込む**E2E 10件**で検査している（2026-08-05 実測・いずれも全PASS）
3. Open / Merged / Closed の状態を**意図的に出さない**（ログイン状態で読み取り値が食い違う事象を実測したため）

それ以前の同種拡張（2015 / 2018 / 2021）はいずれも更新停止かつManifest V2世代で、現在は動作しません。

---

## 参考: 名前欄の上限

**75文字**です（[公式ドキュメント](https://developer.chrome.com/docs/extensions/reference/manifest/name)で確認）。2024-02-22に45文字から引き上げられており、[Chromium拡張のアナウンス](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/mpDvFpT0KJM/m/WWFFQZFyAAAJ)に「a universal limit of 75 characters for an extension's name field in their manifest.json」と記載があります。古い資料には45文字と書かれていることがあるので注意してください。

この枠を使って「固有名 — 機能説明」の形にしています。固有名だけでは誰も検索しませんし、機能語だけでは他社商標が名前の主役になってしまうためです。`short_name`（`RepoShout`・9文字）は狭い表示領域用で、12文字以内が推奨されます。
