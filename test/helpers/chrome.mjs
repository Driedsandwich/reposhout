/*
 * 実ブラウザでのテスト用ヘルパ
 *
 *  - Chromeの実行ファイルを環境ごとに探す（macOSのパス決め打ちをしない）
 *  - CDPをパイプ経由で話す（--load-extension が現行Chromeで無効化されたため、
 *    拡張の読み込みは Extensions.loadUnpacked を使う。これには
 *    --remote-debugging-pipe と --enable-unsafe-extension-debugging が要る）
 *  - x.com / github.com をローカルのHTTPSサーバへ向ける（外部通信をしない）
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import https from 'node:https';
import { PACKAGE_FILES } from '../../scripts/package-files.mjs';
import { ROOT } from './load.mjs';

export function findChrome() {
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH)) {
      throw new Error(`CHROME_PATH が指す実行ファイルが無い: ${process.env.CHROME_PATH}`);
    }
    return process.env.CHROME_PATH;
  }
  const os = platform();
  const fixed = os === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       '/Applications/Chromium.app/Contents/MacOS/Chromium',
       '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary']
    : os === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
         'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
      : [];
  for (const p of fixed) if (existsSync(p)) return p;

  if (os !== 'win32') {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
      try {
        const p = execFileSync('which', [name], { encoding: 'utf8' }).trim();
        if (p && existsSync(p)) return p;
      } catch (e) { /* 次の候補へ */ }
    }
  }
  throw new Error('Chrome が見つからない。CHROME_PATH で実行ファイルを指定してください。');
}

/* 出荷する9ファイルだけを別ディレクトリへ並べる。E2Eは「配布物そのもの」を読み込む */
export function stageExtension() {
  const dir = mkdtempSync(join(tmpdir(), 'reposhout-ext-'));
  for (const rel of PACKAGE_FILES) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(ROOT, rel), dest);
  }
  return dir;
}

/* テスト専用の自己署名証明書。Chrome側は --ignore-certificate-errors で受ける */
function makeCert() {
  const dir = mkdtempSync(join(tmpdir(), 'reposhout-cert-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes',
      '-keyout', key, '-out', cert, '-subj', '/CN=localhost'
    ], { stdio: 'ignore' });
  } catch (e) {
    throw new Error('openssl で証明書を作れなかった。E2Eには openssl が要る。');
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

const GITHUB_REPO_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>GitHub - octocat/Hello-World: My first repository on GitHub! · GitHub</title></head>
<body><ul data-testid="repo-header-actions"><li><button id="star">Star</button></li></ul></body></html>`;

const X_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Post on X</title></head>
<body><h1>compose</h1></body></html>`;

const OPENER_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>opener</title></head>
<body><h1>opener</h1></body></html>`;

/* x.com と github.com の代わりを1台で受けるHTTPSサーバ */
export function startTestServer() {
  const { key, cert } = makeCert();
  const server = https.createServer({ key, cert }, (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url.startsWith('/opener')) return res.end(OPENER_PAGE);
    if (host === 'github.com') return res.end(GITHUB_REPO_PAGE);
    return res.end(X_PAGE);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/* CDP をパイプ（fd3=送信 / fd4=受信、NUL区切りJSON）で話す最小クライアント */
export class Cdp {
  constructor(proc) {
    this.proc = proc;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.buf = Buffer.alloc(0);
    proc.stdio[4].on('data', (chunk) => this._onData(chunk));
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    let i;
    while ((i = this.buf.indexOf(0)) !== -1) {
      const raw = this.buf.subarray(0, i).toString('utf8');
      this.buf = this.buf.subarray(i + 1);
      let m;
      try { m = JSON.parse(raw); } catch (e) { continue; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(`${m.error.message} (${JSON.stringify(m.error)})`));
        else resolve(m.result);
      } else if (m.method) {
        const hs = this.handlers.get(m.method) || [];
        for (const h of hs) h(m.params, m.sessionId);
      }
    }
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdio[3].write(JSON.stringify(payload) + '\0');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP タイムアウト: ${method}`));
        }
      }, 20000);
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
}

export async function launchChrome({ port, extraArgs = [] } = {}) {
  const bin = findChrome();
  const profile = mkdtempSync(join(tmpdir(), 'reposhout-profile-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--ignore-certificate-errors',
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`,
    // CI（コンテナ内・非特権）ではサンドボックスと /dev/shm でChromeが起動できない。
    // テスト専用の緩和で、拡張の出荷物には影響しない。
    ...(platform() === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ...(port ? [`--host-resolver-rules=MAP x.com 127.0.0.1:${port},MAP github.com 127.0.0.1:${port}`] : []),
    ...extraArgs,
    'about:blank'
  ];
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  const cdp = new Cdp(proc);

  // 起動待ち（Browser.getVersion が返れば話せる状態）
  let ok = false;
  for (let i = 0; i < 40; i++) {
    try { await cdp.send('Browser.getVersion'); ok = true; break; } catch (e) { await sleep(250); }
  }
  if (!ok) throw new Error(`Chrome と CDP で接続できなかった: ${stderr.slice(0, 400)}`);

  return {
    cdp,
    proc,
    bin,
    stderr: () => stderr,
    kill: () => { try { proc.kill('SIGKILL'); } catch (e) {} }
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 条件が満たされるまで待つ。満たされなければ理由つきで失敗させる */
export async function waitFor(label, fn, { timeout = 15000, interval = 200 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`待ち時間内に成立しなかった: ${label}`);
}
