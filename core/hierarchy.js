// メモリ階層のタイミングモデル — L1/L2/L3/DRAM のどこで当たったかと、届くまでのサイクル
// 仕様: docs/timing.md「メモリ階層」
//
// データの値は扱わない (値は Machine のメモリが持つ)。各レベルはタグだけのキャッシュで、
// ラインごとに「いつ届くか (readyAt)」を覚えている。まだ届いていないラインに当たったら、
// 届くまで待つ (ミスの重なりを表すため)。

import { Cache } from './cache.js';

export class MemoryHierarchy {
  /**
   * @param {object} o
   * @param {number} [o.lineSize=64]
   * @param {{name:string, size:number, ways?:number, latency:number, policy?:string}[]} o.levels  上 (CPU に近い方) から順に
   * @param {number} [o.memoryLatency=200]  どのキャッシュにもないとき (DRAM)
   * @param {number} [o.memorySize]         プリフェッチが番地の外に出ないための上限 (バイト)
   * @param {number} [o.prefetch=0]         ミスのとき、続く何ラインを先に取りに行くか (0 = なし)
   */
  constructor(o) {
    this.lineSize = o.lineSize ?? 64;
    this.levelSpecs = o.levels.map(l => ({ ...l }));
    this.memoryLatency = o.memoryLatency ?? 200;
    this.memorySize = o.memorySize ?? Infinity;
    this.prefetch = o.prefetch ?? 0;
    this.reset();
  }

  reset() {
    this.levels = this.levelSpecs.map(l => new Cache({ name: l.name, size: l.size, lineSize: this.lineSize, ways: l.ways ?? 0, policy: l.policy ?? 'LRU' }));
    this.stats = { hits: new Array(this.levels.length + 1).fill(0), loads: 0, stores: 0, prefetches: 0 };
  }

  get names() { return [...this.levelSpecs.map(l => l.name), 'DRAM']; }
  latencyOf(level) { return level < this.levels.length ? this.levelSpecs[level].latency : this.memoryLatency; }
  lineOf(addr) { return Math.floor(addr / this.lineSize); }

  /** どのレベルにあるか (状態は変えない)。どこにもなければ levels.length (= DRAM) */
  probe(addr) {
    for (let i = 0; i < this.levels.length; i++) if (this.levels[i].has(addr)) return i;
    return this.levels.length;
  }

  _fillAbove(addr, level, readyAt) {
    for (let j = Math.min(level, this.levels.length) - 1; j >= 0; j--) this.levels[j].fill(addr, readyAt);
  }

  /**
   * 時刻 t に読み出しを始める。
   * @returns {{level:number, latency:number}}  latency は t から値が使えるまでのサイクル
   */
  load(addr, t) {
    const L = this.levels;
    let level = L.length, latency = this.memoryLatency;
    for (let i = 0; i < L.length; i++) {
      const ln = L[i].line(addr);
      if (ln) {
        level = i;
        latency = Math.max(this.levelSpecs[i].latency, (ln.meta ?? 0) - t);
        L[i].fill(addr); // 使ったことを記録
        break;
      }
    }
    this._fillAbove(addr, level, t + latency);
    this.stats.hits[level]++;
    this.stats.loads++;
    if (level > 0 && this.prefetch) {
      const line = this.lineOf(addr), maxLine = Math.floor(this.memorySize / this.lineSize);
      for (let d = 1; d <= this.prefetch; d++) {
        const p = (line + d) * this.lineSize;
        if (line + d >= maxLine || L[0].has(p)) continue;
        const pl = this.probe(p);
        this._fillAbove(p, pl, t + this.latencyOf(pl));
        this.stats.prefetches++;
      }
    }
    return { level, latency };
  }

  /** 時刻 t の書き込み。ラインを L1 まで持ってくる (書き込みは CPU を待たせない) */
  store(addr, t) {
    this.stats.stores++;
    if (this.levels.length && this.levels[0].has(addr)) { this.levels[0].fill(addr); return; }
    const pl = this.probe(addr);
    this._fillAbove(addr, pl, t + this.latencyOf(pl));
  }

  /** 各レベルに載っているライン番号 (表示用) */
  residentLines(level) {
    const c = this.levels[level], out = [];
    c.set.forEach((S, s) => S.ways.forEach(L => { if (L.valid) out.push(Math.floor(c.baseOf(s, L.tag) / this.lineSize)); }));
    return out;
  }
}
