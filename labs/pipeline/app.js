/* パイプライン・ラボ — シミュレータ本体 (../../core) の上に作ったラボ
 * 命令の意味は Machine、サイクルごとの動きは PipelineModel が計算する。
 * このファイルはその結果を「サイクル c に何が起きたか」として表示するだけ。 */
import { createISA, BASE, MULDIV, assemble, Machine, PipelineModel, STAGES } from '../../core/index.js';
import { SAMPLES, MEM_BYTES } from './lessons.js';

const isa = createISA([BASE, MULDIV]);
const STAGE_UI = [
  { k: 'IF', j: '命令フェッチ', cls: 'is-if' },
  { k: 'ID', j: 'デコード・レジスタ読出し', cls: 'is-id' },
  { k: 'EX', j: '演算・分岐判定', cls: 'is-ex' },
  { k: 'MEM', j: 'メモリアクセス', cls: 'is-mem' },
  { k: 'WB', j: 'レジスタ書き戻し', cls: 'is-wb' },
];
const MAX_INSTRS = 40, MAX_STEPS = 200;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const R = n => 'r' + n;

/* ---------- シミュレーション ---------- */
function simulate(program, memInit, opt) {
  const m = new Machine({ program, memSize: MEM_BYTES, init: mem => memInit.forEach((v, i) => mem.writeWord(i * 4, v)) });
  const { trace, reason } = m.trace({ maxSteps: MAX_STEPS });
  const pipe = new PipelineModel({ program, forwarding: opt.fwd, branch: opt.branch === 'predict' ? 'not-taken' : 'stall' });
  for (const r of trace) pipe.push(r);
  const sum = pipe.finish();
  const E = pipe.entries;
  const last = sum.cycles; // 表示上のサイクルは 1〜last (モデルのサイクル + 1)

  // 行 (タイミング図): 正しい命令と取り消された命令を、フェッチした順に
  const rows = [...E, ...pipe.squashed].sort((a, b) => a.t[0] - b.t[0] || (a.wrong ? 1 : 0) - (b.wrong ? 1 : 0));

  // サイクルごとのレジスタとメモリ (WB・MEM で書かれたものを順に反映)
  const regs0 = new Int32Array(16), mem0 = new Int32Array(MEM_BYTES / 4);
  memInit.forEach((v, i) => { mem0[i] = v; });
  const regsAt = [], memAt = [];
  {
    const r = regs0.slice(), mm = mem0.slice();
    regsAt[0] = r.slice(); memAt[0] = mm.slice();
    for (let k = 1; k <= last; k++) {
      const c = k - 1;
      for (const e of E) {
        if (e.t[4] === c && e.rec.write && !e.rec.write.discarded) r[e.rec.write.reg] = e.rec.write.value;
        if (e.t[3] === c) for (const a of e.rec.mem) if (a.type === 'write') mm[a.addr >> 2] = a.value;
      }
      regsAt[k] = r.slice(); memAt[k] = mm.slice();
    }
  }

  // サイクルごとの出来事
  const events = [[{ type: 'info', text: 'リセット状態です。「1サイクル進む」で最初の命令をフェッチします。' }]];
  const stagesAt = [null];
  const counts = [{ stalls: 0, flushes: 0, fwds: 0 }];
  for (let k = 1; k <= last; k++) {
    const c = k - 1, ev = [], st = {};
    const add = (type, text) => ev.push({ type, text });
    const prev = counts[k - 1], cnt = { ...prev };
    const occ = pipe.stagesAt(c);
    const fwdFrom = [];
    occ.forEach((list, s) => {
      const o = list[0];
      if (!o) return;
      const e = o.entry, ins = e.ins, text = e.wrong ? ins.text : e.ins.text;
      let note = '', tag = null;
      if (o.flushed) tag = 'flush';
      else if (o.stalled) tag = 'stall';
      switch (s) {
        case 0: note = `PC = ${e.pc}`; break;
        case 1: {
          if (e.wrong) { note = '取り消し待ち'; break; }
          const wait = e.waits.find(w => w.stage === 1 && c >= w.from - 1 && c < w.to - 1);
          if (o.stalled && wait && wait.cause.type === 'data') { note = `${R(wait.cause.reg)} 待ち`; break; }
          const rd = e.rec.reads.filter(x => x.field !== 'rd');
          note = rd.length ? '読出し ' + rd.map(x => `${R(x.reg)}=${regsAt[k][x.reg]}`).join(', ') : '読むレジスタなし';
          break;
        }
        case 2: {
          note = exNote(e);
          if (e.t[2] === c && e.fwd.some(f => f.from !== 'RF')) { tag = tag || 'fwd'; }
          break;
        }
        case 3: note = memNote(e); break;
        case 4: {
          const w = e.rec.write;
          note = !w ? '書き込みなし' : w.discarded ? 'r0 は常に 0（無視）' : `${R(w.reg)} ← ${w.value}`;
          break;
        }
      }
      st[STAGES[s]] = { text, note, tag };
    });
    // フェッチ停止 (分岐待ち)
    if (!occ[0].length) {
      const blocked = E.find(e => e.fetchDelay && c >= e.fetchDelay.from && c < e.fetchDelay.to);
      if (blocked) { st.IF = { text: null, note: 'フェッチ停止（分岐待ち）', tag: 'bubble' }; cnt.stalls++; add('stall', '分岐の行き先が決まるまでフェッチを止める（制御ハザード）'); }
    }
    // EX に入った命令: 転送
    for (const e of E) if (e.t[2] === c) for (const f of e.fwd) if (f.from !== 'RF') {
      const p = E[f.producer];
      cnt.fwds++;
      fwdFrom.push(f.from === 'EX/MEM' ? 'MEM' : 'WB');
      add('fwd', `${R(f.reg)} = ${p.rec.write.value} を ${f.from} から EX へ転送（${p.ins.text} の結果）`);
    }
    // ID で待っている命令: データハザード
    for (const e of E) {
      const w = e.waits.find(w => w.stage === 1 && w.cause.type === 'data' && c >= w.from - 1 && c < w.to - 1);
      if (!w) continue;
      const p = E[w.cause.producer];
      const ps = pipe.stageOf(p, c).stage;
      const why = p.cls === 'load' && opt.fwd ? 'LW の値は MEM が終わるまで出てこない' : `その命令はまだ ${STAGES[ps] ?? 'WB 前'}`;
      cnt.stalls++;
      add('stall', `${e.ins.text} が ${R(w.cause.reg)} を待つ: ${p.ins.text} の結果が未完成（${why}）。ID で足止めし、EX にバブルを送る`);
    }
    // 分岐の解決
    for (const e of E) if (e.branch && e.branch.resolveAt === c) {
      const b = e.branch, nm = e.ins.def.mnemonic;
      const where = b.taken ? `ラベル ${program.labelAt(b.target) ?? b.target}（${b.target}番目）` : '次の命令';
      if (opt.branch === 'predict') {
        if (b.mispredicted) {
          cnt.flushes += e.wrongPath.length;
          add('flush', `${nm} 成立 → 予測が外れた。後ろの ${e.wrongPath.length} 命令を取り消し、${where} からフェッチし直す`);
        } else add('info', `${nm} 不成立 → 予測どおり。そのまま流れ続ける`);
      } else add('info', `${nm} ${b.taken ? '成立' : '不成立'} → 次のサイクルから ${where} をフェッチ`);
    }
    for (const e of E) if (e.t[4] === c && e.rec.write && !e.rec.write.discarded) add('info', `${R(e.rec.write.reg)} に ${e.rec.write.value} を書き込んだ`);
    const retired = pipe.retiredBy(c);
    if (k === last) add('done', `全命令が完了。${k} サイクルで ${retired} 命令を実行（CPI ${(k / retired).toFixed(2)}）`);
    st.fwdFrom = fwdFrom;
    stagesAt[k] = st; events[k] = ev; counts[k] = cnt;
  }
  return { pipe, sum, rows, last, regsAt, memAt, events, stagesAt, counts, truncated: reason === 'limit' };
}

function exNote(e) {
  const rec = e.rec, d = e.ins.def, v = f => (rec.reads.find(x => x.field === f) || {}).value;
  const a = v('rs'), b = v('rt'), out = rec.write ? rec.write.computed : null;
  switch (d.class) {
    case 'load': case 'store': return `番地 ${a} + ${e.ins.imm} = ${rec.mem[0] ? rec.mem[0].addr : a + e.ins.imm}`;
    case 'branch': {
      const sym = { BEQ: '=', BNE: '≠', BLT: '<', BGE: '≥', BLTU: '<', BGEU: '≥' }[d.mnemonic] || '?';
      return `${a} ${sym} ${b} ? → ${rec.branch.taken ? '成立' : '不成立'}`;
    }
    case 'jump': return `飛び先 ${rec.branch.target}`;
    case 'system': return '何もしない';
  }
  if (d.mnemonic === 'ADDI' && e.ins.rd === 0 && e.ins.rs === 0 && e.ins.imm === 0) return '何もしない';
  const op = { ADD: '+', SUB: '−', AND: 'AND', OR: 'OR', XOR: 'XOR', MUL: '×', ADDI: '+', ANDI: 'AND', ORI: 'OR' }[d.mnemonic];
  const rhs = d.format === 'R' ? b : e.ins.imm;
  return op ? `${a} ${op} ${rhs} = ${out}` : `${d.mnemonic} → ${out}`;
}
function memNote(e) {
  const m = e.rec.mem[0];
  if (!m) return 'メモリは使わない';
  return m.type === 'read' ? `M[${m.addr}] を読む → ${m.value}` : `M[${m.addr}] ← ${m.value}`;
}

/* ---------- 状態とUI ---------- */
const st = { sample: SAMPLES[0], code: SAMPLES[0].code, mem: SAMPLES[0].mem, fwd: true, branch: 'predict', cur: 0, sim: null, timer: null };

function rebuild(keepCycle) {
  const { program, errors } = assemble(st.code, { isa });
  const errs = errors.map(e => `${e.line}行目: ${e.message}`);
  if (program && program.instrs.length > MAX_INSTRS) errs.push(`命令は${MAX_INSTRS}個までにしてください`);
  $('err').hidden = !errs.length; $('err').textContent = errs.slice(0, 4).join('\n');
  $('ninst').textContent = program ? `${program.instrs.length} 命令` : '';
  if (errs.length) { stop(); st.sim = null; render(); return; }
  st.sim = simulate(program, st.mem, { fwd: st.fwd, branch: st.branch });
  const last = st.sim.last;
  st.cur = keepCycle ? Math.min(st.cur, last) : 0;
  $('scrub').max = last; $('cmax').textContent = last + (st.sim.truncated ? '+' : '');
  render();
}

function render() {
  const sim = st.sim;
  const last = sim ? sim.last : 0;
  const k = st.cur;
  $('cyc').textContent = k; $('scrub').value = k;
  $('bBack').disabled = !sim || k === 0; $('bReset').disabled = !sim || k === 0;
  $('bStep').disabled = !sim || k >= last; $('bPlay').disabled = !sim || (k >= last && !st.timer);
  $('bPlay').textContent = st.timer ? '⏸ 停止' : '▶ 再生';

  // ステージ
  const snap = sim && k > 0 ? sim.stagesAt[k] : null;
  const srcs = snap ? snap.fwdFrom : [];
  const tagTxt = { stall: 'ストール', flush: '取り消し', fwd: '転送を受信', bubble: '空き' };
  $('stages').innerHTML = STAGE_UI.map(S => {
    const o = snap && snap[S.k];
    const src = srcs.includes(S.k) ? ' src' : '';
    let body;
    if (o && o.text) body = `<div class="ins">${esc(o.text)}</div><div class="note">${esc(o.note)}</div>`;
    else if (o) body = `<div class="ins empty">—</div><div class="note">${esc(o.note)}</div>`;
    else body = `<div class="ins empty">バブル（空き）</div>`;
    const tag = o && o.tag ? `<span class="tag ${o.tag}">${tagTxt[o.tag]}</span>` : (srcs.includes(S.k) ? '<span class="tag fwd">転送元</span>' : '');
    return `<div class="stage ${S.cls}${src}"><div class="sh"><span class="sn">${S.k}</span><span class="sj">${S.j}</span></div>${body}${tag}</div>`;
  }).join('');

  // イベント
  const evs = sim ? sim.events[k] : [{ type: 'stall', text: 'プログラムにエラーがあります。左の欄を直してください。' }];
  const kmap = { stall: '待ち', flush: '取り消し', fwd: '転送', info: '', done: '完了' };
  $('events').innerHTML = (evs.length ? evs : [{ type: 'info', text: '特別なことは起きていません。全ステージが順調に進みました。' }])
    .map(e => `<li class="${e.type}">${kmap[e.type] ? `<span class="k">${kmap[e.type]}</span>` : ''}${esc(e.text)}</li>`).join('');

  // タイミング図
  if (sim) {
    const cols = Math.max(last, 8);
    let h = '<table class="tm"><thead><tr><th class="lbl">命令</th>';
    for (let c = 1; c <= cols; c++) h += `<th class="${c === k ? 'cur' : ''}">${c}</th>`;
    h += '</tr></thead><tbody>';
    const shown = sim.rows.filter(e => e.t[0] + 1 <= k);
    for (const e of shown) {
      const fl = e.wrong && e.flushAt + 1 <= k;
      h += `<tr class="${fl ? 'flushed' : ''}"><td class="lbl"><span class="pcn">${String(e.pc).padStart(2, '0')}</span>${esc(e.ins.text)}</td>`;
      for (let c = 1; c <= cols; c++) {
        let cell = '';
        if (c <= k) {
          const s = sim.pipe.stageOf(e, c - 1);
          if (s.stage >= 0) {
            const cls = s.flushed ? 'flush' : s.stalled ? 'stall' : '';
            cell = `<span class="c ${STAGES[s.stage]} ${cls}">${cls === 'stall' ? '待' : STAGES[s.stage]}</span>`;
          }
        }
        h += `<td class="${c === k ? 'curc' : ''}">${cell}</td>`;
      }
      h += '</tr>';
    }
    if (k === 0) h += `<tr><td class="lbl" style="color:var(--muted);font-weight:400">まだ何もフェッチしていません</td>${'<td></td>'.repeat(cols)}</tr>`;
    h += '</tbody></table>';
    const d = $('diag'); const sl = d.scrollLeft; d.innerHTML = h; d.scrollLeft = sl;
    const curTh = d.querySelector('th.cur');
    if (curTh) { const r = curTh.offsetLeft + curTh.offsetWidth + 40 - d.clientWidth; if (r > d.scrollLeft) d.scrollLeft = r; else if (curTh.offsetLeft - 200 < d.scrollLeft) d.scrollLeft = Math.max(0, curTh.offsetLeft - 200); }
  } else $('diag').innerHTML = '';

  // 性能
  const retired = sim && k > 0 ? sim.pipe.retiredBy(k - 1) : 0;
  const cnt = sim ? sim.counts[k] : { stalls: 0, flushes: 0, fwds: 0 };
  const cpi = retired ? (k / retired).toFixed(2) : '—';
  $('stats').innerHTML = [
    [k, '経過サイクル'], [retired, '完了した命令'], [cpi, 'CPI（低いほど良い）'],
    [cnt.stalls, 'ストール'], [cnt.flushes, '取り消した命令'], [cnt.fwds, 'フォワーディング'],
  ].map(([v, l]) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
  if (sim) {
    const N = sim.sum.instructions, pipeC = last, seq = N * 5, ideal = N ? N + 4 : 0;
    const mx = Math.max(seq, pipeC, 1);
    const row = (l, v, cls) => `<div class="bar"><span>${l}</span><div class="track"><div class="fill ${cls}" style="width:${v / mx * 100}%"></div></div><span class="n">${v} cyc</span></div>`;
    $('compare').innerHTML = `<div style="color:var(--muted)">プログラム全体（${N} 命令）の比較</div>`
      + row('パイプラインなし (5×N)', seq, '')
      + row('このパイプライン', pipeC, 'p')
      + row('理想 (N+4)', ideal, '')
      + `<div style="color:var(--muted)">高速化率 <b style="color:var(--ink);font-family:var(--mono)">${pipeC ? (seq / pipeC).toFixed(2) : '—'}×</b>　理想との差 ${pipeC - ideal} サイクルがハザードによる損失です。</div>`;
  } else $('compare').innerHTML = '';

  // レジスタ・メモリ
  const regs = sim ? sim.regsAt[k] : new Int32Array(16);
  const wroteReg = new Set(), wroteMem = new Set();
  if (sim && k > 0) for (const e of sim.pipe.entries) {
    if (e.t[4] === k - 1 && e.rec.write && !e.rec.write.discarded) wroteReg.add(e.rec.write.reg);
    if (e.t[3] === k - 1) for (const a of e.rec.mem) if (a.type === 'write') wroteMem.add(a.addr >> 2);
  }
  $('regs').innerHTML = Array.from(regs, (v, i) => `<div class="cell${wroteReg.has(i) ? ' hot' : ''}"><div class="a">r${i}</div><div class="d">${v}</div></div>`).join('');
  const mem = sim ? sim.memAt[k] : new Int32Array(MEM_BYTES / 4);
  $('mem').innerHTML = Array.from(mem, (v, i) => `<div class="cell${wroteMem.has(i) ? ' hotm' : ''}"><div class="a">M[${i * 4}]</div><div class="d">${v}</div></div>`).join('');
}

function go(n) { if (!st.sim) return; st.cur = Math.max(0, Math.min(st.sim.last, n)); render(); }
function stop() { if (st.timer) { clearInterval(st.timer); st.timer = null; } }
function play() {
  if (st.timer) { stop(); render(); return; }
  if (!st.sim) return;
  if (st.cur >= st.sim.last) st.cur = 0;
  st.timer = setInterval(() => { if (st.cur >= st.sim.last) { stop(); render(); return; } go(st.cur + 1); }, +$('speed').value);
  render();
}

function setSeg(id, val) { $(id).querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === val)); }
function loadSample(s) {
  stop(); st.sample = s; st.code = s.code; st.mem = s.mem; $('code').value = s.code; $('hint').innerHTML = s.hint;
  $('samples').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.id === s.id));
  rebuild(false);
}

$('samples').innerHTML = SAMPLES.map(s => `<button type="button" data-id="${s.id}">${s.name}<small>${s.sub}</small></button>`).join('');
$('samples').addEventListener('click', e => { const b = e.target.closest('button'); if (b) loadSample(SAMPLES.find(s => s.id === b.dataset.id)); });
$('optFwd').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; st.fwd = b.dataset.v === 'on'; setSeg('optFwd', b.dataset.v); stop(); rebuild(true); });
$('optBr').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; st.branch = b.dataset.v; setSeg('optBr', b.dataset.v); stop(); rebuild(true); });
let deb; $('code').addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => { stop(); st.code = $('code').value; $('samples').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', 'false')); rebuild(false); }, 300); });
$('bStep').onclick = () => { stop(); go(st.cur + 1); };
$('bBack').onclick = () => { stop(); go(st.cur - 1); };
$('bReset').onclick = () => { stop(); go(0); };
$('bPlay').onclick = play;
$('scrub').addEventListener('input', e => { stop(); go(+e.target.value); });
$('speed').addEventListener('change', () => { if (st.timer) { stop(); play(); } });
document.addEventListener('keydown', e => {
  if (e.target.closest('textarea,input,select')) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); stop(); go(st.cur + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); stop(); go(st.cur - 1); }
  else if (e.key === ' ') { e.preventDefault(); play(); }
});

setSeg('optFwd', 'on'); setSeg('optBr', 'predict');
loadSample(SAMPLES[0]);
// 開いた直後に流れが見えるよう、パイプラインが埋まった時点まで進めておく
go(5);
