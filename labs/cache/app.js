/* キャッシュ・ラボ — シミュレータ本体 (../../core) の上に作ったラボ
 * Machine のメモリポートに Cache を差し込むので、ロード/ストアが本当にキャッシュを通る。
 * ダーティなラインの値はメモリとは食い違い、追い出されるときに書き戻される。 */
import { createISA, BASE, MULDIV, assemble, Machine, Memory, Cache } from '../../core/index.js';
import { PRESETS, MEM_BYTES, initMemory } from './lessons.js';

const isa = createISA([BASE, MULDIV]);
const MEM_WORDS = MEM_BYTES / 4, ADDR_BITS = 10, PENALTY = 20;

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const hx = (n, d = 0) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(d, '0');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TYPE_KEY = { compulsory: 'comp', capacity: 'cap', conflict: 'conf' };

/* ---------- configuration ---------- */
const cfg = { size: 128, block: 16, assoc: 1, policy: 'LRU', write: 'WB' };
function geo() {
  const nBlocks = cfg.size / cfg.block;
  const ways = cfg.assoc === 0 ? nBlocks : Math.min(cfg.assoc, nBlocks);
  const sets = nBlocks / ways;
  const off = Math.log2(cfg.block), idx = Math.log2(sets);
  return { nBlocks, ways, sets, off, idx, tag: ADDR_BITS - off - idx, words: cfg.block / 4 };
}

/* ---------- simulator ---------- */
let source = PRESETS[0].src, program = asm(source), S;
function asm(src) {
  const { program, errors } = assemble(src, { isa });
  if (!program) throw new Error(errors.slice(0, 3).map(e => `${e.line}行目: ${e.message}`).join('\n'));
  if (!program.instrs.length) throw new Error('命令がありません');
  return program;
}
function resetSim() {
  const memory = new Memory(MEM_BYTES);
  const cache = new Cache({
    size: cfg.size, lineSize: cfg.block, ways: cfg.assoc, policy: cfg.policy === 'RAND' ? 'RANDOM' : cfg.policy,
    write: cfg.write === 'WB' ? 'back' : 'through', missPenalty: PENALTY, backing: memory, classify: true, seed: 7,
  });
  const machine = new Machine({ program, memory, port: cache, init: initMemory });
  S = { machine, memory, cache, regs: machine.cores[0].regs, changed: -1, error: null, instrs: 0, cycles: 0, events: [], last: null };
}
const halted = () => S.machine.cores[0].halted;

function step() {
  if (halted()) return false;
  const rec = S.machine.step(0);
  S.changed = rec.write && !rec.write.discarded ? rec.write.reg : -1;
  if (rec.trap) { S.error = `${rec.ins.line}行目: ${rec.trap}`; return false; }
  let cyc = 1;
  const a = rec.mem[0];
  if (a) {
    const i = a.info;
    const ev = {
      addr: a.addr, isW: a.type === 'write', blk: i.block, set: i.set, tag: i.tag, w: i.offset >> 2, hit: i.hit, cycles: i.cycles, way: i.way,
      evict: i.evicted, noAlloc: i.noAllocate, type: i.missType ? TYPE_KEY[i.missType] : null, base: i.base, value: a.value,
      ins: rec.ins.src.replace(/\s+/g, ' '), line: rec.ins.line - 1, n: S.cache.stats.accesses,
    };
    S.last = ev; S.events.unshift(ev); if (S.events.length > 80) S.events.pop();
    cyc = ev.cycles;
  }
  S.instrs++; S.cycles += cyc;
  return !halted();
}

/* ---------- explanations ---------- */
const TYPE = { comp: ['初期参照', '--c-comp'], cap: ['容量', '--c-cap'], conf: ['競合', '--c-conf'] };
function explain(ev) {
  const loc = `セット${ev.set} でタグ ${hx(ev.tag)} を探す → `;
  const range = `${hx(ev.base, 3)}〜${hx(ev.base + cfg.block - 1, 3)}`;
  if (ev.hit) {
    if (!ev.isW) return loc + `ウェイ${ev.way}で一致、ヒット。値をキャッシュから返す。`;
    return loc + `ウェイ${ev.way}で一致、ヒット。` + (cfg.write === 'WB' ? 'キャッシュだけ書き換えてダーティにする。' : 'キャッシュとメモリの両方を書き換える。');
  }
  let s = loc + `一致なし、ミス(${TYPE[ev.type][0]})。`;
  if (ev.noAlloc) return s + 'ライトスルーなのでキャッシュには載せず、メモリへ直接書く。';
  if (ev.evict) s += `ウェイ${ev.way}のライン ${hx(ev.evict.base, 3)} を追い出す` + (ev.evict.dirty ? '。ダーティなのでメモリへ書き戻す。' : '。');
  else s += `空いているウェイ${ev.way}を使う。`;
  s += `メモリから ${range} を読み込む。`;
  if (ev.isW) s += cfg.write === 'WB' ? 'その後書き込み、ダーティにする。' : 'その後書き込み、メモリにも書く。';
  return s;
}

/* ---------- rendering ---------- */
function renderGeo() {
  const g = geo();
  $('geo').innerHTML = `${g.nBlocks}ライン = <b>${g.sets}セット × ${g.ways}ウェイ</b>、1ライン ${cfg.block}B ／ 番地10ビット = タグ <b style="color:var(--tag)">${g.tag}</b> + インデックス <b style="color:var(--idx)">${g.idx}</b> + オフセット <b style="color:var(--off)">${g.off}</b> ビット`;
  $('cgeo').textContent = `${cfg.size}B · ${g.sets}×${g.ways}`;
  $('rkLegend').innerHTML = g.ways > 1 ? (cfg.policy === 'LRU' ? "<b class='mono'>#1</b> 最近使った順" : cfg.policy === 'FIFO' ? "<b class='mono'>#1</b> 新しく入った順" : 'ランダムに追い出し') : '';
}

function renderListing() {
  const core = S.machine.cores[0];
  const nextIns = program.instrs[core.pc];
  const cur = !halted() ? nextIns?.line - 1 : (core.haltReason === 'halt' ? program.instrs[core.pc]?.line - 1 : -1);
  $('listing').innerHTML = source.split('\n').map((l, i) => {
    const ci = l.search(/[#;]/);
    const code = ci < 0 ? l : l.slice(0, ci), cm = ci < 0 ? '' : l.slice(ci);
    return `<div class="ln${i === cur ? ' cur' : ''}"><span class="no">${i + 1}</span><span>${esc(code)}<span class="cm">${esc(cm)}</span></span></div>`;
  }).join('');
  const el = $('listing').querySelector('.cur');
  if (el) { const box = $('listing'); const t = el.offsetTop - box.offsetTop; if (t < box.scrollTop || t > box.scrollTop + box.clientHeight - 24) box.scrollTop = t - 60; }
}

function renderRegs() {
  $('regs').innerHTML = Array.from(S.regs, (v, i) => `<div class="reg${i === S.changed ? ' chg' : ''}"><span>r${i}</span>${v}</div>`).join('');
  $('pcline').textContent = `PC = ${S.machine.cores[0].pc}　実行命令数 ${S.instrs}　サイクル ${S.cycles}`;
}

function renderAddr() {
  const ev = S.last, g = geo();
  if (!ev) { $('addr').innerHTML = `<p class="empty" style="padding:0">まだロード/ストアを実行していません。「1命令実行」で進めてください。</p>`; return; }
  const bits = ev.addr.toString(2).padStart(ADDR_BITS, '0').split('');
  const tagB = bits.slice(0, g.tag), idxB = bits.slice(g.tag, g.tag + g.idx), offB = bits.slice(g.tag + g.idx);
  const fld = (cls, name, arr, val) => arr.length ? `<div class="field ${cls}"><div class="bx">${arr.map(b => `<span>${b}</span>`).join('')}</div><div class="fl">${name} <b>${val}</b></div></div>` : '';
  const t = ev.hit ? `<b class="h">ヒット</b>` : `<b class="m">ミス (${TYPE[ev.type][0]})</b>`;
  $('addr').innerHTML =
    `<div class="addrtop"><span class="big">${hx(ev.addr, 3)}</span><span class="mono">${esc(ev.ins)}</span><span>${ev.isW ? '書き込み' : '読み出し'} · ${ev.cycles}サイクル</span></div>
     <div class="bits">${fld('tag', 'タグ', tagB, hx(ev.tag))}${fld('idx', 'インデックス', idxB, 'セット' + ev.set)}${fld('off', 'オフセット', offB, (ev.addr & (cfg.block - 1)) + 'B目')}</div>
     <div class="verdict ${ev.hit ? 'hit' : 'miss'}">${t}　${esc(explain(ev))}</div>`;
}

function renderCache() {
  const g = geo(), ev = S.last, C = S.cache;
  $('cache').innerHTML = C.set.map((Sx, s) => {
    const lines = Sx.ways;
    const order = lines.map((l, i) => ({ i, k: cfg.policy === 'FIFO' ? l.loadedAt : l.usedAt, v: l.valid })).filter(x => x.v).sort((a, b) => b.k - a.k).map(x => x.i);
    const cells = lines.map((L, wi) => {
      let cls = L.valid ? '' : ' inv';
      const act = ev && ev.set === s && ev.way === wi;
      if (act) cls += ev.hit ? ' hit' : ' miss';
      const base = C.baseOf(s, L.tag);
      const rank = g.ways > 1 && L.valid && cfg.policy !== 'RAND' ? `<span class="rk">#${order.indexOf(wi) + 1}</span>` : '';
      const view = new DataView(L.data.buffer);
      const words = Array.from({ length: g.words }, (_, k) => `<span${act && k === ev.w ? ' class="tw"' : ''}>${L.valid ? view.getInt32(k * 4, true) : '–'}</span>`).join('');
      return `<div class="cl${cls}"><div class="hd"><span class="flag${L.valid ? ' on' : ''}">V</span><span class="flag d${L.dirty ? ' on' : ''}">D</span><span class="tg">${L.valid ? 'tag ' + hx(L.tag) : '空き'}</span>${rank}</div>
        <div class="rg">${L.valid ? hx(base, 3) + '〜' + hx(base + cfg.block - 1, 3) : 'ウェイ' + wi}</div><div class="wd">${words}</div></div>`;
    }).join('');
    const bin = g.idx ? s.toString(2).padStart(g.idx, '0') : '—';
    return `<div class="set${ev && ev.set === s ? ' act' : ''}"><div class="sidx">セット<br><b>${s}</b> <span>${bin}</span></div><div class="ways">${cells}</div></div>`;
  }).join('');
}

function renderStats() {
  const st = S.cache.stats, a = st.accesses;
  const pct = a ? (st.hits / a * 100) : 0;
  const seg = (n, v) => a ? `<i style="width:${n / a * 100}%;background:var(${v})" title=""></i>` : '';
  const amat = a ? (st.cycles / a).toFixed(2) : '—';
  const cpi = S.instrs ? (S.cycles / S.instrs).toFixed(2) : '—';
  const tl = S.events.slice(0, 80).reverse().map(e => `<i style="background:var(${e.hit ? '--hit' : TYPE[e.type][1]})" title="#${e.n} ${hx(e.addr, 3)} ${e.hit ? 'ヒット' : 'ミス(' + TYPE[e.type][0] + ')'}"></i>`).join('');
  $('stats').innerHTML =
    `<div class="hr"><span class="pct">${a ? pct.toFixed(1) : '—'}<small style="font-size:16px">%</small></span><span class="sub">ヒット率<br>${st.hits} / ${a} アクセス</span></div>
     <div class="bar3" role="img" aria-label="ヒットとミスの内訳">${seg(st.hits, '--hit')}${seg(st.compulsory, '--c-comp')}${seg(st.capacity, '--c-cap')}${seg(st.conflict, '--c-conf')}</div>
     <dl class="kv">
       <dt><span class="dot" style="background:var(--hit)"></span>ヒット</dt><dd>${st.hits}</dd>
       <dt><span class="dot" style="background:var(--c-comp)"></span>ミス: 初期参照</dt><dd>${st.compulsory}</dd>
       <dt><span class="dot" style="background:var(--c-cap)"></span>ミス: 容量</dt><dd>${st.capacity}</dd>
       <dt><span class="dot" style="background:var(--c-conf)"></span>ミス: 競合</dt><dd>${st.conflict}</dd>
       <dt>平均メモリアクセス時間</dt><dd>${amat} cyc</dd>
       <dt>CPI (1命令あたりサイクル)</dt><dd>${cpi}</dd>
       <dt>メモリからのライン読込</dt><dd>${st.blockReads}</dd>
       <dt>書き戻し (ライトバック)</dt><dd>${st.writebacks}</dd>
       <dt>メモリへの直接書込 (ライトスルー)</dt><dd>${st.writeThroughs}</dd>
     </dl>
     <div class="tl" aria-label="直近のアクセス履歴 (左が古い)">${tl}</div>`;
}

function renderLog() {
  if (!S.events.length) { $('log').innerHTML = `<p class="empty">ロード/ストアを実行すると、ここに1件ずつ理由つきで記録されます。</p>`; return; }
  $('log').innerHTML = S.events.slice(0, 40).map(e => {
    const b = e.hit ? `<span class="badge" style="background:var(--hit)">HIT</span>` : `<span class="badge" style="background:var(${TYPE[e.type][1]})">MISS·${TYPE[e.type][0]}</span>`;
    return `<div class="ev"><div class="top"><span style="color:var(--muted)">#${e.n}</span>${b}<span>${esc(e.ins)}</span><span style="color:var(--muted)">${hx(e.addr, 3)}</span></div><p>${esc(explain(e))}</p></div>`;
  }).join('');
}

function renderMem() {
  const g = geo(), C = S.cache;
  const state = new Uint8Array(MEM_WORDS);
  C.set.forEach((Sx, s) => Sx.ways.forEach(L => {
    if (!L.valid) return;
    const base = C.baseOf(s, L.tag) >> 2;
    for (let k = 0; k < g.words; k++) state[base + k] = L.dirty ? 2 : 1;
  }));
  const lastW = S.last ? S.last.addr >> 2 : -1, lastB = S.last ? S.last.blk : -1;
  let html = '';
  for (let r = 0; r < 16; r++) {
    let blks = '';
    for (let b = 0; b < 16 / g.words; b++) {
      const blkNo = (r * 64 + b * cfg.block) >> g.off;
      let ws = '';
      for (let k = 0; k < g.words; k++) {
        const wi = r * 16 + b * g.words + k, addr = wi * 4;
        const st = state[wi];
        const sIdx = blkNo & (g.sets - 1);
        ws += `<div class="mw${st === 1 ? ' c' : st === 2 ? ' d' : ''}${wi === lastW ? ' last' : ''}" title="${hx(addr, 3)} = ${S.memory.readWord(addr)} / セット${sIdx}・タグ${hx(blkNo >> g.idx)}">${(addr & 0x3f).toString(16).toUpperCase()}</div>`;
      }
      blks += `<div class="mblk${blkNo === lastB ? ' lastb' : ''}">${ws}</div>`;
    }
    html += `<div class="mrow"><span class="ma">${hx(r * 64, 3)}</span><div class="blks">${blks}</div></div>`;
  }
  $('mem').innerHTML = html;
}

function renderStatus() {
  const st = $('status');
  if (S.error) { st.textContent = 'エラー: ' + S.error; st.className = 'status err'; }
  else if (timer) { st.textContent = '実行中'; st.className = 'status run'; }
  else if (halted()) { st.textContent = '終了 (halt)'; st.className = 'status end'; }
  else { st.textContent = S.instrs ? '一時停止' : '待機'; st.className = 'status'; }
  $('bStep').disabled = $('bAll').disabled = halted();
  $('bRun').disabled = halted();
  $('bRun').textContent = timer ? '一時停止' : '連続実行';
}

function renderAll() { renderGeo(); renderListing(); renderRegs(); renderAddr(); renderCache(); renderStats(); renderLog(); renderMem(); renderStatus(); }

/* ---------- controls ---------- */
let timer = null;
function stop() { if (timer) { clearInterval(timer); timer = null; } }
function delay() { const v = +$('speed').value; return Math.round(700 * Math.pow(0.6, v - 1)); }
function startRun() {
  stop();
  timer = setInterval(() => { if (!step()) stop(); renderAll(); }, delay());
  renderStatus();
}
function setPreset(i) {
  stop();
  source = PRESETS[i].src; program = asm(source);
  $('goal').textContent = PRESETS[i].goal;
  $('try').innerHTML = '<b>試してみよう</b>　' + esc(PRESETS[i].tryText);
  resetSim(); renderAll();
}

PRESETS.forEach((p, i) => { const o = document.createElement('option'); o.value = i; o.textContent = p.name; $('prog').append(o); });
const custom = document.createElement('option'); custom.value = 'custom'; custom.textContent = '自作プログラム'; custom.hidden = true; $('prog').append(custom);

$('prog').addEventListener('change', e => { if (e.target.value !== 'custom') setPreset(+e.target.value); });
$('bStep').addEventListener('click', () => { stop(); step(); renderAll(); });
$('bRun').addEventListener('click', () => { if (timer) { stop(); renderStatus(); } else startRun(); });
$('bAll').addEventListener('click', () => {
  stop(); let n = 0; while (step() && ++n < 50000);
  if (n >= 50000 && !halted()) { S.machine.cores[0].halted = true; S.error = '5万命令を超えたので止めました (無限ループ?)'; }
  renderAll();
});
$('bReset').addEventListener('click', () => { stop(); resetSim(); renderAll(); });
$('speed').addEventListener('input', () => { if (timer) startRun(); });
[['cSize', 'size', Number], ['cBlock', 'block', Number], ['cAssoc', 'assoc', Number], ['cPol', 'policy', String], ['cWrite', 'write', String]].forEach(([id, key, f]) => {
  $(id).addEventListener('change', e => { stop(); cfg[key] = f(e.target.value); resetSim(); renderAll(); });
});
$('bEdit').addEventListener('click', () => { stop(); $('src').value = source; $('asmerr').textContent = ''; $('editor').hidden = false; $('listing').hidden = true; $('bEdit').hidden = true; $('src').focus(); });
$('bCancel').addEventListener('click', () => { $('editor').hidden = true; $('listing').hidden = false; $('bEdit').hidden = false; });
$('bAsm').addEventListener('click', () => {
  try {
    program = asm($('src').value); source = $('src').value;
    $('prog').value = 'custom';
    $('goal').textContent = '自作プログラムを実行中。';
    $('try').innerHTML = '<b>ヒント</b>　同じプログラムで構成だけを変えて、ミスの種類がどう移り変わるか比べてみよう。';
    $('editor').hidden = true; $('listing').hidden = false; $('bEdit').hidden = false;
    resetSim(); renderAll();
  } catch (err) { $('asmerr').textContent = err.message; }
});

/* 開いたときに様子が分かるよう、最初のプログラムを少し進めておく */
setPreset(0);
for (let i = 0; i < 14; i++) step();
renderAll();
