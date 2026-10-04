// 拡張 A — アトミック命令 (マルチコア用)
// 仕様: docs/isa.md「アトミック (A)」、docs/machine.md「予約と不可分性」
import { defineExtension } from '../isa.js';

// どれもワード (4バイト) 単位で、番地は4の倍数でなければならない。
export const ATOMIC = defineExtension({
  name: 'A',
  title: 'アトミック命令',
  description: '複数のコアが同じメモリを書き換えるときに使う、不可分な読み書き命令と LL/SC。',
  instructions: [
    { mnemonic: 'LL', opcode: 0x50, format: 'I', operands: 'rd, mem', class: 'load',
      name: 'ロード・リンク', summary: 'rd ← M32[rs + imm]; その番地を予約する',
      exec: c => { const a = c.addr(); c.write(c.load(a, 4)); c.reserve(a); } },
    { mnemonic: 'SC', opcode: 0x51, format: 'A', operands: 'rd, rt, mem', class: 'rmw', atomic: true,
      name: 'ストア・コンディショナル', summary: '予約が残っていれば M32[rs + imm] ← rt, rd ← 1。なければ rd ← 0',
      exec: c => {
        const a = c.addr();
        if (c.holds(a)) { c.store(a, 4, c.b); c.write(1); } else c.write(0);
        c.release();
      } },
    { mnemonic: 'CAS', opcode: 0x52, format: 'A', operands: 'rd, rt, mem', class: 'rmw', atomic: true,
      reads: ['rs', 'rt', 'rd'],
      name: '比較して交換', summary: 'old ← M32[rs + imm]; old = rd なら M32 ← rt。rd ← old',
      exec: c => {
        const a = c.addr(), old = c.load(a, 4);
        if (old === c.d) c.store(a, 4, c.b);
        c.write(old);
      } },
    { mnemonic: 'XCHG', opcode: 0x53, format: 'I', operands: 'rd, mem', class: 'rmw', atomic: true,
      reads: ['rs', 'rd'],
      name: '交換', summary: 'old ← M32[rs + imm]; M32 ← rd; rd ← old',
      exec: c => { const a = c.addr(), old = c.load(a, 4); c.store(a, 4, c.d); c.write(old); } },
    { mnemonic: 'AMOADD', opcode: 0x54, format: 'A', operands: 'rd, rt, mem', class: 'rmw', atomic: true,
      name: 'フェッチ・アンド・アッド', summary: 'old ← M32[rs + imm]; M32 ← old + rt; rd ← old',
      exec: c => { const a = c.addr(), old = c.load(a, 4); c.store(a, 4, old + c.b); c.write(old); } },
  ],
});
