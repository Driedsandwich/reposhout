/*
 * 文書とコードの言っていることを揃えるための検査
 *
 * 「どこにも送らない」と書いてある文書が残っていたのを、
 * 3回の監査で3回とも指摘された。人が読み直す運用では落ちるので、
 * 禁止する言い回しを機械で見張る。
 *
 * 履歴を書いた文書（CHANGELOG・実装報告・ストア差分表）は対象外にする。
 * そこでは「昔こう書いていたのが誤りだった」と**引用する必要がある**ため。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers/load.mjs';

/* 利用者が読む文書。ここに旧説明が残ってはいけない */
const USER_FACING = ['README.md', 'README.ja.md', 'PRIVACY.md', 'store/LISTING.md'];

/* 実挙動と食い違う言い回し。過去3回の監査で名指しされたもの */
const FORBIDDEN = [
  'sends nothing anywhere',
  'not transmitted anywhere',
  'transmitted anywhere by the extension',
  'does not transmit any user information',
  'does not collect, store, or transmit',
  'All processing happens locally',
  'all processing happens locally',
  '保存も送信もありません',
  '保存も送信もしません',
  '収集・保存・送信しません',
  '独自の通信を一切行いません',
  '過去に審査を通ったので',
  'どこにも送信しません'
];

const read = (f) => readFileSync(join(ROOT, f), 'utf8');

test('利用者が読む文書に、実挙動と食い違う言い回しが残っていない', () => {
  for (const f of USER_FACING) {
    const body = read(f);
    for (const phrase of FORBIDDEN) {
      assert.ok(!body.includes(phrase), `${f} に禁止表現が残っている: ${phrase}`);
    }
  }
});

test('検査が効いているかの対照', () => {
  // 禁止表現の一覧そのものには当然その文字列が入っている＝grepは機能している
  const self = read('test/docs.test.mjs');
  for (const phrase of ['sends nothing anywhere', '保存も送信もありません']) {
    assert.ok(self.includes(phrase), `対照が成立していない: ${phrase}`);
  }
});

test('Xへ渡ることが、利用者が読む文書すべてに書いてある', () => {
  const mustMention = {
    'README.md': ['travel to X', 'composer opens'],
    'README.ja.md': ['Xへ渡ります', '画面が開いた時点'],
    'PRIVACY.md': ['sent to X', 'Xへ送られます'],
    'store/LISTING.md': ['sent to X']
  };
  for (const [f, phrases] of Object.entries(mustMention)) {
    const body = read(f);
    for (const p of phrases) {
      assert.ok(body.includes(p), `${f} に「Xへ渡る」の記述が無い: ${p}`);
    }
  }
});

/*
 * 「conformance」という語は、実行していないことを断る文脈でだけ使ってよい。
 * 語そのものを禁止すると、「走らせていない」と書くことすらできなくなる。
 */
const DENIES_RUNNING = /not run|not shipped|is not|実行していない|同梱されていない|走らせていない|していません/i;

test('conformance を「実行した」とは書いていない', () => {
  for (const f of [...USER_FACING, 'CHANGELOG.md', 'IMPLEMENTATION_REPORT.md']) {
    const lines = read(f).split('\n');
    for (const line of lines) {
      if (!/conformance/i.test(line)) continue;
      assert.ok(DENIES_RUNNING.test(line),
        `${f}: conformance を実行したように読める行がある: ${line.trim().slice(0, 90)}`);
    }
  }
});

test('conformance の検査が効いているかの対照', () => {
  const claim = '公式 conformance コーパスを実行して全PASSした';
  assert.ok(/conformance/i.test(claim) && !DENIES_RUNNING.test(claim),
    '対照が成立していない＝この検査は主張を捕まえられない');
});

test('バージョンが manifest / package.json / CHANGELOG で揃っている', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const pkg = JSON.parse(read('package.json'));
  const changelog = read('CHANGELOG.md');
  assert.equal(pkg.version, manifest.version);
  assert.ok(changelog.includes(`## [${manifest.version}]`),
    `CHANGELOG に ${manifest.version} の節が無い`);
});
