// ドキュメントとコードが食い違っていないか
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createISA, BASE, MULDIV, ATOMIC, XMRMW } from '../core/index.js';
import { DOCS, render } from '../docs/viewer.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const isa = createISA([BASE, MULDIV, ATOMIC, XMRMW]);
const spec = read('docs/isa.md');

test('すべての命令と疑似命令が命令セット仕様に載っている', () => {
  for (const m of [...isa.defs.keys(), ...isa.pseudos.keys()]) {
    assert.match(spec, new RegExp('`' + m.replace('.', '\\.') + '[ `]'), `${m} が docs/isa.md にない`);
  }
});

test('命令セット仕様の表のオペコードと形式がコードと一致する', () => {
  let checked = 0;
  for (const line of spec.split('\n')) {
    const m = /^\| `([A-Z]+)[^`]*` \| (?:([RISBJAN]) \| )?(0x[0-9A-F]{2}) \|/.exec(line);
    if (!m || isa.prefixes.has(m[1])) continue; // 「LOCK INCM」の行は INCM の行で確かめる
    const d = isa.defs.get(m[1]);
    assert.ok(d, `${m[1]} はコードにない`);
    assert.equal(d.opcode, parseInt(m[3], 16), `${m[1]} のオペコード`);
    if (m[2]) assert.equal(d.format, m[2], `${m[1]} の形式`);
    checked++;
  }
  assert.ok(checked >= isa.defs.size, `表から読めた命令が ${checked} 個しかない`);
});

test('ドキュメントどうしのリンクと、ラボ・一覧へのリンクが切れていない', () => {
  for (const d of DOCS.filter(x => x.file)) {
    const path = join('docs', d.file);
    assert.ok(existsSync(join(root, path)), path);
    const md = read(path);
    for (const [, href] of md.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|#)/.test(href)) continue;
      const target = resolve(join(root, dirname(path)), href.split('#')[0]);
      assert.ok(existsSync(target), `${path} のリンク ${href} の先がない`);
    }
    assert.ok(render(md).length > 100);
  }
});

test('Markdown 表示: 表・コード・リンクの読み替え', () => {
  const html = render('# 見出し 1.0\n\n| a | b |\n|---|---|\n| `x\\|y` | [isa](isa.md) |\n\n```js\nconst a = 1 < 2;\n```\n\n- 項目\n  続き\n- [x] 済み');
  assert.match(html, /<h1 id="見出し-10">/);
  assert.match(html, /<code>x\|y<\/code>/);
  assert.match(html, /href="#isa"/);
  assert.match(html, /1 &lt; 2/);
  assert.match(html, /<input type="checkbox" disabled checked>/);
});

test('README の文書表とラボ表のリンク先がある', () => {
  const md = read('README.md');
  for (const [, href] of md.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^https?:/.test(href)) continue;
    assert.ok(existsSync(join(root, href)), `README のリンク ${href}`);
  }
});
