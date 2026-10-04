import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createISA, defineExtension, BASE, MULDIV, ATOMIC, XMRMW, encode, decode, disassemble } from '../core/index.js';
import { asm, isaX } from './helpers.js';

test('既定の命令セットの名前と構成', () => {
  const isa = createISA([BASE, MULDIV, ATOMIC]);
  assert.equal(isa.name, 'TOY-IMA');
  assert.ok(isa.def('add'));
  assert.ok(isa.pseudo('li'));
  assert.equal(isa.def('NOPE'), undefined);
});

test('オペコードの衝突は組み立て時にエラーになる', () => {
  const bad = defineExtension({ name: 'Xdup', instructions: [{ mnemonic: 'FOO', opcode: 0xc0, format: 'N', operands: '', class: 'system', exec: () => {} }] });
  assert.throws(() => createISA([BASE, XMRMW, bad]), /衝突/);
});

test('ニーモニックの重複はエラーになる', () => {
  const bad = defineExtension({ name: 'Xadd', instructions: [{ mnemonic: 'ADD', opcode: 0xc5, format: 'R', operands: 'rd, rs, rt', class: 'alu', exec: () => {} }] });
  assert.throws(() => createISA([BASE, bad]), /複数の拡張/);
});

test('拡張はオペコードの範囲を守る', () => {
  assert.throws(() => defineExtension({ name: 'Xbad', instructions: [{ mnemonic: 'FOO', opcode: 0x05, format: 'N', operands: '', class: 'system', exec: () => {} }] }), /0xc0/);
  assert.throws(() => defineExtension({ name: 'Xbad', instructions: [{ mnemonic: 'FOO', opcode: 0xc1, format: 'Q', operands: '', class: 'system', exec: () => {} }] }), /形式/);
  assert.throws(() => defineExtension({ name: 'Xbad', instructions: [{ mnemonic: 'FOO', opcode: 0xc1, format: 'N', operands: '', class: 'magic', exec: () => {} }] }), /分類/);
  assert.throws(() => defineExtension({ name: 'Xbad', instructions: [{ mnemonic: 'FOO', opcode: 0xc1, format: 'N', operands: '', class: 'system' }] }), /exec/);
});

test('すべての命令が符号化→復号で元に戻る', () => {
  // 各命令を1つずつ書いたプログラムを作る
  const lines = ['top:'];
  for (const d of isaX.defs.values()) {
    const ops = d.operandList.map(k => ({ rd: 'r3', rs: 'r7', rt: 'r12', imm: d.imm && !d.imm.signed ? '40000' : d.imm && d.imm.max === 31 ? '17' : '-5', mem: d.format === 'A' ? '-8(r7)' : '-300(r7)', label: 'top' }[k]));
    lines.push(`${d.mnemonic} ${ops.join(', ')}`);
  }
  const p = asm(lines.join('\n'), { isa: isaX });
  assert.equal(p.instrs.length, isaX.defs.size);
  for (const ins of p.instrs) {
    const back = decode(ins.word, isaX, ins.index);
    assert.ok(back, ins.text);
    assert.equal(back.op, ins.op);
    for (const f of ['rd', 'rs', 'rt']) if (ins.def.reads.includes(f) || ins.def.writes.includes(f) || ins.def.format !== 'N') {
      if (ins.def.format === 'J' && f !== 'rd') continue;
      if (ins.def.format === 'S' && f === 'rd') continue;
      if (ins.def.format === 'B' && f === 'rd') continue;
      if (ins.def.format === 'I' && f === 'rt') continue;
      assert.equal(back[f], ins[f], `${ins.text} の ${f}`);
    }
    if (ins.target !== null) assert.equal(back.target, ins.target, ins.text);
    else if (ins.def.imm) assert.equal(back.imm, ins.imm, ins.text);
    assert.equal(encode(back), ins.word, ins.text);
    assert.equal(disassemble(back, t => p.labelAt(t)), ins.text);
  }
});

test('機械語の形式 (ビット配置) が仕様どおり', () => {
  const p = asm('ADD r1, r2, r3\nADDI r4, r5, -1\nSW r6, 8(r7)\nx: BEQ r1, r2, x\nJAL r15, x\nHALT');
  const w = p.instrs.map(i => i.word);
  assert.equal(w[0], 0x01123000);
  assert.equal(w[1], 0x1045ffff);
  assert.equal(w[2], 0x24670008);
  assert.equal(w[3], 0x2812ffff); // 自分自身へ: 相対 −1
  assert.equal(w[4], 0x30f00003);
  assert.equal(w[5], 0x3f000000);
});

test('0 は不正な命令 (オペコード 0 は予約)', () => {
  assert.equal(decode(0, isaX), null);
});
