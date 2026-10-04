// 拡張 I — 基本整数命令
// 仕様: docs/isa.md「基本整数命令 (I)」
import { defineExtension } from '../isa.js';

const u = v => v >>> 0;

// exec(c) の c が持つもの (docs/machine.md「実行コンテキスト」)
//   c.a = rs の値, c.b = rt の値, c.d = rd の (書き込み前の) 値, c.imm, c.ins, c.pc
//   c.write(v)  rd へ書く          c.load(addr, size, signed)   c.store(addr, size, v)
//   c.addr()    rs + imm           c.branch(cond)  c.jump(target)  c.halt()  c.trap(msg)

const R = (mnemonic, opcode, name, summary, f, cls = 'alu') => ({
  mnemonic, opcode, format: 'R', operands: 'rd, rs, rt', class: cls, name, summary,
  exec: c => c.write(f(c.a, c.b)),
});
const I = (mnemonic, opcode, name, summary, f, imm) => ({
  mnemonic, opcode, format: 'I', operands: 'rd, rs, imm', class: 'alu', name, summary, imm,
  exec: c => c.write(f(c.a, c.imm)),
});
const B = (mnemonic, opcode, name, summary, f) => ({
  mnemonic, opcode, format: 'B', operands: 'rs, rt, label', class: 'branch', name, summary,
  exec: c => c.branch(f(c.a, c.b)),
});

const UIMM16 = { bits: 16, signed: false };
const SHAMT = { min: 0, max: 31 };

export const BASE = defineExtension({
  name: 'I',
  title: '基本整数命令',
  description: '16本の32ビットレジスタ (r0 は常に 0) とバイト単位のデータメモリを操作する、ロード/ストア型の命令。',
  instructions: [
    // ---- レジスタ同士の演算 ----
    R('ADD', 0x01, '加算', 'rd ← rs + rt', (a, b) => a + b),
    R('SUB', 0x02, '減算', 'rd ← rs − rt', (a, b) => a - b),
    R('AND', 0x03, 'ビット積', 'rd ← rs & rt', (a, b) => a & b),
    R('OR', 0x04, 'ビット和', 'rd ← rs | rt', (a, b) => a | b),
    R('XOR', 0x05, '排他的論理和', 'rd ← rs ^ rt', (a, b) => a ^ b),
    R('SLT', 0x06, '符号付き比較', 'rd ← (rs < rt) ? 1 : 0', (a, b) => (a < b ? 1 : 0)),
    R('SLTU', 0x07, '符号なし比較', 'rd ← (rs <ᵤ rt) ? 1 : 0', (a, b) => (u(a) < u(b) ? 1 : 0)),
    R('SLL', 0x08, '左シフト', 'rd ← rs << (rt & 31)', (a, b) => a << (b & 31)),
    R('SRL', 0x09, '論理右シフト', 'rd ← rs >>> (rt & 31)', (a, b) => a >>> (b & 31)),
    R('SRA', 0x0a, '算術右シフト', 'rd ← rs >> (rt & 31)', (a, b) => a >> (b & 31)),

    // ---- 即値との演算 ----
    I('ADDI', 0x10, '即値加算', 'rd ← rs + imm', (a, i) => a + i),
    I('ANDI', 0x11, '即値ビット積', 'rd ← rs & imm (ゼロ拡張)', (a, i) => a & i, UIMM16),
    I('ORI', 0x12, '即値ビット和', 'rd ← rs | imm (ゼロ拡張)', (a, i) => a | i, UIMM16),
    I('XORI', 0x13, '即値排他的論理和', 'rd ← rs ^ imm (ゼロ拡張)', (a, i) => a ^ i, UIMM16),
    I('SLTI', 0x14, '即値と符号付き比較', 'rd ← (rs < imm) ? 1 : 0', (a, i) => (a < i ? 1 : 0)),
    I('SLTIU', 0x15, '即値と符号なし比較', 'rd ← (rs <ᵤ imm) ? 1 : 0', (a, i) => (u(a) < u(i) ? 1 : 0)),
    I('SLLI', 0x16, '即値左シフト', 'rd ← rs << imm', (a, i) => a << i, SHAMT),
    I('SRLI', 0x17, '即値論理右シフト', 'rd ← rs >>> imm', (a, i) => a >>> i, SHAMT),
    I('SRAI', 0x18, '即値算術右シフト', 'rd ← rs >> imm', (a, i) => a >> i, SHAMT),
    { mnemonic: 'LUI', opcode: 0x19, format: 'I', operands: 'rd, imm', class: 'alu', imm: UIMM16, reads: [],
      name: '上位即値ロード', summary: 'rd ← imm << 16', exec: c => c.write(c.imm << 16) },

    // ---- ロード / ストア ----
    { mnemonic: 'LW', opcode: 0x20, format: 'I', operands: 'rd, mem', class: 'load',
      name: 'ワード読み出し', summary: 'rd ← M32[rs + imm]', exec: c => c.write(c.load(c.addr(), 4)) },
    { mnemonic: 'LB', opcode: 0x21, format: 'I', operands: 'rd, mem', class: 'load',
      name: 'バイト読み出し (符号拡張)', summary: 'rd ← sext(M8[rs + imm])', exec: c => c.write(c.load(c.addr(), 1, true)) },
    { mnemonic: 'LBU', opcode: 0x22, format: 'I', operands: 'rd, mem', class: 'load',
      name: 'バイト読み出し (ゼロ拡張)', summary: 'rd ← M8[rs + imm]', exec: c => c.write(c.load(c.addr(), 1, false)) },
    { mnemonic: 'SW', opcode: 0x24, format: 'S', operands: 'rt, mem', class: 'store',
      name: 'ワード書き込み', summary: 'M32[rs + imm] ← rt', exec: c => c.store(c.addr(), 4, c.b) },
    { mnemonic: 'SB', opcode: 0x25, format: 'S', operands: 'rt, mem', class: 'store',
      name: 'バイト書き込み', summary: 'M8[rs + imm] ← rt & 0xFF', exec: c => c.store(c.addr(), 1, c.b) },

    // ---- 分岐 (PC+1 からの相対) ----
    B('BEQ', 0x28, '等しければ分岐', 'if rs = rt: PC ← label', (a, b) => a === b),
    B('BNE', 0x29, '等しくなければ分岐', 'if rs ≠ rt: PC ← label', (a, b) => a !== b),
    B('BLT', 0x2a, '小さければ分岐', 'if rs < rt: PC ← label', (a, b) => a < b),
    B('BGE', 0x2b, '以上なら分岐', 'if rs ≥ rt: PC ← label', (a, b) => a >= b),
    B('BLTU', 0x2c, '小さければ分岐 (符号なし)', 'if rs <ᵤ rt: PC ← label', (a, b) => u(a) < u(b)),
    B('BGEU', 0x2d, '以上なら分岐 (符号なし)', 'if rs ≥ᵤ rt: PC ← label', (a, b) => u(a) >= u(b)),

    // ---- ジャンプ ----
    { mnemonic: 'JAL', opcode: 0x30, format: 'J', operands: 'rd, label', class: 'jump',
      name: 'ジャンプして戻り先を保存', summary: 'rd ← PC + 1; PC ← label',
      exec: c => { c.write(c.pc + 1); c.jump(c.ins.target); } },
    { mnemonic: 'JALR', opcode: 0x31, format: 'I', operands: 'rd, rs, imm', class: 'jump',
      name: 'レジスタ間接ジャンプ', summary: 'rd ← PC + 1; PC ← rs + imm',
      exec: c => { const t = (c.a + c.imm) | 0; c.write(c.pc + 1); c.jump(t); } },

    // ---- システム ----
    { mnemonic: 'HALT', opcode: 0x3f, format: 'N', operands: '', class: 'system',
      name: '停止', summary: 'このコアを停止する', exec: c => c.halt() },
  ],

  // 疑似命令: アセンブラが本物の命令に置き換える
  pseudos: [
    { mnemonic: 'NOP', operands: '', summary: 'ADDI r0, r0, 0', description: '何もしない',
      expand: () => [{ op: 'ADDI', rd: 0, rs: 0, imm: 0 }] },
    { mnemonic: 'LI', operands: 'rd, imm', summary: 'ADDI rd, r0, imm / ORI rd, r0, imm / LUI (+ ORI)',
      description: '32ビット定数を読み込む。16ビットに収まらないときは2命令になる',
      size: o => liExpand(o.rd, o.imm).length,
      expand: o => liExpand(o.rd, o.imm) },
    { mnemonic: 'LA', operands: 'rd, imm', summary: 'LI と同じ', description: 'ラベルの番地を読み込む (LI の別名)',
      size: o => liExpand(o.rd, o.imm).length,
      expand: o => liExpand(o.rd, o.imm) },
    { mnemonic: 'MOV', operands: 'rd, rs', summary: 'ADDI rd, rs, 0', description: 'レジスタをコピーする',
      expand: o => [{ op: 'ADDI', rd: o.rd, rs: o.rs, imm: 0 }] },
    { mnemonic: 'NEG', operands: 'rd, rs', summary: 'SUB rd, r0, rs', description: '符号を反転する',
      expand: o => [{ op: 'SUB', rd: o.rd, rs: 0, rt: o.rs }] },
    { mnemonic: 'SUBI', operands: 'rd, rs, imm', summary: 'ADDI rd, rs, −imm', description: '即値を引く',
      expand: o => [{ op: 'ADDI', rd: o.rd, rs: o.rs, imm: -o.imm }] },
    { mnemonic: 'BEQZ', operands: 'rs, label', summary: 'BEQ rs, r0, label', description: '0 なら分岐',
      expand: o => [{ op: 'BEQ', rs: o.rs, rt: 0, target: o.target }] },
    { mnemonic: 'BNEZ', operands: 'rs, label', summary: 'BNE rs, r0, label', description: '0 でなければ分岐',
      expand: o => [{ op: 'BNE', rs: o.rs, rt: 0, target: o.target }] },
    { mnemonic: 'BGT', operands: 'rs, rt, label', summary: 'BLT rt, rs, label', description: 'rs > rt なら分岐',
      expand: o => [{ op: 'BLT', rs: o.rt, rt: o.rs, target: o.target }] },
    { mnemonic: 'BLE', operands: 'rs, rt, label', summary: 'BGE rt, rs, label', description: 'rs ≤ rt なら分岐',
      expand: o => [{ op: 'BGE', rs: o.rt, rt: o.rs, target: o.target }] },
    { mnemonic: 'BGTU', operands: 'rs, rt, label', summary: 'BLTU rt, rs, label', description: 'rs > rt なら分岐 (符号なし)',
      expand: o => [{ op: 'BLTU', rs: o.rt, rt: o.rs, target: o.target }] },
    { mnemonic: 'BLEU', operands: 'rs, rt, label', summary: 'BGEU rt, rs, label', description: 'rs ≤ rt なら分岐 (符号なし)',
      expand: o => [{ op: 'BGEU', rs: o.rt, rt: o.rs, target: o.target }] },
    { mnemonic: 'J', operands: 'label', summary: 'JAL r0, label', description: '無条件ジャンプ',
      expand: o => [{ op: 'JAL', rd: 0, target: o.target }] },
    { mnemonic: 'JR', operands: 'rs', summary: 'JALR r0, rs, 0', description: 'レジスタの番地へジャンプ',
      expand: o => [{ op: 'JALR', rd: 0, rs: o.rs, imm: 0 }] },
    { mnemonic: 'CALL', operands: 'label', summary: 'JAL r15, label', description: 'サブルーチン呼び出し (戻り先は r15)',
      expand: o => [{ op: 'JAL', rd: 15, target: o.target }] },
    { mnemonic: 'RET', operands: '', summary: 'JALR r0, r15, 0', description: 'サブルーチンから戻る',
      expand: () => [{ op: 'JALR', rd: 0, rs: 15, imm: 0 }] },
  ],
});

function fits16(v) { return v >= -32768 && v <= 32767; }
function liExpand(rd, v) {
  v |= 0;
  if (fits16(v)) return [{ op: 'ADDI', rd, rs: 0, imm: v }];
  const hi = (v >>> 16) & 0xffff, lo = v & 0xffff;
  if (hi === 0) return [{ op: 'ORI', rd, rs: 0, imm: lo }]; // 32768〜65535
  const out = [{ op: 'LUI', rd, imm: hi }];
  if (lo) out.push({ op: 'ORI', rd, rs: rd, imm: lo });
  return out;
}
