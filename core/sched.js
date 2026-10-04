// マルチコアのスケジューラ — 次にどのコアを1ステップ進めるかを決める
// 仕様: docs/machine.md「マルチコアとスケジューリング」
//
// スケジューラは関数 (machine, current) => coreId | null。Machine.runScheduled に渡す。

import { mulberry32 } from './random.js';

/** 順番に1ステップずつ */
export function roundRobin() {
  return (m, cur) => {
    const ids = m.running;
    if (!ids.length) return null;
    if (cur === null) return ids[0];
    return ids.find(i => i > cur) ?? ids[0];
  };
}

/**
 * 確率 p で別のコアに切り替える。p = 1 なら毎ステップ切り替え、p が小さいほど同じコアが続く。
 * @param {number} p        切り替え確率 (0〜1)
 * @param {function} [rng]  乱数 (省略時はシード 1 の mulberry32)
 */
export function randomSwitch(p, rng = mulberry32(1)) {
  return (m, cur) => {
    const ids = m.running;
    if (!ids.length) return null;
    if (ids.length === 1) return ids[0];
    if (cur !== null && ids.includes(cur) && rng() >= p) return cur;
    const others = ids.filter(x => x !== cur);
    return others[Math.floor(rng() * others.length)];
  };
}

/** 決めた順番どおり (例: [0, 0, 1, 0, 1]) に進め、尽きたら null */
export function scripted(order) {
  let k = 0;
  return m => {
    while (k < order.length) {
      const id = order[k++];
      if (!m.cores[id].halted) return id;
    }
    return null;
  };
}
