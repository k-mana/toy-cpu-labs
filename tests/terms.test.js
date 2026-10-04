// 用語集 (docs/glossary.md) で使わないことにした言葉が、画面・ドキュメント・コメントに紛れ込んでいないか
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['docs/glossary.md', 'tests/terms.test.js']);

// [使わない言葉, 代わりに使う言葉]
const BANNED = [
  [/教室/, '〇〇・ラボ'], [/実験室/, '〇〇・ラボ / 仮想CPU ラボ'], [/実験台/, '命令セット・ラボ'], [/実験/, 'プログラム'],
  [/共通コア/, 'シミュレータ本体'], [/仕様書/, 'ドキュメント'],
  [/アドレス/, '番地'], [/ブロック/, 'ライン'],
  [/バリアント|例題|サンプル|プリセット/, 'プログラム'], [/チャレンジ/, '課題'], [/トラップ/, '例外'],
  [/命令一覧/, '命令セット一覧'],
];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(html|js|md)$/.test(name)) yield p;
  }
}

test('使わないことにした言葉がない', () => {
  const hits = [];
  for (const p of files(root)) {
    const rel = relative(root, p).replace(/\\/g, '/');
    if (SKIP.has(rel)) continue;
    readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      for (const [re, use] of BANNED) if (re.test(line)) hits.push(`${rel}:${i + 1} 「${line.match(re)[0]}」→ ${use}`);
      // 「〇〇ラボ」(中黒なし) の名前
      for (const m of line.matchAll(/([ァ-ヶー]+)ラボ/g)) hits.push(`${rel}:${i + 1} 「${m[0]}」→ ${m[1]}・ラボ`);
    });
  }
  assert.deepEqual(hits, []);
});
