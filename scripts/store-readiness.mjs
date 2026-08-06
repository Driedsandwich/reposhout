/*
 * store-readiness.mjs — ストアへ出す前の確認を、純粋な関数として持つ
 *
 * 第9回監査 R9-002 で作った関門は、ファイルを読んで表示するだけのスクリプトだった。
 * テストが1つも無く、中身も「文字列があるか」「桁数が合うか」しか見ていなかったので、
 * でたらめな値でも全部 ✅ になった（第10回監査 R10-002 で実測）。そこで判定を
 * 副作用の無い関数へ分け、fixture テストを付けた。
 *
 * 第11回監査 R11-002 で、さらに次を直している。
 *
 *   ・**2段に分ける。** preflight はリポジトリ側の材料だけを見る。実物の成果物も
 *     外部監査の判定も無いまま exit 0 になり得るので、**これを最終関門にしない**。
 *     strict は実物の成果物と外部監査の申告を**必須**にする。
 *   ・外部監査の申告は、リポジトリに置いた自己申告では権威にしない。報告書の実体を
 *     読んでハッシュを計算し、申告と突き合わせる（呼び出し側が計算して渡す）。
 *   ・申告は runtime（配布物）だけでなく **metadata（掲載文・申告の位置）** にも結び付ける。
 *     監査後に文書を書き換えたら合わなくなる。
 */

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const blank = (v) => typeof v !== 'string' || v.trim() === '';

/* YYYY-MM-DD として実在する日か（2026-02-30 のようなものを弾く） */
function isRealDate(s) {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * @param {object} input   ファイルを読んだ結果（この関数はファイルを読まない）
 * @returns {{problems:string[], ok:string[], mode:string, artifactChecked:boolean, auditChecked:boolean}}
 */
export function validateStoreReadiness(input) {
  const problems = [];
  const ok = [];
  const check = (label, condition, detail) => {
    if (condition) ok.push(label);
    else problems.push(`${label} — ${detail}`);
  };

  const {
    mode = 'preflight',
    disclosure, candidate, manifestVersion, packageVersion,
    privacy = '', listing = '', dashboardChanges = '',
    today, artifact = null, audit = null, auditReportSha256 = null,
    metadata = null,          // いまの文書側の位置 {sourceCommit, treeSha, dirty}
    sha256, readZipStrict = null
  } = input;

  const strict = mode === 'strict';
  const pending = candidate.status === 'pending_main_ci';

  /* ---- 1. 版がそろっているか ---------------------------------------- */
  check('版の一致',
    manifestVersion === packageVersion &&
    disclosure.version === manifestVersion &&
    candidate.version === manifestVersion,
    `manifest=${manifestVersion} package=${packageVersion} ` +
    `disclosure=${disclosure.version} candidate=${candidate.version}`);

  /* ---- 2. データ申告 ------------------------------------------------- */
  check('データ申告の欄が9つ', disclosure.categories.length === 9,
    `欄が ${disclosure.categories.length} 個`);

  for (const c of disclosure.categories) {
    const at = `申告 ${c.label}`;
    if (c.confirmationStatus === 'not_required') {
      check(at, ['Yes', 'No'].includes(c.answer), `答えが Yes / No でない: ${c.answer}`);
      continue;
    }
    if (c.confirmationStatus !== 'confirmed') {
      problems.push(`${at} — 本人の確認がまだ（ダッシュボードの設問文を読んで確定してください）`);
      continue;
    }
    const oc = c.ownerConfirmation || {};
    check(`${at} の答え`, ['Yes', 'No'].includes(c.answer), `答えが Yes / No でない: ${c.answer}`);
    check(`${at} の選んだ答え`, ['Yes', 'No'].includes(oc.chosen), `Yes / No でない: ${oc.chosen}`);
    check(`${at} の一致`, c.answer === oc.chosen,
      `answer(${c.answer}) と ownerConfirmation.chosen(${oc.chosen}) が違う`);
    check(`${at} の読んだ設問文`, !blank(oc.dashboardQuestionText), '空欄または空白だけ');
    check(`${at} の理由`, !blank(oc.reason), '空欄または空白だけ');
    check(`${at} の確認した日`, !blank(oc.confirmedOn) && isRealDate(oc.confirmedOn),
      `YYYY-MM-DD の実在する日でない: ${oc.confirmedOn}`);
    if (isRealDate(oc.confirmedOn) && isRealDate(today)) {
      check(`${at} の確認日が未来でない`, oc.confirmedOn <= today,
        `確認日 ${oc.confirmedOn} が今日 ${today} より後`);
    }
  }

  /* ---- 3. 3つの証明 --------------------------------------------------- */
  const certs = disclosure.certifications || [];
  check('証明が3つ', certs.length === 3, `${certs.length} 個`);
  for (const cert of certs) {
    check(`証明 ${cert.id}`, cert.checked === true, 'チェックが入っていない');
  }

  /* ---- 4. プライバシーポリシーURL ------------------------------------- */
  const url = disclosure.privacyPolicyUrl;
  check('ポリシーURLがHTTPS', typeof url === 'string' && url.startsWith('https://'),
    `HTTPSでない: ${url}`);
  check('ポリシーURLが正本と一致', url === candidate.privacyPolicyUrl,
    `候補(${candidate.privacyPolicyUrl}) と違う: ${url}`);
  check('ポリシーURLが提出手順にも書いてある', listing.includes(url),
    'store/LISTING.md に同じURLが無い');

  /* ---- 5. Limited Use の遵守声明と、言い過ぎの禁止 --------------------- */
  check('Limited Use の遵守声明（英語）',
    /adheres to the Chrome Web Store User Data Policy/i.test(privacy),
    'PRIVACY.md に英語の遵守声明が無い');
  check('Limited Use の遵守声明（日本語）',
    /ユーザーデータポリシー（Limited Use の要件を含む）に従います/.test(privacy),
    'PRIVACY.md に日本語の遵守声明が無い');
  const flat = privacy.replace(/\s+/g, ' ');
  const sendsToX = /X receives|Xへ渡|Xは利用者が要求した/.test(flat);
  for (const [re, why] of [
    [/No human [—-] including the developer [—-] reads this data/, '「人は誰も読まない」と断定している'],
    [/there is no server that could receive it/i, '「受け取れるサーバーは存在しない」と限定なしに断定している'],
    [/開発者を含め、人がこのデータを読むことはありません/, '「人は誰も読まない」と断定している'],
    [/受け取れるサーバーも存在しません/, '「受け取れるサーバーは存在しない」と限定なしに断定している'],
    [/nothing is retained/i, '「何も保存しない」と断定している（ウィンドウIDと時刻は保存する）']
  ]) {
    check('Limited Use の書き方', !(sendsToX && re.test(flat)), why);
  }
  check('人手閲覧の限定（英語）',
    /human review by the developer or anyone acting on the developer's behalf/i.test(flat),
    '「開発者または開発者のために行動する者」に限定した記述が無い');
  check('人手閲覧の限定（日本語）',
    /開発者または開発者のために行動する者の人手閲覧/.test(flat),
    '日本語側に同じ限定が無い');
  check('X側の扱いの明記',
    /X's own policies/i.test(flat) && /Xのポリシーに従って/.test(flat),
    'Xが受け取ったあとはX自身のポリシーに従う、と書いていない');

  /* ---- 6. 提出手順 ---------------------------------------------------- */
  check('更新の手順', listing.includes('Upload New Package'),
    'store/LISTING.md が新規登録のままになっている');
  check('Privacy practices も必須と書いてある',
    /§0[^\n]*§3|§0 から §3|§0〜§3/.test(listing),
    '更新時に §3（Privacy practices）を飛ばしてよいと読める');
  check('古い全部Noの申告を直すと書いてある',
    /すべて No|全部 No/.test(listing),
    '掲載中の古い申告（すべてNo）を直す指示が無い');

  /* ---- 7. 出す成果物の正本 -------------------------------------------- */
  if (pending) {
    /*
     * まだ main の CI が作っていない。ここで名前やハッシュを推測で埋めない
     * （第11回監査 Task B）。preflight では「進行中」として扱い、strict では落とす。
     */
    for (const [k, v] of Object.entries({
      sourceCommit: candidate.sourceCommit, artifactName: candidate.artifactName,
      innerSha256: candidate.innerSha256, runId: candidate.runId
    })) {
      check(`正本の ${k} が空のまま`, v === null,
        `pending_main_ci なのに値が入っている: ${v}`);
    }
    for (const [name, body] of [['store/LISTING.md', listing],
                                ['store/STORE_DASHBOARD_CHANGES.md', dashboardChanges]]) {
      check(`${name} が「まだ成果物が無い」と書いている`, body.includes('pending_main_ci'),
        '成果物が未確定であることが書いていない');
    }
    if (strict) {
      problems.push('提出できる成果物 — まだ main の CI が作っていません（pending_main_ci）');
    }
  } else {
    check('成果物名が正本と一致', listing.includes(candidate.artifactName),
      `store/LISTING.md に ${candidate.artifactName} が無い`);
    check('中身のZIPのハッシュが正本と一致', listing.includes(candidate.innerSha256),
      `store/LISTING.md に ${candidate.innerSha256} が無い`);
    check('正本のコミットが40桁の16進', HEX40.test(candidate.sourceCommit || ''),
      `sourceCommit が不正: ${candidate.sourceCommit}`);
    check('正本のハッシュが64桁の16進', HEX64.test(candidate.innerSha256 || ''),
      `innerSha256 が不正: ${candidate.innerSha256}`);
  }

  /*
   * 文書に「いまの main はどこか」を書かない（第10回監査 R10-006）。
   * 正本（履歴を含む）に無いコミットが書いてあれば止める。
   */
  const known = new Set();
  const collect = (o) => {
    if (!o) return;
    for (const k of ['sourceCommit', 'treeSha', 'innerSha256']) if (o[k]) known.add(o[k]);
  };
  collect(candidate);
  (candidate.history || []).forEach(collect);
  for (const [name, body] of [['store/LISTING.md', listing],
                              ['store/STORE_DASHBOARD_CHANGES.md', dashboardChanges]]) {
    const strays = (body.match(/\b[0-9a-f]{7,40}\b/g) || []).filter(
      (h) => ![...known].some((k) => k.startsWith(h)));
    check(`${name} に古くなるコミットを書いていない`, strays.length === 0,
      `正本に無いコミットが書いてある: ${[...new Set(strays)].join(', ')}`);
  }

  /* ---- 8. 手元ビルドを提出用として案内していないか --------------------- */
  for (const [name, body] of [['store/LISTING.md', listing],
                              ['store/STORE_DASHBOARD_CHANGES.md', dashboardChanges]]) {
    check(`${name} の案内`, !/`npm run package` で作れます/.test(body),
      '手元ビルドを提出用として案内している');
  }

  /* ---- 9. 実物の成果物 ------------------------------------------------ */
  let artifactChecked = false;
  if (strict && !artifact) {
    problems.push('実物の成果物 — strict では --artifact が要ります（見ないまま提出可にしない）');
  }
  if (artifact && !pending) {
    artifactChecked = true;
    check('成果物の名前', artifact.outerName === candidate.artifactName,
      `${artifact.outerName} は正本 ${candidate.artifactName} と違う`);

    const byName = new Map(artifact.files.map((f) => [f.name.replace(/^.*\//, ''), f.data]));
    const manifestRaw = byName.get('release-manifest.json');
    const innerZip = byName.get(candidate.innerName);
    const shaFile = byName.get(`${candidate.innerName}.sha256`);

    check('成果物に記録が入っている', Boolean(manifestRaw), 'release-manifest.json が無い');
    check('成果物に中身のZIPが入っている', Boolean(innerZip), `${candidate.innerName} が無い`);
    check('成果物にハッシュの控えが入っている', Boolean(shaFile),
      `${candidate.innerName}.sha256 が無い`);

    if (innerZip) {
      const actual = sha256(innerZip);
      check('中身のZIPの実ハッシュ', actual === candidate.innerSha256,
        `実測 ${actual} ≠ 正本 ${candidate.innerSha256}`);
      check('中身のZIPの大きさ', innerZip.length === candidate.innerBytes,
        `実測 ${innerZip.length} B ≠ 正本 ${candidate.innerBytes} B`);
    }
    if (innerZip && readZipStrict) {
      let entries = null;
      let why = '';
      try { entries = readZipStrict(innerZip); } catch (e) { why = e.message; }
      check('中身のZIPが厳しい読み手で開ける', Boolean(entries), why);
      if (entries && candidate.innerFiles) {
        check('中身のZIPの収録数', entries.length === candidate.innerFiles,
          `実測 ${entries.length} ≠ 正本 ${candidate.innerFiles}`);
        check('中身のZIPの直下に manifest.json',
          entries.some((e) => e.name === 'manifest.json'), 'manifest.json が無い');
      }
    }
    if (shaFile) {
      check('ハッシュの控えの中身', shaFile.toString('utf8').includes(candidate.innerSha256),
        '控えのハッシュが正本と違う');
    }
    if (manifestRaw) {
      let rm = null;
      try { rm = JSON.parse(manifestRaw.toString('utf8')); } catch { /* 次の行で落とす */ }
      check('記録が読める', Boolean(rm), 'release-manifest.json が壊れている');
      if (rm) {
        check('記録の版', rm.version === candidate.version, `${rm.version} ≠ ${candidate.version}`);
        check('記録のコミット', rm.sourceCommit === candidate.sourceCommit,
          `${rm.sourceCommit} ≠ ${candidate.sourceCommit}`);
        check('記録のtree', rm.treeSha === candidate.treeSha,
          `${rm.treeSha} ≠ ${candidate.treeSha}`);
        check('記録のZIP名', rm.zip && rm.zip.name === candidate.innerName,
          `${rm.zip && rm.zip.name} ≠ ${candidate.innerName}`);
        check('記録のハッシュ', rm.zip && rm.zip.sha256 === candidate.innerSha256,
          '記録のハッシュが正本と違う');
        check('main への push で作られた',
          rm.ci && rm.ci.eventName === 'push' && rm.ci.ref === 'refs/heads/main',
          `event=${rm.ci && rm.ci.eventName} ref=${rm.ci && rm.ci.ref}`);
        check('記録のrun', String(rm.ci && rm.ci.runId) === String(candidate.runId),
          `${rm.ci && rm.ci.runId} ≠ ${candidate.runId}`);
        check('技術的な提出資格', rm.submittable === true,
          `submittable=${rm.submittable} / ${(rm.notSubmittableBecause || []).join(' / ')}`);
        check('未コミットの変更が無い状態で作られた', rm.dirty === false, 'dirty=true');
      }
    }
  }

  /* ---- 10. 外部監査の申告 --------------------------------------------- */
  let auditChecked = false;
  if (strict && !audit) {
    problems.push('外部監査の判定 — strict では申告（--audit-attestation）が要ります');
  }
  if (audit) {
    auditChecked = true;
    check('外部監査の判定', audit.verdict === 'READY', `判定が READY でない: ${audit.verdict}`);
    check('外部監査が見た配布物のコミット', audit.runtimeSourceCommit === candidate.sourceCommit,
      `${audit.runtimeSourceCommit} ≠ ${candidate.sourceCommit}`);
    check('外部監査が見た配布物のtree', audit.runtimeTree === candidate.treeSha,
      `${audit.runtimeTree} ≠ ${candidate.treeSha}`);
    check('外部監査が見た配布物のハッシュ', audit.innerSha256 === candidate.innerSha256,
      '申告のZIPハッシュが正本と違う');
    check('外部監査が見た版', audit.runtimeVersion === candidate.version,
      `${audit.runtimeVersion} ≠ ${candidate.version}`);
    check('外部監査の日付', isRealDate(audit.auditDate || ''),
      `YYYY-MM-DD の実在する日でない: ${audit.auditDate}`);
    check('外部監査の実施者', !blank(audit.auditor), '空欄');
    /*
     * 報告書は書式ではなく**実体のハッシュ**で結び付ける。呼び出し側が
     * 実ファイルを読んで計算した値を渡す（第11回監査 R11-002）。
     */
    check('外部監査の報告書のハッシュが64桁の16進', HEX64.test(audit.reportSha256 || ''),
      `64桁の16進でない: ${audit.reportSha256}`);
    check('外部監査の報告書が実物と一致',
      Boolean(auditReportSha256) && auditReportSha256 === audit.reportSha256,
      auditReportSha256
        ? `実測 ${auditReportSha256} ≠ 申告 ${audit.reportSha256}`
        : '報告書の実体を渡していない（--audit-report）');
    /*
     * 掲載文とデータ申告は監査のあとで書き換えられる。**文書側の位置**も結び付ける。
     */
    check('外部監査が見た文書のコミット',
      Boolean(metadata) && audit.metadataSourceCommit === metadata.sourceCommit,
      metadata ? `申告 ${audit.metadataSourceCommit} ≠ いまの ${metadata.sourceCommit}`
               : 'いまの文書側の位置を渡していない');
    check('外部監査が見た文書のtree',
      Boolean(metadata) && audit.metadataTree === metadata.treeSha,
      metadata ? `申告 ${audit.metadataTree} ≠ いまの ${metadata.treeSha}` : '同上');
    check('文書側に未コミットの変更が無い',
      Boolean(metadata) && metadata.dirty === false,
      metadata ? '未コミットの変更がある' : '同上');
  }

  return { problems, ok, mode, artifactChecked, auditChecked };
}
