import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Machine, scripted, randomSwitch, roundRobin, mulberry32 } from '../core/index.js';
import { asm, isaX } from './helpers.js';

const two = (src, opts = {}) => new Machine({ program: asm(src, opts), cores: 2, memSize: 64 });
const counter = m => m.memory.readWord(0);

const RACE = `
        LI r3, 3
loop:   LW r1, 0(r0)
        ADDI r1, r1, 1
        SW r1, 0(r0)
        SUBI r3, r3, 1
        BNEZ r3, loop`;

test('交互に実行すると更新が消える (LW/ADDI/SW)', () => {
  const m = two(RACE);
  // 両コアが同じ値を読んでから書く
  m.runScheduled(scripted([0, 1, 0, 1, 0, 1, 0, 1, 0, 1].concat(Array(40).fill(0), Array(40).fill(1))));
  assert.ok(m.halted);
  assert.ok(counter(m) < 6, `counter = ${counter(m)}`);
});

test('1コアずつ実行すれば正しい', () => {
  const m = two(RACE);
  m.runScheduled(scripted([...Array(16).fill(0), ...Array(16).fill(1)]));
  assert.equal(counter(m), 6);
});

test('AMOADD は不可分 (どんな順番でも 6)', () => {
  const src = `
        LI r3, 3
        LI r2, 1
loop:   AMOADD r1, r2, 0(r0)
        SUBI r3, r3, 1
        BNEZ r3, loop`;
  for (let seed = 1; seed <= 50; seed++) {
    const m = two(src);
    m.runScheduled(randomSwitch(0.5, mulberry32(seed)));
    assert.equal(counter(m), 6);
  }
});

test('CAS ループ: 失敗すると最新値を受け取ってやり直す', () => {
  const src = `
        LI r3, 3
loop:   LW r1, 0(r0)
retry:  ADDI r2, r1, 1
        MOV r4, r1
        CAS r1, r2, 0(r0)
        BNE r1, r4, retry
        SUBI r3, r3, 1
        BNEZ r3, loop`;
  for (let seed = 1; seed <= 50; seed++) {
    const m = two(src);
    m.runScheduled(randomSwitch(0.7, mulberry32(seed)));
    assert.equal(counter(m), 6, `seed ${seed}`);
  }
});

test('LL/SC: 間に他のコアが書くと SC は失敗し、予約が消えた記録が残る', () => {
  const src = `
loop:   LL r1, 0(r0)
        ADDI r1, r1, 1
        SC r2, r1, 0(r0)
        BEQZ r2, loop`;
  const m = two(src);
  m.step(0); m.step(0);            // コア0: LL, ADDI
  m.step(1); m.step(1);            // コア1: LL, ADDI
  const sc1 = m.step(1);           // コア1: SC 成功
  assert.equal(sc1.write.value, 1);
  assert.deepEqual(sc1.notes.filter(n => n.type === 'reservation-lost').map(n => n.core), [0]);
  const sc0 = m.step(0);           // コア0: SC 失敗
  assert.equal(sc0.write.value, 0);
  assert.equal(sc0.mem.length, 0);
  m.runScheduled(roundRobin());
  assert.equal(counter(m), 2);
});

test('XCHG でスピンロック: クリティカルセクションに同時に入らない', () => {
  const src = `
        LI r3, 3
loop:
acq:    LI r5, 1
        XCHG r5, 4(r0)
        BNEZ r5, acq
.region cs
        LW r1, 0(r0)
        ADDI r1, r1, 1
        SW r1, 0(r0)
.endregion
        SW r0, 4(r0)
        SUBI r3, r3, 1
        BNEZ r3, loop`;
  for (let seed = 1; seed <= 30; seed++) {
    const m = two(src);
    const sched = randomSwitch(0.6, mulberry32(seed));
    let cur = null, both = 0;
    while (!m.halted) {
      cur = sched(m, cur);
      m.step(cur);
      const inCs = m.cores.filter(c => !c.halted && m.program.instrs[c.pc]?.regions.includes('cs')).length;
      if (inCs === 2) both++;
    }
    assert.equal(both, 0);
    assert.equal(counter(m), 6);
  }
});

test('μop 命令 INCM は2ステップに分かれ、LOCK で1ステップになる', () => {
  const m = new Machine({ program: asm('INCM 0(r0)\nLOCK INCM 0(r0)', { isa: isaX }), memSize: 16 });
  const a = m.step(), b = m.step(), c = m.step();
  assert.deepEqual([a.uop, a.uopCount, a.done, a.mem[0].type], [0, 2, false, 'read']);
  assert.deepEqual([b.uop, b.done, b.mem[0].type, b.pc], [1, true, 'write', 0]);
  assert.deepEqual([c.uopCount, c.done, c.atomic, c.mem.map(x => x.type).join()], [1, true, true, 'read,write']);
  assert.equal(m.memory.readWord(0), 2);
});

test('INCM の μop の間に割り込まれると更新が消える', () => {
  const m = new Machine({ program: asm('INCM 0(r0)', { isa: isaX }), cores: 2, memSize: 16 });
  m.runScheduled(scripted([0, 1, 0, 1]));
  assert.equal(m.memory.readWord(0), 1);
});

test('スケジューラは止まったコアを選ばない', () => {
  const m = two('NOP');
  m.step(0);
  assert.equal(roundRobin()(m, 0), 1);
  assert.equal(randomSwitch(1)(m, 1), 1);
});
