/* 命令セット・ラボ — いちばん小さなラボ。新しいラボを作るときはここから始める。
 *
 *  1. 命令セットを組み立てる     createISA([...拡張])
 *  2. アセンブルする             assemble(source, { isa })  → { program, errors }
 *  3. 実行する                   new Machine({ program }) → step() / run()
 *  4. (必要なら) タイミングを測る  new PipelineModel(cfg) に実行記録を push
 *
 * 画面の更新は render() にまとめてある。 */
import { createISA, BASE, MULDIV, ATOMIC, assemble, Machine, PipelineModel, hexWord } from '../../core/index.js';
import { EXAMPLES } from './lessons.js';

const isa = createISA([BASE, MULDIV, ATOMIC]);
const MEM_BYTES = 65536;
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const S = { program: null, machine: null, last: null, prevRegs: null };

function load() {
  const { program, errors } = assemble($('src').value, { isa });
  $('err').hidden = !errors.length;
  $('err').textContent = errors.map(e => `${e.line}行目: ${e.message}`).join('\n');
  S.program = program;
  S.machine = program ? new Machine({ program, memSize: MEM_BYTES }) : null;
  S.last = null; S.prevRegs = null;
  renderPipeline();
  render();
}

function step() {
  if (!S.machine) return;
  S.prevRegs = Array.from(S.machine.cores[0].regs);
  S.last = S.machine.step(0);
  render();
}
function runAll() {
  if (!S.machine) return;
  S.prevRegs = Array.from(S.machine.cores[0].regs);
  S.machine.run({ maxSteps: 1e6 });
  render();
}

/** 別のマシンで最後まで流し、5段パイプラインのサイクルを測る */
function renderPipeline() {
  if (!S.program) { $('pipe').innerHTML = ''; return; }
  const m = new Machine({ program: S.program, memSize: MEM_BYTES });
  const { trace, reason } = m.trace({ maxSteps: 1e5 });
  const rows = [];
  for (const [label, cfg] of [['フォワーディングあり・不成立予測', { forwarding: true, branch: 'not-taken' }], ['フォワーディングなし・分岐で停止', { forwarding: false, branch: 'stall' }], ['2命令幅・2ビット予測', { forwarding: true, branch: 'bimodal', width: 2 }]]) {
    const p = new PipelineModel(cfg);
    for (const r of trace) p.push(r);
    const s = p.finish();
    rows.push(`<dt>${label}</dt><dd>${s.cycles} サイクル (CPI ${s.cpi.toFixed(2)})</dd>`);
  }
  $('pipe').innerHTML = `<dt>実行した命令</dt><dd>${trace.length}${reason === 'limit' ? ' (上限で打ち切り)' : ''}</dd>` + rows.join('');
}

function render() {
  const m = S.machine, core = m && m.cores[0];
  $('bStep').disabled = $('bRun').disabled = !m || core.halted;
  const st = $('status');
  if (!m) { st.textContent = ''; st.className = 'status'; }
  else if (core.trap) { st.textContent = `例外 (${core.trap.line}行目): ${core.trap.message}`; st.className = 'status bad'; }
  else if (core.halted) { st.textContent = `停止 · ${core.retired} 命令を実行`; st.className = 'status ok'; }
  else { st.textContent = `PC = ${core.pc} · ${core.retired} 命令を実行`; st.className = 'status'; }

  const regs = core ? core.regs : new Int32Array(16);
  $('regs').innerHTML = Array.from(regs, (v, i) => {
    const chg = S.prevRegs && S.prevRegs[i] !== v;
    return `<div class="reg${chg ? ' chg' : ''}"><span>r${i}</span><b title="${hexWord(v)}">${v}</b></div>`;
  }).join('');

  const P = S.program;
  $('listing').innerHTML = P ? `<tr><th>番号</th><th>機械語</th><th>命令</th><th>行</th><th>書いたもの</th></tr>` + P.instrs.map(i =>
    `<tr class="${core && !core.halted && core.pc === i.index ? 'cur' : ''}"><td>${(P.labelAt(i.index) ? esc(P.labelAt(i.index)) + ': ' : '') + i.index}</td><td>${hexWord(i.word)}</td><td>${esc(i.text)}</td><td>${i.line}</td><td>${esc(i.src)}</td></tr>`).join('') : '';

  let from = parseInt($('memFrom').value, $('memFrom').value.trim().toLowerCase().startsWith('0x') ? 16 : 10);
  if (!Number.isFinite(from) || from < 0) from = 0;
  from = Math.min(from & ~3, MEM_BYTES - 256);
  const written = new Set((S.last ? S.last.mem : []).filter(a => a.type === 'write').map(a => a.addr & ~3));
  let h = '<tr><th>番地</th><th>+0</th><th>+4</th><th>+8</th><th>+C</th></tr>';
  for (let r = 0; r < 16; r++) {
    const base = from + r * 16;
    h += `<tr><td>${hexWord(base).replace('0x0000', '0x')}</td>`;
    for (let k = 0; k < 4; k++) {
      const a = base + k * 4, v = m ? m.memory.readWord(a) : 0;
      h += `<td style="${written.has(a) ? 'color:var(--accent);font-weight:600' : ''}">${v}</td>`;
    }
    h += '</tr>';
  }
  $('mem').innerHTML = h;
}

EXAMPLES.forEach((e, i) => { const o = document.createElement('option'); o.value = i; o.textContent = e.name; $('example').append(o); });
$('example').addEventListener('change', e => { $('src').value = EXAMPLES[+e.target.value].code; load(); });
$('bAsm').onclick = load;
$('bStep').onclick = step;
$('bRun').onclick = runAll;
$('memFrom').addEventListener('change', render);
$('src').value = EXAMPLES[0].code;
$('memFrom').value = '0x100';
load();
