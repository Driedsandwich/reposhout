/*
 * esc-close.js の安全性テスト
 *
 * 実行:  node test/esc-close.test.js
 * 必要:  Node 22+（WebSocket / fetch 組み込み）と Google Chrome
 *
 * ヘッドレスChromeを起動し、実ファイルの src/esc-close.js をページへ注入して
 * Esc の挙動を確認する。最重要は B の「利用者の通常タブは閉じない」。
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9377;
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'esc-close.js'), 'utf8');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'et-'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
fs.writeFileSync(path.join(dir, 'child.html'), '<!doctype html><meta charset=utf-8><title>x-like</title><body>page</body>');
fs.writeFileSync(path.join(dir, 'opener.html'), '<!doctype html><meta charset=utf-8><title>opener</title><body>o</body>');

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-popup-blocking',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
function conn(u) {
  const ws = new WebSocket(u); let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (me, pa) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: me, params: pa || {} })); });
  return { ws, ready, send };
}

async function trial(label, winName, modifiers) {
  const page = (await j('/json/list')).find((t) => t.type === 'page' && !t.url.includes('child.html'));
  const A = conn(page.webSocketDebuggerUrl); await A.ready;
  await A.send('Page.enable'); await A.send('Runtime.enable');
  await A.send('Page.navigate', { url: `file://${dir}/opener.html` }); await sleep(600);
  await A.send('Runtime.evaluate', {
    expression: `window.open('file://${dir}/child.html','${winName}','width=560,height=640,noopener,noreferrer')`,
    userGesture: true,
  });
  await sleep(1200);

  const child = (await j('/json/list')).find((t) => t.url.includes('child.html'));
  if (!child) { A.ws.close(); return { label, ok: false, note: '子ウィンドウが開かなかった' }; }

  const B = conn(child.webSocketDebuggerUrl); await B.ready; await B.send('Runtime.enable');
  // 実ファイルの esc-close.js をそのまま注入
  await B.send('Runtime.evaluate', { expression: SRC });
  const nameCheck = await B.send('Runtime.evaluate', { expression: 'window.name', returnByValue: true });

  // Esc の keydown を合成して発火
  await B.send('Runtime.evaluate', {
    expression: `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,${modifiers}}))`,
  });
  await sleep(1200);

  const still = (await j('/json/list')).filter((t) => t.url.includes('child.html'));
  const closed = still.length === 0;
  try { B.ws.close(); } catch (e) {}
  if (!closed) { try { await fetch(`http://127.0.0.1:${PORT}/json/close/${child.id}`); } catch (e) {} }
  A.ws.close();
  await sleep(400);
  return { label, winName: nameCheck.result.result.value, closed };
}

(async () => {
  for (let i = 0; i < 60; i++) { await sleep(300); try { const l = await j('/json/list'); if (l && l.length) break; } catch (e) {} }

  const A = await trial('A: 拡張が開いたウィンドウ + Esc', 'gxs-share-window', '');
  const B = await trial('B: 利用者の通常タブ相当 + Esc', 'some-other-window', '');
  const C = await trial('C: 拡張のウィンドウ + Shift+Esc', 'gxs-share-window', 'shiftKey:true');

  const expect = { 'A: 拡張が開いたウィンドウ + Esc': true, 'B: 利用者の通常タブ相当 + Esc': false, 'C: 拡張のウィンドウ + Shift+Esc': false };
  console.log('=== esc-close.js 安全性テスト ===');
  let fail = 0;
  for (const r of [A, B, C]) {
    const want = expect[r.label];
    const ok = r.closed === want;
    if (!ok) fail++;
    console.log(`  ${ok ? '✅' : '❌'} ${r.label}`);
    console.log(`       window.name = "${r.winName}" / 閉じた = ${r.closed} / 期待 = ${want}`);
  }
  console.log(fail === 0 ? '\n  3件すべて期待どおり' : `\n  ${fail}件が期待と違う`);
  chrome.kill();
  process.exit(fail === 0 ? 0 : 2);
})().catch((e) => { console.error('失敗:', e.message); chrome.kill(); process.exit(1); });
