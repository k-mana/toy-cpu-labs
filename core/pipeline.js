// 5段パイプライン (IF ID EX MEM WB) のタイミングモデル — トレース駆動
// 仕様: docs/timing.md「5段パイプライン」
//
//   const pipe = new PipelineModel({ forwarding: true, branch: 'not-taken', program });
//   for (const rec of trace) pipe.push(rec);     // Machine の実行記録 (done のもの) を順に渡す
//   const sum = pipe.finish();                   // 総サイクル・CPI・ストールの内訳
//   pipe.stagesAt(c)                             // サイクル c に各ステージにいる命令
//
// サイクルは 0 から数える。命令 i がステージ s に入るサイクルを t[s] とし、
// ステージ s で実際に働くサイクル数を d[s] とする (t[s+1] − t[s] > d[s] なら待っている)。

import { operandRegs } from './machine.js';
import { createPredictor } from './predictor.js';
import { mulberry32 } from './random.js';

export const STAGES = ['IF', 'ID', 'EX', 'MEM', 'WB'];
export const LATCHES = ['IF/ID', 'ID/EX', 'EX/MEM', 'MEM/WB'];

const DEFAULTS = {
  pipelined: true,     // false なら1命令ずつ5サイクルかけて実行する
  width: 1,            // 1サイクルに取り込む命令数 (スーパースカラの幅)
  forwarding: true,    // EX/MEM・MEM/WB から EX への転送路があるか
  branch: 'not-taken', // 分岐予測: stall | not-taken | taken | bimodal | perfect
  units: {             // 演算器のレイテンシ (EX のサイクル数) と、パイプライン化されているか
    alu: { latency: 1, pipelined: true },
    mul: { latency: 1, pipelined: false },
    div: { latency: 1, pipelined: false },
  },
  memTime: null,       // (rec) => MEM ステージのサイクル数 (省略時は常に 1)
  serializeMemory: true, // メモリポートは1つ (MEM を使う命令は1つずつ)
  program: null,       // 渡すと、予測が外れたときに誤って取り込んだ命令も記録する
};

/** ロードを一定の確率でミスさせる MEM 時間 (乱数は固定シード) */
export function randomMissTime({ rate = 0, penalty = 8, seed = 12345 } = {}) {
  const rng = mulberry32(seed);
  return rec => {
    const c = rec.ins.def.class;
    if ((c === 'load' || c === 'rmw') && rng() * 100 < rate) return 1 + penalty;
    return 1;
  };
}

/** キャッシュのアクセス結果 (rec.mem[].info.cycles) を MEM 時間にする */
export const cacheMemTime = rec => {
  let t = 1;
  for (const m of rec.mem) if (m.info && m.info.cycles) t = Math.max(t, m.info.cycles);
  return t;
};

export class PipelineModel {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULTS, ...cfg, units: { ...DEFAULTS.units, ...(cfg.units || {}) } };
    if (!this.cfg.pipelined) this.cfg.width = 1;
    this.reset();
  }

  reset() {
    this.entries = [];   // 正しい経路の命令 (実行順)
    this.squashed = [];  // 誤って取り込み、取り消した命令
    this.ready = new Map();      // レジスタ → { at, producer }
    this.lastWriter = new Map(); // レジスタ → entry
    this.unitFree = {};
    this.memFree = 0;
    this.fetchBarrier = 0;
    this.barrierBy = null;
    this.predictor = createPredictor(this.cfg.branch);
    this.stats = { data: 0, ctrl: 0, unit: 0, mem: 0, mispredicts: 0, branches: 0, memSlow: 0, forwards: 0 };
  }

  exTime(cls) {
    const u = this.cfg.units[cls];
    return u ? u.latency : 1;
  }

  /** 実行記録を1つ加え、その命令のタイミング (entry) を返す */
  push(rec) {
    if (!rec || !rec.done) return null;
    const cfg = this.cfg, E = this.entries, W = cfg.width;
    const i = E.length;
    const P = i > 0 ? E[i - 1] : null;
    const Q = i >= W ? E[i - W] : null;
    const ins = rec.ins, cls = ins.def.class;
    const exDur = this.exTime(cls);
    const isMem = cls === 'load' || cls === 'store' || cls === 'rmw';
    const memDur = Math.max(1, cfg.memTime ? cfg.memTime(rec) : 1);
    const t = [0, 0, 0, 0, 0], d = [1, 1, exDur, memDur, 1];
    const waits = [];
    const entry = { i, rec, ins, pc: rec.pc, cls, t, d, waits, fwd: [], branch: null, fetchDelay: null, slowMem: memDur > 1 };

    // IF
    let c = 0;
    if (P) c = Math.max(c, P.t[0]);
    if (Q) c = Math.max(c, Q.t[1]);
    if (!cfg.pipelined && P) c = Math.max(c, P.t[4] + 1);
    if (this.fetchBarrier > c) {
      entry.fetchDelay = { from: c, to: this.fetchBarrier, by: this.barrierBy };
      this.stats.ctrl += this.fetchBarrier - c;
      c = this.fetchBarrier;
    }
    t[0] = c;

    // ID
    t[1] = Math.max(t[0] + 1, P ? P.t[1] : 0, Q ? Q.t[2] : 0);
    if (t[1] > t[0] + 1) waits.push({ stage: 0, from: t[0] + 1, to: t[1], cause: { type: 'pipeline' } });

    // EX: 前の命令・演算器・データの3つを待つ
    const base = Math.max(t[1] + 1, P ? P.t[2] : 0, Q ? Q.t[3] : 0);
    let e = base, cause = { type: 'pipeline' };
    const unit = cfg.units[cls];
    if (unit && !unit.pipelined && (this.unitFree[cls] ?? 0) > e) { e = this.unitFree[cls]; cause = { type: 'unit', unit: cls }; }
    const { src, dst } = operandRegs(ins);
    let dataAt = 0, dataReg = null;
    for (const r of src) {
      const rr = this.ready.get(r);
      if (rr && rr.at > dataAt) { dataAt = rr.at; dataReg = r; }
    }
    if (dataAt > e) {
      this.stats.data += dataAt - Math.max(e, base);
      if (e > base) this.stats.unit += e - base;
      e = dataAt;
      cause = { type: 'data', reg: dataReg, producer: this.ready.get(dataReg).producer };
    } else if (cause.type === 'unit') this.stats.unit += e - base;
    t[2] = e;
    if (t[2] > t[1] + 1) waits.push({ stage: 1, from: t[1] + 1, to: t[2], cause });
    if (unit && !unit.pipelined) this.unitFree[cls] = e + exDur;

    // どこから値を受け取ったか (表示用)
    for (const r of src) {
      const p = this.lastWriter.get(r);
      let from = 'RF';
      if (p && cfg.forwarding && cfg.pipelined) {
        if (p.t[4] <= e - 1) from = 'RF';
        else if (p.t[4] === e) from = 'MEM/WB';
        else from = 'EX/MEM';
      }
      if (from !== 'RF') this.stats.forwards++;
      entry.fwd.push({ reg: r, from, producer: p ? p.i : null });
    }

    // MEM
    let mm = Math.max(t[2] + exDur, P ? P.t[3] : 0, Q ? Q.t[4] : 0), mcause = { type: 'pipeline' };
    if (isMem && cfg.serializeMemory && this.memFree > mm) { this.stats.mem += this.memFree - mm; mm = this.memFree; mcause = { type: 'memport' }; }
    t[3] = mm;
    if (t[3] > t[2] + exDur) waits.push({ stage: 2, from: t[2] + exDur, to: t[3], cause: mcause });
    if (isMem) this.memFree = mm + memDur;
    if (memDur > 1) this.stats.memSlow++;

    // WB
    t[4] = Math.max(t[3] + memDur, P ? P.t[4] : 0, Q ? Q.t[4] + 1 : 0);
    if (t[4] > t[3] + memDur) waits.push({ stage: 3, from: t[3] + memDur, to: t[4], cause: { type: 'pipeline' } });
    entry.end = t[4];

    // 結果が使えるようになる時刻
    if (dst) {
      const late = cls === 'load' || cls === 'rmw';
      const at = !cfg.pipelined ? t[4] + 1 : cfg.forwarding ? (late ? t[3] + memDur : t[2] + exDur) : t[4] + 1;
      this.ready.set(dst, { at, producer: i });
      this.lastWriter.set(dst, entry);
    }

    // 分岐・ジャンプ
    const br = rec.branch;
    if (cls === 'branch' && br) {
      this.stats.branches++;
      const { mispredicted, predicted } = this.predictor.resolve(rec.pc, br.taken);
      const resolveAt = t[2] + exDur - 1;
      entry.branch = { taken: br.taken, target: br.target, predicted, mispredicted, resolveAt, policy: cfg.branch };
      if (mispredicted) {
        if (cfg.branch !== 'stall') this.stats.mispredicts++;
        this.redirect(entry, resolveAt, cfg.branch === 'stall' ? null : predicted ? br.target : rec.pc + 1);
      }
    } else if (cls === 'jump' && br) {
      const indirect = ins.def.operandList.includes('rs');
      let resolveAt = null;
      if (indirect && cfg.branch !== 'perfect') resolveAt = t[2] + exDur - 1;          // 番地はレジスタの値なので EX で決まる
      else if (!indirect && (cfg.branch === 'stall' || cfg.branch === 'not-taken')) resolveAt = t[1]; // 直接ジャンプは ID で決まる
      entry.branch = { taken: true, target: br.target, predicted: resolveAt === null, mispredicted: resolveAt !== null, resolveAt, policy: cfg.branch, jump: true };
      if (resolveAt !== null) this.redirect(entry, resolveAt, cfg.branch === 'stall' ? null : rec.pc + 1);
    }

    E.push(entry);
    return entry;
  }

  /** 分岐が resolveAt で決まり、次のサイクルから正しい命令を取り込む。wrongPc があればそこから誤って取り込んでいた */
  redirect(entry, resolveAt, wrongPc) {
    this.fetchBarrier = Math.max(this.fetchBarrier, resolveAt + 1);
    this.barrierBy = entry.i;
    entry.wrongPath = [];
    const prog = this.cfg.program;
    if (wrongPc === null || !prog || !this.cfg.pipelined) return;
    const W = this.cfg.width, seq = this.entries.slice(Math.max(0, this.entries.length - W)).concat([entry]);
    for (let k = 0, pc = wrongPc; pc < prog.instrs.length && k < 16; k++, pc++) {
      const n = seq.length, P = seq[n - 1], Q = n >= W ? seq[n - W] : null;
      const t = [];
      t[0] = Math.max(P.t[0], Q ? Q.t[1] : 0);
      if (t[0] > resolveAt) break;
      t[1] = Math.max(t[0] + 1, P.t[1], Q ? Q.t[2] : 0);
      t[2] = Math.max(t[1] + 1, P.t[2], Q ? Q.t[3] : 0);
      t[3] = Math.max(t[2] + 1, P.t[3], Q ? Q.t[4] : 0);
      t[4] = Math.max(t[3] + 1, P.t[4], Q ? Q.t[4] + 1 : 0);
      const reached = t.filter(x => x <= resolveAt).length; // 取り消されるまでに入ったステージ数
      const w = { wrong: true, by: entry.i, pc, ins: prog.instrs[pc], t, d: [1, 1, 1, 1, 1], reached, flushAt: resolveAt, end: resolveAt };
      entry.wrongPath.push(w);
      this.squashed.push(w);
      seq.push(w);
    }
  }

  /** 最後まで渡し終えたあとの集計 */
  finish() {
    const E = this.entries, N = E.length, cfg = this.cfg;
    if (!N) return { ...this.stats, cycles: 0, instructions: 0, ipc: 0, cpi: 0, ideal: 0, lost: 0, data: 0, ctrl: 0, other: 0, latency: 0 };
    const cycles = E[N - 1].end + 1;
    const ideal = cfg.pipelined ? Math.ceil(N / cfg.width) + 4 : 5 * N;
    const lost = Math.max(0, cycles - ideal);
    let data = this.stats.data, ctrl = this.stats.ctrl;
    if (data + ctrl > lost) { const k = lost / (data + ctrl || 1); data = Math.round(data * k); ctrl = lost - data; }
    const other = Math.max(0, lost - data - ctrl);
    let latSum = 0;
    for (const e of E) latSum += e.end - e.t[0] + 1;
    return {
      ...this.stats, rawData: this.stats.data, rawCtrl: this.stats.ctrl,
      cycles, instructions: N, ipc: N / cycles, cpi: cycles / N, ideal, lost, data, ctrl, other,
      latency: latSum / N,
    };
  }

  /** entry がサイクル c にいるステージ (いなければ −1) と、待っているかどうか */
  stageOf(entry, c) {
    if (c < entry.t[0]) return { stage: -1 };
    if (entry.wrong) {
      if (c > entry.flushAt) return { stage: -1 };
      let s = -1;
      for (let k = 0; k < entry.reached; k++) if (entry.t[k] <= c) s = k;
      const next = s + 1 < entry.reached ? entry.t[s + 1] : Infinity;
      return { stage: s, stalled: s >= 0 && s <= 1 && c < next - 1, flushed: c === entry.flushAt };
    }
    if (c > entry.end) return { stage: -1 };
    let s = 0;
    for (let k = 4; k >= 0; k--) if (c >= entry.t[k]) { s = k; break; }
    // IF・ID は「保持されて待ち、最後のサイクルで先へ進む」ので待ちは前半。
    // EX・MEM は「仕事をしてから空きを待つ」ので待ちは後半。
    const stalled = s <= 1 ? c < entry.t[s + 1] - entry.d[s] : c - entry.t[s] >= entry.d[s];
    return { stage: s, stalled };
  }

  /** サイクル c の各ステージの中身: [[{entry, stalled, flushed}], …×5] */
  stagesAt(c) {
    const out = [[], [], [], [], []];
    const add = e => { const s = this.stageOf(e, c); if (s.stage >= 0) out[s.stage].push({ entry: e, stalled: s.stalled, flushed: !!s.flushed }); };
    for (const e of this.entries) { if (e.t[0] > c) break; if (e.end >= c) add(e); }
    for (const w of this.squashed) if (w.t[0] <= c && w.flushAt >= c) add(w);
    return out;
  }

  /** サイクル c までに完了 (WB) した命令の数 */
  retiredBy(c) {
    let n = 0;
    for (const e of this.entries) if (e.t[4] <= c) n++;
    return n;
  }
}
