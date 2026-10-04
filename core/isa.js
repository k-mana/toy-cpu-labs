// TOY ISA — 命令セットの登録・符号化・逆アセンブル
//
// 命令セットは「拡張」の集まりとして組み立てる。基本整数命令 (I) に、
// 乗除算 (M)・アトミック (A)・独自拡張 (X…) を足していく。
// 仕様: docs/isa.md

export const NUM_REGS = 16;
export const REG_ZERO = 0;
export const REG_LINK = 15; // CALL / RET が使うリンクレジスタ (慣習)

/* ------------------------------------------------------------------ *
 * 命令形式
 *
 *  31      24 23  20 19  16 15  12 11                    0
 *  ┌────────┬──────┬──────┬──────┬───────────────────────┐
 *  │ opcode │  rd  │  rs  │  rt  │          0            │  R
 *  │ opcode │  rd  │  rs  │       imm16                  │  I
 *  │ opcode │  rt  │  rs  │       imm16                  │  S  (ストア: rt を書く)
 *  │ opcode │  rs  │  rt  │       off16 (PC+1 からの相対)  │  B
 *  │ opcode │  rd  │          target20 (絶対)            │  J
 *  │ opcode │  rd  │  rs  │  rt  │       imm12           │  A  (アトミック)
 *  │ opcode │                  0                         │  N
 *  └────────┴──────┴──────┴──────┴───────────────────────┘
 * ------------------------------------------------------------------ */
export const FORMATS = {
  R: { fields: ['rd', 'rs', 'rt'], imm: null },
  I: { fields: ['rd', 'rs'], imm: { bits: 16, signed: true } },
  S: { fields: ['rt', 'rs'], imm: { bits: 16, signed: true } },
  B: { fields: ['rs', 'rt'], imm: { bits: 16, signed: true, relative: true } },
  J: { fields: ['rd'], imm: { bits: 20, signed: false, absolute: true } },
  A: { fields: ['rd', 'rs', 'rt'], imm: { bits: 12, signed: true } },
  N: { fields: [], imm: null },
};

// オペランド記法 → どのフィールドを埋めるか
//   rd rs rt : レジスタ
//   imm      : 即値 (式)
//   mem      : off(rs) 形式のメモリオペランド → imm と rs
//   label    : 分岐・ジャンプ先 → target
export const OPERAND_KINDS = ['rd', 'rs', 'rt', 'imm', 'mem', 'label'];

// 命令の分類。タイミングモデルはこの分類で振る舞いを決める。
export const CLASSES = ['alu', 'mul', 'div', 'load', 'store', 'rmw', 'branch', 'jump', 'system'];

// 拡張ごとに使ってよいオペコードの範囲 (衝突を防ぐため)
export const OPCODE_RANGES = {
  I: [0x01, 0x3f],
  M: [0x40, 0x4f],
  A: [0x50, 0x5f],
  X: [0xc0, 0xff], // 独自拡張 (名前が X で始まるもの)
};

const DEFAULT_READS = { R: ['rs', 'rt'], I: ['rs'], S: ['rs', 'rt'], B: ['rs', 'rt'], J: [], A: ['rs', 'rt'], N: [] };
const DEFAULT_WRITES = { R: ['rd'], I: ['rd'], S: [], B: [], J: ['rd'], A: ['rd'], N: [] };

function rangeFor(ext) {
  if (OPCODE_RANGES[ext]) return OPCODE_RANGES[ext];
  if (/^X/.test(ext)) return OPCODE_RANGES.X;
  return null;
}

/**
 * 拡張を定義する。中身を検証して、そのまま返す。
 * @param {object} spec  { name, title, description, instructions:[…], pseudos:[…], prefixes:[…] }
 */
export function defineExtension(spec) {
  if (!spec || typeof spec.name !== 'string' || !spec.name) throw new Error('拡張には name が必要です');
  const range = rangeFor(spec.name);
  const seen = new Set();
  for (const d of spec.instructions || []) {
    const where = `${spec.name}.${d.mnemonic}`;
    if (!/^[A-Z][A-Z0-9.]*$/.test(d.mnemonic || '')) throw new Error(`${where}: ニーモニックは英大文字で書きます`);
    if (seen.has(d.mnemonic)) throw new Error(`${where}: 同じ拡張の中で重複しています`);
    seen.add(d.mnemonic);
    if (!FORMATS[d.format]) throw new Error(`${where}: 形式 ${d.format} は未定義です`);
    if (!Number.isInteger(d.opcode) || d.opcode < 1 || d.opcode > 0xff) throw new Error(`${where}: オペコードは 1〜255 です`);
    if (range && (d.opcode < range[0] || d.opcode > range[1]))
      throw new Error(`${where}: 拡張 ${spec.name} のオペコードは 0x${range[0].toString(16)}〜0x${range[1].toString(16)} です`);
    if (!CLASSES.includes(d.class)) throw new Error(`${where}: 分類 ${d.class} は未定義です (${CLASSES.join(', ')})`);
    if (!d.exec && !(Array.isArray(d.uops) && d.uops.length)) throw new Error(`${where}: exec か uops が必要です`);
    for (const tok of parseOperandSpec(d.operands)) {
      if (!OPERAND_KINDS.includes(tok)) throw new Error(`${where}: オペランド記法「${tok}」は未定義です`);
    }
  }
  for (const p of spec.pseudos || []) {
    if (!p.mnemonic || typeof p.expand !== 'function') throw new Error(`${spec.name}: 疑似命令には mnemonic と expand が必要です`);
  }
  return spec;
}

export function parseOperandSpec(s) {
  return (s || '').split(',').map(x => x.trim()).filter(Boolean);
}

/**
 * 拡張の配列から命令セットを組み立てる。
 * @param {object[]} extensions  defineExtension で作った拡張 (先頭は基本命令 I を推奨)
 */
export function createISA(extensions) {
  const defs = new Map();
  const byOpcode = new Map();
  const pseudos = new Map();
  const prefixes = new Map(); // 接頭辞 → 付けられる命令の集合
  const exts = [];
  for (const ext of extensions) {
    defineExtension(ext);
    if (exts.some(e => e.name === ext.name)) throw new Error(`拡張 ${ext.name} が二重に指定されています`);
    exts.push(ext);
    for (const raw of ext.instructions || []) {
      if (defs.has(raw.mnemonic) || pseudos.has(raw.mnemonic)) throw new Error(`命令 ${raw.mnemonic} が複数の拡張で定義されています`);
      if (byOpcode.has(raw.opcode)) throw new Error(`オペコード 0x${raw.opcode.toString(16)} が ${byOpcode.get(raw.opcode).mnemonic} と ${raw.mnemonic} で衝突しています`);
      const f = FORMATS[raw.format];
      const def = Object.freeze({
        ...raw,
        ext: ext.name,
        operandList: parseOperandSpec(raw.operands),
        reads: raw.reads || DEFAULT_READS[raw.format],
        writes: raw.writes || DEFAULT_WRITES[raw.format],
        imm: raw.imm === undefined ? f.imm : raw.imm && { ...f.imm, ...raw.imm },
        uopCount: raw.uops ? raw.uops.length : 1,
        prefixes: raw.prefixes || [],
      });
      defs.set(def.mnemonic, def);
      byOpcode.set(def.opcode, def);
      for (const p of def.prefixes) {
        if (!prefixes.has(p)) prefixes.set(p, new Set());
        prefixes.get(p).add(def.mnemonic);
      }
    }
    for (const p of ext.pseudos || []) {
      if (defs.has(p.mnemonic) || pseudos.has(p.mnemonic)) throw new Error(`疑似命令 ${p.mnemonic} が他の命令と重複しています`);
      pseudos.set(p.mnemonic, { ...p, ext: ext.name, operandList: parseOperandSpec(p.operands) });
    }
  }
  const isa = {
    extensions: exts,
    name: 'TOY-' + exts.map(e => e.name).join(''),
    defs, byOpcode, pseudos, prefixes,
    def: m => defs.get(String(m).toUpperCase()),
    pseudo: m => pseudos.get(String(m).toUpperCase()),
    encode: ins => encode(ins),
    decode: word => decode(word, isa),
    disassemble: (ins, labelOf) => disassemble(ins, labelOf),
  };
  return isa;
}

/* ------------------------------ 即値の範囲 ------------------------------ */

export function immRange(spec) {
  if (!spec) return null;
  if (spec.min !== undefined) return [spec.min, spec.max];
  return spec.signed ? [-(2 ** (spec.bits - 1)), 2 ** (spec.bits - 1) - 1] : [0, 2 ** spec.bits - 1];
}

/* ------------------------------ 符号化 ------------------------------ */

const mask = bits => (bits >= 32 ? 0xffffffff : (1 << bits) - 1);

/** 命令オブジェクト (アセンブラの出力) → 32ビットの機械語 */
export function encode(ins) {
  const d = ins.def;
  let w = (d.opcode & 0xff) << 24;
  const reg = n => (n ?? 0) & 0xf;
  switch (d.format) {
    case 'R': w |= reg(ins.rd) << 20 | reg(ins.rs) << 16 | reg(ins.rt) << 12; break;
    case 'I': w |= reg(ins.rd) << 20 | reg(ins.rs) << 16 | (ins.imm & 0xffff); break;
    case 'S': w |= reg(ins.rt) << 20 | reg(ins.rs) << 16 | (ins.imm & 0xffff); break;
    case 'B': w |= reg(ins.rs) << 20 | reg(ins.rt) << 16 | ((ins.target - (ins.index + 1)) & 0xffff); break;
    case 'J': w |= reg(ins.rd) << 20 | (ins.target & 0xfffff); break;
    case 'A': w |= reg(ins.rd) << 20 | reg(ins.rs) << 16 | reg(ins.rt) << 12 | (ins.imm & 0xfff); break;
    case 'N': break;
  }
  return w >>> 0;
}

const sext = (v, bits) => (v << (32 - bits)) >> (32 - bits);

/** 32ビットの機械語 → 命令オブジェクト (index を渡すと分岐先を絶対位置に直す) */
export function decode(word, isa, index = 0) {
  const op = word >>> 24;
  const d = isa.byOpcode.get(op);
  if (!d) return null;
  const a = (word >>> 20) & 0xf, b = (word >>> 16) & 0xf, c = (word >>> 12) & 0xf;
  const ins = { op: d.mnemonic, def: d, index, rd: 0, rs: 0, rt: 0, imm: 0, target: null };
  const immOf = bits => (d.imm && !d.imm.signed ? word & mask(bits) : sext(word & mask(bits), bits));
  switch (d.format) {
    case 'R': ins.rd = a; ins.rs = b; ins.rt = c; break;
    case 'I': ins.rd = a; ins.rs = b; ins.imm = immOf(16); break;
    case 'S': ins.rt = a; ins.rs = b; ins.imm = immOf(16); break;
    case 'B': ins.rs = a; ins.rt = b; ins.target = index + 1 + sext(word & 0xffff, 16); break;
    case 'J': ins.rd = a; ins.target = word & 0xfffff; break;
    case 'A': ins.rd = a; ins.rs = b; ins.rt = c; ins.imm = sext(word & 0xfff, 12); break;
  }
  return ins;
}

/* ---------------------------- 逆アセンブル ---------------------------- */

export const regName = n => 'r' + n;

/** 命令オブジェクト → 正規化したアセンブリ表記 (例: "ADD r1, r2, r3") */
export function disassemble(ins, labelOf) {
  const d = ins.def;
  if (d.mnemonic === 'ADDI' && ins.rd === 0 && ins.rs === 0 && ins.imm === 0) return 'NOP';
  const parts = d.operandList.map(k => {
    switch (k) {
      case 'rd': return regName(ins.rd);
      case 'rs': return regName(ins.rs);
      case 'rt': return regName(ins.rt);
      case 'imm': return String(ins.imm);
      case 'mem': return `${ins.imm}(${regName(ins.rs)})`;
      case 'label': return (labelOf && labelOf(ins.target)) ?? String(ins.target);
    }
    return '?';
  });
  const pre = ins.lock ? 'LOCK ' : '';
  return pre + d.mnemonic + (parts.length ? ' ' + parts.join(', ') : '');
}

/** 機械語を 0x01234567 形式で */
export const hexWord = w => '0x' + (w >>> 0).toString(16).toUpperCase().padStart(8, '0');
