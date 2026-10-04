# 実行モデル (機能シミュレータ)

版: 1.0 — 実装: `core/machine.js`, `core/memory.js`, `core/sched.js`

TOY のシミュレータは 2 層に分かれています。

```
 アセンブリ ──assemble()──▶ program ──▶ Machine ──step()──▶ 実行記録 ──▶ タイミングモデル ──▶ サイクル数
                                         (何が起きるか)                     (いつ起きるか)
```

- **Machine** は命令の意味だけを扱います。「r1 に 5 が入る」「番地 0x40 に書く」は決めますが、「何サイクル目か」は扱いません。
- **タイミングモデル** ([timing.md](timing.md)) は、Machine が出した実行記録の列 (トレース) を受け取って、パイプラインやキャッシュでのサイクル数を計算します。

この分け方のおかげで、同じプログラムの正しい結果を保ったまま、CPU の構成 (フォワーディングの有無、キャッシュの形など) だけを取り替えて比べられます。

## 1. Machine

```js
import { defaultISA, assemble, Machine } from './core/index.js';
const { program } = assemble(source, { isa: defaultISA() });
const m = new Machine({ program, cores: 1, memSize: 65536 });
const rec = m.step(0);      // コア 0 を 1 ステップ進める
m.run();                    // 止まるまで進める
```

| 引数 | 意味 |
|---|---|
| `program` | `assemble()` の結果 |
| `cores` | コア数 (既定 1)。全コアが同じプログラムを PC=0 から実行する |
| `memSize` / `memory` | データメモリの大きさ、または `Memory` そのもの |
| `port` | メモリアクセスの入口 (§3)。既定は `memory` |
| `init(memory, machine)` | `reset()` のたびに呼ばれる。プログラムの `.data` より先 |

`reset()` は次の順に行います: メモリを 0 で埋める → `port.reset()` (あれば) → `init` → プログラムの `.data` を書く → 全コアのレジスタと PC を 0 に。

### コアの状態

`m.cores[i]` は次のものを持ちます。

| 名前 | 意味 |
|---|---|
| `pc` | 次に実行する命令の番号 |
| `regs` | `Int32Array(16)` |
| `halted`, `haltReason` | 止まったか。理由は `'halt'` (HALT)・`'end'` (末尾に達した)・`'trap'` (例外) |
| `trap` | 例外なら `{ message, pc, line }` |
| `uop`, `tmp` | μop 命令の途中なら、次の μop 番号と途中の値 |
| `reservation` | LL の予約 (番地) または `null` |
| `retired`, `steps` | 完了した命令数、実行したステップ数 |

## 2. 実行記録

`step()` は 1 ステップごとに次の記録を返します (止まっているコアなら `null`)。タイミングモデルもラボの表示も、すべてこの記録から作ります。

| 名前 | 意味 |
|---|---|
| `seq` | マシン全体での通し番号 |
| `core`, `pc`, `ins` | どのコアが、どの番号の、どの命令を実行したか |
| `uop`, `uopCount` | μop 命令なら何番目の μop か (それ以外は 0 と 1) |
| `done` | 命令が完了したか (μop の途中・例外なら `false`) |
| `reads` | 読んだレジスタ `[{ field, reg, value }]` (実行前の値) |
| `write` | 書いたレジスタ `{ reg, value, old, computed, discarded }`。`discarded` は r0 への書き込み |
| `mem` | メモリアクセス `[{ type: 'read'\|'write', addr, size, value, old?, info }]`。`info` はポートが返した付加情報 (キャッシュならヒットかどうかなど) |
| `branch` | 分岐・ジャンプ `{ taken, target, conditional }` |
| `nextPc` | 次の PC |
| `halt`, `end`, `trap` | HALT した / 末尾に達した / 例外の理由 |
| `atomic` | 不可分な命令か (A 拡張の不可分命令、または LOCK 付き) |
| `notes` | そのほかの出来事 `[{ type: 'reserve' \| 'reservation-lost', core, addr }]` |

`m.trace()` は 1 コアのマシンを最後まで走らせ、完了した命令の記録 (`done` が真のもの) を配列で返します。タイミングモデルにはこれを渡します。

## 3. メモリとポート

`Memory` はバイトの配列です。番地の範囲と境界は Machine が確かめてから (§5)、**ポート**を通してアクセスします。

ポートは `access(req)` を持つものなら何でもよく、

```js
req = { type: 'read' | 'write', addr, size: 1 | 4, value?, signed? }
→ { value, old?, ...付加情報 }
```

を返します。`Memory` 自身がポートで、`Cache` もポートです。`new Machine({ memory, port: cache })` とすると、ロードとストアが本当にキャッシュを通り、ダーティなデータはメモリと食い違います (キャッシュ・ラボはこの使い方です)。

## 4. 実行コンテキスト (命令を定義する人向け)

命令の意味は、拡張の中の `exec(c)` (または `uops: [c => …, c => …]`) で書きます。`c` は次のものを持ちます。

| 名前 | 意味 |
|---|---|
| `c.a`, `c.b`, `c.d` | rs、rt、rd の (実行前の) 値 |
| `c.imm`, `c.ins`, `c.pc` | 即値、命令オブジェクト、PC |
| `c.addr()` | `(rs + imm)` を 32 ビットで |
| `c.write(v)` | rd に書く (r0 なら捨てる) |
| `c.load(addr, size = 4, signed = false)` | メモリから読む |
| `c.store(addr, size, value)` | メモリへ書く (予約の解除も行われる) |
| `c.branch(cond)` | 条件が真なら `ins.target` へ |
| `c.jump(target)` | 無条件に飛ぶ |
| `c.halt()` | このコアを止める |
| `c.trap(message)` | 例外を起こす |
| `c.reserve(addr)`, `c.holds(addr)`, `c.release()` | 予約の設定・確認・解除 |
| `c.tmp` | μop の間で値を受け渡すための入れ物 (命令が終わると空になる) |
| `c.note(obj)` | 実行記録の `notes` に書き足す |

例: `ADD` は `exec: c => c.write(c.a + c.b)`、`LW` は `exec: c => c.write(c.load(c.addr(), 4))` です。

## 5. 例外の扱い

- `c.load` / `c.store` は、番地がメモリの外か、境界に合っていなければ例外を起こします。例外を起こした命令は、それ以前に書いたものを除いて何も変えずに止まります (標準命令はアクセスを先に行うので、何も変わりません)。
- 例外の記録は `rec.trap` とコアの `trap` に入り、`rec.done` は `false` です。

## 6. 予約と不可分性

- 予約はコアごとに 1 つです。`c.store` は、書いたバイトと重なるワードを予約しているすべてのコアの予約を消します。消えたのが他のコアなら `notes` に `reservation-lost` が残ります。
- 1 ステップの中では他のコアは動かないので、1 ステップで終わる命令は自動的に不可分です。**μop に分かれた命令**だけが、μop の間に他のコアの命令を挟めます。`LOCK` 接頭辞は μop を 1 ステップにまとめます。

## 7. マルチコアとスケジューリング

`step(id)` で好きなコアを進められます。自動で進めるにはスケジューラを使います。

```js
import { roundRobin, randomSwitch, scripted, mulberry32 } from './core/index.js';
m.runScheduled(randomSwitch(0.5, mulberry32(42)));   // 確率 0.5 で別のコアへ
m.runScheduled(scripted([0, 1, 0, 1]));              // 決めた順に
```

スケジューラは `(machine, current) => coreId | null` という関数なので、自作もできます。止まっているコアは選ばないでください。

## 8. 再現性

シミュレーションに使う乱数 (RANDOM 置換、ランダムなミス、ランダムスケジューラ) はすべて `mulberry32(seed)` で作ります。同じプログラム・構成・シードなら、いつ誰が実行しても同じ結果になります。
