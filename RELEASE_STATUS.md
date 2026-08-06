# 公開状態

**「どこまで出したか」を書く場所はここだけ。** 他の文書に散らさない。

CHANGELOG は「何を変えたか」、実装報告は「どう直したか」を書く。
どちらも書いた時点で固定される文書なので、そこに公開状態を書くと必ず古くなる。
実際、1.1.4 は main へマージしたあとも CHANGELOG と実装報告が「作業ツリーにあるだけ」と
言い続けていた（第6回監査 R6-005）。

欄を混ぜないこと。**タグを打つこと**と **GitHub Release を作ること**と
**ストアへ提出すること**と**ストアで公開されること**は、全部べつの出来事である。

## 現況（2026-08-06 実測）

| 版 | main へマージ | タグ | GitHub Release | ストアへ提出 | ストアで公開中 |
|---|---|---|---|---|---|
| 1.0.0 | （タグ運用の前） | 無し | 無し | 済（2026-08-01） | 通過（2026-08-02） |
| 1.0.1 | （タグ運用の前） | 無し | 無し | 済（2026-08-02） | **✅ いま公開中**（2026-08-03通過） |
| 1.1.0 | `e13080f` | `v1.1.0` | 無し | していない | していない |
| 1.1.1 | `00a3eee` | `v1.1.1` | 無し | していない | していない |
| 1.1.2 | `b1d9a41` | `v1.1.2` | 無し | していない | していない |
| 1.1.3 | `4db83f0` | `v1.1.3` | 無し | していない | していない |
| 1.1.4 | `0be7aaf`（tree `04d1fb0`） | `v1.1.4` | 無し | していない | していない |
| 1.1.5 | **まだ**（作業ツリーのみ） | まだ | 無し | していない | していない |

**ストアで公開されているのは 1.0.1 だけ**です。1.1.0 以降はどれも提出していません。
提出は「外部監査に合格してから」と決めてあります（本人決定・2026-08-05）。

## 自分で確かめる方法

この表を信じる前に、次のコマンドで実物を見てください。表とずれていたら表のほうが古い。

```bash
# main のコミットとツリー
git rev-parse origin/main
git rev-parse origin/main^{tree}

# タグ（リモートの実体）
git ls-remote --tags origin | grep -v '\^{}'

# GitHub Release（1本も無ければ何も出ない）
gh release list

# ストアで配布中の版（CRXを取って manifest を読む）
curl -sSL "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=151.0&acceptformat=crx3&x=id%3Djoaipdjaiefbenoijcekdnjagiadikkd%26uc" -o /tmp/rs.crx
```

拡張機能のIDは `joaipdjaiefbenoijcekdnjagiadikkd` です。

## 提出に使うZIP

**手元で作ったZIPは提出しないでください。** 使うのは main への push で走ったCIが残した
成果物だけです。判定はファイル名と `release-manifest.json` の `submittable` に出ます。
手順は [store/LISTING.md](store/LISTING.md) §1「どのZIPを出すか」を見てください。

| 版 | 提出用ZIP | SHA-256 |
|---|---|---|
| 1.1.4 | `reposhout-1.1.4.zip`（27,436 B / 11ファイル） | `31629c0816c4e399ec2c3d6968c1f07c43fe94cabbcb0b93f9f23a95d6379e71` |
