// 命令セット一覧を、コアの命令定義そのものから作る
import { createISA, BASE, MULDIV, ATOMIC, XMRMW, FORMATS, immRange, decode, disassemble } from '../core/index.js';

const isa = createISA([BASE, MULDIV, ATOMIC, XMRMW]);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hex2 = n => '0x' + n.toString(16).toUpperCase().padStart(2, '0');
const CLASS_JP = { alu: '演算', mul: '乗算', div: '除算', load: 'ロード', store: 'ストア', rmw: 'メモリ読み書き', branch: '分岐', jump: 'ジャンプ', system: 'システム' };
const COLOR = { I: '--I', M: '--M', A: '--A' };

const LAYOUT = {
  R: [['opcode', 8, 1], ['rd', 4], ['rs', 4], ['rt', 4], ['0', 12, 1]],
  I: [['opcode', 8, 1], ['rd', 4], ['rs', 4], ['imm16', 16]],
  S: [['opcode', 8, 1], ['rt', 4], ['rs', 4], ['imm16', 16]],
  B: [['opcode', 8, 1], ['rs', 4], ['rt', 4], ['off16 (PC+1 から)', 16]],
  J: [['opcode', 8, 1], ['rd', 4], ['target20', 20]],
  A: [['opcode', 8, 1], ['rd', 4], ['rs', 4], ['rt', 4], ['imm12', 12]],
  N: [['opcode', 8, 1], ['0', 24, 1]],
};
$('formats').innerHTML = Object.keys(FORMATS).map(f => `<b>${f}</b><div class="bits">${LAYOUT[f].map(([n, w, o]) => `<span class="${o ? 'o' : ''}" style="flex:${w}">${n}<br><small>${w}</small></span>`).join('')}</div>`).join('');

const opText = d => d.operandList.map(k => (k === 'mem' ? 'off(rs)' : k)).join(', ');
const immText = d => {
  if (!d.imm) return '';
  if (d.imm.relative) return '±32767 命令';
  if (d.imm.absolute) return '0〜1048575';
  const r = immRange(d.imm);
  return `${r[0]}〜${r[1]}`;
};

$('exts').innerHTML = isa.extensions.map(ext => {
  const c = COLOR[ext.name] || '--X';
  const rows = (ext.instructions || []).map(d0 => {
    const d = isa.defs.get(d0.mnemonic);
    const tags = [CLASS_JP[d.class], d.atomic && '不可分', d.uops && `${d.uops.length} μop`, d.prefixes.length && `接頭辞 ${d.prefixes.join('/')}`].filter(Boolean);
    return `<tr><td class="mn">${d.mnemonic}</td><td class="op">${esc(opText(d))}</td><td>${esc(d.name)}</td><td class="sum">${esc(d.summary)}</td>
      <td>${d.format}</td><td class="hex">${hex2(d.opcode)}</td><td class="op">${esc(immText(d))}</td><td>${tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</td></tr>`;
  }).join('');
  const pseudo = (ext.pseudos || []).map(p0 => isa.pseudos.get(p0.mnemonic)).map(p => `<tr><td class="mn">${p.mnemonic}</td><td class="op">${esc(p.operandList.map(k => (k === 'mem' ? 'off(rs)' : k)).join(', '))}</td><td>${esc(p.description)}</td><td class="sum">${esc(p.summary)}</td></tr>`).join('');
  return `<h2 id="ext-${ext.name}"><span class="chip" style="--c:var(${c})">${ext.name}</span>${esc(ext.title)}</h2>
    <p>${esc(ext.description)}</p>
    <div class="tbl"><table><thead><tr><th>命令</th><th>オペランド</th><th>名前</th><th>動作</th><th>形式</th><th>オペコード</th><th>即値の範囲</th><th>分類</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${pseudo ? `<h3>疑似命令 (アセンブラが本物の命令に置き換える)</h3><div class="tbl"><table><thead><tr><th>疑似命令</th><th>オペランド</th><th>意味</th><th>置き換え先</th></tr></thead><tbody>${pseudo}</tbody></table></div>` : ''}`;
}).join('');

function showDecode() {
  const s = $('word').value.trim();
  const w = /^0x[0-9a-f]{1,8}$/i.test(s) ? parseInt(s, 16) : /^\d+$/.test(s) ? Number(s) >>> 0 : NaN;
  if (!Number.isFinite(w)) { $('dis').textContent = '16進数 (0x…) で入力してください'; return; }
  const ins = decode(w >>> 0, isa, 0);
  $('dis').textContent = ins ? disassemble(ins) + (ins.def.format === 'B' ? '  (命令 0 にあるとき)' : '') : '定義されていないオペコード';
}
$('word').addEventListener('input', showDecode);
showDecode();
