# Chrome ウェブストア掲載欄の差分（1.0.1 → 1.1.8）

作成: 2026-08-07 / 対象: 掲載中の 1.0.1 を 1.1.8 へ更新するときに、ダッシュボードのどの欄を何に直すか。

**データの取り扱い欄の答えの正本は [DATA_DISCLOSURE.json](DATA_DISCLOSURE.json) です。** この文書はそこから写しています。

**この文書はAIが書いた下書きです。ダッシュボードの操作はすべて本人が行います。**

> **提出の前提（2026-08-05 決定）**: 外部監査に合格してから提出する。
> 監査が `NOT_READY_FOR_CHROME_WEB_STORE_SUBMISSION` を返している間は、
> この文書の内容をダッシュボードへ反映しない。 画面の設問文はGoogle側が変えることがあるので、貼る前に実際の文言を読んでください。

---

## 0. なぜ直すのか（1行）

掲載中の説明文に「**sends nothing anywhere**（どこにも送らない）」と書いてありますが、これは事実と違います。Shareを押すと、ページのルートから生成した1行と組み直したURLが**Xの投稿画面を開いた時点でXへ渡ります**（1.1.8 以降、ページのタイトルは送りません）。開発者には何も送っていないので「開発者に送らない」は正しく、そこと混ざった書き方になっていました。

---

## 1. Description（説明文）

`LISTING.md` の §2 が全文の正本です。1.0.1 から変わるのは次の3点。

| 箇所 | 直す内容 |
|---|---|
| Privacy の段落 | 「no network requests of its own and sends nothing anywhere」→ 開発者には送らないことと、Xへは機能上渡ることを分けて書く |
| 機能の箇条書き | 「認証・設定・組織管理のページは共有しない」を追加 |
| 機能の箇条書き | 「ページのタイトルは送らない。本文はルートから生成する」を追加（第15回監査 R15-001） |
| 機能の箇条書き | 「検索語や作成中の本文など、自由に書ける欄は共有URLに含めない」を追加（第12回監査 R12-001） |

貼る文面（英語・そのままコピー）:

```
Nothing is sent to the developer, and there is no analytics or tracking. The page
generated line and URL are sent to X, because that is what the extension does: they are
placed in X's own composer link and reach X when the composer opens, before you
decide whether to post. Authentication, account, settings and organisation
admin pages are refused outright and are never shared.
```

---

## 2. Privacy practices（プライバシー）タブ

### Single purpose

**直します**（第18回監査 R18-001。1.1.8 でタイトルを送らなくなったのに、
掲載中の 1.0.1 の文面のままでした）。`LISTING.md` §3 と同じ文を貼ってください。

```
RepoShout has one purpose: to open X's post composer pre-filled with a one-line
description generated from the route of the GitHub page the user is currently
viewing, together with that page's link. The page title is not read or sent.
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
| Xへ渡るか | **渡る**。ルートから生成した1行と、検査済みパーツから組み直したURLが、Xの投稿画面のリンクに入って、画面が開いた時点で届く。**ページのタイトルは読まず、渡らない** |
| いつ渡るか | 利用者が Share を押し、投稿画面が開いた瞬間。**Postを押す前** |
| 保存するか | URLも投稿本文もタイトルも所有者名も保存しない。ウィンドウIDと開いた時刻だけを `chrome.storage.session`（メモリ）へ一時保存。12時間を過ぎた記録は根拠として数えなくなる（**消す期限ではない**——実際に消えるのは、窓を閉じたとき／Chromeがsession storageを消したとき／失効した記録を次に読んだとき） |
| 画面へ足すもの | `<style>` 1つとボタンの入れ物1つ、および共有できなかったときの一時的な案内1つ（`<div id="gxs-notice">`・数秒で消える・URLや値は含まない）。**案内は操作列が無いページでも足す**。GitHub側の要素は消しも置き換えもしない |
| 画面から読むもの | ボタンを置くための決まった範囲だけ——目印の有無・先頭の子の作り・配置合わせの表示値3つ・隣のボタンの高さ。ページの本文も入力欄の値も読まない。タイトルは読まない。URLもここでは読まず、見るのは service worker |

これを踏まえた答えが次の表です。**答えの正本は [DATA_DISCLOSURE.json](DATA_DISCLOSURE.json)** で、この表はそこから写しています。ずれるとテストが落ちます。
<!-- HISTORICAL_CLAIM:start reason="第5回監査より前の文書構成。現在の運用ではない" -->以前はこの表と `LISTING.md` で PII の答えが割れていて、どちらを見るかで申告が変わる状態でした（第5回監査 R5-001）。<!-- HISTORICAL_CLAIM:end -->

| 設問 | 1.0.1での回答 | 今回 | 理由 |
|---|---|---|---|
| Personally identifiable information | No | **Yes へ変更** | 共有できるページでは、GitHubの所有者名とリポジトリ名が**必ず**投稿本文と共有URLに入る |
| Health information | No | No | 扱わない |
| Financial and payment information | No | No | 扱わない |
| Authentication information | No | **要確認**（案: No） | 資格情報そのものは扱わないが、操作時に現在のタブのURL全体をいったん受け取る |
| Personal communications | No | No | 扱わない |
| Location | No | No | 扱わない |
| Web history | No | **Yes へ変更** | 利用者が見ているページのURLが、第三者（X）へ渡る |
| User activity | No | **要確認**（案: No） | クリック・スクロール・マウス位置・入力内容は読まない。keydown を1つ見て Escape かだけ判定する |
| Website content | No | **Yes へ変更** | ボタンの位置を探すためにDOMを端末内で読む（タイトルは読まず、Xへも送らない） |

**個人を識別できる情報（PII）を Yes にする理由**（第5回監査 R5-001）: 公式の User Data FAQ は、PIIの例に **username を明記**しています。RepoShout が共有するURLは `github.com/<所有者名>/<リポジトリ名>` の形で、投稿本文（`owner/repo`・`Issue #12 · owner/repo` など）にも同じ2つが入ります。**共有できるページでは、所有者名とリポジトリ名が必ず入ります**（第15回監査 R15-001 以降、共有できるのはこの形のルートだけになったため）。**handle には transmit が含まれ**、これらはXへ渡ります。

<!-- HISTORICAL_CLAIM:start reason="第5回〜第14回のPII申告の経緯。現在の仕様ではない" -->
> **【履歴・現在の仕様ではありません】** 第5回監査（2026-08-06）の時点では、ここに
> 「URLには必ずアカウント名が入る」と書いてあったのを「入る場合がある」へ弱めました。
> 当時は `github.com/search?q=…`・`github.com/explore`・`github.com/topics/…` を
> 共有でき、それらにアカウント名が入らなかったためです。
> **第15回監査 R15-001 でこれらのルートは共有対象から外れたので、いまは
> 「必ず入る」が正しくなっています。** 弱いままにすると、こんどは過少申告になります。
<!-- HISTORICAL_CLAIM:end -->

**本人の確認が要る欄は2つ**（残りの7欄は判断が確定しています）。この2欄は、**確定するまで「要確認」のまま**にしてあります（第7回監査 R7-002）。確定したら `store/DATA_DISCLOSURE.json` の `ownerConfirmation` へ、読んだ設問文・確認日・選んだ答え・理由を書いてください。

**① Authentication information**: cookie もフォームの入力値も読みません。**1.1.8 で、共有URLに残るクエリの値も検査し、資格情報の形をしていればURLごと拒否するようにしました**（第11回監査 R11-001。<!-- HISTORICAL_CLAIM:start reason="1.1.7までの挙動。現在の仕様ではない" -->1.1.7 までは名前しか見ておらず、`q`・`body`・`title` の値に入った資格情報がXへ渡っていました<!-- HISTORICAL_CLAIM:end -->）。ただし**操作された時点では現在のタブのURL全体をいったん受け取り**（ツールバー/ショートカットは `activeTab` 経由）、拒否の判定はそのあとで行います。資格情報そのものを保存したり送ったりはしないので **No と判断**しましたが、`handle` には use が含まれるので、現行の設問文を読んで最終確認してください。

**② User activity**: `x.com` 側で capture phase の `keydown` listener を1つ登録しており、**すべての keydown の `key` を見ます**。未修飾の Escape 以外は直ちに無視し、入力欄の値やページの中身は読まず、保存も集計も送信もしません（拡張が自分で開いた投稿画面を閉じるためです）。なお 1.1.8 では、**投稿画面の窓を記録できなかったとき**（Escで閉じられない状態）に、3つの入口すべてでその場に定型の案内を1回だけ出します（第24回監査 R24-003）。案内の文にURLも値も入れず、外へは何も送りません。この欄は「操作の監視（クリック・マウス位置・スクロール・キーロギング等）」を指すので **No と判断**しましたが、「Escapeだけを聞いている」という書き方は技術的に狭いので、事実として上のとおり書いておきます（第11回監査 R11-003）。ダッシュボードの現行の説明文を読んで、最終的には本人が決めてください。

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
status : pending_main_ci（成果物がまだありません）
中のZIP : reposhout-1.1.8.zip
```

第24回監査の是正で出荷物（`src/background.js` / `src/content.js` / `_locales`）が変わったため、
前の候補は却下しました（`SUBMISSION_CANDIDATE.json` の history に理由つきで残しています）。
**成果物名・大きさ・SHA-256 は、main の CI が作ってから実測して書きます。**
いま「それらしい値」を書くと、必ず作り話になります。

正本のファイルは [SUBMISSION_CANDIDATE.json](SUBMISSION_CANDIDATE.json) です。
却下した成果物は提出しません（理由も同ファイルにあります）。
**「最新の main」では選ばず、上の成果物名とSHA-256 で選んでください**（第10回監査 R10-006）。

---

## 5. この文書でやらないこと

- ダッシュボードの操作そのもの（拡張機能からウェブストアは操作できません。人の手作業です）
- 掲載中 1.0.1 の説明文の即時修正（1.1.8 の提出と同時で足りるか、先に文面だけ直すかは本人の判断）
