// 再現できる乱数 (同じシードなら同じ列)。シミュレーションの結果を毎回同じにするため、
// Math.random ではなくこれを使う。
export function mulberry32(seed = 1) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return next;
}

/** 0 以上 n 未満の整数 */
export const randInt = (rng, n) => Math.floor(rng() * n);
