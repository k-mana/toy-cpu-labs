// TOY アセンブラ
// 仕様: docs/assembly.md
//
//   const { program, errors } = assemble(source, { isa });
//   errors: [{ line, message }]  (行番号は1始まり。エラーがあれば program は null)

import { encode, disassemble, immRange, NUM_REGS } from './isa.js';

const MAX_INSTRS = 1 << 20;

export class AsmError extends Error {
  constructor(line, message) { super(message); this.line = line; }
}

/* ------------------------------ 字句 ------------------------------ */

function stripComment(s) {
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") q = !q;
    else if (!q && (ch === ';' || ch === '#')) return s.slice(0, i);
  }
  return s;
}

function splitArgs(s) {
  const out = [];
  let depth = 0, q = false, cur = '';
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (!q && ch === '(') depth++;
    if (!q && ch === ')') depth--;
    if (!q && depth === 0 && ch === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() || out.length) out.push(cur.trim());
  return out;
}

const REG_RE = /^r(\d{1,2})$/i;
const SYM_RE = /^[A-Za-z_.$][\w.$]*$/;
const LABEL_RE = /^([A-Za-z_.$][\w.$]*)\s*:/;

function parseReg(s) {
  const m = REG_RE.exec(s.trim());
  if (!m || +m[1] >= NUM_REGS) throw new Error(`レジスタ「${s}」は r0〜r${NUM_REGS - 1} で書きます`);
  return +m[1];
}

/* ------------------------------ 式 ------------------------------ */
// 式 := 項 (('+'|'-') 項)*      項 := 因子 ('*' 因子)*
// 因子 := 数 | 記号 | '(' 式 ')' | '-' 因子
// 数   := 123  0x7F  0b1010  'A'

const TOKEN_RE = /\s*(0x[0-9a-f]+|0b[01]+|\d+|'(?:\\.|[^'\\])'|[A-Za-z_.$][\w.$]*|[-+*()])/iy;

function tokenize(s) {
  const toks = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while (TOKEN_RE.lastIndex < s.length) {
    const at = TOKEN_RE.lastIndex;
    if (/^\s*$/.test(s.slice(at))) break;
    m = TOKEN_RE.exec(s);
    if (!m) throw new Error(`「${s.slice(at).trim()}」を数や記号として読めません`);
    toks.push(m[1]);
  }
  return toks;
}

function parseExpr(text) {
  const src = text.trim();
  if (!src) throw new Error('値がありません');
  const t = tokenize(src);
  let i = 0;
  const peek = () => t[i];
  const factor = () => {
    const k = t[i++];
    if (k === undefined) throw new Error(`式「${src}」が途中で終わっています`);
    if (k === '-') return { neg: factor() };
    if (k === '+') return factor();
    if (k === '(') { const e = sum(); if (t[i++] !== ')') throw new Error(`式「${src}」の括弧が閉じていません`); return e; }
    if (/^0x/i.test(k)) return { num: parseInt(k.slice(2), 16) };
    if (/^0b/i.test(k)) return { num: parseInt(k.slice(2), 2) };
    if (/^\d/.test(k)) return { num: parseInt(k, 10) };
    if (k[0] === "'") { const body = k.slice(1, -1); return { num: (body[0] === '\\' ? ({ n: 10, t: 9, 0: 0 }[body[1]] ?? body.charCodeAt(1)) : body.charCodeAt(0)) }; }
    if (SYM_RE.test(k)) {
      if (REG_RE.test(k) && +REG_RE.exec(k)[1] < NUM_REGS) throw new Error(`ここにはレジスタ「${k}」ではなく数やラベルを書きます`);
      return { sym: k };
    }
    throw new Error(`式「${src}」に「${k}」は使えません`);
  };
  const product = () => { let e = factor(); while (peek() === '*') { i++; e = { mul: [e, factor()] }; } return e; };
  const sum = () => {
    let e = product();
    while (peek() === '+' || peek() === '-') { const op = t[i++]; const r = product(); e = op === '+' ? { add: [e, r] } : { sub: [e, r] }; }
    return e;
  };
  const e = sum();
  if (i < t.length) throw new Error(`式「${src}」の「${t[i]}」以降が読めません`);
  e.text = src;
  return e;
}

function evalExpr(e, lookup) {
  if ('num' in e) return e.num;
  if ('sym' in e) return lookup(e.sym);
  if ('neg' in e) return -evalExpr(e.neg, lookup);
  if ('add' in e) return evalExpr(e.add[0], lookup) + evalExpr(e.add[1], lookup);
  if ('sub' in e) return evalExpr(e.sub[0], lookup) - evalExpr(e.sub[1], lookup);
  if ('mul' in e) return evalExpr(e.mul[0], lookup) * evalExpr(e.mul[1], lookup);
  throw new Error('式を評価できません');
}

/* --------------------------- オペランド --------------------------- */

function parseOperand(kind, text) {
  const s = text.trim();
  if (!s) throw new Error('オペランドが空です');
  switch (kind) {
    case 'rd': case 'rs': case 'rt': return { kind, reg: parseReg(s) };
    case 'imm': case 'label': return { kind, expr: parseExpr(s) };
    case 'mem': {
      const m = /^(.*?)\(\s*([^()]*?)\s*\)$/.exec(s);
      if (m) return { kind, base: parseReg(m[2]), off: m[1].trim() ? parseExpr(m[1]) : { num: 0, text: '0' } };
      return { kind, base: 0, off: parseExpr(s) }; // 絶対番地 (r0 基準)
    }
  }
  throw new Error(`オペランド種別 ${kind} は未定義です`);
}

const KIND_JP = { rd: 'レジスタ', rs: 'レジスタ', rt: 'レジスタ', imm: '数', mem: 'off(rs)', label: 'ラベル' };

/* ---------------------------- 本体 ---------------------------- */

/**
 * @param {string} source
 * @param {{isa: object, dataBase?: number, symbols?: Object<string, number>}} opts
 * @returns {{program: Program|null, errors: {line:number, message:string}[]}}
 */
export function assemble(source, opts = {}) {
  const isa = opts.isa;
  if (!isa) throw new Error('assemble には { isa } が必要です');
  const errors = [];
  const err = (line, message) => errors.push({ line, message });
  const rows = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');

  /* ---- 1. 構文解析 ---- */
  const items = [];
  let section = 'text';
  const regionStack = [];
  rows.forEach((raw, idx) => {
    const line = idx + 1;
    let s = stripComment(raw).trim();
    try {
      let m;
      while ((m = LABEL_RE.exec(s))) {
        const name = m[1];
        if (REG_RE.test(name)) throw new Error(`「${name}」はレジスタ名なのでラベルに使えません`);
        items.push({ type: 'label', line, name, section });
        s = s.slice(m[0].length).trim();
      }
      if (!s) return;
      if (s[0] === '.') {
        const sp = s.search(/\s/);
        const dir = (sp < 0 ? s : s.slice(0, sp)).toLowerCase();
        const rest = sp < 0 ? '' : s.slice(sp).trim();
        const args = rest ? splitArgs(rest) : [];
        switch (dir) {
          case '.text': case '.data': section = dir.slice(1); return;
          case '.org': case '.align': case '.space':
            if (section !== 'data') throw new Error(`${dir} は .data セクションで使います`);
            if (args.length < 1 || args.length > (dir === '.space' ? 2 : 1)) throw new Error(`${dir} の引数の数が違います`);
            items.push({ type: dir, line, section, exprs: args.map(parseExpr) }); return;
          case '.word': case '.byte':
            if (section !== 'data') throw new Error(`${dir} は .data セクションで使います`);
            if (!args.length) throw new Error(`${dir} に値がありません`);
            items.push({ type: dir, line, section, exprs: args.map(parseExpr) }); return;
          case '.equ': {
            if (args.length !== 2 || !SYM_RE.test(args[0])) throw new Error('.equ は「.equ 名前, 値」の形で書きます');
            items.push({ type: 'equ', line, name: args[0], expr: parseExpr(args[1]) }); return;
          }
          case '.region':
            if (args.length !== 1 || !SYM_RE.test(args[0])) throw new Error('.region には名前を1つ書きます');
            regionStack.push({ name: args[0], line }); return;
          case '.endregion':
            if (!regionStack.length) throw new Error('対応する .region がありません');
            regionStack.pop(); return;
          default: throw new Error(`疑似命令「${dir}」は使えません`);
        }
      }
      if (section !== 'text') throw new Error('命令は .text セクションに書きます (.data の後なら .text で戻る)');
      // 接頭辞 (例: LOCK)
      let sp = s.search(/\s/);
      let mn = (sp < 0 ? s : s.slice(0, sp)).toUpperCase();
      let rest = sp < 0 ? '' : s.slice(sp).trim();
      let prefix = null;
      if (isa.prefixes.has(mn)) {
        prefix = mn;
        sp = rest.search(/\s/);
        mn = (sp < 0 ? rest : rest.slice(0, sp)).toUpperCase();
        rest = sp < 0 ? '' : rest.slice(sp).trim();
        if (!mn) throw new Error(`${prefix} の後に命令が必要です`);
        if (!isa.prefixes.get(prefix).has(mn)) throw new Error(`${prefix} は ${[...isa.prefixes.get(prefix)].join(', ')} にだけ付けられます`);
      }
      const def = isa.defs.get(mn), pseudo = !def && isa.pseudos.get(mn);
      if (!def && !pseudo) throw new Error(`命令「${mn}」は ${isa.name} にありません`);
      const kinds = (def || pseudo).operandList;
      const args = rest ? splitArgs(rest) : [];
      if (args.length !== kinds.length) {
        const form = kinds.length ? `${mn} ${kinds.map(k => k === 'mem' ? 'off(rs)' : k).join(', ')}` : mn;
        throw new Error(`${mn} のオペランドは ${kinds.length} 個です (${form})`);
      }
      const ops = kinds.map((k, i) => {
        try { return parseOperand(k, args[i]); }
        catch (e) { throw new Error(`${mn} の第${i + 1}オペランド (${KIND_JP[k]}): ${e.message}`); }
      });
      items.push({ type: 'ins', line, mn, def, pseudo, ops, prefix, text: s, regions: regionStack.map(r => r.name) });
    } catch (e) {
      err(line, e.message);
    }
  });
  for (const r of regionStack) err(r.line, `.region ${r.name} が .endregion で閉じられていません`);

  /* ---- 記号表 ---- */
  const symbols = new Map(); // name → { value, section, line }
  const equs = new Map();    // name → { expr, line }
  const define = (name, value, sec, line) => {
    if (symbols.has(name) || equs.has(name)) { err(line, `ラベル「${name}」が二重に定義されています (${(symbols.get(name) || equs.get(name)).line}行目)`); return; }
    symbols.set(name, { value, section: sec, line });
  };
  // 呼び出し側が与える記号 (例: { counter: 0, lock: 4 })。プログラムの .equ で上書きはできない
  for (const [name, value] of Object.entries(opts.symbols || {})) equs.set(name, { expr: { num: value }, value, line: 0, predefined: true });
  for (const it of items) if (it.type === 'equ') {
    if (equs.has(it.name)) err(it.line, `「${it.name}」が二重に定義されています`);
    else equs.set(it.name, { expr: it.expr, line: it.line });
  }
  const resolving = new Set();
  const lookupWith = textFallback => name => {
    if (symbols.has(name)) return symbols.get(name).value;
    if (equs.has(name)) {
      const q = equs.get(name);
      if (q.value !== undefined) return q.value;
      if (resolving.has(name)) throw new Error(`.equ ${name} が自分自身を参照しています`);
      resolving.add(name);
      try { const v = evalExpr(q.expr, lookupWith(textFallback)); if (!textFallback) q.value = v; return v; }
      finally { resolving.delete(name); }
    }
    if (textFallback && pendingText.has(name)) return 0;
    throw new Error(`ラベル「${name}」が見つかりません`);
  };
  const pendingText = new Set(items.filter(i => i.type === 'label' && i.section === 'text').map(i => i.name));

  /* ---- 2. データの配置 ---- */
  const dataBase = opts.dataBase ?? 0;
  let loc = dataBase;
  const dataItems = [];
  for (const it of items) {
    if (it.section !== 'data') continue;
    try {
      if (it.type === 'label') { define(it.name, loc, 'data', it.line); continue; }
      const val = e => evalExpr(e, lookupWith(true));
      switch (it.type) {
        case '.org': { const v = val(it.exprs[0]); if (v < 0) throw new Error('.org の番地は 0 以上です'); loc = v; break; }
        case '.align': { const n = val(it.exprs[0]); if (n < 1 || (n & (n - 1))) throw new Error('.align の値は 2 のべき乗です'); loc = Math.ceil(loc / n) * n; break; }
        case '.space': { const n = val(it.exprs[0]); if (n < 0) throw new Error('.space の大きさは 0 以上です'); dataItems.push({ ...it, addr: loc, size: 1, count: n, fill: it.exprs[1] }); loc += n; break; }
        case '.word':
          if (loc % 4) throw new Error(`.word は4の倍数の番地に置きます (いまは ${loc}。前に .align 4 を)`);
          dataItems.push({ ...it, addr: loc, size: 4 }); loc += 4 * it.exprs.length; break;
        case '.byte': dataItems.push({ ...it, addr: loc, size: 1 }); loc += it.exprs.length; break;
      }
    } catch (e) { err(it.line, e.message); }
  }

  /* ---- 3. 命令の配置 ---- */
  let pc = 0;
  for (const it of items) {
    if (it.section === 'data') continue;
    if (it.type === 'label') { define(it.name, pc, 'text', it.line); pendingText.delete(it.name); continue; }
    if (it.type !== 'ins') continue;
    it.index = pc;
    it.size = 1;
    if (it.pseudo && it.pseudo.size) {
      try { it.size = it.pseudo.size(operandValues(it, lookupWith(true))); }
      catch (e) { it.size = 1; } // 値の誤りは次の段階で報告する
    }
    pc += it.size;
  }
  const count = pc;
  if (count > MAX_INSTRS) err(1, `命令が多すぎます (${MAX_INSTRS} 個まで)`);

  /* ---- 4. 生成 ---- */
  const instrs = [];
  const labelAtIndex = new Map();
  for (const [name, s] of symbols) if (s.section === 'text' && !labelAtIndex.has(s.value)) labelAtIndex.set(s.value, name);
  const lookup = lookupWith(false);
  for (const it of items) {
    if (it.type !== 'ins') continue;
    try {
      const o = operandValues(it, lookup);
      const list = it.pseudo ? it.pseudo.expand(o) : [{ op: it.mn, ...o }];
      if (list.length !== it.size) throw new Error(`内部エラー: ${it.mn} の展開数が配置時と違います`);
      list.forEach((x, k) => {
        const def = isa.defs.get(x.op);
        if (!def) throw new Error(`内部エラー: 疑似命令が未知の命令 ${x.op} を生成しました`);
        const ins = {
          index: it.index + k, op: def.mnemonic, def,
          rd: x.rd ?? 0, rs: x.rs ?? 0, rt: x.rt ?? 0, imm: x.imm ?? 0, target: x.target ?? null,
          line: it.line, src: it.text, pseudo: it.pseudo ? it.pseudo.mnemonic : null,
          lock: it.prefix === 'LOCK', prefix: it.prefix, regions: it.regions,
        };
        checkFields(ins, count);
        ins.word = encode(ins);
        ins.text = disassemble(ins, t => labelAtIndex.get(t));
        instrs.push(ins);
      });
    } catch (e) { err(it.line, e.message); }
  }

  /* ---- 5. データの値 ---- */
  const chunks = [];
  for (const d of dataItems) {
    try {
      if (d.type === '.space') {
        const fill = d.fill ? evalExpr(d.fill, lookup) & 0xff : 0;
        chunks.push({ addr: d.addr, bytes: new Uint8Array(d.count).fill(fill), line: d.line });
        continue;
      }
      const bytes = new Uint8Array(d.exprs.length * d.size);
      const dv = new DataView(bytes.buffer);
      d.exprs.forEach((e, i) => {
        const v = evalExpr(e, lookup);
        if (d.size === 1) {
          if (v < -128 || v > 255) throw new Error(`.byte の値 ${v} は −128〜255 です`);
          bytes[i] = v & 0xff;
        } else {
          if (v < -2147483648 || v > 4294967295) throw new Error(`.word の値 ${v} は32ビットに収まりません`);
          dv.setInt32(i * 4, v | 0, true);
        }
      });
      chunks.push({ addr: d.addr, bytes, line: d.line });
    } catch (e) { err(d.line, e.message); }
  }

  if (errors.length) {
    errors.sort((a, b) => a.line - b.line);
    return { program: null, errors };
  }

  const lines = rows.map(text => ({ text, instrs: [] }));
  for (const ins of instrs) lines[ins.line - 1].instrs.push(ins.index);
  const labels = {};
  for (const [name, s] of symbols) labels[name] = { ...s };
  for (const [name, q] of equs) labels[name] = { value: lookup(name), section: q.predefined ? 'predefined' : 'equ', line: q.line };

  const program = {
    isa, source: String(source ?? ''), instrs, labels, data: chunks, lines,
    dataEnd: loc,
    labelAt: index => labelAtIndex.get(index) ?? null,
    symbol: name => (name in labels ? labels[name].value : undefined),
  };
  return { program, errors: [] };
}

function operandValues(it, lookup) {
  const o = {};
  it.ops.forEach(op => {
    switch (op.kind) {
      case 'rd': case 'rs': case 'rt': o[op.kind] = op.reg; break;
      case 'imm': o.imm = evalExpr(op.expr, lookup); break;
      case 'label': o.target = evalExpr(op.expr, lookup); break;
      case 'mem': o.rs = op.base; o.imm = evalExpr(op.off, lookup); break;
    }
  });
  return o;
}

function checkFields(ins, count) {
  const d = ins.def;
  if (d.operandList.includes('label') || ins.target !== null) {
    if (!Number.isInteger(ins.target) || ins.target < 0 || ins.target > count)
      throw new Error(`飛び先 ${ins.target} はプログラムの外です (0〜${count})`);
    const r = immRange(d.imm);
    if (d.imm && d.imm.relative) {
      const off = ins.target - (ins.index + 1);
      if (off < r[0] || off > r[1]) throw new Error(`分岐先が遠すぎます (${off} 命令。${r[0]}〜${r[1]})`);
    } else if (r && (ins.target < r[0] || ins.target > r[1])) throw new Error(`飛び先 ${ins.target} が範囲外です`);
    return;
  }
  const r = immRange(d.imm);
  if (r && (ins.imm < r[0] || ins.imm > r[1])) {
    const hint = d.mnemonic === "ADDI" || d.mnemonic === "ORI" ? "大きな定数は LI で読み込みます。" : "";
    throw new Error(`${d.mnemonic} の即値 ${ins.imm} は ${r[0]}〜${r[1]} の範囲で書きます。${hint}`);
  }
}
