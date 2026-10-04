// 分岐予測器
// 仕様: docs/timing.md「分岐予測」
//
//   const p = createPredictor('bimodal');
//   const guess = p.predict(pc);         // true = 成立と予測
//   p.update(pc, actuallyTaken);
//
// 'stall' と 'perfect' は予測器というより方針で、タイミングモデルが特別扱いする。

export const PREDICTORS = {
  stall: '分岐で停止 (予測しない)',
  'not-taken': '常に不成立と予測',
  taken: '常に成立と予測',
  bimodal: '2ビット飽和カウンタ',
  perfect: '完全予測 (理論上の上限)',
};

/**
 * @param {string} kind  PREDICTORS のキー
 * @param {{entries?:number, init?:number}} [opts]  bimodal 用。entries=0 なら PC ごとに無制限
 */
export function createPredictor(kind, opts = {}) {
  if (!(kind in PREDICTORS)) throw new Error(`分岐予測 ${kind} は未定義です (${Object.keys(PREDICTORS).join(', ')})`);
  const entries = opts.entries ?? 0;
  const init = opts.init ?? 1; // 1 = 弱い不成立
  const table = new Map();
  const key = pc => (entries ? pc % entries : pc);
  return {
    kind,
    /** 予測 (true = 成立)。stall / perfect では意味を持たない */
    predict(pc) {
      if (kind === 'taken') return true;
      if (kind === 'bimodal') return (table.has(key(pc)) ? table.get(key(pc)) : init) >= 2;
      return false;
    },
    update(pc, taken) {
      if (kind !== 'bimodal') return;
      const k = key(pc), c = table.has(k) ? table.get(k) : init;
      table.set(k, taken ? Math.min(3, c + 1) : Math.max(0, c - 1));
    },
    /** 予測が外れたか (= 正しい命令の取り込みが遅れるか) を判定して学習もする */
    resolve(pc, taken) {
      if (kind === 'stall') return { mispredicted: true, predicted: null };
      if (kind === 'perfect') return { mispredicted: false, predicted: taken };
      const predicted = this.predict(pc);
      this.update(pc, taken);
      return { mispredicted: predicted !== taken, predicted };
    },
    counter: pc => (table.has(key(pc)) ? table.get(key(pc)) : init),
    reset() { table.clear(); },
  };
}
