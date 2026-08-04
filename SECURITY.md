# Security Policy / セキュリティ

## English

### Supported versions

Only the latest published version is supported. Fixes are shipped as a new Chrome Web Store release rather than backported.

### Reporting a vulnerability

**Do not put the details in a public issue.** A public issue is readable by everyone the moment you press submit, including before a fix exists.

GitHub's private vulnerability reporting is **not currently enabled** on this repository (checked 2026-08-05), so the route is:

1. Open an issue titled `Security report — requesting a private channel`, with **no technical detail** in it.
2. The maintainer will reply with a way to send the details privately.

If you would rather not open anything public at all, the Chrome Web Store listing shows the developer's contact address; that address is published by Google as part of the listing, not by this repository, so it is not repeated here.

### What to expect

This is a side project maintained by one person. There is no bounty and no guaranteed response time. What is promised is that a report will not be dismissed without being reproduced.

### Scope

In scope — anything in this repository, in particular:

- The Escape-to-close path on `x.com`. The rule is that only a window the extension opened itself may be closed. A page-controlled way to close a window the user opened is a vulnerability.
- The URL policy in `src/share.js`. A URL whose credentials, tokens or OAuth parameters survive into a draft post is a vulnerability.
- Anything that causes the extension to post without the user pressing Post on X.

Out of scope:

- GitHub's or X's own behaviour
- Attacks that require the user to install a modified copy of the extension
- The absence of a feature (for example, that the extension does not post on your behalf — that is deliberate)

---

## 日本語

### 対象バージョン

サポートするのは公開中の最新版だけです。修正は新しいバージョンとして Chrome ウェブストアへ出す形で、古い版への差し戻しは行いません。

### 脆弱性の報告方法

**詳細を公開Issueに書かないでください。** 公開Issueは投稿した瞬間から誰でも読めます。修正ができる前でも同じです。

このリポジトリでは GitHub の非公開脆弱性報告（Private vulnerability reporting）を**現時点で有効にしていません**（2026-08-05確認）。そのため手順は次のとおりです。

1. `Security report — requesting a private channel` という題で、**技術的な詳細を書かずに** Issue を立てる
2. 作者が非公開で詳細を送る方法を返信する

公開の場に何も出したくない場合は、Chrome ウェブストアの掲載ページに開発者の連絡先が表示されています。あれは掲載の仕様としてGoogleが出しているもので、このリポジトリが公開しているものではないため、ここには転記しません。

### 期待できること

個人の趣味で維持しているものです。報奨金はなく、対応期限の保証もありません。約束できるのは、再現を試みずに却下することはしない、という点だけです。

### 対象範囲

対象に含まれるもの——このリポジトリの内容すべて。特に次の3つ。

- `x.com` 上のEscで閉じる処理。ルールは「拡張自身が開いたウィンドウだけを閉じてよい」です。ページ側の操作で利用者のウィンドウを閉じられるなら、それは脆弱性です
- `src/share.js` のURL方針。資格情報・トークン・OAuthのパラメータが投稿の下書きまで残るURLがあれば、それは脆弱性です
- 利用者がX側で投稿ボタンを押していないのに投稿が行われる経路

対象外——GitHub や X 自体の挙動、改造した拡張を利用者が自分で入れることを前提とする攻撃、機能が無いこと（例: 代理投稿をしないのは意図的な設計です）。
