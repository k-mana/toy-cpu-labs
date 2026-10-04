import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cache, Memory, Machine, MemoryHierarchy, InOrderModel } from '../core/index.js';
import { asm } from './helpers.js';

const mem1k = () => { const m = new Memory(1024); for (let i = 0; i < 256; i++) m.writeWord(i * 4, i); return m; };

test('形状: 128B・16B ライン・ダイレクトマップ', () => {
  const c = new Cache({ size: 128, lineSize: 16, ways: 1, backing: new Memory(1024) });
  assert.deepEqual(c.geometry, { size: 128, lineSize: 16, sets: 8, ways: 1, lines: 8, offsetBits: 4, indexBits: 3, tagBits: 3, addrBits: 10 });
  assert.deepEqual(c.decompose(0x1a4), { block: 26, set: 2, tag: 3, offset: 4 });
  assert.equal(c.baseOf(2, 3), 0x1a0);
});

test('フルアソシアティブは ways: 0', () => {
  const c = new Cache({ size: 64, lineSize: 16, ways: 0 });
  assert.equal(c.sets, 1);
  assert.equal(c.ways, 4);
});

test('3C 分類: 初期参照・競合・容量', () => {
  const c = new Cache({ size: 64, lineSize: 16, ways: 1, backing: mem1k(), classify: true });
  const rd = a => c.access({ type: 'read', addr: a, size: 4 });
  assert.equal(rd(0).missType, 'compulsory');
  assert.equal(rd(4).hit, true);
  assert.equal(rd(64).missType, 'compulsory');  // セット0 を奪う
  assert.equal(rd(0).missType, 'conflict');     // 同じ容量のフルアソシアティブなら当たっていた
  // 容量ミス: フルアソシアティブでも入りきらない
  const fa = new Cache({ size: 64, lineSize: 16, ways: 0, backing: mem1k(), classify: true });
  for (const a of [0, 16, 32, 48, 64]) fa.access({ type: 'read', addr: a, size: 4 });
  assert.equal(fa.access({ type: 'read', addr: 0, size: 4 }).missType, 'capacity');
  assert.deepEqual([fa.stats.compulsory, fa.stats.capacity, fa.stats.conflict], [5, 1, 0]);
});

test('ライトバック: ダーティなラインは追い出すときにだけ書き戻す', () => {
  const mem = mem1k();
  const c = new Cache({ size: 64, lineSize: 16, ways: 1, backing: mem, missPenalty: 20 });
  const w = c.access({ type: 'write', addr: 8, size: 4, value: 99 });
  assert.equal(w.cycles, 21);
  assert.equal(w.old, 2);
  assert.equal(mem.readWord(8), 2);              // まだメモリは古い
  const r = c.access({ type: 'read', addr: 64, size: 4 });
  assert.equal(r.writeback, true);
  assert.equal(r.cycles, 41);
  assert.equal(mem.readWord(8), 99);
  assert.equal(c.stats.writebacks, 1);
});

test('ライトスルー: 書き込みミスは載せずにメモリへ', () => {
  const mem = mem1k();
  const c = new Cache({ size: 64, lineSize: 16, ways: 1, write: 'through', backing: mem });
  const w = c.access({ type: 'write', addr: 8, size: 4, value: 99 });
  assert.equal(w.noAllocate, true);
  assert.equal(w.cycles, 1);
  assert.equal(mem.readWord(8), 99);
  assert.equal(c.has(8), false);
  c.access({ type: 'read', addr: 8, size: 4 });
  c.access({ type: 'write', addr: 12, size: 4, value: 7 });
  assert.equal(mem.readWord(12), 7);
  assert.equal(c.stats.writeThroughs, 2);
});

test('LRU と FIFO の違い', () => {
  const seq = [0, 16, 0, 32, 0];   // 2ウェイ1セット
  const hits = policy => {
    const c = new Cache({ size: 32, lineSize: 16, ways: 2, policy, backing: mem1k() });
    return seq.map(a => c.access({ type: 'read', addr: a, size: 4 }).hit);
  };
  assert.deepEqual(hits('LRU'), [false, false, true, false, true]);
  assert.deepEqual(hits('FIFO'), [false, false, true, false, false]);
});

test('RANDOM は同じシードなら同じ結果', () => {
  const run = seed => {
    const c = new Cache({ size: 32, lineSize: 4, ways: 0, policy: 'RANDOM', backing: mem1k(), seed });
    for (let i = 0; i < 200; i++) c.access({ type: 'read', addr: ((i * 37) % 64) * 4, size: 4 });
    return c.stats.hits;
  };
  assert.equal(run(5), run(5));
});

test('Machine の port に差し込むとロード/ストアがキャッシュを通る', () => {
  const memory = new Memory(1024);
  const cache = new Cache({ size: 64, lineSize: 16, ways: 1, backing: memory });
  const p = asm('LI r1, 5\nSW r1, 0x40(r0)\nLW r2, 0x40(r0)\nLW r3, 0x50(r0)');
  const m = new Machine({ program: p, memory, port: cache });
  const recs = [];
  while (!m.halted) recs.push(m.step());
  assert.equal(recs[1].mem[0].info.hit, false);
  assert.equal(recs[2].mem[0].info.hit, true);
  assert.equal(m.cores[0].regs[2], 5);
  assert.equal(memory.readWord(0x40), 0);  // ダーティのまま
  cache.flush();
  assert.equal(memory.readWord(0x40), 5);
});

/* ---------------- メモリ階層とインオーダー発行モデル ---------------- */

const lt1 = (o = {}) => new MemoryHierarchy({
  lineSize: 64, memoryLatency: 200, memorySize: 1 << 20, prefetch: o.prefetch ?? 0,
  levels: [{ name: 'L1', size: 4096, latency: 4 }, { name: 'L2', size: 32768, latency: 12 }, { name: 'L3', size: 131072, latency: 40 }],
});

function runLT(src, cfg = {}) {
  const program = asm(src);
  const m = new Machine({ program, memSize: 1 << 20 });
  const H = lt1(cfg);
  const model = new InOrderModel({ hierarchy: H, ...cfg });
  const recs = [];
  m.run({ onStep: r => { const t = model.push(r); if (t) recs.push(t); } });
  return { sum: model.finish(), H, recs };
}

test('階層: 最初は DRAM、同じラインの続きは L1', () => {
  const H = lt1();
  assert.deepEqual(H.load(0, 0), { level: 3, latency: 200 });
  assert.deepEqual(H.load(4, 300), { level: 0, latency: 4 });
  // 届く前に同じラインに触れると、届くまで待つ
  assert.deepEqual(H.load(128, 1000), { level: 3, latency: 200 });
  assert.deepEqual(H.load(132, 1010), { level: 0, latency: 190 });
});

test('連続アクセスはストライドより速い', () => {
  const seq = runLT('LI r1, 0\nLI r3, 256\nloop: LW r2, 0(r1)\nADD r4, r4, r2\nADDI r1, r1, 4\nSUBI r3, r3, 1\nBNEZ r3, loop');
  const str = runLT('LI r1, 0\nLI r3, 256\nloop: LW r2, 0(r1)\nADD r4, r4, r2\nADDI r1, r1, 64\nSUBI r3, r3, 1\nBNEZ r3, loop');
  assert.equal(seq.H.stats.hits[3], 16);
  assert.equal(str.H.stats.hits[3], 256);
  assert.ok(str.sum.cycles > 5 * seq.sum.cycles);
});

test('プリフェッチは連続アクセスの DRAM 待ちを減らす', () => {
  const src = 'LI r1, 0\nLI r3, 512\nloop: LW r2, 0(r1)\nADD r4, r4, r2\nADDI r1, r1, 4\nSUBI r3, r3, 1\nBNEZ r3, loop';
  const off = runLT(src), on = runLT(src, { prefetch: 2 });
  assert.ok(on.sum.cycles < off.sum.cycles);
  assert.ok(on.H.stats.prefetches > 0);
});

test('依存チェーンは MUL のレイテンシが積み重なる', () => {
  const chain = runLT('MUL r1, r1, r2\nMUL r1, r1, r2\nMUL r1, r1, r2\nMUL r1, r1, r2');
  const indep = runLT('MUL r1, r1, r2\nMUL r3, r3, r2\nMUL r5, r5, r2\nMUL r6, r6, r2');
  assert.equal(chain.sum.cycles, 12);
  assert.equal(indep.sum.cycles, 6);
  assert.equal(chain.recs[1].cause, 'alu');
});

test('DIV はパイプライン化されていないので独立でも重ならない', () => {
  const { sum } = runLT('DIV r1, r1, r2\nDIV r3, r3, r2', { latency: { div: 20 } });
  assert.equal(sum.cycles, 40);
});

test('MSHR が 1 ならミスは1つずつ', () => {
  const src = 'LW r1, 0(r0)\nLW r2, 0x1000(r0)\nLW r3, 0x2000(r0)\nADD r4, r1, r2\nADD r4, r4, r3';
  const many = runLT(src, { mshr: 8 }), one = runLT(src, { mshr: 1 });
  assert.ok(many.sum.cycles < 210);
  assert.ok(one.sum.cycles > 600);
});

test('分岐予測ミスは決まったサイクルを失う', () => {
  const { sum } = runLT('LI r1, 1\nBNEZ r1, x\nNOP\nx: NOP', { mispredictPenalty: 15 });
  assert.equal(sum.mispredicts, 1);
  assert.equal(sum.brm, 15);
});
