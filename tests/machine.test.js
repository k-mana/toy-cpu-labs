import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Machine } from '../core/index.js';
import { asm, run } from './helpers.js';

test('整数演算の意味', () => {
  const { r } = run(`
    LI r1, -7
    LI r2, 3
    ADD r3, r1, r2
    SUB r4, r1, r2
    AND r5, r1, r2
    OR  r6, r1, r2
    XOR r7, r1, r2
    SLT r8, r1, r2
    SLTU r9, r1, r2
    SLL r10, r2, r2
    SRL r11, r1, r2
    SRA r12, r1, r2
  `);
  assert.deepEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(r), [-4, -10, 1, -5, -6, 1, 0, 24, 536870911, -1]);
});

test('即値演算・LUI・32ビットの桁あふれ', () => {
  const { r } = run(`
    LI r1, 0x7FFFFFFF
    ADDI r2, r1, 1
    ANDI r3, r1, 0xFF00
    ORI  r4, r0, 0xFFFF
    XORI r5, r4, 0x00FF
    SLTI r6, r0, -1
    SLTIU r7, r0, -1
    SLLI r8, r4, 16
    SRAI r9, r8, 31
    SRLI r10, r8, 31
    LUI r11, 0xABCD
  `);
  assert.equal(r(2), -2147483648);
  assert.equal(r(3), 0xff00);
  assert.equal(r(4), 0xffff);
  assert.equal(r(5), 0xff00);
  assert.equal(r(6), 0);
  assert.equal(r(7), 1);
  assert.equal(r(8), -65536);
  assert.equal(r(9), -1);
  assert.equal(r(10), 1);
  assert.equal(r(11) >>> 0, 0xabcd0000);
});

test('r0 は常に 0', () => {
  const rec = [];
  const p = asm('ADDI r0, r0, 5\nADD r1, r0, r0');
  const m = new Machine({ program: p });
  rec.push(m.step(), m.step());
  assert.equal(m.cores[0].regs[0], 0);
  assert.equal(m.cores[0].regs[1], 0);
  assert.equal(rec[0].write.discarded, true);
  assert.equal(rec[0].write.computed, 5);
});

test('乗除算と 0 除算', () => {
  const { r } = run(`
    LI r1, -7
    LI r2, 2
    MUL r3, r1, r2
    DIV r4, r1, r2
    REM r5, r1, r2
    DIV r6, r1, r0
    REM r7, r1, r0
    DIVU r8, r1, r2
    LI r9, 0x10000
    MULH r10, r9, r9
    MULHU r11, r1, r2
    LI r12, 0x80000000
    LI r13, -1
    DIV r14, r12, r13
  `);
  assert.deepEqual([3, 4, 5, 6, 7].map(r), [-14, -3, -1, -1, -7]);
  assert.equal(r(8), 2147483644);
  assert.equal(r(10), 1);
  assert.equal(r(11), 1);
  assert.equal(r(14), -2147483648);
});

test('ロード・ストア (ワードとバイト、リトルエンディアン)', () => {
  const { m, r } = run(`
    LI r1, 0x100
    LI r2, 0x11223380
    SW r2, 0(r1)
    LB r3, 0(r1)
    LBU r4, 0(r1)
    LBU r5, 3(r1)
    SB r0, 1(r1)
    LW r6, 0(r1)
  `);
  assert.equal(r(3), -128);
  assert.equal(r(4), 128);
  assert.equal(r(5), 0x11);
  assert.equal(r(6), 0x11220080);
  assert.equal(m.memory.read(0x100, 1), 0x80);
});

test('.data の初期値がメモリに入る', () => {
  const { r } = run('LW r1, val\n.data\n.org 0x20\nval: .word 1234');
  assert.equal(r(1), 1234);
});

test('init はプログラムの .data より先に呼ばれる', () => {
  const { m } = run('NOP\n.data\n.org 4\n.word 9', { init: mem => { mem.writeWord(0, 1); mem.writeWord(4, 2); } });
  assert.equal(m.memory.readWord(0), 1);
  assert.equal(m.memory.readWord(4), 9);
});

test('分岐とループ', () => {
  const { r, m } = run(`
        LI r1, 10
        LI r2, 0
  loop: ADD r2, r2, r1
        SUBI r1, r1, 1
        BNEZ r1, loop
  `);
  assert.equal(r(2), 55);
  assert.equal(m.cores[0].haltReason, 'end');
});

test('符号付きと符号なしの分岐', () => {
  const { r } = run(`
        LI r1, -1
        LI r2, 1
        LI r3, 0
        BLT r1, r2, a
        ORI r3, r3, 1
    a:  BLTU r1, r2, b
        ORI r3, r3, 2
    b:  BGE r2, r1, c
        ORI r3, r3, 4
    c:  BGEU r2, r1, d
        ORI r3, r3, 8
    d:
  `);
  assert.equal(r(3), 2 | 8);
});

test('CALL / RET', () => {
  const { r } = run(`
        LI r1, 3
        CALL double
        CALL double
        HALT
double: ADD r1, r1, r1
        RET
  `);
  assert.equal(r(1), 12);
});

test('HALT と実行記録', () => {
  const p = asm('ADDI r1, r0, 1\nHALT\nADDI r1, r0, 2');
  const m = new Machine({ program: p });
  m.step();
  const rec = m.step();
  assert.equal(rec.halt, true);
  assert.equal(m.cores[0].halted, true);
  assert.equal(m.cores[0].haltReason, 'halt');
  assert.equal(m.step(), null);
  assert.equal(m.cores[0].regs[1], 1);
});

test('実行記録の中身', () => {
  const p = asm('LI r1, 0x40\nLI r2, 5\nSW r2, 4(r1)\nLW r3, 4(r1)\nBEQ r3, r2, x\nNOP\nx:');
  const m = new Machine({ program: p });
  const recs = [];
  while (!m.halted) recs.push(m.step());
  const [, , sw, lw, beq] = recs;
  assert.deepEqual(sw.mem.map(x => [x.type, x.addr, x.value, x.old]), [['write', 0x44, 5, 0]]);
  assert.deepEqual(sw.reads.map(x => [x.field, x.reg, x.value]), [['rs', 1, 0x40], ['rt', 2, 5]]);
  assert.deepEqual([lw.write.reg, lw.write.value, lw.write.old], [3, 5, 0]);
  assert.deepEqual(beq.branch, { taken: true, target: 6, conditional: true });
  assert.equal(beq.nextPc, 6);
  assert.equal(beq.end, true);
  assert.equal(recs.length, 5);
});

test('例外: 4の倍数でないワード番地とメモリの外', () => {
  let { m } = run('LI r1, 2\nLW r2, 0(r1)\nLI r3, 9', { memSize: 64 });
  assert.equal(m.cores[0].haltReason, 'trap');
  assert.match(m.cores[0].trap.message, /4の倍数/);
  assert.equal(m.cores[0].trap.line, 2);
  assert.equal(m.cores[0].regs[3], 0);
  ({ m } = run('SW r0, 64(r0)', { memSize: 64 }));
  assert.match(m.cores[0].trap.message, /メモリの外/);
  ({ m } = run('LI r1, 99\nJR r1'));
  assert.match(m.cores[0].trap.message, /プログラムの外/);
});

test('reset で最初からやり直せる', () => {
  const p = asm('LW r1, v\nADDI r1, r1, 1\nSW r1, v\n.data\nv: .word 41');
  const m = new Machine({ program: p });
  m.run();
  assert.equal(m.memory.readWord(0), 42);
  m.reset();
  assert.equal(m.memory.readWord(0), 41);
  m.run();
  assert.equal(m.memory.readWord(0), 42);
});

test('run の上限 (無限ループの打ち切り)', () => {
  const p = asm('x: J x');
  const m = new Machine({ program: p });
  assert.deepEqual(m.run({ maxSteps: 100 }), { steps: 100, reason: 'limit' });
});
