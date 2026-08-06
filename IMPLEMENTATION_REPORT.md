# RepoShout Implementation Report

監査（2026-08-04）の指摘4件に対する是正の記録。作成 2026-08-05。

---

> **この文書は 1.1.0 時点の記録です。最新の状態と 1.1.4 の対応は
> [IMPLEMENTATION_REPORT_1.1.4.md](IMPLEMENTATION_REPORT_1.1.4.md) を見てください。**

## 現在の状態（2026-08-05 追記）

**以下の本文は 1.1.0 を作った時点の記録で、その後に状態が変わっている。**
本文中の「commit / push / tag / CI は未実行」「status: COMPLETE」は、
書いた時点の事実であって、いまの状態ではない。

| 項目 | いまの状態 |
|---|---|
| 1.1.0 | main へマージ済み（`e13080f`）・タグ `v1.1.0`・CI success |
| 1.1.1 | 2回目の監査への対応。main へマージ済み（`00a3eee`）・タグ `v1.1.1`・CI success |
| 1.1.2 | 3回目の監査＋英語/Windows対応。main へマージ済み（`b1d9a41`）・タグ `v1.1.2`・CIは Ubuntu と Windows の両方で success |
| 1.1.3 | 4回目の監査への対応。main へマージ済み（`4db83f0`）・タグ `v1.1.3`・CIは Ubuntu と Windows の両方で success |
| 1.1.4 | 5回目の監査への対応。この表の時点では作業ツリーのみ（→ 最新は `IMPLEMENTATION_REPORT_1.1.4.md`） |
| ストア | **公開中は 1.0.1 のまま。1.1.0〜1.1.3 はどれも提出していない** |
| GitHub Release | **1本も作っていない**（あるのはタグだけ） |
| 監査 | 2026-08-05〜06 に外部レビューが5回。**指摘は 4件 → 7件 → 5件 → 6件 → 5件。4回目の1件（R4-001）だけは再現せず、指摘の前提が事実と違った** |
| ストア提出 | **外部監査に合格してから出す**（本人決定・2026-08-05）。判定は5回とも NOT_READY |

3回目（T3-001〜005）の要点と対応は [CHANGELOG.md](CHANGELOG.md) の 1.1.2 の節を正本とする。
とくに **1.1.1 の README に書いた「少なく数えない」という保証は、1.1.1 の時点では成立していなかった**
（`foobar.みんな/` などで公式を下回っていた）。1.1.2 でこれを直し、公式実装を判定器にした
機械検査を入れて、同じ主張を測れる形にした。

「status: COMPLETE」は RS-MAJ-01〜04 に対する判定であって、
再監査で出た RA-001〜007 を含む判定ではない。RA系の対応状況は
[CHANGELOG.md](CHANGELOG.md) の 1.1.1 の節を正本とする。

### 再監査で出た7件と、1.1.1 での対応

| ID | 再現したか | 対応 |
|---|---|---|
| RA-001 X文字数がなお非準拠 | ○ `example.com`=11、`a.co`×50=249、`✊🏽`=4 を再現 | ドットを含むトークンを一律23として数える（少なく数えない側へ倒す）。肌色修飾子つきを1絵文字として扱う。**公式パーサーの同梱は本人判断で見送り**（配布物が22KB→250KB超になるため）。README・掲載文の「公式どおり」という断定を撤回 |
| RA-002 Privacy と実挙動の不一致 | ○ 「sends nothing anywhere」等が実挙動と矛盾 | 「開発者へ送らない」と「機能としてXへ渡る」を分けて記述。投稿画面が開いた時点で渡ることを明記。`store/STORE_DASHBOARD_CHANGES.md` を新設 |
| RA-003 機微ルートを共有できる | ○ `/settings/tokens` が非nullで共有可能 | `buildShare` と `fallbackUrl` が `null` を返す。組織・Enterpriseの管理画面も対象 |
| RA-004 長文でサフィックスが消える | ○ 300文字のIssueで `(Issue #123 · owner/repo)` が消えるのを再現 | サフィックスぶんを先に確保し、可変のタイトル側だけを削る |
| RA-005 リポジトリrootのアンカー削除 | ○ `#readme` が落ちる | 節アンカーは残す。`key=value` 形と長すぎるものは落とす |
| RA-006 CIの供給網対策 | ○ 可変タグ・permissions無し・timeout無し | 完全なcommit SHAへ固定、`permissions: contents: read`、`timeout-minutes: 15`。静的検査をテストへ追加 |
| RA-007 文書のドリフト | ○ 「13ファイル」表記・本報告の古い記述 | 9ファイルへ訂正、`CHANGELOG.md` 新設、この節を追加 |

**再監査の前提のうち1つは誤りだった**: 「監査環境から `git clone` がDNS解決失敗」とあるとおり、再監査はテストを独立に再実行していない。そのうえで挙げられた指摘は7件とも実在した。

---

## Executive result

- **status: COMPLETE**（RS-MAJ-01〜04 はすべて閉じた。未検証事項は下の Incomplete / untested に列挙）
- **base commit**: `dbd078071f6c2394c3e43c2680482445aa60ccb5`（main・origin と一致）
- **final worktree status**: 変更12ファイル・新規12・削除1。**commit / push / tag / release / ストア提出はいずれも未実行**

## Findings verification

修正前に必ず現物で再現させ、修正後は「旧実装に戻すとテストが落ちる」ことまで確認した。

| ID | reproduced before fix | resolution | evidence |
|---|---|---|---|
| RS-MAJ-01 クエリを全部落とす | ○ 再現。`/issues?q=…`→`/issues`、`?plain=1#L14`→`#L14` だけ残る、`compare?quick_pull&title&body`→全消失 | ページ種別ごとの allowlist（`QUERY_ALLOW`）。未知のクエリは落とす。認証・設定系はクエリもハッシュも捨てる | `test/fixtures.js` URLS 28件 → `share.test.mjs`「URLの正規化」「機微なルート」。変異（`'sensitive': null` を allowlist へ差し替え）で3件FAIL |
| RS-MAJ-02 X文字数が非準拠 | ○ 再現。12ケース中10ケースが公式値と不一致（U+1160=1、ZWJ家族=11、半角カタカナ=1、本文URL=71） | twitter-text v3 の定義（既定2／重み1は4範囲／絵文字は書記素1つで2／URLは23／先にNFC） | `fixtures.js` WEIGHT 33件。変異（NFC無効化／絵文字判定無効化）でそれぞれ1件FAIL |
| RS-MAJ-03 Escの所有権 | ○ 再現。(a) `window.name === 'gxs-share-window'` だけで閉じていた（旧テスト自身が file:// から偽装して閉じることを示していた） (b) 記録が `new Set()` でSW停止とともに消える | 生成を service worker へ一本化。所有権は `chrome.windows.create` が返す windowId のみ。記録は `chrome.storage.session`（12時間で失効・`windows.onRemoved` で削除） | `extension.e2e.mjs` 10件。変異A（window.name判定を復活）→ E2E #6 FAIL。変異B（記録をメモリのみに）→ E2E #4 FAIL |
| RS-MAJ-04 テスト・CI・配布物 | ○ 再現。`package.json` 無し／CI 無し／ZIPは手作業／Chromeパスが macOS 決め打ち（`test/esc-close.test.js:13`） | `npm ci && npm test && npm run package`、GitHub Actions、allowlist方式の決定論的ZIP、Chromeは `CHROME_PATH`＋OS別探索 | 下の Commands and exact results |

### 監査指摘のうち、事実と違ったもの

- **「現在Issue作成がrestricted」→ 誤り。** `gh api repos/Driedsandwich/reposhout/interaction-limits` は `{}`（制限なし）、`has_issues: true`。よって `SUPPORT.md` は Issue を正規の窓口として書いた。
- 一方 **private vulnerability reporting は無効**（`{"enabled": false}`・postcloak も同じ）。`SECURITY.md` は「詳細を書かないIssueで非公開経路を要求する」手順にし、有効化はオーナーの手作業として下に挙げた。

## Changed files

| file | purpose | risk |
|---|---|---|
| `src/share.js` | URL方針の全面書き換え＋X文字数の準拠実装 | 中。共有される文面とURLが変わる。fixtures 103件で固定 |
| `src/background.js` | ウィンドウ生成の一本化・session storage による所有権管理 | 中。`storage` 権限が増える |
| `src/content.js` | `window.open` をやめ service worker へ依頼 | 低。依頼が届かない場合は素の `window.open`（Esc対象外）へ退避 |
| `src/esc-close.js` | `window.name` 判定の削除 | 低。判断がつかないときは「閉じない」側へ倒す設計は不変 |
| `manifest.json` | version 1.0.1→**1.1.0**、`storage` 権限を追加 | 中。ストア提出時に権限が増える |
| `package.json` / `package-lock.json` | 依存ゼロのテスト・パッケージ入口 | 低 |
| `scripts/package.mjs` / `scripts/package-files.mjs` | 決定論的ZIPと収録allowlist | 低 |
| `test/fixtures.js` | 期待値の表（Node／ブラウザ共通・手書き） | 低 |
| `test/share.test.mjs` / `esc-close.test.mjs` / `manifest.test.mjs` | 単体・適合・manifest検査 | 低 |
| `test/extension.e2e.mjs` / `test/helpers/*` | 実拡張E2E | 低 |
| `test/share.test.html` | 同じ期待値のブラウザ表示に作り替え | 低 |
| `test/esc-close.test.js` | **削除**（`.mjs` 版へ置換。macOSパス決め打ちの当事者） | 低。未コミットなので `git checkout -- test/esc-close.test.js` で復元可 |
| `.github/workflows/ci.yml` | Ubuntuで同じコマンドを実行 | 低 |
| `README.md` / `README.ja.md` / `PRIVACY.md` / `store/LISTING.md` | 実装との食い違いを解消 | 低 |
| `SECURITY.md` / `SUPPORT.md` | 新規 | 低 |

## Permissions and privacy impact

- **before**: `["activeTab"]`
- **after**: `["activeTab", "storage"]`
- **reason**: Escで閉じてよいウィンドウを windowId で識別するには、MV3 の service worker が停止・再起動しても残る置き場が要る。`chrome.storage.session` はメモリ上のみ・ブラウザ終了で消滅・ディスク非書き込み・content script から読めない（既定のアクセスレベルを変更していない）。保存するのは windowId と時刻だけで、URL・ページ内容・履歴は入らない。
- **alternatives rejected**:
  - ランダムな `window.name` に変えるだけ — 名前は依然ページ側から観測・再現できるうえ、SW再起動で失われる問題が残る
  - `chrome.scripting` で窓へ印を入れる — `scripting` 権限が要り、`storage` より広い
  - 記録をやめてEsc機能を削る — 製品判断なので自動実施しない（指示書のSTOP条件3）
- Chrome の権限警告文は `storage` では増えない。ただし**権限が増える更新であることは事実**なので、ストア審査が前回より長くなる可能性がある。

## Commands and exact results

| command | exit code | result |
|---|---|---|
| `npm ci` | 0 | `up to date, audited 1 package`（依存ゼロ） |
| `npm run test:unit` | 0 | tests 35 / pass 35 / fail 0 / skipped 0 |
| `npm run test:e2e` | 0 | tests 10 / pass 10 / fail 0 / skipped 0（実測 約38秒） |
| `npm run package` | 0 | `dist/reposhout-1.1.0.zip` 22,343 B / 9ファイル |
| `unzip -t dist/reposhout-1.1.0.zip` | 0 | `No errors detected` |
| ブラウザ版 `test/share.test.html` | — | 195項目 / fail 0（headless Chrome + CDP で実行して確認） |
| 変異A（`window.name` 判定を復活） | 2 | E2E #6 が FAIL（テストが本当に効いている証拠） |
| 変異B（記録をメモリのみに） | 2 | E2E #4 が FAIL |
| 変異C（NFC正規化を無効化） | 1 | 単体1件 FAIL |
| 変異D（絵文字クラスタ判定を無効化） | 1 | 単体1件 FAIL |
| 変異E（機微ルートのクエリ落としを無効化） | 1 | 単体3件 FAIL |

## Test coverage

- **unit**: 35テスト。手書き期待値103行（WEIGHT 33 / URLS 28 / TITLES 7 / LOCATIONS 12 / BUILD 23）。期待値は本番関数で生成していない。
- **X文字数の検査**（当時は conformance と呼んでいたが、公式コーパスは実行していない）: X文字数を twitter-text v3 の config 値（既定2・重み1の4範囲・emoji parsing・URL=23・NFC）に対して照合。境界は 279/280/281 を明示的に検査。切り詰めは絵文字301位置を走査し、孤立サロゲート・`encodeURIComponent` 例外・重み超過が無いことを確認。
- **actual-extension E2E**: 10テスト。出荷する9ファイルだけを一時ディレクトリへ並べ、`Extensions.loadUnpacked`（`--remote-debugging-pipe` ＋ `--enable-unsafe-extension-debugging`）で本物のChromeへ読み込む。`x.com` と `github.com` は `--host-resolver-rules` でローカルHTTPSサーバへ向けるので、外部通信も実アカウントも要らない。
- **CI**: `.github/workflows/ci.yml`。ubuntu-latest で Chrome の存在を先に確認し、無ければ**失敗させる**（黙ってskipしない）。`npm ci` → unit → e2e → package → 2回のSHA-256一致確認。
- **package reproducibility**: 同一worktreeで2回生成し SHA-256 一致を実測。

## Package dry-run

- **version**: 1.1.0
- **included files**（9・この順で固定）: `manifest.json` / `icons/icon16.png` / `icon32` / `icon48` / `icon128` / `src/share.js` / `src/content.js` / `src/background.js` / `src/esc-close.js`
- **excluded**: `test/` `store/` `scripts/` `.github/` `dist/` および全Markdown（allowlist方式なので、ファイルが増えても黙って混入しない。`test/manifest.test.mjs` が一覧を固定している）
- **sha256 run 1**: `78d49cf5feaa06196b629a6c38b158835b67195ba0ced0c74142a05063ccae68`
- **sha256 run 2**: 同一

## Incomplete / untested

完了扱いにしていないもの。

1. **ツールバーアイコン押下・キーボードショートカットを、ブラウザのUIイベントとして発火させたE2Eは無い。** `chrome.action.onClicked` と `chrome.commands.onCommand` は CDP から合成できない。E2Eはリスナーが呼ぶ本番関数（`shareActiveTab` / `openShareWindow`）を service worker 内で直接呼んでおり、リスナー登録そのものは `manifest.json` とコードの静的確認にとどまる。
2. **IME変換中のEscは単体テスト（偽イベント）でのみ検査。** 実ブラウザのIME合成イベントは再現していない。
3. **X文字数は「公式configの値」に対する適合であって、twitter-text の公式テストコーパス（conformance YAML）は実行していない。** 外部依存を入れない方針を優先した。絵文字の切り出しは `Intl.Segmenter` で、twitter-text の絵文字正規表現と完全一致する保証は無い。この差を吸収するために本文上限を256でなく250のままにしている。
4. **実際の x.com / github.com に対する動作確認は未実施**（E2Eはローカルの代替サーバ）。1.0.1 の実GitHubでの計測結果は README の「検証状況」に残っているが、今回の変更後に実サイトで押した記録は無い。
5. **Windows での実行は未確認。** Chrome探索のWindows分岐は書いたが動かしていない。
6. **CIは未実行。** ワークフローファイルを置いただけで、GitHub Actions 上で走らせてはいない（push していないため）。

## Failure modes and rollback

破壊的な操作は行っていない。戻すときはファイル単位で戻せる。

- すべて未コミットなので、`git checkout -- <path>` で個別に、`git checkout -- .` かつ新規ファイル削除で全体を 1.0.1 の状態へ戻せる（削除した `test/esc-close.test.js` も HEAD から復元される）。
- 権限だけ戻したい場合は `manifest.json` の `"storage"` を外し、`src/background.js` の記録を元のメモリ保持へ戻す必要がある（`storage` 無しでSW再起動をまたぐ記録は作れない）。
- 主な失敗モード: ①`storage` 追加でストア審査が延びる ②クエリを残す方針にした結果、意図しないパラメータが投稿へ入る（allowlist方式なので新規パラメータは既定で落ちる） ③`Intl.Segmenter` が無い環境では重み計算がコードポイント単位へ退避し、絵文字を多めに数える（安全側）。

## Manual external actions for owner

私が実行していない（できない・してはいけない）もの。

- **GitHub settings**: private vulnerability reporting の有効化（`SECURITY.md` の手順を簡単にできる）。Issueテンプレートの追加。
- **Chrome Web Store**: 1.1.0 の提出そのもの。`store/LISTING.md` の「storage」正当化文を貼る欄がある。Support URL を `SUPPORT.md` へ向けるかの設定。
- **version / tag / release / upload**: manifest は 1.1.0 へ上げたが、タグもリリースも作っていない（このリポジトリには現在タグが1つも無い）。
- **commit / push / PR**: 一切していない。

## Recommended independent review

別の人（別のセッション）が最短で再現する手順。

```bash
cd ~/dev/reposhout
npm ci
npm test                      # 35 + 10 が pass / fail 0 になるか
npm run package               # SHA-256 を控える
npm run package               # 同じ値になるか
node --test test/share.test.mjs --test-name-pattern="重み付き文字数"
```

テストが本当に効いているかを疑う場合は、次のどれかを壊してから `npm test` を回す。落ちなければテストの側が悪い。

- `src/share.js` の `normalize('NFC')` を外す → 単体1件が落ちる
- `src/share.js` の `isEmojiCluster` を `return false;` にする → 単体1件が落ちる
- `src/esc-close.js` に `window.name === 'gxs-share-window'` の分岐を戻す → E2E #6 が落ちる
- `src/background.js` の記録をメモリ変数へ戻す → E2E #4 が落ちる
