// 機能シミュレータ — 命令の意味どおりにレジスタとメモリを書き換える
// 仕様: docs/machine.md
//
//   const m = new Machine({ program, cores: 1, memSize: 65536 });
//   const rec = m.step(0);   // 1命令 (μop 命令なら1 μop) 進め、実行記録を返す
//
// タイミング (サイクル数) はここでは扱わない。実行記録の列 (トレース) を
// タイミングモデル (pipeline.js, inorder.js) に渡して計算する。

import { Memory } from './memory.js';
import { NUM_REGS } from './isa.js';

export class Trap extends Error {}

/** 命令が読む・書くレジスタ (r0 を除く)。タイミングモデルの依存関係判定に使う */
const regCache = new WeakMap();
export function operandRegs(ins) {
  let r = regCache.get(ins);
  if (!r) {
    const src = new Set();
    for (const f of ins.def.reads) if (ins[f]) src.add(ins[f]);
    const dst = ins.def.writes.includes('rd') && ins.rd ? ins.rd : null;
    r = { src: [...src], dst };
    regCache.set(ins, r);
  }
  return r;
}

const hex = n => '0x' + (n >>> 0).toString(16).toUpperCase();

/** exec(c) に渡す実行コンテキスト */
class Context {
  constructor(machine) { this.m = machine; }
  setup(core, ins, rec) {
    const r = core.regs;
    this.core = core; this.ins = ins; this.rec = rec;
    this.pc = core.pc; this.imm = ins.imm;
    this.a = r[ins.rs]; this.b = r[ins.rt]; this.d = r[ins.rd];
    this.tmp = core.tmp;
  }
  addr() { return (this.a + this.imm) | 0; }
  write(v) {
    v |= 0;
    const rd = this.ins.rd, regs = this.core.regs;
    const old = regs[rd];
    if (rd !== 0) regs[rd] = v;
    this.rec.write = { reg: rd, value: rd ? v : 0, old, computed: v, discarded: rd === 0 };
  }
  load(addr, size = 4, signed = false) {
    this.m.checkAccess(addr, size);
    const info = this.m.port.access({ type: 'read', addr, size, signed });
    this.rec.mem.push({ type: 'read', addr, size, value: info.value, info });
    return info.value;
  }
  store(addr, size, value) {
    this.m.checkAccess(addr, size);
    const v = size === 1 ? value & 0xff : value | 0;
    const info = this.m.port.access({ type: 'write', addr, size, value: v });
    this.rec.mem.push({ type: 'write', addr, size, value: v, old: info.old, info });
    this.m.afterWrite(this.core, addr, size, this.rec);
  }
  branch(cond) {
    const t = this.ins.target;
    this.rec.branch = { taken: !!cond, target: t, conditional: true };
    if (cond) this.rec.nextPc = t;
  }
  jump(target) {
    this.rec.branch = { taken: true, target, conditional: false };
    this.rec.nextPc = target;
  }
  halt() { this.rec.halt = true; this.rec.nextPc = this.pc; }
  trap(message) { throw new Trap(message); }
  reserve(addr) { this.core.reservation = addr; this.rec.notes.push({ type: 'reserve', core: this.core.id, addr }); }
  holds(addr) { return this.core.reservation === addr; }
  release() { this.core.reservation = null; }
  note(n) { this.rec.notes.push(n); }
}

export class Machine {
  /**
   * @param {object} o
   * @param {object} o.program   assemble() の結果
   * @param {number} [o.cores=1] コア数 (全コアが同じプログラムを PC=0 から実行する)
   * @param {Memory} [o.memory]  データメモリ (省略時は memSize バイトの Memory)
   * @param {number} [o.memSize=65536]
   * @param {object} [o.port]    メモリアクセスの入口 (キャッシュなど)。省略時は memory
   * @param {function} [o.init]  reset のたびに init(memory, machine) を呼ぶ (プログラムの .data より先)
   */
  constructor({ program, cores = 1, memory, memSize = 65536, port, init } = {}) {
    if (!program) throw new Error('Machine には program が必要です');
    this.program = program;
    this.isa = program.isa;
    this.memory = memory || new Memory(memSize);
    this.port = port || this.memory;
    this.init = init;
    this.numCores = cores;
    this.ctx = new Context(this);
    this.reset();
  }

  reset() {
    this.memory.clear();
    if (this.port !== this.memory && typeof this.port.reset === 'function') this.port.reset();
    if (this.init) this.init(this.memory, this);
    this.memory.loadChunks(this.program.data);
    const empty = this.program.instrs.length === 0;
    this.cores = Array.from({ length: this.numCores }, (_, id) => ({
      id, pc: 0, regs: new Int32Array(NUM_REGS), halted: empty, haltReason: empty ? 'end' : null,
      trap: null, uop: 0, tmp: {}, reservation: null, retired: 0, steps: 0,
    }));
    this.seq = 0;
  }

  get halted() { return this.cores.every(c => c.halted); }
  get running() { return this.cores.filter(c => !c.halted).map(c => c.id); }

  checkAccess(addr, size) {
    if (!this.memory.inRange(addr, size))
      throw new Trap(`番地 ${addr} (${hex(addr)}) はメモリの外です (0〜${this.memory.size - 1})`);
    if (size > 1 && addr % size)
      throw new Trap(`番地 ${addr} (${hex(addr)}) は ${size} の倍数ではありません (ワードは4の倍数の番地)`);
  }

  afterWrite(core, addr, size, rec) {
    for (const k of this.cores) {
      const r = k.reservation;
      if (r !== null && addr < r + 4 && r < addr + size) {
        k.reservation = null;
        if (k !== core) rec.notes.push({ type: 'reservation-lost', core: k.id, addr: r, by: core.id });
      }
    }
  }

  /**
   * コア id を1命令 (μop 命令は1 μop) 進める。
   * @returns 実行記録 (docs/machine.md「実行記録」)。停止済みなら null
   */
  step(id = 0) {
    const core = this.cores[id];
    if (!core || core.halted) return null;
    const instrs = this.program.instrs;
    const ins = instrs[core.pc];
    const def = ins.def;
    const n = def.uopCount;
    const whole = !def.uops || ins.lock;
    const rec = {
      seq: this.seq++, core: id, pc: core.pc, ins,
      uop: whole ? 0 : core.uop, uopCount: whole ? 1 : n, done: true,
      reads: [], write: null, mem: [], branch: null, nextPc: core.pc + 1,
      halt: false, end: false, trap: null, notes: [], atomic: !!(def.atomic || ins.lock),
    };
    for (const f of def.reads) rec.reads.push({ field: f, reg: ins[f], value: core.regs[ins[f]] });
    const c = this.ctx;
    c.setup(core, ins, rec);
    try {
      if (!def.uops) def.exec(c);
      else if (whole) for (const u of def.uops) u(c);
      else def.uops[core.uop](c);
    } catch (e) {
      if (!(e instanceof Trap)) throw e;
      core.halted = true; core.haltReason = 'trap';
      core.trap = { message: e.message, pc: core.pc, line: ins.line };
      rec.trap = e.message; rec.done = false; rec.nextPc = core.pc;
      core.steps++;
      return rec;
    }
    if (!whole && core.uop < n - 1) { core.uop++; rec.done = false; rec.nextPc = core.pc; }
    else { core.uop = 0; core.tmp = {}; core.retired++; }
    core.steps++;
    core.pc = rec.nextPc;
    if (rec.halt) { core.halted = true; core.haltReason = 'halt'; }
    else if (core.pc === instrs.length) { core.halted = true; core.haltReason = 'end'; rec.end = true; }
    else if (core.pc < 0 || core.pc > instrs.length) {
      core.halted = true; core.haltReason = 'trap';
      core.trap = { message: `PC ${core.pc} はプログラムの外です`, pc: rec.pc, line: ins.line };
      rec.trap = core.trap.message;
    }
    return rec;
  }

  /**
   * 1つのコアを停止するまで (または maxSteps まで) 進める。
   * @returns {{steps:number, reason:'halt'|'end'|'trap'|'limit'}}
   */
  run({ core = 0, maxSteps = 1e7, onStep } = {}) {
    let steps = 0;
    const k = this.cores[core];
    while (!k.halted && steps < maxSteps) {
      const rec = this.step(core);
      steps++;
      if (onStep) onStep(rec);
    }
    return { steps, reason: k.halted ? k.haltReason : 'limit' };
  }

  /** 複数コアをスケジューラ (sched.js) に従って進める */
  runScheduled(scheduler, { maxSteps = 1e6, onStep } = {}) {
    let steps = 0, current = null;
    while (!this.halted && steps < maxSteps) {
      current = scheduler(this, current);
      if (current === null || current === undefined) break;
      const rec = this.step(current);
      steps++;
      if (onStep) onStep(rec);
    }
    return { steps, reason: this.halted ? 'halt' : 'limit' };
  }

  /** 実行してトレース (完了した命令の記録の配列) を返す。単一コア用 */
  trace({ maxSteps = 1e6 } = {}) {
    const out = [];
    const res = this.run({ maxSteps, onStep: r => { if (r.done) out.push(r); } });
    return { trace: out, ...res };
  }
}
