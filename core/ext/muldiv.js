// 拡張 M — 乗算・除算
// 仕様: docs/isa.md「乗除算 (M)」
import { defineExtension } from '../isa.js';

const MIN = -2147483648;

const R = (mnemonic, opcode, cls, name, summary, f) => ({
  mnemonic, opcode, format: 'R', operands: 'rd, rs, rt', class: cls, name, summary,
  exec: c => c.write(f(c.a, c.b)),
});

export const MULDIV = defineExtension({
  name: 'M',
  title: '乗算・除算',
  description: '整数の乗算・除算・剰余。0 による除算は例外にならず、決まった値を返す。',
  instructions: [
    R('MUL', 0x40, 'mul', '乗算 (下位32ビット)', 'rd ← (rs × rt) の下位32ビット', (a, b) => Math.imul(a, b)),
    R('MULH', 0x41, 'mul', '乗算 (上位32ビット・符号付き)', 'rd ← (rs × rt) >> 32',
      (a, b) => Number((BigInt(a) * BigInt(b)) >> 32n) | 0),
    R('MULHU', 0x42, 'mul', '乗算 (上位32ビット・符号なし)', 'rd ← (rs ×ᵤ rt) >> 32',
      (a, b) => Number((BigInt(a >>> 0) * BigInt(b >>> 0)) >> 32n) | 0),
    R('DIV', 0x44, 'div', '除算 (符号付き・0方向に切り捨て)', 'rd ← rs ÷ rt  (rt = 0 なら −1)',
      (a, b) => (b === 0 ? -1 : a === MIN && b === -1 ? MIN : Math.trunc(a / b))),
    R('DIVU', 0x45, 'div', '除算 (符号なし)', 'rd ← rs ÷ᵤ rt  (rt = 0 なら 0xFFFFFFFF)',
      (a, b) => (b === 0 ? -1 : Math.floor((a >>> 0) / (b >>> 0)))),
    R('REM', 0x46, 'div', '剰余 (符号付き)', 'rd ← rs mod rt  (rt = 0 なら rs)',
      (a, b) => (b === 0 ? a : a === MIN && b === -1 ? 0 : a % b)),
    R('REMU', 0x47, 'div', '剰余 (符号なし)', 'rd ← rs modᵤ rt  (rt = 0 なら rs)',
      (a, b) => (b === 0 ? a : (a >>> 0) % (b >>> 0))),
  ],
});
