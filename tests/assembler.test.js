import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assemble } from '../core/index.js';
import { asm, isa, isaX } from './helpers.js';

const errs = (src, i = isa) => assemble(src, { isa: i }).errors;

test('コメントは ; と # の両方', () => {
  const p = asm('ADDI r1, r0, 1 ; コメント\nADDI r2, r0, 2 # これも\n; 行全体\n# 行全体');
  assert.equal(p.instrs.length, 2);
});

test('大文字小文字: 命令とレジスタは区別しない、ラベルは区別する', () => {
  const p = asm('add R1, r2, R3\nLoop: j Loop');
  assert.equal(p.instrs[0].text, 'ADD r1, r2, r3');
  assert.equal(p.instrs[1].target, 1);
  assert.match(errs('loop: J Loop')[0].message, /Loop/);
});

test('数の書き方', () => {
  const p = asm("ADDI r1, r0, 0x7F\nADDI r2, r0, 0b101\nADDI r3, r0, 'A'\nADDI r4, r0, -12\nADDI r5, r0, 2*3+1");
  assert.deepEqual(p.instrs.map(i => i.imm), [127, 5, 65, -12, 7]);
});

test('メモリオペランドの4つの形', () => {
  const p = asm('.equ BUF, 0x40\nLW r1, 8(r2)\nLW r1, (r2)\nLW r1, BUF\nLW r1, BUF+4(r3)');
  assert.deepEqual(p.instrs.map(i => [i.imm, i.rs]), [[8, 2], [0, 2], [64, 0], [68, 3]]);
});

test('ラベルは同じ行の命令の位置、前方参照もできる', () => {
  const p = asm('  J end\nmid: NOP\nend:');
  assert.equal(p.instrs[0].target, 2);
  assert.equal(p.labels.mid.value, 1);
  assert.equal(p.labels.end.value, 2);
});

test('LI は値の大きさで1命令か2命令になる', () => {
  const cases = [[5, 1], [-32768, 1], [32768, 1], [0xffff, 1], [0x12345678, 2], [0x10000, 1], [-1, 1], [0xffffffff, 1], [0x80000000, 1], [-32769, 2]];
  for (const [v, n] of cases) {
    const p = asm(`LI r1, ${v}\nHALT`);
    assert.equal(p.instrs.length - 1, n, `LI ${v}`);
  }
});

test('LI の後ろのラベル位置は展開後の命令数で決まる', () => {
  const p = asm('LI r1, 0x12345678\nx: HALT\nJ x');
  assert.equal(p.labels.x.value, 2);
  assert.equal(p.instrs[3].target, 2);
});

test('疑似命令の展開', () => {
  const p = asm('NOP\nMOV r1, r2\nNEG r3, r4\nSUBI r5, r5, 3\nBEQZ r1, z\nBGT r1, r2, z\nJR r9\nCALL z\nRET\nz:');
  assert.deepEqual(p.instrs.map(i => i.text), [
    'NOP', 'ADDI r1, r2, 0', 'SUB r3, r0, r4', 'ADDI r5, r5, -3', 'BEQ r1, r0, z', 'BLT r2, r1, z',
    'JALR r0, r9, 0', 'JAL r15, z', 'JALR r0, r15, 0',
  ]);
  assert.equal(p.instrs[1].pseudo, 'MOV');
  assert.equal(p.instrs[1].src, 'MOV r1, r2');
});

test('.data の配置: .org .align .word .byte .space とラベル', () => {
  const p = asm('.data\n.org 0x10\nb: .byte 1, 2, 0xff\n.align 4\nw: .word 7, -1, w\nsp: .space 3, 9\n.text\nLA r1, w');
  assert.equal(p.labels.b.value, 16);
  assert.equal(p.labels.w.value, 20);
  assert.equal(p.labels.sp.value, 32);
  const bytes = {};
  for (const c of p.data) c.bytes.forEach((v, i) => { bytes[c.addr + i] = v; });
  assert.deepEqual([bytes[16], bytes[17], bytes[18]], [1, 2, 255]);
  assert.deepEqual([bytes[20], bytes[24], bytes[28]], [7, 255, 20]);
  assert.deepEqual([bytes[32], bytes[34]], [9, 9]);
  assert.equal(p.instrs[0].imm, 20);
});

test('.equ は前方参照・入れ子ができる', () => {
  const p = asm('ADDI r1, r0, B\n.equ B, A*2\n.equ A, 3');
  assert.equal(p.instrs[0].imm, 6);
});

test('.region は命令に名前を付ける', () => {
  const p = asm('NOP\n.region cs\nNOP\nNOP\n.endregion\nNOP');
  assert.deepEqual(p.instrs.map(i => i.regions.join()), ['', 'cs', 'cs', '']);
});

test('接頭辞 LOCK は許された命令にだけ付く', () => {
  const p = asm('LOCK INCM 0(r0)\nINCM 4(r0)', { isa: isaX });
  assert.equal(p.instrs[0].lock, true);
  assert.equal(p.instrs[1].lock, false);
  assert.match(errs('LOCK ADD r1, r1, r1', isaX)[0].message, /INCM/);
  assert.match(errs('LOCK INCM 0(r0)')[0].message, /LOCK/); // 拡張がなければ未知の命令
});

test('エラーは行番号つきで、すべて報告される', () => {
  const e = errs('ADD r1, r2\nFOO r1\nLW r1, 3(r99)\nBEQ r1, r2, nowhere\nADDI r1, r1, 70000\nx: NOP\nx: NOP\nr3: NOP');
  assert.deepEqual(e.map(x => x.line), [1, 2, 3, 4, 5, 7, 8]);
  assert.match(e[0].message, /3 個/);
  assert.match(e[1].message, /FOO/);
  assert.match(e[2].message, /r0〜r15/);
  assert.match(e[3].message, /nowhere/);
  assert.match(e[4].message, /LI/);
  assert.match(e[5].message, /二重/);
  assert.match(e[6].message, /レジスタ名/);
});

test('即値の範囲は命令ごと', () => {
  assert.equal(errs('ANDI r1, r1, 65535').length, 0);
  assert.equal(errs('ANDI r1, r1, -1').length, 1);
  assert.equal(errs('SLLI r1, r1, 32').length, 1);
  assert.equal(errs('SC r1, r2, 2047(r3)').length, 0);
  assert.equal(errs('SC r1, r2, 2048(r3)').length, 1);
});

test('.word は4の倍数の番地に置く', () => {
  assert.match(errs('.data\n.byte 1\n.word 2')[0].message, /\.align 4/);
});

test('行と命令の対応 (lines) とラベル逆引き', () => {
  const p = asm('; 見出し\nloop: LI r1, 0x12345678\n  J loop');
  assert.deepEqual(p.lines.map(l => l.instrs), [[], [0, 1], [2]]);
  assert.equal(p.labelAt(0), 'loop');
  assert.equal(p.instrs[2].text, 'JAL r0, loop');
});

test('空のプログラムもアセンブルできる', () => {
  const p = asm('; なにもない');
  assert.equal(p.instrs.length, 0);
});

test('呼び出し側が記号を与えられる (symbols)', () => {
  const p = asm('LW r1, counter\nSW r1, lock+0(r2)', { symbols: { counter: 0, lock: 4 } });
  assert.deepEqual(p.instrs.map(i => i.imm), [0, 4]);
  assert.equal(p.labels.counter.section, 'predefined');
  assert.equal(assemble('.equ lock, 8', { isa, symbols: { lock: 4 } }).errors.length, 1);
});
