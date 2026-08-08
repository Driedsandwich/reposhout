# Chrome ウェブストア掲載欄の差分（1.0.1 → 1.1.8）

作成: 2026-08-07 / 対象: 掲載中の 1.0.1 を 1.1.8 へ更新するときに、ダッシュボードのどの欄を何に直すか。

**データの取り扱い欄の答えの正本は [DATA_DISCLOSURE.json](DATA_DISCLOSURE.json) です。** この文書はそこから写しています。

**この文書はAIが書いた下書きです。ダッシュボードの操作はすべて本人が行います。**

> **提出の前提（2026-08-05 決定）**: 外部監査に合格してから提出する。
> 監査が `NOT_READY_FOR_CHROME_WEB_STORE_SUBMISSION` を返している間は、
> この文書の内容をダッシュボードへ反映しない。 画面の設問文はGoogle側が変えることがあるので、貼る前に実際の文言を読んでください。

---

## 0. なぜ直すのか（1行）

掲載中の説明文に「**sends nothing anywhere**（どこにも送らない）」と書いてありますが、これは事実と違います。Shareを押すと、ページのタイトルとURLは**Xの投稿画面を開いた時点でXへ渡ります**。開発者には何も送っていないので「開発者に送らない」は正しく、そこと混ざった書き方になっていました。

---

## 1. Description（説明文）

`LISTING.md` の §2 が全文の正本です。1.0.1 から変わるのは次の3点。

| 箇所 | 直す内容 |
|---|---|
| Privacy の段落 | 「no network requests of its own and sends nothing anywhere」→ 開発者には送らないことと、Xへは機能上渡ることを分けて書く |
| 機能の箇条書き | 「認証・設定・組織管理のページは共有しない」を追加 |
| 機能の箇条書き | 「タイトルを切り詰めても Issue / PR 番号は残る」を追加 |
| 機能の箇条書き | 「検索語や作成中の本文など、自由に書ける欄は共有URLに含めない」を追加（第12回監査 R12-001） |

貼る文面（英語・そのままコピー）:

```
Nothing is sent to the developer, and there is no analytics or tracking. The page
title and URL are sent to X, because that is what the extension does: they are
placed in X's own composer link and reach X when the composer opens, before you
decide whether to post. Authentication, account, settings and organisation
admin pages are refused outright and are never shared.
```

---

## 2. Privacy practices（プライバシー）タブ

### Single purpose

変更なし。

```
RepoShout has one purpose: to open X's post composer pre-filled with the title
and URL of the GitHub page the user is currently viewing.
```

### Permission justification

`activeTab` は変更なし。**`storage` の欄が新しく必要**です（1.1.0 で追加した権限）。文面は `LISTING.md` §3 の「storage」をそのまま貼ってください。

### Data usage — ⚠️ ここが今回いちばん判断の要る欄

**1.0.0 / 1.0.1 は「すべて No」で申告して2回とも審査を通っています。** ただしその根拠として書いていた「何も送信しないから」は**事実ではありませんでした**。通ったこと自体は、答えが正しかったことの証明にはなりません。

事実関係はこうです。

| 事実 | |
|---|---|
| 開発者・開発者のサーバーへ送るか | **送らない**（サーバーが存在しない） |
| 解析・トラッキング・広告 | **無し** |
| Xへ渡るか | **渡る**。ページのタイトルと正規化済みURLが、Xの投稿画面のリンクに入って、画面が開いた時点で届く |
| いつ渡るか | 利用者が Share を押し、投稿画面が開いた瞬間。**Postを押す前** |
| 保存するか | タイトル・URLは保存しない。ウィンドウIDと時刻だけを `chrome.storage.session`（メモリ）へ一時保存 |

これを踏まえた答えが次の表です。**答えの正本は [DATA_DISCLOSURE.json](DATA_DISCLOSURE.json)** で、この表はそこから写しています。以前はこの表と `LISTING.md` で PII の答えが割れていて、どちらを見るかで申告が変わる状態でした（第5回監査 R5-001）。ずれるとテストが落ちます。

| 設問 | 1.0.1での回答 | 今回 | 理由 |
|---|---|---|---|
| Personally identifiable information | No | **Yes へ変更** | 共有するURL・タイトルに、GitHubのユーザー名または組織名が入る場合がある |
| Health information | No | No | 扱わない |
| Financial and payment information | No | No | 扱わない |
| Authentication information | No | **要確認**（案: No） | 資格情報そのものは扱わないが、操作時に現在のタブのURL全体をいったん受け取る |
| Personal communications | No | No | 扱わない |
| Location | No | No | 扱わない |
| Web history | No | **Yes へ変更** | 利用者が見ているページのURLが、第三者（X）へ渡る |
| User activity | No | **要確認**（案: No） | クリック・スクロール・マウス位置・入力内容は読まない。keydown を1つ見て Escape かだけ判定する |
| Website content | No | **Yes へ変更** | ページのタイトルが、第三者（X）へ渡る |

**個人を識別できる情報（PII）を Yes にする理由**（第5回監査 R5-001）: 公式の User Data FAQ は、PIIの例に **username を明記**しています。RepoShout が共有するURLは `github.com/<ユーザー名>/<リポジトリ名>` の形で、タイトルや `(Issue #12 · owner/repo)` というサフィックスにもユーザー名・組織名が入ります。プロフィールページを共有した場合、そのユーザー名は本人を指します。**handle には transmit が含まれ**、これらはXへ渡ります。

> **⚠️ 以前ここには「URLには必ずアカウント名が入る」と書いていましたが、これは言い過ぎでした。**
> `github.com/search?q=…`・`github.com/explore`・`github.com/topics/…` は共有できて、
> アカウント名を含みません（2026-08-06に実測）。正しくは「**入る場合がある**」です。
> 少なく申告しないのと同じくらい、事実より広く言わないことも大事です。

**本人の確認が要る欄は2つ**（残りの7欄は判断が確定しています）。この2欄は、**確定するまで「要確認」のまま**にしてあります（第7回監査 R7-002）。確定したら `store/DATA_DISCLOSURE.json` の `ownerConfirmation` へ、読んだ設問文・確認日・選んだ答え・理由を書いてください。

**① Authentication information**: cookie もフォームの入力値も読みません。**1.1.8 で、共有URLに残るクエリの値も検査し、資格情報の形をしていればURLごと拒否するようにしました**（第11回監査 R11-001。1.1.7 までは名前しか見ておらず、`q`・`body`・`title` の値に入った資格情報がXへ渡っていました）。ただし**操作された時点では現在のタブのURL全体をいったん受け取り**（ツールバー/ショートカットは `activeTab` 経由）、拒否の判定はそのあとで行います。資格情報そのものを保存したり送ったりはしないので **No と判断**しましたが、`handle` には use が含まれるので、現行の設問文を読んで最終確認してください。

**② User activity**: `x.com` 側で capture phase の `keydown` listener を1つ登録しており、**すべての keydown の `key` を見ます**。未修飾の Escape 以外は直ちに無視し、入力欄の値やページの中身は読まず、保存も集計も送信もしません（拡張が自分で開いた投稿画面を閉じるためです）。この欄は「操作の監視（クリック・マウス位置・スクロール・キーロギング等）」を指すので **No と判断**しましたが、「Escapeだけを聞いている」という書き方は技術的に狭いので、事実として上のとおり書いておきます（第11回監査 R11-003）。ダッシュボードの現行の説明文を読んで、最終的には本人が決めてください。

**Web history / Website content を Yes と推奨する理由**: Googleの User Data FAQ は「handle」に collect だけでなく **transmit** を含め、URL やドメインを web browsing activity の例に挙げています。今回のように「機能として第三者へ渡す」場合、No のままにする合理的な根拠がありません。Yes にしても、プライバシーポリシー（`PRIVACY.md`）は既に用意してあり、要件は満たせます。

**推奨に反対する材料**: 過去2回 No で通っている。Yes へ変えると掲載ページの「データの取り扱い」表示が変わり、審査が長くなる可能性がある。ただし**「前に通ったから」は正確さの根拠にはなりません**。

3つの証明のチェックは、これまでどおり全部チェックできます（承認された用途以外に使わない／第三者に販売しない／信用力判断に使わない）。

### Privacy policy URL

変更なし。

```
https://github.com/Driedsandwich/reposhout/blob/main/PRIVACY.md
```

---

## 3. Support URL（任意）

いま未設定なら、設定するとサポート窓口が明確になります。

```
https://github.com/Driedsandwich/reposhout/blob/main/SUPPORT.md
```

---

## 4. アップロードするもの

**手元で `npm run package` して作ったZIPは提出しません**（名前に `NON-SUBMITTABLE` が付きます・第9回監査 R9-003）。
使うのは main への push で走ったCIが残した成果物だけです。取り出し方は
[LISTING.md](LISTING.md) §1「どのZIPを出すか」を見てください。

今回出すもの:

```
成果物 : reposhout-package-4cb45239e8ed9358593f09efb1ed6f6c74e994f7
中のZIP : reposhout-1.1.8.zip
大きさ : 33,576 B / 11ファイル
SHA-256 : 91c5e7983d383f33dfe8c38ab40262af1c828c1f97bce8bddffad767e6256dba
```

正本のファイルは [SUBMISSION_CANDIDATE.json](SUBMISSION_CANDIDATE.json) です。1.1.8 は
第12回監査 R12-001 / R12-002 で作り直した版で、配布物の中身が変わっています。
**「最新の main」では選ばず、上の成果物名とSHA-256 で選んでください**（第10回監査 R10-006）。
実物が正本どおりかは
`npm run verify:submission-ready -- --artifact <成果物.zip> --audit-report … --audit-attestation …`
で確かめられます。

---

## 5. この文書でやらないこと

- ダッシュボードの操作そのもの（拡張機能からウェブストアは操作できません。人の手作業です）
- 掲載中 1.0.1 の説明文の即時修正（1.1.8 の提出と同時で足りるか、先に文面だけ直すかは本人の判断）
