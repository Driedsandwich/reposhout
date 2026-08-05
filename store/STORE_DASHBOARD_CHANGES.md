# Chrome ウェブストア掲載欄の差分（1.0.1 → 1.1.2）

作成: 2026-08-05 / 対象: 掲載中の 1.0.1 を 1.1.2 へ更新するときに、ダッシュボードのどの欄を何に直すか。

**この文書はAIが書いた下書きです。ダッシュボードの操作はすべて本人が行います。** 画面の設問文はGoogle側が変えることがあるので、貼る前に実際の文言を読んでください。

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

これを踏まえた**推奨は次のとおり**です。

| 設問 | 1.0.1での回答 | 推奨 | 理由 |
|---|---|---|---|
| Web history | No | **Yes へ変更** | 利用者が見ているページのURLが、第三者（X）へ渡る |
| Website content | No | **Yes へ変更** | ページのタイトルが、第三者（X）へ渡る |
| Personally identifiable information | No | No | 扱わない |
| Authentication information | No | No | 扱わない |
| Personal communications | No | No | 扱わない |
| Location / Health / Financial / User activity | No | No | 扱わない |

**推奨する理由**: Googleの User Data FAQ は「handle」に collect だけでなく **transmit** を含め、URL やドメインを web browsing activity の例に挙げています。今回のように「機能として第三者へ渡す」場合、No のままにする合理的な根拠がありません。Yes にしても、プライバシーポリシー（`PRIVACY.md`）は既に用意してあり、要件は満たせます。

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

```
dist/reposhout-1.1.2.zip
```

`npm run package` で作れます。同じ内容なら何度作っても同じZIPになるので、`dist/reposhout-1.1.2.zip.sha256` の値を控えておけば、提出したものと手元のものが同じかを後から確かめられます。

---

## 5. この文書でやらないこと

- ダッシュボードの操作そのもの（拡張機能からウェブストアは操作できません。人の手作業です）
- 掲載中 1.0.1 の説明文の即時修正（1.1.2 の提出と同時で足りるか、先に文面だけ直すかは本人の判断）
