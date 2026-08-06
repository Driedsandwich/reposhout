# RepoShout 1.1.4 — 第5回監査への対応記録

作成: 2026-08-06 / 対象コミット: `4db83f086735db360443f4d45512702f38ca5936`（main・タグ `v1.1.3`）

第5回監査（GPT-5.6 Sol Pro）の指摘5件への対応。**5件とも、直す前に現物で再現させた。**
第4回の R4-001 のような「再現しない指摘」は今回は無かった。

---

## 1. いまの状態

| 項目 | 状態 |
|---|---|
| main | `4db83f0`（1.1.3） |
| 1.1.4 | **作業ツリーにあるだけ。commit も push もタグもしていない** |
| タグ | `v1.1.0` `v1.1.1` `v1.1.2` `v1.1.3` の4本。**どれも動かしていない**（リモートで実測） |
| GitHub Release | **1本も作っていない**（あるのはタグだけ） |
| ストア公開版 | **1.0.1**。2026-08-06 に配布中のCRXを取得して `manifest.json` を読み、実測で確認 |
| ストアへの提出 | 1.1.0〜1.1.4 のどれも提出していない |
| 提出の前提 | **外部監査に合格してから出す**（本人決定・2026-08-05）。判定は5回とも NOT_READY |

---

## 2. 指摘と対応

| ID | 再現 | 直したもの | 触ったファイル | 検査 |
|---|---|---|---|---|
| R5-001 | ○ | データ申告の正本を1つにし、PII を Yes に統一。「必ずアカウント名が入る」を「入る場合がある」へ | `store/DATA_DISCLOSURE.json`（新規）`store/LISTING.md` `store/STORE_DASHBOARD_CHANGES.md` `PRIVACY.md` | `test/docs.test.mjs` に5件 |
| R5-002 | ○ | 配布物の作成を「作業用で作って検算し、通ったら入れ替える」方式へ。dirty のZIP名と記録名を一致 | `scripts/package.mjs` | `test/package.test.mjs`（新規・14件） |
| R5-003 | ○ | PRのCIは成果物を残さない。main の push だけコミットSHA入りの名前で残す | `.github/workflows/ci.yml` `scripts/package.mjs` | `test/manifest.test.mjs` に1件 |
| R5-004 | ○ | 公式 conformance コーパスを固定して実際に走らせ、「証明」という言い方を測った範囲へ限定 | `test/vendor/…/validate.yml`（新規）`README.md` `README.ja.md` | `test/conformance.test.mjs`（新規・7件） |
| R5-005 | ○ | 出荷ファイル数・DOM説明・依存の説明・版の状態を実態へ | `README.md` `README.ja.md` `PRIVACY.md` `store/LISTING.md` `IMPLEMENTATION_REPORT.md` | `test/docs.test.mjs` |

### R5-001 — データ申告が文書ごとに割れていた（P1）

**再現**: `store/LISTING.md:254` は `| Personally identifiable information | No | 扱わない |`、
`store/STORE_DASHBOARD_CHANGES.md:76` は `| … | No | **要判断（下記）** | …` で「推奨は Yes」。
どちらの文書を見て入力するかで、申告が変わる状態だった。

**直したこと**:

- 答えの正本を `store/DATA_DISCLOSURE.json` 1つに決めた。文書はそこから写す
- **PII = Yes**。公式 User Data FAQ を読み直したところ、PII の例に **username を明記**している。
  handle の定義は "collecting, transmitting, using, or sharing" で、端末内処理だけでも開示が要る
- 各欄に「コードの事実」と「規約上の判断」を別の項目として書いた。コードを読んだだけで
  「該当しない」と断定しないため
- **1件だけ本人の判断へ回した** — `User activity`。`x.com` で `keydown` を1つ監視しているが、
  見ているのは Escape かどうかだけで保存も送信もしない。「操作の監視」には当たらないと判断して
  No にしたが、事実として書き残し、ダッシュボードの現行の説明文を読んで本人が決める

**あわせて直した言い過ぎ**: 「共有するURLには必ずGitHubのアカウント名が入る」は事実と違った。
実測すると `github.com/search?q=…`・`/explore`・`/topics/…` は共有でき、アカウント名を含まない。

```
https://github.com/search?q=test&type=repositories => 共有できる（アカウント名なし）
https://github.com/explore                          => 共有できる（アカウント名なし）
https://github.com/topics/javascript                => 共有できる（アカウント名なし）
```

少なく申告しないのと同じくらい、事実より広く言わないことも要る。

### R5-002 — 途中で失敗すると前の成果物まで消えた（P2）

**再現**: 旧 `scripts/package.mjs` は `rmSync(DIST)` → `mkdirSync` → 3回 `writeFileSync` の順だった。
2つ目の書き込みで失敗すると、直前まであった正常なZIPは消え、ZIPだけの `dist/` が残る。

**直したこと**: 作業用ディレクトリで3点すべてを作り、**書いたものを読み直して**
（ZIPの長さ・SHA-256、ハッシュファイルの中身、記録の `zip.name`/`sha256`/`bytes`）検算し、
通ったときだけディレクトリごと入れ替える。失敗したら作業用だけ消して、前の成果物には触らない。

入れ替えは2手（退避 → 配置）になる。配置に失敗したら退避を戻す。戻すこともできない場合は、
**前の成果物がどこにあるかを例外に書いて**落ちる。黙って失われるのが一番まずいため。

`--allow-dirty` で作ったZIPは、実ファイル名（`-dirty`）と `release-manifest.json` の `zip.name` が
食い違っていた。一致させ、`submittable: false` と理由も書くようにした。CI では `--allow-dirty` を
受け付けない。

**検査**: 書き込みを1つずつ実際に失敗させて、①前の成果物が残る ②中途半端なものが残らない
③作業用ディレクトリが残らない ④終了コードが0でない、を見る。
旧方式を再現した対照も置いてあり、そちらでは同じ検査が必ず落ちる。

### R5-003 — PRのCI成果物を提出候補と取り違えられた（P2）

**再現**: `pull_request` の既定チェックアウトは、GitHubがPR検証用に作る一時マージコミットを取り出す。
そこから作ったZIPの成果物名は `reposhout-package` で、main由来の提出候補と同じだった。

**直したこと**:

- PRでは成果物を残さない（`if: github.event_name != 'pull_request'`）。作れることの確認までは行う
- main への push と手動実行のときだけ `reposhout-package-<コミットSHA>` で残す
- 記録に `ci.eventName` / `ci.pullRequest` / `ci.githubSha` / PRの head・base / `treeSha` /
  `submittable` / `notSubmittableBecause` を書く
- PRビルドのZIPは名前も `…-NON-SUBMITTABLE.zip` にする（記録を読まずに拾っても間違えないように）
- 所有者がどのZIPを出すかの手順を `store/LISTING.md` §1 に書いた
- ついでに `persist-credentials: false` を全 checkout に付け、`npm ci --ignore-scripts` へ変えた

### R5-004 — 保証がテスト範囲を超えていた（P2）

**再現**: README に `an oracle proving the counter never under-counts` と書いてあるのに、
`test/oracle.test.mjs` 自身が「公式の conformance コーパスは npm パッケージに同梱されていない」
と断っていた。走らせていたのは公式**実装**を判定器にした比較で、公式**コーパス**ではなかった。

**直したこと**（監査の Option A を採った）:

| 項目 | 値 |
|---|---|
| 出所 | `https://github.com/twitter/twitter-text` |
| コミット | `65e7e00da383fb77f5ab7fe3c0dc26b724e14035`（タグ `v3.1.0` と同一と実測） |
| ファイル | `conformance/validate.yml` |
| SHA-256 | `29fa1be663676f3d0bb0a67f393b32c15d92c5dd10db9be401bf7708d7c5b703` |
| ライセンス | Apache-2.0（`test/vendor/twitter-text-conformance/LICENSE`・`08a9320a…`） |
| 走らせる範囲 | 文字数の3節 44件（`WeightedTweetsCounterTest` 20 / `WeightedTweetsWithDiscountedEmojiCounterTest` 22 / `UnicodeDirectionalMarkerCounterTest` 2） |
| 配布物への同梱 | **無し**（`scripts/package-files.mjs` の収録一覧に無く、`test/manifest.test.mjs` が見張る） |

YAML の読み手は自作している（この3節に出てくる構文だけを読む、意図的に狭いもの）。
自作の読み手は黙って壊れるので、**読み取った文字列を公式実装へ渡してコーパスの期待値と
一致するか**を44件すべてで確かめている。読み違えていればここで落ちる。

RepoShout が合わせているのは絵文字を1つ2として数える設定（`twitter-text` v3 の既定）なので、
期待値との突き合わせはその設定の2節24件で行い、残る旧設定の節も含めた44件の文面は
公式実装（v3設定）の値と突き合わせている。

文書の表現も「証明した」から、実際に測った範囲の言い方へ直した。

### R5-005 — 文書と実態のずれ（P3）

| 項目 | 実態 | 直し方 |
|---|---|---|
| 出荷ファイル数 | 11 | 件数を書かず `scripts/package-files.mjs` を参照する形へ（README×2・ストア文書・E2Eのテスト名・ヘルパのコメント） |
| DOMへ足すもの | `<style>` 1つ ＋ ボタン1個を包む要素1つ | 3か所の説明を統一。「GitHub側の要素は消しも置き換えもしない」を明記 |
| 依存 | 実行時ゼロ／テスト専用に `twitter-text` 3.1.0 が1つ | 「`package.json` に依存は無い」→ 実行時と開発時を分けて書く |
| 1.1.3 の状態 | main へマージ済み・タグ済み | 「作業ツリーにあるだけ」を訂正。GitHub Release が無いことも明記 |

---

## 3. 走らせた検査

| コマンド | 結果 | 備考 |
|---|---|---|
| `npm ci --ignore-scripts` | exit 0 | 5パッケージ・脆弱性0件 |
| `npm run test:unit` | **90件 PASS / 0 FAIL** | share / esc-close / manifest / oracle / conformance / package / docs |
| `npm run test:e2e` | **10件 PASS / 0 FAIL** | 実Chromeへ `Extensions.loadUnpacked`・約23秒 |
| 279/280/281 の境界 | 公式判定器で確認 | 280はvalid・281はinvalidを先に固定し、切り詰めた下書き1,600件が上限274を1件も越えないことを確認 |
| `node scripts/package.mjs --allow-dirty` | exit 0 | 作業ツリーが未コミットのため `-dirty` 名。提出には使わない |

環境: macOS（darwin 25.5.0）・Node v22.22.3・Chrome 151。

### 出来上がるZIP

| | |
|---|---|
| 名前（コミット後） | `dist/reposhout-1.1.4.zip` |
| SHA-256 | `31629c0816c4e399ec2c3d6968c1f07c43fe94cabbcb0b93f9f23a95d6379e71` |
| サイズ | 27,436 B / 11ファイル |
| いま手元にあるもの | `reposhout-1.1.4-dirty.zip`（**中身のバイト列は上と同一**。ZIPに入るのは配布する11ファイルだけで、git の状態は入らないため。違うのはファイル名と `release-manifest.json` の記録だけ） |

提出に使うのは、main へマージしたあとに走った CI が残す成果物です（`store/LISTING.md` §1 の手順）。

### 効いていることの確認（変異）

新しい検査が「落ちるべきときに落ちる」ことを、実装を壊して確かめた。

| 壊したもの | 落ちた検査 |
|---|---|
| 配布物の作成を「先に `dist` を消す」旧方式へ戻す | `test/package.test.mjs` 5件 |
| dirty のときの記録名を提出用の名前へ戻す | 「ファイル名と記録の名前が一致する」「PRの検証ビルドは区別される」 |
| 正本の PII を No へ戻す | 「ストア文書のデータ申告が、正本と1つ残らず一致する」 |
| 借りてきたコーパスを1文字書き換える | 「固定したバイト列のままである」「読み取った文字列を公式実装へ渡すと一致する」 |
| ワークフローから PR除外の `if:` を消す | 「PRのCIは提出候補の成果物を残さない」 |

### 依存と秘密情報

| 見たもの | 結果 |
|---|---|
| 依存の木 | `twitter-text@3.1.0` → `@babel/runtime` `core-js@2.6.12` `punycode` `twemoji-parser`（すべて開発用） |
| ライセンス | twitter-text = Apache-2.0（同梱LICENSE）、他4つ = MIT |
| `npm audit` | 脆弱性 0件（開発用を含めて） |
| インストール時スクリプト | `core-js` の `postinstall` 1件（寄付の案内）。`--ignore-scripts` でも全テストが通ることを実測し、CIをそちらへ変更 |
| 秘密情報の走査（追跡＋未追跡 47ファイル） | トークン・鍵・個人メール・ローカルパス **すべて0件**。同じ走査に必ず当たる対照（`RepoShout`）を混ぜて50件ヒットを確認 |
| 同（全履歴の diff・463,033文字） | 同じく0件。対照は149件ヒット |

---

## 4. やっていないこと

- commit / push / PR / タグ / GitHub Release
- ストアへのアップロード・提出・掲載文の変更・データ申告の変更
- Xへの実投稿
- 履歴の書き換え・秘密情報の失効処理（そもそも検出されていない）
- 実ブラウザでの手動QA。E2Eはローカルの偽サイトに対して自動で通っており、279/280/281 の境界も
  **公式の判定器に対しては機械で確認済み**だが、**実際のGitHubと実際のXの投稿画面**での目視確認は
  していない（アカウントが要り、誤って投稿する危険があるため）
