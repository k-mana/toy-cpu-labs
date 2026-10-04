// すべてのラボの教材 (lessons.js) が、アセンブル・実行でき、書かれたとおりの結果になるか
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createISA, BASE, MULDIV, ATOMIC, XMRMW, assemble, Machine, PipelineModel, Memory, Cache, MemoryHierarchy, InOrderModel, scripted, randomSwitch, mulberry32 } from '../core/index.js';
import * as pipeline from '../labs/pipeline/lessons.js';
import * as throughput from '../labs/throughput/lessons.js';
import * as cache from '../labs/cache/lessons.js';
import * as latency from '../labs/latency/lessons.js';
import * as atomic from '../labs/atomic/lessons.js';
import * as playground from '../labs/playground/lessons.js';

const isaIM = createISA([BASE, MULDIV]);
const isaAll = createISA([BASE, MULDIV, ATOMIC, XMRMW]);
const ok = (src, isa = isaIM, opts = {}) => {
  const { program, errors } = assemble(src, { isa, ...opts });
  assert.deepEqual(errors, [], src.split('\n')[0]);
  return program;
};

test('パイプライン・ラボ: 結果のレジスタと、旧版と同じサイクル数', () => {
  const cycles = {};
  for (const s of pipeline.SAMPLES) {
    const program = ok(s.code);
    const m = new Machine({ program, memSize: pipeline.MEM_BYTES, init: mem => s.mem.forEach((v, i) => mem.writeWord(i * 4, v)) });
    const { trace, reason } = m.trace();
    assert.equal(reason, 'end', s.id);
    for (const [r, v] of Object.entries(s.expect)) assert.equal(m.cores[0].regs[r], v, `${s.id} r${r}`);
    const p = new PipelineModel({ program });
    for (const r of trace) p.push(r);
    cycles[s.id] = p.finish().cycles;
  }
  assert.deepEqual(cycles, { ideal: 10, raw: 9, load: 11, loop: 24 });
});

test('スループット・ラボ: 計算結果と課題の前提', () => {
  for (const p of throughput.PRESETS) {
    const program = ok(p.src);
    const m = new Machine({ program, memSize: throughput.MEM_BYTES, init: throughput.initMemory });
    const { trace, reason } = m.trace({ maxSteps: 500 });
    assert.equal(reason, 'end', p.id);
    for (const [a, v] of Object.entries(p.expectMem || {})) assert.equal(m.memory.readWord(+a), v, `${p.id} M[${a}]`);
    // 課題1: 独立命令は 5段で IPC 0.8 以上、非パイプラインで 0.2
    if (p.id === 'indep') {
      const ipc = cfg => { const q = new PipelineModel(cfg); trace.forEach(r => q.push(r)); return q.finish().ipc; };
      assert.ok(ipc({}) >= 0.8);
      assert.equal(ipc({ pipelined: false }), 0.2);
      assert.ok(ipc({ width: 2 }) * 800 >= 1000); // 課題4 は達成できる
    }
  }
});

test('キャッシュ・ラボ: すべてのプログラムが止まり、ミスの種類が説明どおりに出る', () => {
  const run = (src, cfg) => {
    const memory = new Memory(cache.MEM_BYTES);
    const c = new Cache({ size: 128, lineSize: 16, ways: 1, backing: memory, classify: true, ...cfg });
    const m = new Machine({ program: ok(src), memory, port: c, init: cache.initMemory });
    assert.equal(m.run({ maxSteps: 50000 }).reason, 'halt');
    return c.stats;
  };
  const [seq, conflict, , stride] = cache.PRESETS;
  const s1 = run(seq.src, {});
  assert.equal(s1.capacity + s1.conflict, 0); // 連続アクセスは初期参照だけ
  assert.ok(run(conflict.src, {}).conflict > 0);
  assert.equal(run(conflict.src, { ways: 4 }).conflict, 0);
  assert.ok(run(stride.src, {}).capacity > 0);
  for (const p of cache.PRESETS) run(p.src, {});
});

test('レイテンシ・ラボ: 各レッスンの主張が成り立つ', () => {
  const cyc = (v, pf = false) => {
    const H = new MemoryHierarchy({ lineSize: 64, memoryLatency: 200, memorySize: latency.MEM_BYTES, prefetch: pf ? 2 : 0,
      levels: [{ name: 'L1', size: 4096, latency: 4 }, { name: 'L2', size: 32768, latency: 12 }, { name: 'L3', size: 131072, latency: 40 }] });
    const M = new InOrderModel({ latency: { mul: 3, div: 20 }, mispredictPenalty: 15, mshr: 8, hierarchy: H });
    const m = new Machine({ program: ok(v.code), memSize: latency.MEM_BYTES, init: v.init });
    assert.equal(m.run({ onStep: r => M.push(r) }).reason, 'halt', v.name);
    return M.finish().cycles;
  };
  const L = Object.fromEntries(latency.LESSONS.map(l => [l.title, l.variants]));
  const [seq, stride, rnd] = L['アクセスパターン'];
  assert.ok(cyc(stride) > 5 * cyc(seq));
  assert.ok(cyc(seq, true) < cyc(seq));
  assert.ok(cyc(rnd, true) > 0.8 * cyc(rnd)); // ランダムにはプリフェッチがほとんど効かない
  const ws = L['ワーキングセット'].map(v => cyc(v));
  for (let i = 1; i < ws.length; i++) assert.ok(ws[i] > 1.5 * ws[i - 1], 'ワーキングセットは階段状');
  const [m1, m4, d4] = L['依存チェーン'].map(v => cyc(v));
  assert.ok(m4 < 0.6 * m1 && d4 > m1);
  const [br, sorted, nobr] = L['分岐予測'].map(v => cyc(v));
  assert.ok(sorted < br && nobr < br);
  const [chase, indep, unroll] = L['メモリレベル並列性'].map(v => cyc(v));
  assert.ok(unroll < chase / 2 && indep > unroll);
});

test('アトミック・ラボ: 安全なプログラムはどの順番でも 6、危ないものは壊れうる', () => {
  for (const L of atomic.LESSONS) for (const v of L.variants) {
    const program = ok(v.code, isaAll, { symbols: atomic.SYMBOLS });
    let broken = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const m = new Machine({ program, cores: 2, memSize: 16 });
      const r = m.runScheduled(randomSwitch(0.5, mulberry32(seed)), { maxSteps: 5000 });
      assert.equal(r.reason, 'halt', v.name);
      if (m.memory.readWord(0) !== atomic.EXPECTED) broken++;
    }
    if (v.safe) assert.equal(broken, 0, v.name);
    else assert.ok(broken > 0, v.name);
  }
});

test('アトミック・ラボ: レッスン1 は交互に8ステップで更新消失、スピンロックは10ステップで同時侵入', () => {
  const [race] = atomic.LESSONS[0].variants;
  let m = new Machine({ program: ok(race.code, isaAll, { symbols: atomic.SYMBOLS }), cores: 2, memSize: 16 });
  m.runScheduled(scripted([0, 1, 0, 1, 0, 1, 0, 1]));
  assert.equal(m.memory.readWord(0), 1);
  const [unsafe] = atomic.LESSONS[3].variants;
  const program = ok(unsafe.code, isaAll, { symbols: atomic.SYMBOLS });
  m = new Machine({ program, cores: 2, memSize: 16 });
  m.runScheduled(scripted([0, 1, 0, 1, 0, 1, 0, 1, 0, 1]));
  assert.ok(m.cores.every(c => program.instrs[c.pc].regions.includes('cs')));
});

test('命令セット・ラボのプログラム', () => {
  for (const e of playground.EXAMPLES) {
    const m = new Machine({ program: ok(e.code, createISA([BASE, MULDIV, ATOMIC])) });
    assert.equal(m.run().reason, 'halt', e.name);
    for (const [r, v] of Object.entries(e.expect.regs || {})) assert.equal(m.cores[0].regs[r], v, e.name);
    for (const [a, v] of Object.entries(e.expect.mem || {})) assert.equal(m.memory.readWord(+a), v, e.name);
  }
});
