/*
 * 証跡の書き込みに障害を差し込む前置き（`node --import <この file の URL> scripts/run-mutations.mjs …`）。
 * 第28回監査 R28-001 / R28-004 / R28-011。**本番のランナーには何も足さない**——試験が別プロセスとして
 * 起動するときにだけ、`fs.writeFileSync` を包んで、証跡の一時ファイル（`.tmp-` を含む名前）への書き込みを
 * 細工する。どの書き込みを細工するかは環境変数 RS_FAULT で決める。
 *
 *   plant-symlink:<被害の file>   最初の一時ファイルの書き込みの直前に、その名前で被害の file への symlink を置く
 *   plant-hardlink:<被害の file>  同じく hardlink を置く
 *   fail:<種類>                   その種類の証跡の書き込みを失敗させる（ほかは通す）
 *       initial   … 最初の「走っている」（currentMutationId も lastCompletedMutationId も null）
 *       between   … 変異の途中の「走っている」（currentMutationId が null でない）
 *       terminal  … 最後の「走っている」（currentMutationId が null・lastCompletedMutationId が null でない）
 *       final     … 終わりの1枚（state が complete か aborted）
 *
 * 細工した回数は RS_FAULT_LOG（あれば）へ1行ずつ書く。題材が「細工が本当に起きた」ことを確かめるため
 *（起きていないのに通った、を合格にしない）。
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const spec = process.env.RS_FAULT || '';
const log = process.env.RS_FAULT_LOG || null;
const realWrite = fs.writeFileSync;
const note = (s) => { if (log) fs.appendFileSync(log, s + '\n'); };
let planted = false;

function kindOf(data) {
  let o = null;
  try { o = JSON.parse(String(data)); } catch (e) { return null; }
  if (!o || typeof o !== 'object') return null;
  if (o.state === 'complete' || o.state === 'aborted') return 'final';
  if (o.state !== 'running') return null;
  if (o.currentMutationId !== null && o.currentMutationId !== undefined) return 'between';
  return o.lastCompletedMutationId === null || o.lastCompletedMutationId === undefined ? 'initial' : 'terminal';
}

fs.writeFileSync = function (p, data, opts) {
  const isTmp = typeof p === 'string' && p.includes('.tmp-');
  if (isTmp && !planted && spec.startsWith('plant-symlink:')) {
    planted = true;
    fs.symlinkSync(spec.slice('plant-symlink:'.length), p);
    note(`planted symlink ${p}`);
  } else if (isTmp && !planted && spec.startsWith('plant-hardlink:')) {
    planted = true;
    fs.linkSync(spec.slice('plant-hardlink:'.length), p);
    note(`planted hardlink ${p}`);
  } else if (isTmp && spec.startsWith('fail:') && kindOf(data) === spec.slice('fail:'.length)) {
    note(`failed ${spec.slice('fail:'.length)}`);
    const e = new Error(`RS_FAULT: ${spec}`);
    e.code = 'EIO';
    throw e;
  }
  return realWrite.call(fs, p, data, opts);
};
syncBuiltinESMExports();
