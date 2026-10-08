/*
 * 変異対照を分割して走らせるときの「どの変異がどの束か」。**ここ1か所だけ**に置く。
 *   第26回監査 R26-002（§11: 30分へ接近したら stable ID hash で shard する）
 *
 * ⚠️ 分ける鍵は**変異IDのハッシュ**にする。並び順や件数で分けると、
 * 変異を1件足しただけで全部の束が入れ替わり、「前回どの束で落ちたか」が追えない。
 *
 * ⚠️ 分けた結果は「代表を選ぶ」ことではない。**全部の束を必ず走らせ**、
 * 読む側（検証器）が「どのIDもちょうど1回」を自分で数え直す。
 * 束の側の自己申告を信じない。
 */
import { createHash } from 'node:crypto';

export const MAX_SHARDS = 64;

/** 変異IDが属する束（0 起点） */
export function shardOf(id, total) {
  const h = createHash('sha256').update(String(id)).digest('hex').slice(0, 8);
  return Number(BigInt(`0x${h}`) % BigInt(total));
}

/**
 * `--shard 2/4` の形を読む。おかしければ error を返す（黙って全件にしない）。
 * @returns {{index: number, total: number} | {error: string}}
 */
export function parseShard(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(String(spec || ''));
  if (!m) return { error: `--shard は「番号/総数」の形で書く（受け取った値: ${JSON.stringify(spec)}）` };
  const index = Number(m[1]), total = Number(m[2]);
  if (!Number.isInteger(total) || total < 1 || total > MAX_SHARDS) {
    return { error: `束の総数は 1〜${MAX_SHARDS}（受け取った値: ${total}）` };
  }
  if (!Number.isInteger(index) || index < 1 || index > total) {
    return { error: `束の番号は 1〜${total}（受け取った値: ${index}）` };
  }
  return { index, total };
}
