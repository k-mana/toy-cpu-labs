import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PipelineModel, randomMissTime } from '../core/index.js';
import { traceOf } from './helpers.js';

function pipe(src, cfg = {}) {
  const { program, trace } = traceOf(src);
  const p = new PipelineModel({ program, ...cfg });
  for (const r of trace) p.push(r);
  return { p, s: p.finish(), program };
}
const T = (p, i) => p.entries[i].t.join(',');

test('依存のない N 命令は N + 4 サイクル', () => {
  const { s } = pipe('ADDI r1, r0, 1\nADDI r2, r0, 2\nADDI r3, r0, 3\nADDI r4, r0, 4\nADDI r5, r0, 5');
  assert.equal(s.cycles, 9);
  assert.equal(s.ideal, 9);
  assert.equal(s.lost, 0);
});

test('パイプラインなしなら 5N サイクル', () => {
  const { s } = pipe('ADDI r1, r0, 1\nADDI r2, r0, 2\nADDI r3, r0, 3', { pipelined: false });
  assert.equal(s.cycles, 15);
});

test('データハザード: フォワーディングありなら待たない、なしなら2サイクル待つ', () => {
  const src = 'ADDI r1, r0, 10\nADD r2, r1, r1';
  let { p, s } = pipe(src, { forwarding: true });
  assert.equal(s.cycles, 6);
  assert.deepEqual(p.entries[1].fwd.map(f => f.from), ['EX/MEM']);
  ({ p, s } = pipe(src, { forwarding: false }));
  assert.equal(s.cycles, 8);
  assert.equal(T(p, 1), '1,2,5,6,7');       // ID で 2 サイクル待つ
  assert.equal(p.entries[1].waits[0].cause.type, 'data');
  assert.equal(p.entries[1].waits[0].cause.reg, 1);
});

test('2つ前の結果は MEM/WB から転送される', () => {
  const { p } = pipe('ADDI r1, r0, 1\nNOP\nADD r2, r1, r1');
  assert.deepEqual(p.entries[2].fwd.map(f => f.from), ['MEM/WB']);
});

test('ロード直後の使用は、フォワーディングがあっても1サイクル待つ', () => {
  const { p, s } = pipe('LW r1, 0(r0)\nADD r2, r1, r1');
  assert.equal(s.cycles, 7);
  assert.equal(T(p, 1), '1,2,4,5,6');
  assert.deepEqual(p.entries[1].fwd.map(f => f.from), ['MEM/WB']);
});

test('分岐: 不成立予測で成立すると2命令を取り消す', () => {
  const src = 'BEQ r0, r0, x\nADDI r1, r0, 1\nADDI r2, r0, 2\nx: ADDI r3, r0, 3';
  const { p, s } = pipe(src, { branch: 'not-taken' });
  assert.equal(p.entries.length, 2);
  assert.equal(T(p, 1), '3,4,5,6,7');
  assert.deepEqual(p.entries[0].wrongPath.map(w => [w.pc, w.reached]), [[1, 2], [2, 1]]);
  assert.equal(s.mispredicts, 1);
  assert.equal(s.cycles, 8);
  // サイクル 2 には EX に BEQ、ID と IF に取り消される命令
  const at2 = p.stagesAt(2);
  assert.equal(at2[2][0].entry.pc, 0);
  assert.equal(at2[1][0].flushed, true);
  assert.equal(at2[0][0].flushed, true);
});

test('分岐: 停止方式は毎回2サイクル空く (取り消しはない)', () => {
  const { p, s } = pipe('BEQ r0, r1, x\nADDI r1, r0, 1\nx: NOP', { branch: 'stall' });
  assert.equal(T(p, 1), '3,4,5,6,7');
  assert.equal(p.squashed.length, 0);
  assert.equal(s.mispredicts, 0);
  assert.deepEqual(p.entries[1].fetchDelay, { from: 1, to: 3, by: 0 });
});

test('2ビット予測はループの後ろ向き分岐を覚える', () => {
  const src = 'LI r1, 20\nloop: SUBI r1, r1, 1\nBNEZ r1, loop';
  const nt = pipe(src, { branch: 'not-taken' }).s, bi = pipe(src, { branch: 'bimodal' }).s, pf = pipe(src, { branch: 'perfect' }).s;
  assert.equal(nt.mispredicts, 19);
  assert.ok(bi.mispredicts <= 3, `bimodal ${bi.mispredicts}`);
  assert.equal(pf.mispredicts, 0);
  assert.ok(pf.cycles < bi.cycles && bi.cycles < nt.cycles);
});

test('直接ジャンプ: 不成立予測なら ID で決まり1サイクル空く', () => {
  const { p } = pipe('J x\nNOP\nx: NOP', { branch: 'not-taken' });
  assert.equal(T(p, 1), '2,3,4,5,6');
  assert.equal(p.entries[0].wrongPath.length, 1);
  assert.equal(pipe('J x\nNOP\nx: NOP', { branch: 'bimodal' }).p.entries[1].t[0], 1);
});

test('2命令幅: 依存がなければ IPC が 1 を超える', () => {
  const src = Array.from({ length: 16 }, (_, i) => `ADDI r${(i % 15) + 1}, r0, ${i}`).join('\n');
  const { s } = pipe(src, { width: 2 });
  assert.equal(s.cycles, 12);
  assert.ok(s.ipc > 1.3);
});

test('複数サイクルの MUL は EX を占有し、後ろの命令は ID で待つ', () => {
  const { p } = pipe('MUL r1, r2, r3\nADDI r4, r0, 1', { units: { mul: { latency: 3, pipelined: false } } });
  assert.equal(T(p, 0), '0,1,2,5,6');
  assert.equal(T(p, 1), '1,2,5,6,7');
  assert.equal(p.entries[1].waits[0].cause.type, 'pipeline');
});

test('2命令幅: 乗算器がパイプライン化されていなければ MUL どうしが待つ', () => {
  const src = 'MUL r1, r2, r3\nMUL r4, r5, r6';
  const un = pipe(src, { width: 2, units: { mul: { latency: 3, pipelined: false } } });
  const pi = pipe(src, { width: 2, units: { mul: { latency: 3, pipelined: true } } });
  assert.equal(un.p.entries[1].t[2], 5);
  assert.equal(un.p.entries[1].waits[0].cause.type, 'unit');
  assert.equal(pi.p.entries[1].t[2], 2);
});

test('メモリが遅いと MEM で止まり、後ろも待つ', () => {
  const { p, s } = pipe('LW r1, 0(r0)\nADDI r2, r0, 1', { memTime: rec => (rec.ins.def.class === 'load' ? 9 : 1) });
  assert.equal(p.entries[0].d[3], 9);
  assert.equal(T(p, 1), '1,2,3,12,13');
  assert.equal(s.memSlow, 1);
});

test('randomMissTime は同じシードなら同じ結果', () => {
  const src = 'LI r2, 30\nloop: LW r1, 0(r0)\nSUBI r2, r2, 1\nBNEZ r2, loop';
  const a = pipe(src, { memTime: randomMissTime({ rate: 30, seed: 3 }) }).s.cycles;
  const b = pipe(src, { memTime: randomMissTime({ rate: 30, seed: 3 }) }).s.cycles;
  const z = pipe(src, { memTime: randomMissTime({ rate: 0 }) }).s.cycles;
  assert.equal(a, b);
  assert.ok(a > z);
});

test('ストールの内訳: 理想 + データ + 制御 + その他 = 総サイクル', () => {
  const src = 'LI r1, 8\nloop: LW r2, 0(r0)\nADD r3, r3, r2\nSUBI r1, r1, 1\nBNEZ r1, loop';
  for (const forwarding of [true, false]) for (const branch of ['stall', 'not-taken', 'bimodal']) {
    const { s } = pipe(src, { forwarding, branch });
    assert.equal(s.ideal + s.data + s.ctrl + s.other, s.cycles);
  }
});
