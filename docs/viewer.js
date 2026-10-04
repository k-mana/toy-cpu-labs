// ドキュメントビューア — docs/*.md を読み込んで表示する (外部ライブラリなし)
// 文書の切り替えは URL の # で行う (例: docs/#isa)。.md へのリンクも # に読み替える。

export const DOCS = [
  { id: 'overview', file: 'overview.md', title: 'はじめに' },
  { id: 'curriculum', file: 'curriculum.md', title: '学習カリキュラム' },
  { sep: true },
  { id: 'isa', file: 'isa.md', title: '命令セット仕様' },
  { id: 'assembly', file: 'assembly.md', title: 'アセンブリ言語' },
  { id: 'machine', file: 'machine.md', title: '実行モデル' },
  { id: 'timing', file: 'timing.md', title: 'タイミングモデル' },
  { sep: true },
  { id: 'extending', file: 'extending.md', title: '拡張ガイド' },
  { id: 'api', file: 'api.md', title: 'API リファレンス' },
  { id: 'glossary', file: 'glossary.md', title: '用語集' },
  { id: 'contributing', file: '../CONTRIBUTING.md', title: '貢献の手引き' },
];

/* ---------------- Markdown (この文書群で使う範囲) ---------------- */
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function slug(text) {
  return text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
}

function linkTarget(href) {
  const m = /^(?:\.\/)?(?:\.\.\/)?([\w-]+)\.md(#.*)?$/i.exec(href);
  if (m) {
    const name = m[1].toLowerCase();
    const d = DOCS.find(x => x.id === name || (x.file && x.file.toLowerCase().endsWith(name + '.md')));
    if (d) return '#' + d.id + (m[2] ? '/' + m[2].slice(1) : '');
  }
  return href;
}

export function inline(src) {
  const codes = [];
  let s = src.replace(/`([^`]+)`/g, (_, c) => { codes.push(c.replace(/\\\|/g, '|')); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, h) => {
    const href = linkTarget(h.replace(/&amp;/g, '&'));
    const ext = /^https?:/.test(href);
    return `<a href="${esc(href)}"${ext ? ' rel="noopener"' : ''}>${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\\([|*_`\\])/g, '$1');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  return s;
}

const splitRow = line => {
  const cells = [];
  let cur = '', code = false;
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '\\' && t[i + 1] === '|') { cur += '\\|'; i++; continue; }
    if (ch === '`') code = !code;
    if (ch === '|' && !code) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
};

const LIST_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

export function render(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const out = [];
  const para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { flush(); i++; continue; }
    let m;
    if ((m = /^```(\w*)/.exec(line))) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${m[1] ? ` class="lang-${m[1]}"` : ''}>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
      flush();
      const n = m[1].length, html = inline(m[2]);
      out.push(`<h${n} id="${esc(slug(m[2]))}">${html}</h${n}>`);
      i++; continue;
    }
    if (/^---+\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^\s*</.test(line)) { // HTML の行 (details など) はそのまま
      flush();
      const t = line.trim();
      if (/^<\/?(details|summary)\b/i.test(t)) {
        out.push(t.replace(/<summary>(.*)<\/summary>/i, (_, x) => `<summary>${inline(x)}</summary>`));
        i++; continue;
      }
    }
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      out.push(`<div class="tbl"><table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if ((m = LIST_RE.exec(line))) {
      flush();
      const indent = m[1].length, ordered = /\d/.test(m[2]);
      const items = [];
      while (i < lines.length) {
        const l = lines[i], mm = LIST_RE.exec(l);
        if (mm && mm[1].length === indent && /\d/.test(mm[2]) === ordered) { items.push([mm[3]]); i++; continue; }
        if (/^\s*$/.test(l)) {
          // 空行の後に字下げした行が続けば、同じ項目の続き
          if (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !(LIST_RE.exec(lines[i + 1]) && LIST_RE.exec(lines[i + 1])[1].length <= indent)) { items[items.length - 1].push(''); i++; continue; }
          break;
        }
        if (/^\s+\S/.test(l) && (l.match(/^\s*/)[0].length > indent)) { items[items.length - 1].push(l.slice(Math.min(indent + 2, l.match(/^\s*/)[0].length))); i++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map(it => {
        let first = it[0];
        let box = '';
        const cb = /^\[( |x)\]\s+(.*)$/i.exec(first);
        if (cb) { box = `<input type="checkbox" disabled${cb[1].toLowerCase() === 'x' ? ' checked' : ''}>`; first = cb[2]; }
        if (it.length === 1) return `<li>${box}${inline(first)}</li>`;
        const body = render([first, ...it.slice(1)].join('\n'));
        return `<li>${box}${body}</li>`;
      }).join('')}</${tag}>`);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out.join('\n');
}

/* ---------------- ページ ---------------- */
if (typeof document !== 'undefined') {
  const nav = document.getElementById('nav'), doc = document.getElementById('doc');
  nav.innerHTML = DOCS.map(d => (d.sep ? '<div class="sep" role="separator"></div>' : `<a href="#${d.id}" data-id="${d.id}">${d.title}</a>`)).join('');
  const cache = new Map();
  async function show() {
    const [id, anchor] = decodeURIComponent(location.hash.slice(1)).split('/');
    const d = DOCS.find(x => x.id === id) || DOCS[0];
    nav.querySelectorAll('a').forEach(a => a.setAttribute('aria-current', a.dataset.id === d.id ? 'page' : 'false'));
    try {
      if (!cache.has(d.file)) {
        const r = await fetch(d.file);
        if (!r.ok) throw new Error(r.status);
        cache.set(d.file, await r.text());
      }
      doc.innerHTML = render(cache.get(d.file));
      document.title = `${d.title} — TOY ドキュメント`;
      const target = anchor && document.getElementById(anchor);
      if (target) target.scrollIntoView(); else window.scrollTo(0, 0);
    } catch (e) {
      doc.innerHTML = `<p class="err">${d.file} を読み込めませんでした。ファイルとして直接開いている場合は、サーバー経由 (例: python3 -m http.server) で開いてください。</p>`;
    }
  }
  // 文書の中の「#節」リンクは、文書を切り替えずにその節へ移動する
  doc.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (!a) return;
    const h = a.getAttribute('href') || '';
    if (h.startsWith('#') && !DOCS.some(d => d.id && (h === '#' + d.id || h.startsWith('#' + d.id + '/')))) {
      e.preventDefault();
      const el = document.getElementById(decodeURIComponent(h.slice(1)));
      if (el) el.scrollIntoView();
    }
  });
  window.addEventListener('hashchange', show);
  show();
}
