// 拡張 Xmrmw — メモリを直接 +1 する命令 (教材用の独自拡張の例)
//
// x86 の INC [mem] のように、1命令に見えて内部では「読む」「書く」の
// 2つのマイクロ操作 (μop) に分かれる命令。マルチコアでは μop の間に
// 他のコアが割り込めるので、LOCK 接頭辞を付けたときだけ不可分になる。
//
// 独自拡張の書き方の見本でもある (docs/extending.md)。
import { defineExtension } from '../isa.js';

export const XMRMW = defineExtension({
  name: 'Xmrmw',
  title: 'メモリ直接加算 (教材用)',
  description: 'メモリを直接書き換える命令。2つの μop に分かれ、LOCK 接頭辞で不可分になる。',
  instructions: [
    { mnemonic: 'INCM', opcode: 0xc0, format: 'I', operands: 'mem', class: 'rmw',
      reads: ['rs'], writes: [], prefixes: ['LOCK'],
      name: 'メモリを +1', summary: 'M32[rs + imm] ← M32[rs + imm] + 1  (μop1: 読む, μop2: 書く)',
      uopNames: ['読み出し', '書き込み'],
      uops: [
        c => { c.tmp.value = c.load(c.addr(), 4); },
        c => { c.store(c.addr(), 4, c.tmp.value + 1); },
      ] },
  ],
});
