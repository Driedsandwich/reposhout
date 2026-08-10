/*
 * verify-store-readiness.mjs — 提出前の確認（ファイルを読んで、判定を表示する）
 *
 * 2つの入口がある（第11回監査 R11-002）。
 *
 *   npm run verify:store-preflight
 *     リポジトリ側の材料だけを見る。**これは最終関門ではない。**
 *     成果物も外部監査の判定も見ないまま通ることがある。
 *
 *   npm run verify:submission-ready -- --artifact <成果物.zip> \
 *       --audit-report <報告書> --audit-attestation <申告.json>
 *     実物の成果物と外部監査の申告を必須にする。報告書は実体を読んでハッシュを
 *     計算し、申告の値と突き合わせる。申告は配布物と文書の両方の位置に結び付ける。
 *
 * 判定そのものは scripts/store-readiness.mjs の純粋な関数が持つ。
 * このファイルは何も送らない・何も変えない。
 */
import { readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateStoreReadiness, dateIn, pickPushRun } from './store-readiness.mjs';
import { readZip } from './zip-read.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/*
 * 引数の読み方も fail-closed にする（第12回監査 R12-004）。
 * 知らない指定・二度書き・値なし・日付として読めない --today は、
 * 黙って無視せず終了コード2で止める。
 */
const argv = process.argv.slice(2);
const FLAGS = ['--strict'];
const VALUED = ['--artifact', '--audit-report', '--audit-attestation', '--today', '--timezone'];
const given = new Map();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (FLAGS.includes(a)) {
    if (given.has(a)) fail(`同じ指定が二度あります: ${a}`);
    given.set(a, true);
    continue;
  }
  if (VALUED.includes(a)) {
    if (given.has(a)) fail(`同じ指定が二度あります: ${a}`);
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) fail(`${a} のあとに値が要ります`);
    given.set(a, v);
    i++;
    continue;
  }
  fail(`知らない指定です: ${a}`);
}
function fail(message) {
  console.error(message);
  process.exit(2);
}
const strict = given.get('--strict') === true;
const argOf = (name) => (given.has(name) ? given.get(name) : null);

const candidate = JSON.parse(read('store/SUBMISSION_CANDIDATE.json'));

/* 無ければ null。壊れていれば止める（黙って「無い」ことにしない） */
function readJsonOrNull(rel) {
  let text;
  try {
    text = read(rel);
  } catch (e) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(`${rel} が JSON として読めません: ${e.message}`);
  }
}

/* 確認日は本人の暮らしている時間帯で見る（第11回監査 R11-005） */
const timeZone = argOf('--timezone') || candidate.confirmationTimeZone || 'Asia/Tokyo';
let today;
try {
  today = argOf('--today') || dateIn(timeZone);
} catch (e) {
  fail(`時間帯として読めません: ${timeZone}`);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(today) ||
    new Date(`${today}T00:00:00Z`).toISOString().slice(0, 10) !== today) {
  fail(`--today は YYYY-MM-DD の実在する日で渡してください: ${today}`);
}

/* 外側の成果物ZIP。GitHub が書くので data descriptor 付きで来る（実測） */
const artifactPath = argOf('--artifact');
let artifact = null;
if (artifactPath) {
  const outerBytes = readFileSync(artifactPath);
  artifact = {
    outerName: basename(artifactPath).replace(/\.zip$/i, ''),
    /* GitHub 側の digest と突き合わせる実バイトのハッシュ（第14回監査 R14-005） */
    outerSha256: sha256(outerBytes),
    files: readZip(outerBytes, { allowDataDescriptor: true })
  };
}

/* 外部監査の申告と、その報告書の実体 */
const attestationPath = argOf('--audit-attestation');
const reportPath = argOf('--audit-report');
let audit = null;
if (attestationPath) {
  try {
    audit = JSON.parse(readFileSync(attestationPath, 'utf8'));
  } catch (e) {
    fail(`外部監査の申告が読めません（${attestationPath}）: ${e.message}`);
  }
}
const auditReportSha256 = reportPath ? sha256(readFileSync(reportPath)) : null;

/* いまの文書側の位置（監査後に書き換えていないかを見るため） */
const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
};
const head = git(['rev-parse', 'HEAD']);
const metadata = head
  ? { sourceCommit: head, treeSha: git(['rev-parse', 'HEAD^{tree}']),
      dirty: git(['status', '--porcelain']) !== '' }
  : null;

/*
 * strict では、リモートの main と、そのコミットのCIまで見る
 * （第12回監査 R12-003）。取れなかったら通さない。
 */
const EXPECTED_ORIGIN = 'Driedsandwich/reposhout';
/* 正本側と同じワークフローを、いまの文書側でも固定する（第15回監査 R15-004） */
const EXPECTED_WORKFLOW = '.github/workflows/ci.yml';
let remote = null;
let metadataCi = null;
let runtime = null;
if (strict) {
  const originUrl = git(['remote', 'get-url', 'origin']);
  const lsRemote = git(['ls-remote', 'origin', 'refs/heads/main']);
  remote = {
    originUrl,
    originMainSha: lsRemote ? lsRemote.split(/\s+/)[0] : null,
    expectedOrigin: EXPECTED_ORIGIN
  };
  metadataCi = fetchCiFor(head);
  runtime = fetchRuntime(candidate);
}

/*
 * 正本が名指しする run と成果物を、GitHub から read-only で引く
 * （第14回監査 R14-005）。引けなかったら error を返して落とす。
 */
function fetchRuntime(cand) {
  if (!cand || cand.status === 'pending_main_ci') return null;   // 候補がまだ無いときは見ない
  if (!cand.runId) return { error: '正本に runId が無い' };
  try {
    const run = JSON.parse(execFileSync('gh',
      ['api', `repos/${EXPECTED_ORIGIN}/actions/runs/${cand.runId}`],
      { cwd: ROOT, encoding: 'utf8', timeout: 60000 }));
    const jobsRaw = execFileSync('gh',
      ['api', `repos/${EXPECTED_ORIGIN}/actions/runs/${cand.runId}/jobs`],
      { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const jobs = {};
    for (const j of JSON.parse(jobsRaw).jobs || []) jobs[j.name] = j.conclusion;
    const artsRaw = execFileSync('gh',
      ['api', `repos/${EXPECTED_ORIGIN}/actions/runs/${cand.runId}/artifacts`],
      { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const arts = JSON.parse(artsRaw).artifacts || [];
    const art = arts.find((a) => a.name === cand.artifactName);
    return {
      run: {
        id: String(run.id), path: run.path, event: run.event, branch: run.head_branch,
        headSha: run.head_sha, conclusion: run.conclusion, jobs
      },
      artifact: art
        ? { name: art.name, expired: art.expired, digest: art.digest }
        : { name: null, expired: null, digest: null }
    };
  } catch (e) {
    return { error: `GitHub API を引けなかった: ${e.message.split('\n')[0]}` };
  }
}

/* GitHub の API を read-only で引く。失敗は error として返す（黙って通さない） */
function fetchCiFor(sha) {
  if (!sha) return { error: 'HEAD が取れない' };
  try {
    const runsRaw = execFileSync('gh',
      ['api', `repos/${EXPECTED_ORIGIN}/actions/runs?head_sha=${sha}&per_page=20`],
      { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const runs = JSON.parse(runsRaw).workflow_runs || [];
    /*
     * 第15回監査 R15-004。ワークフローを見ずに「main への push」だけで選んでいたので、
     * 同じジョブ名を持つ別のワークフローがあれば、本来のCIが落ちていても通せた。
     * 選ぶ判断は pickPushRun（純粋関数・テストあり）に持たせる。
     */
    const run = pickPushRun(runs, { branch: 'main', workflowPath: EXPECTED_WORKFLOW });
    if (!run) {
      return { error: `このコミットの ${EXPECTED_WORKFLOW} の main への push の run が見つからない: ${sha}` };
    }
    const jobsRaw = execFileSync('gh',
      ['api', `repos/${EXPECTED_ORIGIN}/actions/runs/${run.runId}/jobs`],
      { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const jobs = {};
    for (const j of JSON.parse(jobsRaw).jobs || []) jobs[j.name] = j.conclusion;
    return { ...run, jobs };
  } catch (e) {
    return { error: `GitHub API を引けなかった: ${e.message.split('\n')[0]}` };
  }
}

const result = validateStoreReadiness({
  mode: strict ? 'strict' : 'preflight',
  disclosure: JSON.parse(read('store/DATA_DISCLOSURE.json')),
  candidate,
  manifestVersion: JSON.parse(read('manifest.json')).version,
  packageVersion: JSON.parse(read('package.json')).version,
  privacy: read('PRIVACY.md'),
  listing: read('store/LISTING.md'),
  dashboardChanges: read('store/STORE_DASHBOARD_CHANGES.md'),
  today,
  artifact,
  audit,
  auditReportSha256,
  metadata,
  remote,
  metadataCi,
  runtime,
  /* X の Web Intent の判断（第16回監査 R16-005）。無ければ null で渡して strict で落とす */
  webIntentDecision: readJsonOrNull('store/WEB_INTENT_POLICY_DECISION.json'),
  sha256,
  readZipStrict: (buf) => readZip(buf)
});

console.log(strict
  ? '提出直前の確認（実物の成果物と外部監査を含む）\n'
  : 'リポジトリ側の事前確認（preflight）\n');
for (const line of result.ok) console.log(`  ✅ ${line}`);
for (const line of result.problems) console.log(`  ❌ ${line}`);
console.log();
console.log(`  基準日: ${today}（${candidate.confirmationTimeZone || 'Asia/Tokyo'}）`);
if (!result.artifactChecked) console.log('  ※ 実物の成果物は見ていません');
if (!result.auditChecked) console.log('  ※ 外部監査の判定は見ていません');

if (result.problems.length) {
  console.log(`\n${result.problems.length} 件そろっていません。ここが埋まるまで提出しないでください。`);
  process.exit(1);
}

if (strict) {
  console.log('\nAll machine-verifiable submission checks passed.');
  console.log('機械で確かめられる項目はすべて通りました。');
  console.log('**ダッシュボードでの人の確認と、提出そのものは本人の作業です。**');
} else {
  console.log('\nリポジトリ側の材料はそろっています。');
  console.log('**これは「提出してよい」という意味ではありません（preflight）。**');
  console.log('提出の可否は npm run verify:submission-ready で、実物の成果物と');
  console.log('外部監査の報告書・申告を渡して確かめてください。');
}
