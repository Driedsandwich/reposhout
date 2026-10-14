# Web Intent が審査で差し戻されたときの作り替えの手順

**これは手順の下書きで、作り替えはまだしていない。** いまの出荷物は、投稿画面を
`https://x.com/intent/post?text=<ルートから生成した1行>&url=<組み直した github.com のURL>`
で開く（クエリに値を載せる）。

2026-10-14 に本人は、3つの道（Developer Support へ問い合わせる／問い合わせずに今の形で出す／
クエリを使わない形へ作り替える）のうち「問い合わせずに今の形で出す」を選んだ
（[WEB_INTENT_POLICY_DECISION.json](WEB_INTENT_POLICY_DECISION.json) の status `owner_accepted_risk`）。
この文書は、その道で審査に差し戻されたときに「クエリを使わない形」へ移るための手順を、
先に決めておくもの。

## 1. この手順を使うとき

審査の差し戻し（Rejected）または違反の警告のメールで、理由が次のどちらかに当たるとき。

| 論点 | 公式の原文 | 出典 |
|---|---|---|
| `secure_query_transport` | "Don't encode data in request headers or query parameters, even over HTTPS." | troubleshooting の User data policy - secure transmission |
| `redirection_policy` | "Do not post an extension with a single purpose of installing or launching another app, theme, webpage, or extension." | Program Policies の Minimum Functionality |

ほかの理由での差し戻しは、この手順の対象ではない（理由ごとに別に直す）。

## 2. 作り替えの前にすること

1. 差し戻しのメールの全文・通知の ID・受け取った日を記録する。
   [WEB_INTENT_POLICY_DECISION.json](WEB_INTENT_POLICY_DECISION.json) の status を `refused` にし、
   どの論点で差し戻されたかを論点ごとに書く。
2. メールに書かれた期限と、対象の版（提出した版か、公開中の版にも及ぶか）を確かめる。
3. **同じ ZIP をそのまま出し直さない。**
4. 本人に差し戻しの中身を見せ、この形へ移るかを決めてもらう（本人の判断）。

## 3. 移る先の形（設計の下書き・未実装）

- 共有の操作を受けたら、拡張の中のページに「ルートから生成した1行」と「組み直した github.com のURL」を
  表示し、利用者が「コピー」を押してクリップボードへ写す。
- X の投稿画面は**クエリを付けずに**開き、利用者が貼り付けて Post を押す。開き先の URL は、作り替えのときに
  X の現行の画面で確かめる（未確認）。
- これで `secure_query_transport`（クエリにデータを載せること）は外れる。`redirection_policy`
  （別のページを開くだけの拡張に当たらないか）は**残る**——下書きの表示とコピーは独自の機能の説明には
  なるが、適合は審査で決まる（第27回監査 A §5.4）。
- 使い勝手は落ちる（利用者が貼り付ける手間が増える）。

## 4. 作り替えで触る所

| 所 | 変えること |
|---|---|
| `src/share.js`（`intentUrlFor`・共有の組み立て） | クエリつきのURLを組み立てるのをやめ、下書き（1行とURL）を返す |
| `src/background.js`（投稿画面を開く処理） | 下書きのページを開く。投稿画面はクエリなしで開く |
| `src/esc-close.js` | Esc で閉じる対象（拡張が自分で開いた投稿画面）の決め方を見直す |
| `manifest.json` | 下書きのページを足す。クリップボードへの書き込みに権限が要るかを確かめ、足すなら権限の説明を直す |
| `_locales/` | 新しいページの文言（英日） |
| `store/DATA_DISCLOSURE.json` | X へ渡るのが利用者の貼り付けだけになるので、該当する欄の codeFact と答えを見直す（答えは本人が決める） |
| `store/DATA_FLOW_CLAIMS.json`・`PRIVACY.md`・`README.md`・`README.ja.md`・`store/LISTING.md`・`store/STORE_DASHBOARD_CHANGES.md` | 「投稿画面へ渡す」説明を貼り付けの形へ直す |
| `store/WEB_INTENT_POLICY_DECISION.json` | 作り替えで外した論点と残る論点を論点ごとに書く（Developer Support の確認を装わない） |
| `scripts/store-readiness.mjs` | 作り替えた状態を通す枝（論点ごとの解決の仕方を見る） |
| `test/`・`test/mutations.json` | 新しい形の試験と変異対照 |
| `store/SUBMISSION_CANDIDATE.json` | いまの候補を却下し、作り替えの後の main の CI 成果物で作り直す |
| 版（`manifest.json`・`package.json`） | 差し戻された版の扱いをダッシュボードで確かめてから決める（未確認） |

## 5. 順番

1. 【本人】差し戻しの中身を読み、この形へ移るかを決める。
2. 【AI】feature branch で作り替え、単体・E2E・変異対照を通し、PR → CI → main。
3. 【AI】作り替えた範囲の外部監査を通す（出荷物・方針・ゲートが変わるので、記録の追加だけの確認では足りない）。
4. 【AI】作り替えの後の main の CI 成果物で提出候補を作り直して実測する。
5. 【本人】アップロード・掲載とデータ申告の貼り替え・Submit for review。
