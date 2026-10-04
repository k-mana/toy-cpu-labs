/* スループット・ラボ — シミュレータ本体 (../../core) の上に作ったラボ
 * Machine でプログラムを実行してトレースを取り、PipelineModel で構成ごとのサイクルを計算する。 */
import { createISA, BASE, MULDIV, assemble, Machine, PipelineModel, randomMissTime, STAGES } from '../../core/index.js';
import { PRESETS, CHALLENGES, MEM_BYTES, initMemory } from './lessons.js';

const isa = createISA([BASE, MULDIV]);
const MAXDYN = 500, MISS_PENALTY = 8;
const STAGE = STAGES;
const PRED_NAME = { stall: '分岐で停止', 'not-taken': '不成立予測', bimodal: '2ビット予測', perfect: '完全予測' };
const S = { preset: 'sum', edited: false, cfg: { pipelined: true, width: 1, forwarding: false, predictor: 'not-taken', mulLat: 3, miss: 0, freq: 1000 },
  run: null, cursor: 0, timer: null, history: [], done: {} };
const $ = id => document.getElementById(id);
const fmt = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '–';
const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
function load() {
  try { const h = JSON.parse(localStorage.getItem('toy5-history') || '[]'); if (Array.isArray(h)) S.history = h.slice(0, 12); } catch (e) {}
  try { S.done = JSON.parse(localStorage.getItem('toy5-done') || '{}') || {}; } catch (e) {}
}
function save() { try { localStorage.setItem('toy5-history', JSON.stringify(S.history)); localStorage.setItem('toy5-done', JSON.stringify(S.done)); } catch (e) {} }

/* ===================== UI: program ===================== */
function renderTabs() {
  $('tabs').innerHTML = PRESETS.map(p => `<button class="tab" data-id="${p.id}" aria-pressed="${p.id === S.preset}">${p.name}<small>${p.tag}</small></button>`).join('');
  const p = PRESETS.find(p => p.id === S.preset); $('pdesc').textContent = p.desc + (S.edited ? '（編集済み）' : '');
}
$('tabs').addEventListener('click', e => {
  const b = e.target.closest('.tab'); if (!b) return;
  S.preset = b.dataset.id; S.edited = false; $('src').value = PRESETS.find(p => p.id === S.preset).src; renderTabs(); simulate(true);
});
let srcT; $('src').addEventListener('input', () => { S.edited = $('src').value !== PRESETS.find(p => p.id === S.preset).src; renderTabs(); clearTimeout(srcT); srcT = setTimeout(() => simulate(true), 350); });

/* ===================== UI: config ===================== */
function syncCfg() {
  document.querySelectorAll('.seg').forEach(seg => { const k = seg.dataset.key; seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v) === String(S.cfg[k]))); });
  for (const k of ['mulLat', 'miss', 'freq']) $(k).value = S.cfg[k];
  $('v-mulLat').textContent = S.cfg.mulLat + ' サイクル'; $('v-miss').textContent = S.cfg.miss + ' %'; $('v-freq').textContent = S.cfg.freq + ' MHz';
  const wseg = document.querySelector('.seg[data-key="width"]'); wseg.querySelectorAll('button').forEach(b => { b.disabled = !S.cfg.pipelined; });
  wseg.style.opacity = S.cfg.pipelined ? 1 : 0.45;
}
document.querySelectorAll('.seg').forEach(seg => seg.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  const k = seg.dataset.key, v = b.dataset.v; S.cfg[k] = v === 'true' ? true : v === 'false' ? false : isNaN(+v) ? v : +v; syncCfg(); simulate(false);
}));
for (const k of ['mulLat', 'miss', 'freq']) $(k).addEventListener('input', e => { S.cfg[k] = +e.target.value; syncCfg(); simulate(false); });

/* ===================== simulate ===================== */
function simulate() {
  stop();
  const { program, errors } = assemble($('src').value, { isa });
  if (!program) { showErr(errors.map(e => `${e.line} 行目: ${e.message}`).slice(0, 3).join('\n')); return; }
  if (!program.instrs.length) { showErr('命令がありません'); return; }
  const m = new Machine({ program, memSize: MEM_BYTES, init: initMemory });
  const { trace, reason } = m.trace({ maxSteps: MAXDYN });
  const core = m.cores[0];
  if (core.trap) { showErr(`${core.trap.line} 行目: ${core.trap.message}`); return; }
  $('err').hidden = true;
  const cfg = S.cfg;
  const pipe = new PipelineModel({
    pipelined: cfg.pipelined, width: cfg.width, forwarding: cfg.forwarding, branch: cfg.predictor,
    units: { mul: { latency: cfg.mulLat, pipelined: false } },
    memTime: randomMissTime({ rate: cfg.miss, penalty: MISS_PENALTY, seed: 12345 }),
  });
  for (const r of trace) pipe.push(r);
  const sm = pipe.finish();
  S.run = { pipe, E: pipe.entries, N: sm.instructions, total: sm.cycles, ideal: sm.ideal, data: sm.data, ctrl: sm.ctrl, other: sm.other,
    lat: sm.latency, mispred: sm.mispredicts, branches: sm.branches, misses: sm.memSlow, W: pipe.cfg.width,
    mem: m.memory, capped: reason === 'limit', cfg: { ...cfg }, preset: S.preset, edited: S.edited };
  S.cursor = sm.cycles - 1;
  renderAll();
}
function showErr(t) { $('err').hidden = false; $('err').textContent = t; }
function mips(r) { return r.N / r.total * r.cfg.freq; }

/* ===================== render ===================== */
function renderAll() { renderMeters(); renderDiagram(); renderCursor(); renderBreakdown(); renderCompare(); renderChallenges(); }
function renderMeters() {
  const r = S.run, ipc = r.N / r.total, us = r.total / r.cfg.freq;
  const items = [
    ['hero', 'スループット', fmt(mips(r), 0), 'MIPS'],
    ['', 'IPC（命令/サイクル）', fmt(ipc), ''],
    ['', 'CPI（サイクル/命令）', fmt(1 / ipc), ''],
    ['', '総サイクル / 命令数', `${r.total}<span class="u">/ ${r.N}</span>`, ''],
    ['', '平均レイテンシ', fmt(r.lat, 1), 'サイクル'],
  ];
  $('meters').innerHTML = items.map(([c, k, v, u]) => `<div class="meter ${c}"><div class="k">${k}</div><div class="v">${v}${u ? `<span class="u">${u}</span>` : ''}</div></div>`).join('');
  $('meters').title = `実行時間 ${us < 1 ? fmt(us * 1000, 0) + ' ns' : fmt(us, 2) + ' µs'}`;
}
const MAXROWS = 48;
function cellOf(e, c) {
  const s = S.run.pipe.stageOf(e, c);
  if (s.stage < 0) return null;
  if (s.stalled) return { cls: 'st', txt: STAGE[s.stage][0].toLowerCase(), title: `${STAGE[s.stage]} で待機` };
  // そのステージで最初に働くサイクルにだけ名前を書く
  const prev = c > 0 ? S.run.pipe.stageOf(e, c - 1) : { stage: -1 };
  const first = prev.stage !== s.stage || prev.stalled;
  const miss = s.stage === 3 && e.slowMem && !first;
  return { cls: miss ? 'miss' : 's' + s.stage, txt: first ? STAGE[s.stage] : miss ? '' : '·' };
}
function renderDiagram() {
  const r = S.run, rows = Math.min(r.N, MAXROWS);
  const cols = Math.min(r.E[rows - 1].end + 2, 400);
  let h = `<thead><tr><th class="lab">命令（動的順）</th>`;
  for (let c = 0; c < cols; c++) h += `<th>${c}</th>`;
  h += '</tr></thead><tbody>';
  for (let i = 0; i < rows; i++) {
    const e = r.E[i], text = esc(e.ins.text);
    h += `<tr><td class="lab" title="${text}"><span class="pc">${String(e.pc).padStart(2, '0')}</span> ${text}</td>`;
    for (let c = 0; c < cols; c++) {
      const x = cellOf(e, c);
      h += x ? `<td class="${x.cls}" data-c="${c}"${x.title ? ` title="${x.title}"` : ''}>${x.txt}</td>` : '<td></td>';
    }
    h += '</tr>';
  }
  $('pd').innerHTML = h + '</tbody>';
  $('pipe-sub').textContent = `${r.cfg.pipelined ? '5段パイプライン' : '非パイプライン'} · ${r.W}命令幅 · ${r.cfg.forwarding ? 'フォワーディングあり' : 'フォワーディングなし'} · ${PRED_NAME[r.cfg.predictor]}`;
  const notes = [];
  if (r.N > MAXROWS) notes.push(`最初の ${MAXROWS} 命令を表示しています（全 ${r.N} 命令。数値は全命令で計算）。`);
  if (r.capped) notes.push(`実行命令数が上限の ${MAXDYN} に達したため打ち切りました。無限ループになっていないか確認してください。`);
  notes.push('左端の数字は命令番号（PC）。ループは同じ PC が何度も現れます。');
  $('dg-note').textContent = notes.join(' ');
}
function renderCursor() {
  const r = S.run, c = S.cursor;
  const occ = r.pipe.stagesAt(c);
  const col = ['--if', '--id', '--ex', '--mem', '--wb'];
  $('snap').innerHTML = occ.map((l, s) => `<div class="slot"><div class="sn" style="color:var(${col[s]})">${STAGE[s]}</div>${
    l.length ? l.map(x => { const t = esc(x.entry.ins.text), miss = s === 3 && x.entry.slowMem; return `<div class="si ${x.stalled ? 'stl' : ''}" title="${t}">${x.stalled ? '⏸ ' : ''}${t}${miss && !x.stalled ? ' ✕$' : ''}</div>`; }).join('') : '<div class="si bub">（空き）</div>'}</div>`).join('');
  const done = r.pipe.retiredBy(c);
  $('cyc').innerHTML = `サイクル <b>${c}</b> / ${r.total - 1} · 完了 ${done} 命令 · 途中IPC ${fmt(done / (c + 1))}`;
  const dg = $('dg'), table = $('pd'), cur = $('cursor');
  table.querySelectorAll('td[data-c]').forEach(td => td.classList.toggle('fut', +td.dataset.c > c));
  const th = table.querySelectorAll('thead th')[c + 1];
  if (th) {
    cur.hidden = false; cur.style.left = th.offsetLeft + 'px'; cur.style.height = table.offsetHeight + 'px';
    const lw = table.querySelector('.lab').offsetWidth; const x = th.offsetLeft;
    if (x < dg.scrollLeft + lw + 20 || x > dg.scrollLeft + dg.clientWidth - 60) dg.scrollLeft = Math.max(0, x - lw - dg.clientWidth * 0.35);
  } else cur.hidden = true;
  $('b-play').textContent = S.timer ? '⏸ 一時停止' : '▶ 再生';
}
function stop() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }
function setCursor(c) { S.cursor = Math.max(0, Math.min(S.run.total - 1, c)); renderCursor(); }
$('b-first').onclick = () => { stop(); setCursor(0); };
$('b-last').onclick = () => { stop(); setCursor(1e9); };
$('b-prev').onclick = () => { stop(); setCursor(S.cursor - 1); };
$('b-next').onclick = () => { stop(); setCursor(S.cursor + 1); };
function play() {
  stop(); if (S.cursor >= S.run.total - 1) S.cursor = 0;
  S.timer = setInterval(() => { if (S.cursor >= S.run.total - 1) { stop(); renderCursor(); return; } setCursor(S.cursor + 1); }, +$('speed').value); renderCursor();
}
$('b-play').onclick = () => { if (S.timer) { stop(); renderCursor(); } else play(); };
$('speed').onchange = () => { if (S.timer) play(); };

function renderBreakdown() {
  const r = S.run;
  const parts = [
    ['理想（パイプライン充填含む）', r.ideal, 'var(--accent)'],
    ['データハザード', r.data, 'var(--stall)'],
    ['制御ハザード（分岐）', r.ctrl, 'var(--id)'],
    ['メモリ・構造', r.other, 'var(--ex)'],
  ];
  const tot = parts.reduce((a, p) => a + p[1], 0) || 1;
  $('bar').innerHTML = parts.map(p => `<div style="width:${p[1] / tot * 100}%;background:${p[2]}" title="${p[0]} ${p[1]}"></div>`).join('');
  $('bk').innerHTML = parts.map(p => `<div class="it"><span class="sw" style="background:${p[2]}"></span>${p[0]}<b>${p[1]}<span class="u" style="font-size:11px;color:var(--muted)"> サイクル</span></b></div>`).join('');
  const c = r.cfg, ins = []; const ipc = r.N / r.total;
  if (!c.pipelined) ins.push(['各命令が5サイクルを占有し、次の命令は前の命令が終わるまで始まりません。パイプラインを「5段」にすると、レイテンシは同じままスループットが上がります。', '']);
  else {
    if (r.data > 0 && !c.forwarding) ins.push([`データハザードで ${r.data} サイクル失っています。フォワーディングを有効にすると、EX の結果を WB を待たずに次の命令へ渡せます。`, '']);
    else if (r.data > 0) ins.push([`フォワーディングがあってもデータハザードが ${r.data} サイクル残っています。ロード直後や乗算直後に結果を使っている箇所です。間に無関係な命令を挟む（並べ替える）とストールが消えます。`, '']);
    if (r.ctrl > 0 && (c.predictor === 'stall' || c.predictor === 'not-taken')) ins.push([`分岐で ${r.ctrl} サイクル失っています（${r.branches} 回の分岐）。ループの後ろ向き分岐はほぼ毎回成立するので、2ビット予測が効きます。`, '']);
    else if (r.ctrl > 0) ins.push([`予測ミス ${r.mispred} 回で ${r.ctrl} サイクル失っています。2ビット予測でもループの入口と出口では外れます。`, '']);
    if (r.misses > 0) ins.push([`キャッシュミスが ${r.misses} 回起き、1回あたり ${MISS_PENALTY} サイクル MEM が止まりました。後続命令もすべて待たされます。`, '']);
    if (c.width === 1 && ipc > 0.8) ins.push(['IPC が 1.0 に近づいています。これ以上を狙うなら2命令幅（スーパースカラ）を試してください。', 'ok']);
    if (c.width === 2 && ipc < 1.2 && r.data + r.ctrl + r.other > r.ideal * 0.3) ins.push(['2命令幅でも IPC が伸びていません。依存関係やストールがある間は、幅を増やしても並列に流せる命令がありません。', '']);
    if (c.width === 2 && ipc >= 1.2) ins.push([`IPC ${fmt(ipc)}。1サイクルに複数命令が完了しています。周波数を上げずにスループットを稼ぐ方法です。`, 'ok']);
  }
  const p = PRESETS.find(p => p.id === r.preset);
  if (p.expectMem) for (const [a, exp] of Object.entries(p.expectMem)) {
    const v = r.mem.readWord(+a);
    ins.push([`計算結果: メモリ[${a}] = ${v}${v === exp ? '（正解）' : `（期待値は ${exp}。並べ替えで結果が変わっていないか確認してください）`}`, v === exp ? 'ok' : '']);
  }
  $('insights').innerHTML = ins.map(([t, k]) => `<li class="${k}">${t}</li>`).join('');
}

/* ===================== compare ===================== */
function cfgSummary(c) { return `${c.pipelined ? '5段' : '非パイプ'}・${c.pipelined ? c.width : 1}幅・FWD${c.forwarding ? 'あり' : 'なし'}・${PRED_NAME[c.predictor]}・MUL${c.mulLat}・ミス${c.miss}%・${c.freq}MHz`; }
$('record').onclick = () => {
  const r = S.run; if (!r) return;
  const p = PRESETS.find(p => p.id === r.preset);
  S.history.unshift({ name: p.name + (r.edited ? '（編集）' : ''), cfg: cfgSummary(r.cfg), ipc: r.N / r.total, mips: mips(r), cycles: r.total });
  S.history = S.history.slice(0, 12); save(); renderCompare();
};
$('clear').onclick = () => { S.history = []; save(); renderCompare(); };
function renderCompare() {
  const H = S.history;
  if (!H.length) { $('cmp').innerHTML = '<div class="empty">構成を変えるたびに「この結果を比較表に記録」を押すと、ここに並んでスループットを比べられます。たとえば「フォワーディングなし → あり → 2ビット予測」の順に記録してみてください。</div>'; return; }
  const max = Math.max(...H.map(h => h.mips));
  $('cmp').innerHTML = `<div class="r h"><span>プログラム / 構成</span><span class="track-h">スループット</span><span class="n">IPC</span><span class="n">MIPS</span><span></span></div>` +
    H.map((h, i) => `<div class="r"><div class="nm"><b>${esc(h.name)}</b><small>${esc(h.cfg)}</small></div><div class="track"><div class="fill" style="width:${h.mips / max * 100}%"></div></div><span class="n">${fmt(h.ipc)}</span><span class="n">${fmt(h.mips, 0)}</span><button class="x" data-i="${i}" aria-label="この行を削除">×</button></div>`).join('');
}
$('cmp').addEventListener('click', e => { const b = e.target.closest('.x'); if (!b) return; S.history.splice(+b.dataset.i, 1); save(); renderCompare(); });

/* ===================== challenges ===================== */
function renderChallenges() {
  const r = S.run; let changed = false;
  for (const c of CHALLENGES) if (r && !S.done[c.id] && c.ok(r)) { S.done[c.id] = true; changed = true; }
  if (changed) save();
  $('ch').innerHTML = CHALLENGES.map((c, i) => `<div class="c ${S.done[c.id] ? 'done' : ''}"><span class="mk">${S.done[c.id] ? '✓' : i + 1}</span><div><b>${c.t}</b>${S.done[c.id] ? ' <span style="color:var(--good);font-size:12px">達成</span>' : ''}<p>${c.d}</p></div></div>`).join('');
}

/* ===================== boot ===================== */
load();
$('src').value = PRESETS.find(p => p.id === S.preset).src;
renderTabs(); syncCfg(); simulate(true);
window.addEventListener('resize', () => S.run && renderCursor());
