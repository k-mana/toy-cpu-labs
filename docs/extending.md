# 拡張ガイド

TOY は、命令・タイミングモデル・メモリ・ラボ・教材のどれでも、他の部分を壊さずに足せるように作ってあります。この文書は、そのやり方と約束ごとをまとめたものです。

## 1. 全体の構成

```
core/               シミュレータ本体 (ブラウザでも Node でも動く ES モジュール。依存なし)
  isa.js            命令セットの登録・符号化・逆アセンブル
  ext/              命令の定義 (拡張ごとに 1 ファイル)
    base.js         I: 基本整数命令と疑似命令
    muldiv.js       M: 乗除算
    atomic.js       A: アトミック
    xmrmw.js        Xmrmw: 独自拡張の見本
  assembler.js      アセンブラ
  memory.js         データメモリ
  machine.js        機能シミュレータ (マルチコア・μop・予約)
  sched.js          マルチコアのスケジューラ
  pipeline.js       タイミング: 5段パイプライン
  inorder.js        タイミング: インオーダー発行
  cache.js          キャッシュ (データあり / タグだけ)
  hierarchy.js      メモリ階層 (L1/L2/L3/DRAM)
  predictor.js      分岐予測器
  random.js         シード付き乱数
  index.js          まとめて読み込む入口
labs/<名前>/        ラボ (index.html = 見た目、app.js = 動き、lessons.js = 教材データ)
labs/shared/        全ラボ共通の最小限の CSS
reference/          命令セット一覧 (コードから自動生成)
docs/               ドキュメント (この文書を含む)
tests/              node --test で動くテスト
```

依存の向きは一方通行です: **ラボ → core**。core はラボのことを知りません。

## 2. 開発の始め方

ビルドは要りません。ES モジュールを使うので、HTML をファイルとして直接開くのではなく、手元でサーバーを立てて開きます。

```sh
python3 -m http.server 8000     # または npx serve
# → http://localhost:8000/ を開く

node --test tests/*.test.js     # テスト (Node 18 以上)
```

## 3. ラボに教材を足す

いちばん簡単な貢献です。各ラボの教材は `labs/<名前>/lessons.js` にデータとして書かれていて、`app.js` を触らずに足せます。

例: パイプライン・ラボにプログラムを足す

```js
// labs/pipeline/lessons.js の SAMPLES に追加
{ id: 'swap', name: '並べ替え', sub: 'ストールを消す', mem: [8, 3, 5, 2],
  hint: '「ロード・ユース」と同じ計算を、待ちが出ないように並べ替えたものです。',
  code: `LW   r1, 0(r0)
LW   r3, 4(r0)
ADD  r2, r1, r1
SUB  r4, r3, r2
SW   r4, 8(r0)`,
  expect: { 2: 16, 4: -13 } },
```

足したら、`tests/labs.test.js` が教材を自動で実行して確かめます (アセンブルできるか、止まるか、`expect` どおりか)。授業で使う教材を足すときは、教えたいこと (例: 「並べ替えるとストールが 0 になる」) もテストに書いておくと、あとで core が変わっても壊れたことに気づけます。

| ラボ | 教材の配列 | 1 件の形 |
|---|---|---|
| パイプライン・ラボ | `SAMPLES` | `{ id, name, sub, hint, code, mem, expect }` |
| スループット・ラボ | `PRESETS`, `CHALLENGES` | `{ id, name, tag, desc, src, expectMem }` / `{ id, t, d, ok(run) }` |
| キャッシュ・ラボ | `PRESETS` | `{ name, goal, tryText, src }` |
| レイテンシ・ラボ | `LESSONS` | `{ title, body, tasks, point, variants: [{ name, init, code }] }` |
| アトミック・ラボ | `LESSONS` | `{ title, body, tasks, point, variants: [{ name, safe, code }] }` |
| 命令セット・ラボ | `EXAMPLES` | `{ name, code, expect: { regs, mem } }` |

## 4. 命令を足す

命令は**拡張**としてまとめて定義します。既存の拡張 (I・M・A) を書き換えるのではなく、新しい独自拡張 (名前は `X` で始める) を作ってください。

```js
// core/ext/xbit.js
import { defineExtension } from '../isa.js';

export const XBIT = defineExtension({
  name: 'Xbit',
  title: 'ビット操作 (例)',
  description: '1 のビットを数える POPCNT と、最小値を選ぶ MIN。',
  instructions: [
    { mnemonic: 'POPCNT', opcode: 0xd0, format: 'I', operands: 'rd, rs', class: 'alu',
      name: '1 のビットの数', summary: 'rd ← rs の中の 1 の個数',
      exec: c => { let v = c.a >>> 0, n = 0; while (v) { n += v & 1; v >>>= 1; } c.write(n); } },
    { mnemonic: 'MIN', opcode: 0xd1, format: 'R', operands: 'rd, rs, rt', class: 'alu',
      name: '小さいほう', summary: 'rd ← min(rs, rt)',
      exec: c => c.write(Math.min(c.a, c.b)) },
  ],
});
```

使うときは命令セットに加えるだけです。アセンブラ・逆アセンブル・機械語・タイミングモデルは、そのまま新しい命令を扱えます。

```js
const isa = createISA([BASE, MULDIV, XBIT]);
assemble('POPCNT r2, r1', { isa });
```

### 命令定義の項目

| 項目 | 必須 | 意味 |
|---|---|---|
| `mnemonic` | ○ | 英大文字 (`.` と数字も可) |
| `opcode` | ○ | 1〜255。独自拡張は `0xC0`〜`0xFF` |
| `format` | ○ | `R` `I` `S` `B` `J` `A` `N` ([命令セット仕様](isa.md) §3) |
| `operands` | ○ | アセンブリでの書き方。`rd` `rs` `rt` `imm` `mem` `label` をカンマで並べる |
| `class` | ○ | `alu` `mul` `div` `load` `store` `rmw` `branch` `jump` `system`。タイミングモデルはこれで振る舞いを決める |
| `exec(c)` または `uops: [c => …, …]` | ○ | 動作 ([実行モデル](machine.md) §4)。`uops` なら 1 ステップに 1 μop ずつ進む |
| `name`, `summary` | 推奨 | 命令セット一覧に出る説明 |
| `imm` | | 即値の範囲。`{ bits, signed }` か `{ min, max }`。省略時は形式の既定 |
| `reads`, `writes` | | 読み書きするレジスタのフィールド名。省略時は形式の既定。依存関係の判定に使う |
| `atomic` | | 不可分な命令なら `true` |
| `prefixes` | | 付けられる接頭辞 (例: `['LOCK']`) |

`reads` と `writes` は正しく書いてください。間違えると、パイプラインのハザード判定が実際の動作とずれます。たとえば CAS は rd を**読んでから**書くので `reads: ['rs', 'rt', 'rd']` です。

### 約束ごと

- オペコードとニーモニックが他の拡張とぶつかると、`createISA` がエラーにします。公開する拡張は、使うオペコードを README などに書いてください。
- 命令セット一覧 (`reference/app.js`) に載せたいときは、そこで読み込む拡張の配列に加えます。
- テストを `tests/` に足します (命令ごとに、境界の値を含めて)。

## 5. タイミングモデルを作る

タイミングモデルは、`push(rec)` と `finish()` を持つクラスなら何でもかまいません。Machine の実行記録 (完了したもの) が 1 つずつ順に渡されます。

例: 1 命令ずつ、分類ごとに決まったサイクル数をかけるマルチサイクル CPU

```js
export class MultiCycleModel {
  constructor({ cycles = { alu: 4, mul: 6, div: 20, load: 5, store: 4, rmw: 6, branch: 3, jump: 3, system: 1 } } = {}) {
    this.cycles = cycles; this.reset();
  }
  reset() { this.t = 0; this.count = 0; }
  push(rec) {
    if (!rec || !rec.done) return null;
    const n = this.cycles[rec.ins.def.class] ?? 1;
    const out = { start: this.t, end: this.t + n - 1 };
    this.t += n; this.count++;
    return out;
  }
  finish() { return { cycles: this.t, instructions: this.count, cpi: this.count ? this.t / this.count : 0 }; }
}

const { trace } = new Machine({ program }).trace();
const model = new MultiCycleModel();
trace.forEach(r => model.push(r));
model.finish();   // { cycles, instructions, cpi }
```

実行記録で使えるもの: 命令の分類 (`rec.ins.def.class`)、依存関係 (`operandRegs(rec.ins)` が `{ src, dst }` を返す)、メモリの番地 (`rec.mem[i].addr`)、分岐の結果 (`rec.branch.taken`)、PC (`rec.pc`)。分岐予測器 (`createPredictor`) とメモリ階層 (`MemoryHierarchy`) は、自分のモデルからもそのまま使えます。

新しいモデルを core に入れるときは、教科書どおりの小さな例でサイクル数を確かめるテストと、[タイミングモデル](timing.md) への規則の説明を一緒に足してください。

## 6. メモリポートを作る

Machine のロード/ストアは、すべて `port.access(req)` を通ります。同じ形のオブジェクトを作れば、TLB・キャッシュ一貫性・遅いデバイスなどを差し込めます。

```js
export class CountingPort {
  constructor(memory) { this.memory = memory; this.reads = 0; this.writes = 0; }
  reset() { this.reads = this.writes = 0; }           // Machine.reset() から呼ばれる
  access(req) {
    if (req.type === 'read') this.reads++; else this.writes++;
    return this.memory.access(req);                   // { value, old? } を返す
  }
}
const memory = new Memory(4096);
const m = new Machine({ program, memory, port: new CountingPort(memory) });
```

戻り値に足した項目 (ヒットしたか、何サイクルかかったか、など) は、実行記録の `rec.mem[i].info` に入ります。タイミングモデルはそれを読めます (例: `cacheMemTime`)。

番地の範囲と境界は Machine がポートを呼ぶ前に確かめるので、ポートで確かめる必要はありません。

## 7. 新しいラボを作る

1. `labs/playground/` を `labs/<名前>/` にコピーする。`index.html`・`app.js`・`lessons.js` の 3 つから始まる。
2. `app.js` で、使う命令セット (`createISA`)・Machine の設定・タイミングモデルを決める。
3. 教材は `lessons.js` に分け、`tests/labs.test.js` に実行のテストを足す。
4. トップページ (`/index.html`) の一覧にカードを足す。
5. [学習カリキュラム](curriculum.md) のどこに入るかを書き足す。

### 画面づくりの約束

- 文章は日本語で、専門用語は初出で短く説明する。言葉は[用語集](glossary.md)に合わせる (ラボの名前は「〇〇・ラボ」)。
- 色は `:root` の CSS 変数で定義し、`prefers-color-scheme: dark` でも読めるようにする (既存のラボを参考に)。
- 幅 360px の画面でも横にはみ出さないようにする。
- キーボードだけで操作できるようにし、ボタンには目に見える名前を付ける。
- 外から読み込むのは Google Fonts まで。ライブラリは使わない (core だけで作れるようにしておく)。
- 乱数は `mulberry32(seed)` を使い、同じ操作で同じ結果になるようにする。

## 8. 仕様を変えるとき

- 命令の意味を変えるときは、`docs/isa.md` と `core/` を同じ変更で直し、版を上げます ([命令セット仕様](isa.md) §8)。
- `tests/docs.test.js` が、命令セット一覧と命令セット仕様の食い違い (仕様にない命令がある、など) を見つけます。
- 既存のラボの数字が変わる変更 (タイミングの規則など) は、どの教材のどの数字が変わるかを変更の説明に書いてください。

## 9. 変更を送る

[貢献の手引き](../CONTRIBUTING.md) (リポジトリ直下の CONTRIBUTING.md) を見てください。要点は「テストが通ること」「教材には expect を付けること」「仕様の変更は文書と同時に」です。
