// インオーダー発行モデル — 命令ごとのレイテンシと待ち時間を追う (LT-1 構成)
// 仕様: docs/timing.md「インオーダー発行モデル」
//
// 1サイクルに1命令を順番どおりに発行する。発行は、使うレジスタの値がそろうまで待つ。
// 結果が出るまでの時間は命令の種類で決まり、ロードはメモリ階層 (hierarchy.js) に問い合わせる。
// パイプラインの段は描かず、「どの命令が何を何サイクル待ったか」に集中するモデル。

import { operandRegs } from './machine.js';
import { createPredictor } from './predictor.js';

const DEFAULTS = {
  latency: { alu: 1, mul: 3, div: 20, store: 1, branch: 1, jump: 1, system: 1 },
  unpipelined: { div: true }, // パイプライン化されていない演算器 (前の命令が終わるまで次を始められない)
  mispredictPenalty: 15,
  branch: 'bimodal',
  mshr: 8,                    // 同時に処理できるキャッシュミスの数
  hierarchy: null,            // MemoryHierarchy。省略時はロードも latency.load (既定 1) サイクル
};

export class InOrderModel {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULTS, ...cfg, latency: { ...DEFAULTS.latency, ...(cfg.latency || {}) }, unpipelined: { ...DEFAULTS.unpipelined, ...(cfg.unpipelined || {}) } };
    this.reset();
  }

  reset() {
    this.t = 0;            // 次の命令を発行できる最初の時刻
    this.total = null;
    this.ready = new Map(); // レジスタ → { at, kind: 'alu'|'mem' }
    this.unitFree = {};
    this.mshr = [];
    this.predictor = createPredictor(this.cfg.branch);
    this.count = 0;
    this.stats = { issued: 0, mem: 0, alu: 0, brm: 0, branches: 0, mispredicts: 0, loads: 0 };
    if (this.cfg.hierarchy) this.cfg.hierarchy.reset();
  }

  get cycles() { return this.total ?? this.t; }

  /** 実行記録を1つ加え、その命令のタイミングを返す */
  push(rec) {
    if (!rec || !rec.done) return null;
    const C = this.cfg, H = C.hierarchy, ins = rec.ins, cls = ins.def.class;
    const { src, dst } = operandRegs(ins);
    let issue = this.t, cause = null;
    for (const r of src) {
      const rr = this.ready.get(r);
      if (rr && rr.at > issue) { issue = rr.at; cause = rr.kind; }
    }
    if (C.unpipelined[cls] && (this.unitFree[cls] ?? 0) > issue) { issue = this.unitFree[cls]; cause = 'alu'; }
    const isLoad = cls === 'load' || cls === 'rmw';
    const addr = rec.mem.length ? rec.mem[0].addr : null;
    if (isLoad && H && addr !== null && H.probe(addr) > 0) {
      this.mshr = this.mshr.filter(x => x > issue);
      if (this.mshr.length >= C.mshr) {
        const mn = Math.min(...this.mshr);
        if (mn > issue) { issue = mn; cause = 'mem'; }
        this.mshr = this.mshr.filter(x => x > issue);
      }
    }
    const stall = issue - this.t;
    if (stall > 0) this.stats[cause] += stall;
    this.stats.issued++;

    const out = { i: this.count++, rec, from: this.t, issue, stall, cause, done: issue + 1, level: -1, latency: 1, mispredicted: false, penEnd: null };
    let lat = C.latency[cls] ?? 1;
    if (isLoad && addr !== null) {
      if (H) {
        const r = H.load(addr, issue);
        lat = r.latency; out.level = r.level;
        if (r.level > 0) this.mshr.push(issue + r.latency);
      } else lat = C.latency.load ?? 1;
      this.stats.loads++;
    } else if (cls === 'store' && H && addr !== null) H.store(addr, issue);
    out.latency = lat;
    if (C.unpipelined[cls]) this.unitFree[cls] = issue + lat;
    if (dst) { this.ready.set(dst, { at: issue + lat, kind: isLoad ? 'mem' : 'alu' }); out.done = issue + lat; }
    else if (cls !== 'store') out.done = issue + lat;

    let next = issue + 1;
    const br = rec.branch;
    if (br && (cls === 'branch' || cls === 'jump')) {
      let mis = false;
      if (cls === 'branch') {
        this.stats.branches++;
        mis = this.predictor.resolve(rec.pc, br.taken).mispredicted;
      } else if (ins.def.operandList.includes('rs') && C.branch !== 'perfect') mis = true; // 間接ジャンプ
      if (mis) {
        out.mispredicted = true;
        this.stats.mispredicts++;
        this.stats.brm += C.mispredictPenalty;
        next += C.mispredictPenalty;
        out.penEnd = issue + 1 + C.mispredictPenalty;
      }
      out.taken = br.taken;
    }
    this.t = next;
    return out;
  }

  /** 最後の命令の結果が出るまで待って、総サイクルを確定する */
  finish() {
    let mx = this.t, kind = null;
    for (const [, r] of this.ready) if (r.at > mx) { mx = r.at; kind = r.kind; }
    if (kind) this.stats[kind] += mx - this.t;
    this.total = mx;
    return { cycles: mx, instructions: this.count, cpi: this.count ? mx / this.count : 0, ...this.stats };
  }
}
