/* アトミック・ラボ (AL-2 構成: 2コア) — シミュレータ本体 (../../core) の上に作ったラボ
 * 2コアの Machine を、ボタンやスケジューラで1ステップずつ進める。
 * 命令の意味 (アトミック命令・予約・μop) はすべてコアが持ち、ここは実行記録を言葉にして見せるだけ。 */
import { createISA, BASE, MULDIV, ATOMIC, XMRMW, assemble, Machine } from '../../core/index.js';
import { LESSONS, SYMBOLS, ADDR_NAME, EXPECTED } from './lessons.js';

const isa = createISA([BASE, MULDIV, ATOMIC, XMRMW]);
const NREG = 8; // 表示するレジスタ数 (r0〜r7)
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const an = a => ADDR_NAME[a] ?? `M[${a}]`;
const rn = n => 'r' + n;

/* ---------------- 実行 ---------------- */
function asm(code) {
  const { program, errors } = assemble(code, { isa, symbols: SYMBOLS });
  if (!program) throw { line: errors[0].line, msg: errors[0].message };
  return program;
}

/** 2コアの Machine と、表示用の履歴 */
class Lab {
  constructor(prog, record = true) {
    this.prog = prog; this.record = record;
    this.m = new Machine({ program: prog, cores: 2, memSize: 16 });
    this.steps = 0; this.history = []; this.csViol = 0; this.inCS = false; this.lost = 0; this.last = null;
    this.fails = [0, 0];
  }
  get cores() { return this.m.cores; }
  done() { return this.m.halted; }
  mem(a) { return this.m.memory.readWord(a); }
  inCSCore(c) { return !c.halted && !!(this.prog.instrs[c.pc] && this.prog.instrs[c.pc].regions.includes('cs')); }
  step(id) {
    const core = this.cores[id];
    if (core.halted) return null;
    const before = this.mem(0);
    const rec = this.m.step(id);
    const ev = { core: id, pc: rec.pc, op: rec.ins.pseudo || rec.ins.def.mnemonic, lock: rec.ins.lock, atomic: rec.atomic, fail: false, uop: rec.uopCount > 1 ? rec.uop + 1 : 0, text: '' };
    describe(rec, ev);
    if (ev.fail) this.fails[id]++;
    const w = rec.mem.find(x => x.type === 'write');
    if (w) {
      ev.wrote = w.addr;
      if (w.addr === 0 && w.value <= before) { ev.lost = true; this.lost++; }
    }
    const broke = rec.notes.find(n => n.type === 'reservation-lost');
    if (broke) ev.text += `（コア${broke.core}の予約が消える）`;
    if (rec.trap) ev.text = `例外: ${rec.trap}`;
    this.steps++;
    ev.step = this.steps; ev.counter = this.mem(0); ev.lockv = this.mem(4);
    const n = this.cores.filter(k => this.inCSCore(k)).length;
    if (n >= 2 && !this.inCS) { this.csViol++; ev.viol = true; }
    this.inCS = n >= 2;
    this.last = ev;
    if (this.record) this.history.push(ev);
    return ev;
  }
}

/** 実行記録 → 日本語の説明 (と失敗・待ちの判定) */
function describe(rec, ev) {
  const I = rec.ins, d = I.def, w = rec.write, m = rec.mem;
  const rv = f => (rec.reads.find(x => x.field === f) || {}).value;
  switch (d.mnemonic) {
    case 'LW': ev.text = `${rn(w.reg)} ← ${an(m[0].addr)}（${w.value}）を読む`; return;
    case 'SW': ev.text = `${an(m[0].addr)} ← ${m[0].value} を書く`; return;
    case 'INCM': {
      const a = m[m.length - 1].addr;
      if (I.lock) ev.text = `ロックしたまま ${an(a)} を ${m[0].value} → ${m[1].value}`;
      else if (rec.uop === 0) ev.text = `μop1: ${an(a)} を読み出す（${m[0].value}）`;
      else ev.text = `μop2: ${an(a)} ← ${m[0].value} を書く`;
      return;
    }
    case 'AMOADD': ev.text = `${an(m[0].addr)} ${m[0].value} → ${m[1].value}、${rn(w.reg)} ← 旧値 ${w.value}`; return;
    case 'XCHG': {
      ev.text = `${an(m[0].addr)} ← ${m[1].value}、${rn(w.reg)} ← 旧値 ${w.value}`;
      if (m[0].addr === SYMBOLS.lock && w.value !== 0) { ev.fail = true; ev.text += '（ロック使用中）'; }
      return;
    }
    case 'CAS': {
      const e = rv('rd');
      if (w.value === e) ev.text = `CAS 成功: ${an(m[0].addr)} が ${e} のままだったので ${rv('rt')} を書く`;
      else { ev.fail = true; ev.text = `CAS 失敗: 期待 ${e} だが実際は ${w.value}。${rn(w.reg)} ← ${w.value}`; }
      return;
    }
    case 'LL': ev.text = `${rn(w.reg)} ← ${an(m[0].addr)}（${w.value}）を読み、予約する`; return;
    case 'SC':
      if (w.value === 1) ev.text = `SC 成功: 予約が残っていたので ${an(m[0].addr)} ← ${m[0].value}`;
      else { ev.fail = true; ev.text = 'SC 失敗: 予約が消えていた（他コアが書き込み済み）'; }
      return;
    case 'HALT': ev.text = '停止'; return;
  }
  if (rec.branch) {
    const lbl = rec.ins.text.split(', ').pop();
    if (!rec.branch.conditional) { ev.text = `${lbl} へ`; return; }
    ev.text = rec.branch.taken ? `条件成立 → ${lbl} へ` : '条件不成立 → 次へ';
    return;
  }
  if (w) { ev.text = w.discarded ? '何もしない' : `${rn(w.reg)} ← ${w.value}`; return; }
  ev.text = '何もしない';
}

function pickCore(lab, cur, p) {
  const ready = lab.cores.filter(c => !c.halted).map(c => c.id);
  if (!ready.length) return null;
  if (ready.length === 1) return ready[0];
  if (cur !== null && ready.includes(cur) && Math.random() >= p) return cur;
  const others = ready.filter(x => x !== cur);
  return others[Math.floor(Math.random() * others.length)];
}

/* ---------------- State & UI ---------------- */
const S = { lesson: 0, variant: 0, edited: false, code: '', prog: null, m: null, cur: null, timer: null, prevRegs: null, rows: [] };

const MNEMONICS = [...isa.defs.keys(), ...isa.pseudos.keys()].sort((a, b) => b.length - a.length);
const OP_RE = new RegExp('\\b(' + MNEMONICS.join('|') + ')\\b', 'gi');
const ATOMIC_OPS = new Set(['LL', 'SC', 'CAS', 'XCHG', 'AMOADD', 'INCM']);
function hl(line) {
  const i = line.search(/[;#]/);
  const code = i >= 0 ? line.slice(0, i) : line, com = i >= 0 ? line.slice(i) : '';
  let h = esc(code);
  if (/^\s*\.(region|endregion)\b/i.test(code)) h = `<span class="dir">${h}</span>`;
  else {
    h = h.replace(/\b(counter|lock)\b/g, '<span class="mem">$1</span>')
      .replace(/\b(r(?:1[0-5]|\d))\b/g, '<span class="reg">$1</span>')
      .replace(/\bLOCK\b(?=\s+INCM)/gi, '<span class="lk">LOCK</span>')
      .replace(OP_RE, (mm, op) => `<span class="${ATOMIC_OPS.has(op.toUpperCase()) ? 'op lk' : 'op'}">${op}</span>`)
      .replace(/^(\s*)([A-Za-z_]\w*:)/, '$1<span class="lbl">$2</span>');
  }
  return h + (com ? `<span class="com">${esc(com)}</span>` : '');
}

function renderNav() {
  $('lessonNav').innerHTML = LESSONS.map((L, i) =>
    `<button data-i="${i}" aria-current="${i === S.lesson}"><span class="n">${i + 1}</span>${esc(L.title)}</button>`).join('');
  $('lessonNav').querySelectorAll('button').forEach(b => { b.onclick = () => loadLesson(+b.dataset.i, 0); });
}

function renderLesson() {
  const L = LESSONS[S.lesson];
  const vs = L.variants.map((v, i) => {
    const tag = (S.edited && i === S.variant) ? '<span class="tag edited">編集済み</span>' : v.safe ? '<span class="tag safe">安全</span>' : '<span class="tag unsafe">競合あり</span>';
    return `<button data-i="${i}" aria-pressed="${i === S.variant}"><span>${esc(v.name)}</span>${tag}</button>`;
  }).join('');
  $('lessonCard').innerHTML = `
    <div><div class="eyebrow">レッスン ${S.lesson + 1} / ${LESSONS.length}</div><h2>${esc(L.title)}</h2></div>
    <div class="body">${L.body.map(p => `<p>${esc(p)}</p>`).join('')}</div>
    <div><h3>プログラム</h3><div class="variants" style="margin-top:6px">${vs}</div></div>
    <div><h3>試してみよう</h3><ol class="tasks" style="margin-top:6px">${L.tasks.map(t => `<li>${esc(t)}</li>`).join('')}</ol></div>
    <div class="point">${L.point}</div>`;
  $('lessonCard').querySelectorAll('.variants button').forEach(b => { b.onclick = () => loadLesson(S.lesson, +b.dataset.i); });
}

/** ソースの各行: クリティカルセクション内か */
function computeRows(code) {
  let cs = false;
  return code.split('\n').map(text => {
    const t = text.replace(/[;#].*$/, '').trim().toLowerCase();
    if (t === '.region cs') { cs = true; return { text, cs: true }; }
    if (t === '.endregion') { cs = false; return { text, cs: false }; }
    return { text, cs };
  });
}

function renderListing() {
  $('listing').innerHTML = S.rows.map((r, i) =>
    `<div class="row${r.cs ? ' cs' : ''}" data-row="${i}"><span class="g g0"></span><span class="g g1"></span><span class="ln">${i + 1}</span><span class="src">${hl(r.text) || ' '}</span></div>`).join('');
}

function updateListing() {
  const rows = $('listing').children;
  for (const r of rows) { r.querySelector('.g0').innerHTML = ''; r.querySelector('.g1').innerHTML = ''; r.classList.remove('flash0', 'flash1'); }
  S.m.cores.forEach(c => {
    if (c.halted) return;
    const I = S.prog.instrs[c.pc]; if (!I) return;
    rows[I.line - 1].querySelector('.g' + c.id).innerHTML = `<i class="pcm c${c.id}" title="コア${c.id} の次の命令">${c.id}</i>`;
  });
  const ev = S.m.last;
  if (ev) rows[S.prog.instrs[ev.pc].line - 1].classList.add('flash' + ev.core);
}

function renderCores() {
  const m = S.m, ev = m.last;
  $('cores').innerHTML = m.cores.map(c => {
    let st = '<span class="state">実行可能</span>';
    if (c.halted) st = c.trap ? '<span class="state cs">例外で停止</span>' : '<span class="state halt">停止</span>';
    else if (m.inCSCore(c)) st = '<span class="state cs">CS 内</span>';
    else if (c.uop === 1) st = '<span class="state cs">μop 途中</span>';
    const regs = Array.from(c.regs.slice(0, NREG), (v, i) => {
      const chg = ev && ev.core === c.id && S.prevRegs && S.prevRegs[c.id][i] !== v;
      return `<div class="reg-c${chg ? ' chg' : ''}"><span>r${i}</span><b>${v}</b></div>`;
    }).join('');
    const I = S.prog.instrs[c.pc];
    const nextTxt = c.halted ? '—' : I ? esc(I.src) + (c.uop === 1 ? '（μop2）' : '') : '—';
    return `<section class="panel core" data-c="${c.id}">
      <div class="ph"><h2>コア ${c.id}</h2>${st}</div>
      <div class="regs">${regs}</div>
      <div class="meta">
        <span>次: <b>${nextTxt}</b></span>
        <span>予約: <b>${c.reservation === null ? 'なし' : an(c.reservation)}</b>${c.uop === 1 ? ` · 読み出し済み: <b>${c.tmp.value}</b>` : ''}</span>
        <span>失敗・待ち: <b>${m.fails[c.id]}</b> 回</span>
      </div>
      <button class="btn core-btn" data-c="${c.id}" ${c.halted ? 'disabled' : ''}>コア${c.id} を1命令進める <kbd>${c.id + 1}</kbd></button>
    </section>`;
  }).join('');
  $('cores').querySelectorAll('.core-btn').forEach(b => { b.onclick = () => { stopAuto(); doStep(+b.dataset.c); }; });
}

function renderMem() {
  const m = S.m, ev = m.last;
  $('cells').innerHTML = [0, 4].map(a => {
    const w = ev && ev.wrote === a ? ` w${ev.core}` : '';
    const lost = ev && ev.wrote === a && ev.lost ? ' lost' : '';
    const resv = m.cores.filter(c => c.reservation === a).map(c => `<span style="color:var(--c${c.id})">C${c.id} 予約</span>`).join('');
    return `<div class="cell${w}${lost}"><span class="addr">0x${a.toString(16).padStart(2, '0')}</span><span class="nm">${ADDR_NAME[a]}</span><span class="val">${m.mem(a)}</span><div class="resv">${resv}</div></div>`;
  }).join('');
  const on = ev && ev.atomic;
  $('lamp').className = 'lamp' + (on ? ' on' : '');
  $('lamp').innerHTML = `<i></i>BUS LOCK${on ? `（コア${ev.core}）` : ''}`;
}

function renderStatus() {
  const m = S.m, done = m.done(), c = m.mem(0);
  let verdict;
  if (m.inCS) verdict = `<span style="color:var(--bad)">2コアが同時にクリティカルセクション内</span>`;
  else if (!done && m.steps === 0) verdict = `<span style="color:var(--muted)">未実行。コアのボタンかスペースキーで1命令ずつ進める</span>`;
  else if (!done) verdict = `<span>実行中</span>`;
  else if (c === EXPECTED) verdict = `<span style="color:var(--ok)">完了: 6回の +1 がすべて反映された</span>`;
  else verdict = `<span style="color:var(--bad)">完了: ${EXPECTED - c} 回分の +1 が消えた</span>`;
  $('status').innerHTML = `
    <div><div class="k">counter</div><div class="v ${done ? (c === EXPECTED ? 'ok' : 'bad') : ''}">${c}<small> / ${EXPECTED}</small></div></div>
    <div><div class="k">ステップ</div><div class="v">${m.steps}</div></div>
    <div><div class="k">更新消失</div><div class="v ${m.lost ? 'bad' : ''}">${m.lost}</div></div>
    <div><div class="k">CS 同時侵入</div><div class="v ${m.csViol ? 'bad' : ''}">${m.csViol}</div></div>
    <div class="verdict"><div class="k">状態</div><div class="v">${verdict}</div></div>`;
}

const MAXTL = 300;
function short(ev) {
  if (ev.op === 'INCM') return ev.lock ? 'L.INC' : (ev.uop === 1 ? 'INC¹' : 'INC²');
  if (ev.op === 'AMOADD') return 'AMO+';
  return ev.op;
}
function renderTimeline() {
  const h = S.m.history;
  if (!h.length) {
    $('tl').innerHTML = `<div class="tl-lab"><div>step</div><div class="l0">コア0</div><div class="l1">コア1</div><div>counter</div><div>lock</div></div><div class="tl-empty">まだ何も実行していません。</div>`;
    return;
  }
  const v = h.slice(-MAXTL);
  let prevC = h.length > v.length ? h[h.length - v.length - 1].counter : 0;
  let prevL = h.length > v.length ? h[h.length - v.length - 1].lockv : 0;
  const num = [], l0 = [], l1 = [], lc = [], ll = [];
  v.forEach(ev => {
    const vio = ev.viol ? ' viol' : '';
    num.push(`<div class="${vio}">${ev.step}</div>`);
    const cls = `blk c${ev.core}${ev.atomic ? ' atomic' : ''}${ev.fail ? ' fail' : ''}${ev.uop ? ' uop' : ''}`;
    const b = `<div class="${vio}"><span class="${cls}" title="${esc(ev.text)}">${short(ev)}</span></div>`;
    const e = `<div class="${vio}"></div>`;
    l0.push(ev.core === 0 ? b : e); l1.push(ev.core === 1 ? b : e);
    lc.push(`<div class="${ev.lost ? 'lostv' : ev.counter !== prevC ? 'chg' : ''}">${ev.counter}</div>`);
    ll.push(`<div class="${ev.lockv !== prevL ? 'chg' : ''}">${ev.lockv}</div>`);
    prevC = ev.counter; prevL = ev.lockv;
  });
  $('tl').innerHTML = `<div class="tl-lab"><div>step</div><div class="l0">コア0</div><div class="l1">コア1</div><div>counter</div><div>lock</div></div>
    <div class="tl-scroll" id="tlScroll"><div class="tl-grid">
      <div class="tl-row num">${num.join('')}</div><div class="tl-row">${l0.join('')}</div><div class="tl-row">${l1.join('')}</div>
      <div class="tl-row">${lc.join('')}</div><div class="tl-row">${ll.join('')}</div></div></div>`;
  const sc = $('tlScroll'); sc.scrollLeft = sc.scrollWidth;
}

function renderLog() {
  const h = S.m.history.slice(-200).reverse();
  if (!h.length) { $('log').innerHTML = `<p class="note">ここに1命令ごとの動作が出ます。</p>`; return; }
  $('log').innerHTML = h.map(ev => {
    let t = esc(ev.text);
    const cls = ev.lost || ev.fail || ev.viol ? 'x' : ev.atomic ? 'a' : '';
    if (ev.lost) t += ' ← 更新消失';
    if (ev.viol) t += ' ← CS 同時侵入';
    return `<div><span class="s">#${ev.step}</span><span class="c${ev.core}">C${ev.core}</span><span class="${cls}">${t}</span></div>`;
  }).join('');
}

function renderAll() {
  updateListing(); renderCores(); renderMem(); renderStatus(); renderTimeline(); renderLog();
  $('schedBtn').disabled = S.m.done();
  $('autoBtn').disabled = S.m.done() && !S.timer;
}

function doStep(id) {
  if (id === null || S.m.cores[id].halted) return;
  S.prevRegs = S.m.cores.map(c => Array.from(c.regs));
  S.m.step(id); S.cur = id;
  renderAll();
}
function schedStep() {
  const id = pickCore(S.m, S.cur, getP());
  if (id === null) { stopAuto(); return; }
  doStep(id);
  if (S.m.done()) stopAuto();
}
function getP() { return +$('pSlider').value / 100; }

function startAuto() {
  if (S.m.done()) return;
  S.timer = setInterval(() => { if (S.m.steps > 5000) { stopAuto(); return; } schedStep(); }, +$('speed').value);
  $('autoBtn').textContent = '一時停止';
}
function stopAuto() {
  if (S.timer) clearInterval(S.timer);
  S.timer = null; $('autoBtn').textContent = '自動実行';
  $('autoBtn').disabled = S.m && S.m.done();
}

function resetMachine() {
  stopAuto();
  S.m = new Lab(S.prog); S.cur = null; S.prevRegs = null;
  renderAll();
}

function loadLesson(li, vi) {
  S.lesson = li; S.variant = vi; S.edited = false;
  S.code = LESSONS[li].variants[vi].code;
  S.prog = asm(S.code); S.rows = computeRows(S.code);
  $('codeArea').value = S.code; $('asmErr').textContent = '';
  $('trialOut').innerHTML = `<p class="note" style="margin-top:10px">現在のプログラムを、上のコア切り替え確率でランダムにスケジュールして1000回動かし、最終的な counter の値の分布を出します。</p>`;
  renderNav(); renderLesson(); renderListing(); resetMachine();
  try { localStorage.setItem('atomiclab.pos', JSON.stringify([li, vi])); } catch (e) {}
}

/* ---------------- Trials ---------------- */
function runTrials() {
  stopAuto();
  const N = 1000, p = getP(), dist = {};
  let ok = 0, viol = 0, steps = 0, timeouts = 0, fails = 0;
  for (let t = 0; t < N; t++) {
    const m = new Lab(S.prog, false);
    let cur = null;
    while (!m.done() && m.steps < 4000) { cur = pickCore(m, cur, p); m.step(cur); }
    if (!m.done()) { timeouts++; continue; }
    const c = m.mem(0);
    dist[c] = (dist[c] || 0) + 1;
    if (c === EXPECTED && m.csViol === 0) ok++;
    if (m.csViol) viol++;
    steps += m.steps; fails += m.fails[0] + m.fails[1];
  }
  const keys = Object.keys(dist).map(Number);
  const lo = Math.min(...keys, EXPECTED), hi = Math.max(...keys, EXPECTED);
  const xs = []; for (let k = lo; k <= hi; k++) xs.push(k);
  const mx = Math.max(...Object.values(dist), 1);
  const done = N - timeouts;
  $('trialSub').textContent = `切り替え確率 ${Math.round(p * 100)}% · ${N} 回`;
  $('trialOut').innerHTML = `
    <div class="hist" role="img" aria-label="最終値の分布">${xs.map(k => `<div class="bar${k === EXPECTED ? ' exp' : ''}"><span class="c">${dist[k] || 0}</span><i style="height:${((dist[k] || 0) / mx * 100).toFixed(1)}%"></i></div>`).join('')}</div>
    <div class="hist-x">${xs.map(k => `<span style="${k === EXPECTED ? 'color:var(--ok);font-weight:600' : ''}">${k}</span>`).join('')}</div>
    <p class="note" style="text-align:center">最終的な counter の値（緑 = 期待値 ${EXPECTED}）</p>
    <div class="trial-sum">
      <div><div class="k">正しい結果</div><div class="v" style="color:${ok === done ? 'var(--ok)' : 'var(--bad)'}">${(ok / N * 100).toFixed(1)}%</div></div>
      <div><div class="k">平均ステップ</div><div class="v">${done ? (steps / done).toFixed(1) : '—'}</div></div>
      <div><div class="k">平均 失敗・待ち</div><div class="v">${done ? (fails / done).toFixed(1) : '—'}</div></div>
    </div>
    ${viol ? `<p class="note" style="margin-top:8px;color:var(--bad)">${viol} 回の試行で2コアが同時にクリティカルセクションへ入りました。</p>` : ''}
    ${timeouts ? `<p class="note" style="margin-top:8px">${timeouts} 回は 4000 ステップ以内に終わらなかったため集計から除いています。</p>` : ''}`;
}

/* ---------------- Wiring ---------------- */
$('schedBtn').onclick = () => { stopAuto(); schedStep(); };
$('autoBtn').onclick = () => (S.timer ? stopAuto() : startAuto());
$('resetBtn').onclick = resetMachine;
$('trialBtn').onclick = runTrials;
$('pSlider').oninput = () => { $('pOut').textContent = $('pSlider').value + '%'; };
document.querySelectorAll('.presets button').forEach(b => { b.onclick = () => { $('pSlider').value = b.dataset.p; $('pOut').textContent = b.dataset.p + '%'; }; });
$('speed').onchange = () => { if (S.timer) { stopAuto(); startAuto(); } };
$('applyBtn').onclick = () => {
  try {
    const code = $('codeArea').value;
    const p = asm(code);
    if (!p.instrs.length) throw { line: 1, msg: '命令がありません' };
    S.prog = p; S.code = code; S.rows = computeRows(code); S.edited = true; $('asmErr').textContent = '';
    renderLesson(); renderListing(); resetMachine();
  } catch (e) { $('asmErr').textContent = e.line ? `${e.line} 行目: ${e.msg}` : String(e.msg || e); }
};
$('revertBtn').onclick = () => loadLesson(S.lesson, S.variant);
document.addEventListener('keydown', e => {
  if (e.target.closest('textarea, input, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '1') { stopAuto(); doStep(0); }
  else if (e.key === '2') { stopAuto(); doStep(1); }
  else if (e.key === ' ') { if (e.target.closest('button')) return; e.preventDefault(); stopAuto(); schedStep(); }
  else if (e.key === 'r' || e.key === 'R') resetMachine();
});

/* 最初は、レッスン1 を典型的な更新消失の順番まで進めた状態で開く */
(function init() {
  let pos = [0, 0];
  try { const s = JSON.parse(localStorage.getItem('atomiclab.pos')); if (Array.isArray(s) && LESSONS[s[0]] && LESSONS[s[0]].variants[s[1]]) pos = s; } catch (e) {}
  loadLesson(pos[0], pos[1]);
  if (pos[0] === 0 && pos[1] === 0) { for (let i = 0; i < 8; i++) { S.prevRegs = S.m.cores.map(c => Array.from(c.regs)); S.m.step(i % 2); S.cur = i % 2; } renderAll(); }
})();
