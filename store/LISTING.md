# Chrome ウェブストア 提出手順書

更新: 2026-08-06 / 対象: RepoShout **1.1.8**（未提出。公開状態の正本は [RELEASE_STATUS.md](../RELEASE_STATUS.md)）
**この文書は原稿と手順です。提出（Submit for review）はあなたが実行します。**

> **提出の前提（2026-08-05 決定）**: 外部監査（ChatGPT の GPT-5.6 Sol Pro）に**合格してから**提出する。
> **合格が出るまでこの手順は実行しない。** 何回目まで済んでいて判定がどうだったかは、
> ここへ書くと必ず古くなるので書かない。最新の判定は `~/dev/ClaudeCode` の監査応答ファイル
> （`REPOSHOUT_*_AUDIT_RESPONSE_*.md`）の日付が新しいものを見ること。
初回提出と更新提出の両方でこの文書を使います。

> **⚠️ 今回（1.0.1 → 1.1.8）の更新では、§0 事前確認・§1 パッケージ・§2 Store listing・§3 Privacy practices を
> すべて完了させてください（第10回監査 R10-004）。** 以前ここには「更新なら §1 と §2 だけで足りる」と
> 書いていましたが、今回は §3 も必ず直す必要があります。掲載中の 1.0.1 は9項目を**すべて No** で申告して
> おり、そのままにすると事実と違う申告を残したまま提出することになります。§3 で直すのは次の4つです。
>
> - データの取り扱い（すべて No → PII / Web history / Website content を Yes へ。残り2欄は本人確認待ち）
> - プライバシーポリシーURL
> - Limited Use の3つの証明（チェック）
> - `storage` 権限の説明（1.1.0 で追加した権限）

デベロッパーダッシュボードの画面順に並べてあります。上から順に進めてください。
各欄はコードブロックをそのままコピペできます。

- 提出用ZIP: **手元で `npm run package` して作ったものは提出しません**（名前に `NON-SUBMITTABLE` が付きます）。使うのは main への push で走ったCIが残した成果物だけです（→ §1「どのZIPを出すか」）。収録一覧は `scripts/package-files.mjs`・allowlist方式で、同じ内容なら何度作っても同じZIPになります
- 公開リポジトリ: https://github.com/Driedsandwich/reposhout
- ダッシュボード: https://chrome.google.com/webstore/devconsole

---

## 0. 事前確認

- [ ] デベロッパー登録が有効か（$5 は支払い済みとのことですが、**AIからは確認できません**）。ダッシュボードに入って「新しいアイテム」が押せれば有効です
- [ ] Googleアカウントが意図したものか（公開者名として表示されます）

---

## 1. パッケージのアップロード

**⚠️ これは「更新」です。「新しいアイテムを追加」を押さないでください。**

RepoShout は既に `1.0.1` がストアで公開中です。新規登録の入口から入ると、
**別のIDの拡張機能がもう1つ出来てしまい**、いまの利用者・評価・自動更新は引き継がれません
（第8回監査 R8-001）。既存のアイテムを開いて、そこへ新しいZIPを載せます。

1. デベロッパーダッシュボードで、既存のアイテム `joaipdjaiefbenoijcekdnjagiadikkd` を開く
2. **Package** タブを開く
3. **Upload New Package** から、検証済みのZIPをアップロードする
4. Store listing タブと Privacy practices タブを、下の §2・§3 のとおりに直す
5. **Submit for review**

載せるZIP:

```
reposhout-1.1.8.zip
```

（初回登録の手順は §7 にまとめてあります。**いまは使いません。**）

### どのZIPを出すか（2026-08-06 追加・第5回監査 R5-003）

**PRのCIが作ったZIPは使わないでください。** GitHubはPRを検証するとき、そのブランチと main を
仮に合わせた**一時的なコミット**を作り、CIはそこからZIPを作ります。そのコミットは main のどれとも
一致しないので、あとから「提出したものはどのコミットか」を辿れません。

1.1.4 からは、機械側でも人間側でも見分けられるようにしてあります。

| 見るところ | 提出してよいもの | 出してはいけないもの |
|---|---|---|
| ファイル名 | `reposhout-1.1.8.zip` | `…-NON-SUBMITTABLE.zip` / `…-dirty-NON-SUBMITTABLE.zip` |
| `dist/release-manifest.json` の `submittable` | `true` | `false` |
| 同 `ci.eventName` | `push` | `pull_request` / `workflow_dispatch` / `local` |
| 同 `ci.ref` | `refs/heads/main` | それ以外 |
| 同 `sourceCommit` | main のコミットと一致（`ci.githubSha` とも一致） | 一致しない |

**提出候補になるのは「main への push で走ったCI」だけです**（1.1.5 で厳しくしました・第6回監査 R6-001）。
手元で `npm run package` して作ったZIPも、feature ブランチやタグから手で回したCIのZIPも、
名前に `NON-SUBMITTABLE` が付き、記録の `submittable` は `false` になります。
PRのCIはそもそも成果物を残しません（作れることの確認だけ）。

使うのは、**main へマージしたあとに走った CI が残した `reposhout-package-<コミットSHA>`** です。

1. Actions で main の該当 run を開き、成果物 `reposhout-package-<SHA>` をダウンロードする
2. 展開して `release-manifest.json` を開き、上の表の5点を確かめる
3. `shasum -a 256 reposhout-1.1.8.zip` の値が、同梱の `.sha256` と一致することを確かめる
4. **新しい空のフォルダを作り、そこへ `reposhout-1.1.8.zip` を展開する**
   （ダウンロードした成果物のフォルダには `release-manifest.json` とZIPとハッシュしか入っておらず、
   `manifest.json` がありません。そのまま読み込もうとしても拡張として認識されません）
5. 展開したフォルダの直下に `manifest.json` があること、その `version` が上げた版であることを確かめる
6. **そのフォルダ**を「パッケージ化されていない拡張機能」として読み込み、動作を見る
7. **手順3で確かめたのと同じZIPファイルをアップロードする**（手元で作り直したものと差し替えない）

**今回出す正本**（正本のファイルは [SUBMISSION_CANDIDATE.json](SUBMISSION_CANDIDATE.json)）:

```
状態     : pending_main_ci（出せる成果物はまだ存在しません）
版       : 1.1.8
中のZIP  : reposhout-1.1.8.zip
成果物名 : 未定（main への push で CI が作ってから決まります）
SHA-256  : 未定（同上）
```

1.1.8 は `src/share.js` を直した版なので、**配布物の中身が 1.1.7 から変わります**
（第11回監査 R11-001）。本人がコミットして main の CI が走るまで、出すべき成果物は
存在しません。**推測で書かない・手元で作ったZIPで代用しない**——手元ビルドの名前には
`NON-SUBMITTABLE` が付きます。

成果物が出たら、次の順で確定します。

1. main の該当 run から `reposhout-package-<コミットSHA>` をダウンロードする
2. `store/SUBMISSION_CANDIDATE.json` に、実測した成果物名・コミット・tree・run・
   中のZIPの大きさ・収録数・SHA-256 を書く
3. 次で、書いた値と実物が合っているかを機械的に確かめる

```
npm run verify:submission-ready -- --artifact <成果物.zip> \
    --audit-report <監査報告書> --audit-attestation <監査申告.json>
```

**「最新の main」で成果物を選ばないでください。** main は文書・テスト・CIの変更でも進むので、
同じ版の成果物が複数残ります。選ぶ基準は正本に書いた成果物名とSHA-256です（第10回監査 R10-006）。

**手元に控えを残す**（提出後に「何を出したか」を後から確かめられるようにするため）:
ダウンロードした成果物のZIPそのもの・`release-manifest.json`・`reposhout-1.1.8.zip`・
`reposhout-1.1.8.zip.sha256` の4点を、Actions の保存期限（14日）が切れる前に手元へ保存して
おいてください。GitHub Release は作りません。

やってはいけないこと: ダウンロードした成果物のフォルダをそのまま読み込む／リポジトリの
フォルダで代わりに動作確認する／手元で作り直したZIPを出す／ハッシュを確かめていないZIPを出す。

同梱物は `scripts/package-files.mjs` に挙げたファイルだけです（`npm run package` の出力に一覧と件数が出ます）。`store/` `test/` `scripts/` `.github/` と文書は動作に不要なので、収録一覧（allowlist）に入れていません。
アップロード後、名前は `manifest.json` から自動で入ります（入力欄はありません）。

| 自動で入る値 | 内容 |
|---|---|
| Name | `RepoShout — Share GitHub repos, issues & PRs to X`（49文字 / 上限75） |
| Version | `1.1.8`（manifest の値。前回より大きくないと弾かれます） |
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
  that work on other shareable GitHub pages too
• Post text tailored to the page:
    Repository   →  owner/repo: description
    Issue        →  Title (Issue #123 · owner/repo)
    Pull request →  Title (PR #123 · owner/repo)
• Authentication, account, settings and organisation admin pages are never shared
• Query strings are handled per page type: filters on issue lists, ?plain=1 on a
  Markdown file and a prepared pull request's title and body are kept, while
  tracking parameters are dropped. Line, comment and README section anchors are kept
• Character counting follows X's published rules, including Japanese, Chinese and
  Korean text, emoji and links. No under-count was found against twitter-text 3.1.0
  in the pinned counting sections of the official corpus, the regression fixtures or
  the generated differential corpus, so a long title is trimmed with room to spare
• Issue and pull request numbers stay in the post even when the title is trimmed
• Light and dark mode follow GitHub's own theme automatically
• Press Escape in the share window to dismiss it if you change your mind

── Privacy ──

RepoShout requests two API permissions: activeTab and storage. activeTab lets it
read the current tab's URL and title, only at the moment you invoke it, purely to
build the post text. storage holds one thing: the identifiers of the windows the
extension itself opened, kept in memory and cleared when you quit the browser.

Nothing is sent to the developer, and there is no analytics or tracking. The page
title and URL are sent to X, because that is what the extension does: they are
placed in X's own composer link and reach X when the composer opens, before you
decide whether to post. Authentication, account, settings and organisation
admin pages are refused outright and are never shared.

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

The URL and title are used solely to construct the share URL. The extension does
not store them, does not log them, and does not send them to the developer or to
any server the developer operates. They are placed in X's own Web Intent link, so
they reach X when the composer opens -- that is the function the user asked for.
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
The in-page Share button is injected into GitHub's own action row so that
sharing takes one click from where the user already is.

What the content script does on github.com:

- It locates GitHub's action row. It reads the page structure only to find that
  row, and it does not inspect the body content of the page.
- It adds one <style> element to the document head, and one wrapper containing
  one Share button. The wrapper is an <li> or a <div>, depending on which
  container GitHub uses on that page. It does not modify, delete, or replace any
  existing GitHub element, and it does nothing at all if the expected container
  is not found.
- When -- and only when -- the user activates that button with a real click, it
  reads location.href and document.title in order to build the X Web Intent
  link. A click synthesised by page JavaScript is refused (event.isTrusted).
- It does not read cookies or form fields, runs no analytics, and makes no
  network request of its own.

The toolbar icon and the keyboard shortcut are a separate path: they do not use
this content script at all. They read the current tab's URL and title through
the activeTab permission, which is granted only at the moment the user invokes
the extension, and only for that one tab.
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

**この欄の答えは [DATA_DISCLOSURE.json](DATA_DISCLOSURE.json) が正本です。** 以前はこの表と
[STORE_DASHBOARD_CHANGES.md](STORE_DASHBOARD_CHANGES.md) で答えが食い違っていて、どちらを見るかで
申告が変わる状態でした（第5回監査 R5-001）。いまは正本から写した表で、ずれるとテストが落ちます。

| 質問 | 回答 | 理由 |
|---|---|---|
| Personally identifiable information | **Yes** | 共有するURL・タイトルに、GitHubのユーザー名または組織名が入る場合がある（公式FAQはPIIの例に username を挙げている） |
| Health information | No | 扱わない |
| Financial and payment information | No | 扱わない |
| Authentication information | **要確認**（案: No） | 資格情報そのものは扱わないが、操作時に現在のタブのURL全体をいったん受け取る。設問文を読んで本人が確定する |
| Personal communications | No | 扱わない |
| Location | No | 扱わない |
| Web history | **Yes** | 利用者が見ているページのURLが、第三者であるXへ渡るため |
| User activity | **要確認**（案: No） | クリック・スクロール・入力内容は読まない。x.com で keydown を1つ見て Escape かどうかだけ判定する（保存も送信もしない）。設問文を読んで本人が確定する |
| Website content | **Yes** | ページのタイトルが、同じくXへ渡るため |

3つの証明にすべてチェック（該当なし・遵守）:

- [ ] 収集データを承認された用途以外に使用・転送しない
- [ ] 収集データを第三者に販売しない
- [ ] 信用力判断・融資目的に使用・転送しない

> **1.0.0 と 1.0.1 は9項目すべてを No で申告して審査を通っています。**
> しかしその根拠として書いていた「何も送信しないから」は**事実ではありませんでした**。
> Shareを押すと、タイトルとURLは投稿画面が開いた時点でXへ渡ります。
> **通ったという実績は、回答が正確だったことの証明にはなりません。**
>
> 送り先の区別: **開発者は何も受け取りません**（サーバーが存在しません）。渡る先はXだけで、
> タイミングは投稿画面が開いた時点、Postを押すかどうかは利用者が決めます。
> タイトルとURLは保存しません（`chrome.storage.session` に入るのはウィンドウIDと時刻だけです）。

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
2. 文字数の数え方を**Xの規則に沿わせ、ずれるときは多めに数える側へ倒している**（半角カタカナ・絵文字・スキーム無しドメインを含む）。固定した公式コーパスの文字数対象節・手書きの期待値・生成した敵対的コーパスを `twitter-text` 3.1.0 と突き合わせた範囲では、過少計数は検出されていない（有限の回帰検査であり、全入力の証明ではない）。実際のChromeへ拡張を読み込む**E2E**も含め、`npm test` の全テストが通ることを確認している
3. Open / Merged / Closed の状態を**意図的に出さない**（ログイン状態で読み取り値が食い違う事象を実測したため）

それ以前の同種拡張（2015 / 2018 / 2021）はいずれも更新停止かつManifest V2世代で、現在は動作しません。

---

## 参考: 名前欄の上限

**75文字**です（[公式ドキュメント](https://developer.chrome.com/docs/extensions/reference/manifest/name)で確認）。2024-02-22に45文字から引き上げられており、[Chromium拡張のアナウンス](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/mpDvFpT0KJM/m/WWFFQZFyAAAJ)に「a universal limit of 75 characters for an extension's name field in their manifest.json」と記載があります。古い資料には45文字と書かれていることがあるので注意してください。

この枠を使って「固有名 — 機能説明」の形にしています。固有名だけでは誰も検索しませんし、機能語だけでは他社商標が名前の主役になってしまうためです。`short_name`（`RepoShout`・9文字）は狭い表示領域用で、12文字以内が推奨されます。

---

## 7. 付録: 初回登録の手順（いまは使いません）

**この節は、まだ公開していない拡張機能を新規に登録するときのものです。**
RepoShout は 1.0.1 が公開済みなので、更新のときは §1 のとおり
既存アイテムの **Package → Upload New Package** を使ってください。

新規登録の場合だけ、次の入口から入ります。

```
「新しいアイテムを追加」→ ZIPをドラッグ
```

そのあとの Store listing / Privacy practices / Distribution の各欄は、
§2 以降と同じ内容を入力します。

