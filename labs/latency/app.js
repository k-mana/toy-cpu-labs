/* レイテンシ・ラボ (LT-1 構成) — シミュレータ本体 (../../core) の上に作ったラボ
 * Machine が命令の意味を、InOrderModel + MemoryHierarchy が「何サイクル待ったか」を計算する。 */
import { createISA, BASE, MULDIV, assemble, Machine, MemoryHierarchy, InOrderModel } from '../../core/index.js';
import { LESSONS, MEM_BYTES } from './lessons.js';

const isa = createISA([BASE, MULDIV]);
const NLINES = 8192, RECENT = 22;   // メモリマップに描くのは先頭 512KB (8192 ライン)
const LVN = ['L1', 'L2', 'L3', 'DRAM'];
const KIND = { alu: 'alu', system: 'alu', mul: 'mul', div: 'mul', load: 'ld', rmw: 'ld', store: 'st', branch: 'br', jump: 'br' };

function asm(code) {
  const { program, errors } = assemble(code, { isa });
  if (!program) throw { line: errors[0].line, msg: errors[0].message };
  return program;
}

/** 旧 LT-1 の CPU と同じ顔を持つ入れ物: 機能シミュレータ + タイミングモデル */
class LTCPU {
  constructor(prog, cfg, init) {
    this.prog = prog; this.cfg = cfg;
    this.H = new MemoryHierarchy({
      lineSize: 64, memoryLatency: cfg.dram, memorySize: MEM_BYTES, prefetch: cfg.pf ? 2 : 0,
      levels: [{ name: 'L1', size: 4096, latency: cfg.l1 }, { name: 'L2', size: 32768, latency: cfg.l2 }, { name: 'L3', size: 131072, latency: cfg.l3 }],
    });
    this.model = new InOrderModel({ latency: { mul: cfg.mul, div: cfg.div }, mispredictPenalty: cfg.pen, mshr: cfg.mshr, branch: 'bimodal', hierarchy: this.H });
    this.m = new Machine({ program: prog, memSize: MEM_BYTES, init });
    this.rowSt = prog.lines.map(() => ({ n: 0, cyc: 0 }));
    this.recent = []; this.lastLine = -1; this.lastLvl = -1; this.n = 0; this.error = null;
    if (this.halted) this.model.finish();
  }
  get core() { return this.m.cores[0]; }
  get r() { return this.core.regs; }
  get pc() { return this.core.pc; }
  get halted() { return this.core.halted; }
  get t() { return this.model.t; }
  readyOf(i) { const x = this.model.ready.get(i); return x ? x.at : 0; }
  cycles() { return this.model.cycles; }
  get st() {
    const s = this.model.stats, h = this.H.stats;
    return { base: s.issued, mem: s.mem, alu: s.alu, brm: s.brm, hits: h.hits, loads: s.loads, br: s.branches, mis: s.mispredicts, pf: h.prefetches };
  }
  step() {
    if (this.halted) return null;
    const rec = this.m.step(0);
    if (rec.trap) { this.error = `${rec.ins.line} 行目: ${rec.trap}`; this.model.finish(); return null; }
    const t = this.model.push(rec);
    const row = rec.ins.line - 1, cls = rec.ins.def.class;
    const out = { pc: rec.pc, row, txt: rec.ins.src.replace(/\s+/g, ' '), kind: KIND[cls] || 'alu', from: t.from, issue: t.issue, done: t.done, stall: t.stall, cat: t.cause, lvl: t.level, lat: t.latency, mis: t.mispredicted, penEnd: t.penEnd };
    const rs = this.rowSt[row]; rs.n++; rs.cyc += t.stall + 1 + (t.mispredicted ? this.cfg.pen : 0);
    if (rec.mem.length && (cls === 'load' || cls === 'store' || cls === 'rmw')) { this.lastLine = Math.floor(rec.mem[0].addr / 64); this.lastLvl = cls === 'store' ? -1 : t.level; }
    this.n++;
    this.recent.push(out); if (this.recent.length > RECENT) this.recent.shift();
    if (this.halted) this.model.finish();
    return out;
  }
  run(limit = 3e6) { while (!this.halted && this.n < limit && !this.error) this.step(); if (!this.halted) this.model.finish(); }
}

/* ================= State ================= */
const DEF = { l1:4, l2:12, l3:40, dram:200, mul:3, div:20, pen:15, mshr:8, ghz:3, pf:false };
const CFG_IDS = { l1:"cfgL1", l2:"cfgL2", l3:"cfgL3", dram:"cfgDram", mul:"cfgMul", div:"cfgDiv", pen:"cfgPen", mshr:"cfgMshr", ghz:"cfgGhz" };
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[ch]));
const fmt = n => Math.round(n).toLocaleString("ja-JP");
const S = { lesson:0, variant:0, edited:false, prog:null, m:null, cfg:{ ...DEF }, timer:null, cmp:[] };

function curInit(){ return LESSONS[S.lesson].variants[S.variant].init; }

const MNEMONICS = [...isa.defs.keys(), ...isa.pseudos.keys()];
const BRANCHES = MNEMONICS.filter(m => { const d = isa.defs.get(m); return d ? d.class === 'branch' || d.class === 'jump' : /^(B|J|CALL|RET)/.test(m); });
const BR_RE = new RegExp('\\b(' + BRANCHES.join('|') + ')\\b', 'gi');
const OP_RE = new RegExp('\\b(' + MNEMONICS.filter(m => !BRANCHES.includes(m)).join('|') + ')\\b', 'gi');
/* ================= Rendering ================= */
function hl(line){
  const i = line.indexOf(";");
  const code = i >= 0 ? line.slice(0, i) : line, com = i >= 0 ? line.slice(i) : "";
  let h = esc(code)
    .replace(/(-?(?:0x[0-9a-f]+|\d+)?\(r\d+\))/gi, '<span class="mem">$1</span>')
    .replace(/\b(r(?:1[0-5]|\d))\b(?![^<]*<\/span>)/g, '<span class="reg">$1</span>')
    .replace(BR_RE, '<span class="br">$1</span>')
    .replace(OP_RE, '<span class="op">$1</span>')
    .replace(/^(\s*)([A-Za-z_]\w*:)/, '$1<span class="lbl">$2</span>');
  return h + (com ? `<span class="com">${esc(com)}</span>` : "");
}

function renderNav(){
  $("lessonNav").innerHTML = LESSONS.map((L, i) =>
    `<button data-i="${i}" aria-current="${i === S.lesson}"><span class="n">${i + 1}</span>${esc(L.title)}</button>`).join("");
  $("lessonNav").querySelectorAll("button").forEach(b => b.onclick = () => loadLesson(+b.dataset.i, 0));
}

function renderLesson(){
  const L = LESSONS[S.lesson];
  const vs = L.variants.map((v, i) => {
    const c = S.cmp[i];
    const right = (S.edited && i === S.variant) ? "編集済み" : c ? `${fmt(c.cycles)} サイクル` : "";
    return `<button data-i="${i}" aria-pressed="${i === S.variant}"><span>${esc(v.name)}</span><span class="cyc">${right}</span></button>`;
  }).join("");
  $("lessonCard").innerHTML = `
    <div><div class="eyebrow">レッスン ${S.lesson + 1} / ${LESSONS.length}</div><h2>${esc(L.title)}</h2></div>
    <div class="body">${L.body.map(p => `<p>${esc(p)}</p>`).join("")}</div>
    <div><h3>プログラム</h3><div class="variants">${vs}</div></div>
    <div><h3>試してみよう</h3><ol class="tasks">${L.tasks.map(t => `<li>${esc(t)}</li>`).join("")}</ol></div>
    <div class="point">${esc(L.point)}</div>`;
  $("lessonCard").querySelectorAll(".variants button").forEach(b => b.onclick = () => loadLesson(S.lesson, +b.dataset.i));
}

function renderListing(){
  $("listing").innerHTML = `<div class="lrow head"><span></span><span></span><span class="src">コード</span><span class="cnt">実行回数</span><span class="heat"><span>サイクル</span></span></div>` +
    S.prog.lines.map((r, i) => `<div class="lrow" data-row="${i}"><span class="g"></span><span class="ln">${i + 1}</span><span class="src">${hl(r.text) || " "}</span><span class="cnt"></span><span class="heat"><i></i><span></span></span></div>`).join("");
}
function updateListing(){
  const m = S.m, rows = $("listing").querySelectorAll(".lrow[data-row]");
  const tot = Math.max(1, m.cycles());
  const mx = Math.max(1, ...m.rowSt.map(r => r.cyc));
  const curRow = !m.halted && m.prog.instrs[m.pc] ? m.prog.instrs[m.pc].line - 1 : -1;
  const last = m.recent.length ? m.recent[m.recent.length - 1].row : -1;
  rows.forEach((el, i) => {
    const st = m.rowSt[i];
    el.querySelector(".g").innerHTML = i === curRow ? `<i class="pcm" title="次に発行する命令">PC</i>` : "";
    el.classList.toggle("now", i === last);
    el.querySelector(".cnt").textContent = st.n ? fmt(st.n) : "";
    const bar = el.querySelector(".heat i"), lab = el.querySelector(".heat span");
    if (st.cyc) { bar.style.width = (st.cyc / mx * 36).toFixed(1) + "px"; lab.textContent = (st.cyc / tot * 100).toFixed(st.cyc / tot >= .1 ? 0 : 1) + "%"; }
    else { bar.style.width = "0"; lab.textContent = ""; }
  });
}

function renderStatus(){
  const m = S.m, cyc = m.cycles(), st = m.st, C = S.cfg;
  const ns = cyc / C.ghz;
  const time = ns >= 1e6 ? (ns / 1e6).toFixed(2) + " ms" : ns >= 1e3 ? (ns / 1e3).toFixed(2) + " µs" : ns.toFixed(0) + " ns";
  const cpi = m.n ? (cyc / m.n).toFixed(2) : "—";
  const l1 = st.loads ? (st.hits[0] / st.loads * 100).toFixed(1) + "%" : "—";
  const mr = st.br ? (st.mis / st.br * 100).toFixed(1) + "%" : "—";
  const state = m.halted ? "完了" : m.n ? "実行中" : "未実行";
  $("kpis").innerHTML = `
    <div><div class="k">総サイクル · ${state}</div><div class="v">${fmt(cyc)}</div><div class="s">${C.ghz} GHz で ${time}</div></div>
    <div><div class="k">実行した命令</div><div class="v">${fmt(m.n)}</div><div class="s">CPI ${cpi}</div></div>
    <div><div class="k">ロード</div><div class="v">${fmt(st.loads)}</div><div class="s">L1 ヒット ${l1}</div></div>
    <div><div class="k">DRAM まで行った</div><div class="v" style="color:${st.hits[3] ? "var(--dram)" : "inherit"}">${fmt(st.hits[3])}</div><div class="s">プリフェッチ ${fmt(st.pf)}</div></div>
    <div><div class="k">分岐予測ミス</div><div class="v" style="color:${st.mis ? "var(--brm)" : "inherit"}">${fmt(st.mis)}</div><div class="s">ミス率 ${mr}</div></div>`;
  const parts = [["base", "命令の発行", st.base], ["mem", "メモリ待ち", st.mem], ["alu", "演算待ち", st.alu], ["brm", "分岐予測ミス", st.brm]];
  const sum = Math.max(1, parts.reduce((s, p) => s + p[2], 0));
  $("stack").innerHTML = parts.map(p => `<i class="c-${p[0]}" style="width:${(p[2] / sum * 100).toFixed(2)}%" title="${p[1]} ${fmt(p[2])}"></i>`).join("");
  $("stackLegend").innerHTML = parts.map(p => `<span><i class="sw c-${p[0]}"></i>${p[1]} <b>${(p[2] / sum * 100).toFixed(1)}%</b></span>`).join("");
}

function renderRegs(){
  const m = S.m, t = m.t;
  $("regs").innerHTML = [...m.r].map((v, i) => {
    const w = m.readyOf(i) - t;
    return `<div class="reg-c${w > 0 ? " wait" : ""}"><span>r${i}</span><b title="${v}">${v}</b><em>${w > 0 ? `あと ${w}` : ""}</em></div>`;
  }).join("");
}

function renderLevels(){
  const m = S.m, C = S.cfg, st = m.st, last = m.recent.length ? m.recent[m.recent.length - 1] : null;
  const lats = [C.l1, C.l2, C.l3, C.dram], caps = ["4KB", "32KB", "128KB", "512KB"], cols = ["--l1", "--l2", "--l3", "--dram"];
  $("levels").innerHTML = LVN.map((n, i) => {
    const pct = st.loads ? (st.hits[i] / st.loads * 100).toFixed(1) + "%" : "—";
    const hit = last && last.lvl === i;
    return `<div class="lv${hit ? " hit" : ""}" style="--lc:var(${cols[i]})"><div class="nm">${n}</div><div class="lt">${lats[i]} cyc · ${caps[i]}</div><div class="hc">${fmt(st.hits[i])}</div><div class="hp">ロードの ${pct}</div></div>`;
  }).join("");
  drawMap();
}

function drawMap(){
  const cv = $("map"), ctx = cv.getContext("2d"), cs = getComputedStyle(document.documentElement);
  const col = n => cs.getPropertyValue(n).trim();
  const W = 128, CELL = 4;
  ctx.fillStyle = col("--sunk"); ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = col("--line");
  for (let l = 0; l < NLINES; l++) ctx.fillRect((l % W) * CELL, Math.floor(l / W) * CELL, CELL - 1, CELL - 1);
  const paint = (lv, c) => { ctx.fillStyle = c; for (const l of S.m.H.residentLines(lv)) if (l < NLINES) ctx.fillRect((l % W) * CELL, Math.floor(l / W) * CELL, CELL - 1, CELL - 1); };
  paint(2, col("--l3")); paint(1, col("--l2")); paint(0, col("--l1"));
  if (S.m.lastLine >= 0) {
    const l = S.m.lastLine; ctx.strokeStyle = col("--ink"); ctx.lineWidth = 1.5;
    ctx.strokeRect((l % W) * CELL - 2, Math.floor(l / W) * CELL - 2, CELL + 3, CELL + 3);
  }
}

function renderGantt(){
  const R = S.m.recent, C = S.cfg;
  if (!R.length) { $("gantt").innerHTML = `<p class="note">まだ何も実行していません。「1命令」かスペースキーで進めると、ここに命令ごとの待ち時間と実行時間が並びます。</p>`; $("ganttSub").textContent = "直近の命令。横軸 = サイクル"; return; }
  const x0 = Math.min(...R.map(r => r.from));
  const x1 = Math.max(...R.map(r => Math.max(r.done, r.penEnd || 0, r.issue + 1)));
  const span = Math.max(x1 - x0, 12);
  const P = x => ((x - x0) / span * 100).toFixed(3) + "%", W = n => (n / span * 100).toFixed(3) + "%";
  const rows = R.map(r => {
    let b = "";
    if (r.stall > 0) b += `<span class="gb stall" style="left:${P(r.from)};width:${W(r.stall)}"></span>`;
    const k = r.kind === "ld" ? "k-l" + r.lvl : "k-" + r.kind;
    b += `<span class="gb ${k}" style="left:${P(r.issue)};width:${W(r.done - r.issue)}"></span>`;
    if (r.mis) b += `<span class="gb mis" style="left:${P(r.issue + 1)};width:${W(C.pen)}"></span>`;
    let info = "", cls = "";
    if (r.mis) { info = `予測ミス +${C.pen}`; cls = " mis"; }
    else if (r.kind === "ld") info = `${LVN[r.lvl]} ${r.lat}`;
    else if (r.kind === "mul") info = `${r.done - r.issue} cyc`;
    if (r.stall > 0) info = `待ち ${r.stall}` + (info ? " · " + info : "");
    return `<div class="gr"><span class="gl" title="${esc(r.txt)}">${esc(r.txt)}</span><div class="track">${b}</div><span class="gi${cls}">${info}</span></div>`;
  }).join("");
  const mid = Math.round(x0 + span / 2);
  $("gantt").innerHTML = `<div class="gr gaxis"><span class="gl" style="color:var(--muted)">命令</span><div class="track"><span class="tick l" style="left:0">${fmt(x0)}</span><span class="tick" style="left:50%">${fmt(mid)}</span><span class="tick r" style="left:100%">${fmt(x0 + span)}</span></div><span class="gi">待ち · 時間</span></div>` + rows;
  $("ganttSub").textContent = `直近 ${R.length} 命令 · サイクル ${fmt(x0)}〜${fmt(x0 + span)}`;
}

function runCompare(){
  const L = LESSONS[S.lesson];
  S.cmp = L.variants.map(v => {
    const cpu = new LTCPU(asm(v.code), S.cfg, v.init); cpu.run();
    return { name: v.name, cycles: cpu.cycles(), n: cpu.n, st: cpu.st, done: cpu.halted };
  });
  if (S.edited) {
    const cpu = new LTCPU(S.prog, S.cfg, curInit()); cpu.run();
    S.cmp.push({ name: "編集したコード", cycles: cpu.cycles(), n: cpu.n, st: cpu.st, done: cpu.halted, edited: true });
  }
  renderCompare(); renderLesson();
}
function renderCompare(){
  const mx = Math.max(...S.cmp.map(c => c.cycles), 1), mn = Math.min(...S.cmp.map(c => c.cycles));
  $("cmp").innerHTML = S.cmp.map((c, i) => {
    const st = c.st, sum = Math.max(1, st.base + st.mem + st.alu + st.brm), w = c.cycles / mx * 100;
    const seg = [["base", st.base], ["mem", st.mem], ["alu", st.alu], ["brm", st.brm]].map(p => `<i class="c-${p[0]}" style="width:${(p[1] / sum * 100).toFixed(2)}%"></i>`).join("");
    const cur = c.edited ? S.edited : (!S.edited && i === S.variant);
    const ratio = mn ? (c.cycles / mn) : 1;
    return `<div class="it${cur ? " cur" : ""}"><div class="top2"><b>${esc(c.name)}</b><span><strong>${fmt(c.cycles)}</strong> cyc · CPI ${(c.cycles / Math.max(1, c.n)).toFixed(2)} · ${ratio < 1.005 ? "最速" : "×" + ratio.toFixed(1)}</span></div>
      <div class="stack" style="width:${Math.max(w, 1).toFixed(2)}%">${seg}</div>${c.done ? "" : `<p class="note">300万命令で打ち切り</p>`}</div>`;
  }).join("") + `<div class="legend"><span><i class="sw c-base"></i>命令の発行</span><span><i class="sw c-mem"></i>メモリ待ち</span><span><i class="sw c-alu"></i>演算待ち</span><span><i class="sw c-brm"></i>分岐予測ミス</span></div>`;
  $("cmpSub").textContent = `現在の設定で最後まで実行${S.cfg.pf ? " · プリフェッチ有効" : ""}`;
}

function human(sec){
  if (sec < 60) return `${+sec.toFixed(sec < 10 ? 0 : 0)}秒`;
  if (sec < 3600) { const m = Math.floor(sec / 60), s = Math.round(sec % 60); return s ? `${m}分${s}秒` : `${m}分`; }
  if (sec < 86400) return `約${(sec / 3600).toFixed(1).replace(/\.0$/, "")}時間`;
  if (sec < 86400 * 365) return `約${(sec / 86400).toFixed(sec < 864000 ? 1 : 0).replace(/\.0$/, "")}日`;
  return `約${(sec / 86400 / 365).toFixed(1).replace(/\.0$/, "")}年`;
}
function realTime(cyc, ghz){
  const ns = cyc / ghz;
  if (ns < 1000) return (ns < 10 ? ns.toFixed(1) : Math.round(ns)) + " ns";
  if (ns < 1e6) return +(ns / 1e3).toFixed(1) + " µs";
  if (ns < 1e9) return +(ns / 1e6).toFixed(1) + " ms";
  return +(ns / 1e9).toFixed(1) + " s";
}
function renderRuler(){
  const C = S.cfg, g = C.ghz;
  const sim = [["ADD", 1, "--cpu"], ["MUL", C.mul, "--mul"], ["L1 ヒット", C.l1, "--l1"], ["L2 ヒット", C.l2, "--l2"], ["分岐予測ミス", C.pen, "--brm"], ["DIV", C.div, "--mul"], ["L3 ヒット", C.l3, "--l3"], ["DRAM", C.dram, "--dram"]].sort((a, b) => a[1] - b[1]);
  const real = [["NVMe SSD 読み出し", 100e3], ["データセンター内往復", 500e3], ["HDD シーク", 10e6], ["東京↔米西海岸 往復", 100e6]].map(([n, ns]) => [n, ns * g, "--muted"]);
  const lmax = Math.log10(real[real.length - 1][1] * 1.2);
  const row = (r, sep) => `<div class="rr${sep ? " sep" : ""}"><span class="rn">${esc(r[0])}</span><span class="rb"><i style="width:${(Math.log10(Math.max(1, r[1])) / lmax * 100 + 1).toFixed(1)}%;--rc:var(${r[2]})"></i></span><span class="rh">${human(r[1])}<span class="rt">${realTime(r[1], g)}</span></span></div>`;
  $("ruler").innerHTML = `<div class="rr head"><span>操作</span><span>対数目盛</span><span style="text-align:right">1サイクル=1秒なら</span></div>` +
    sim.map(r => row(r)).join("") + real.map((r, i) => row(r, i === 0)).join("");
  $("rulerSub").textContent = `クロック ${g} GHz`;
}

function renderAll(){
  updateListing(); renderStatus(); renderRegs(); renderLevels(); renderGantt();
  const done = S.m.halted;
  ["stepBtn", "step100Btn", "endBtn"].forEach(id => $(id).disabled = done);
  $("autoBtn").disabled = done && !S.timer;
}

/* ================= Control ================= */
function stepN(k){ for (let i = 0; i < k && !S.m.halted && !S.m.error; i++) S.m.step(); renderAll(); if (S.m.halted || S.m.error) stopAuto(); if (S.m.error) $("asmErr").textContent = S.m.error; }
const SPEEDS = { slow:[1, 450], mid:[1, 140], fast:[40, 40] };
function startAuto(){
  if (S.m.halted) return;
  const [k, ms] = SPEEDS[$("speed").value];
  S.timer = setInterval(() => stepN(k), ms);
  $("autoBtn").textContent = "一時停止";
}
function stopAuto(){
  if (S.timer) clearInterval(S.timer);
  S.timer = null; $("autoBtn").textContent = "自動実行";
  if (S.m) $("autoBtn").disabled = S.m.halted;
}
function resetMachine(){ stopAuto(); S.m = new LTCPU(S.prog, S.cfg, curInit()); renderAll(); }

function loadLesson(li, vi){
  S.lesson = li; S.variant = vi; S.edited = false;
  const code = LESSONS[li].variants[vi].code;
  S.prog = asm(code);
  $("codeArea").value = code; $("asmErr").textContent = "";
  renderNav(); renderListing(); resetMachine(); runCompare();
  try { localStorage.setItem("latencylab.pos", JSON.stringify([li, vi])); } catch (e) {}
}

function syncCfgInputs(){ for (const k in CFG_IDS) $(CFG_IDS[k]).value = S.cfg[k]; $("cfgPf").checked = S.cfg.pf; }
function readCfg(){
  for (const k in CFG_IDS) {
    const el = $(CFG_IDS[k]); let v = Number(el.value);
    if (!isFinite(v) || v <= 0) v = k === "pen" && v === 0 ? 0 : DEF[k];
    v = Math.min(Number(el.max), Math.max(Number(el.min), v));
    if (k !== "ghz") v = Math.round(v);
    S.cfg[k] = v;
  }
  S.cfg.pf = $("cfgPf").checked;
  syncCfgInputs(); resetMachine(); runCompare(); renderRuler();
}

$("stepBtn").onclick = () => { stopAuto(); stepN(1); };
$("step100Btn").onclick = () => { stopAuto(); stepN(100); };
$("endBtn").onclick = () => { stopAuto(); S.m.run(); renderAll(); };
$("autoBtn").onclick = () => S.timer ? stopAuto() : startAuto();
$("resetBtn").onclick = resetMachine;
$("speed").onchange = () => { if (S.timer) { stopAuto(); startAuto(); } };
for (const k in CFG_IDS) $(CFG_IDS[k]).addEventListener("change", readCfg);
$("cfgPf").addEventListener("change", readCfg);
$("cfgReset").onclick = () => { S.cfg = { ...DEF }; syncCfgInputs(); readCfg(); };
$("applyBtn").onclick = () => {
  try {
    const p = asm($("codeArea").value);
    if (!p.instrs.length) throw { line: 1, msg: "命令がありません" };
    S.prog = p; S.edited = true; $("asmErr").textContent = "";
    renderListing(); resetMachine(); runCompare();
  } catch (e) { $("asmErr").textContent = e.line ? `${e.line} 行目: ${e.msg}` : String(e.msg || e); }
};
$("revertBtn").onclick = () => loadLesson(S.lesson, S.variant);
document.addEventListener("keydown", e => {
  if (e.target.closest("textarea, input, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === " ") { if (e.target.closest("button")) return; e.preventDefault(); stopAuto(); stepN(1); }
  else if (e.key === "n" || e.key === "N") { stopAuto(); stepN(100); }
  else if (e.key === "e" || e.key === "E") { stopAuto(); S.m.run(); renderAll(); }
  else if (e.key === "r" || e.key === "R") resetMachine();
});
if (window.matchMedia) { const mq = window.matchMedia("(prefers-color-scheme: dark)"); if (mq.addEventListener) mq.addEventListener("change", drawMap); }
new MutationObserver(() => S.m && drawMap()).observe(document.documentElement, { attributes:true, attributeFilter:["data-theme"] });

(function init(){
  let pos = [0, 0];
  try { const s = JSON.parse(localStorage.getItem("latencylab.pos")); if (Array.isArray(s) && LESSONS[s[0]] && LESSONS[s[0]].variants[s[1]]) pos = s; } catch (e) {}
  syncCfgInputs(); renderRuler();
  loadLesson(pos[0], pos[1]);
  stepN(24); /* open mid-run so the pipeline chart already shows a DRAM miss followed by L1 hits */
})();
