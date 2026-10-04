# JavaScript API リファレンス

すべて `core/index.js` から読み込めます。依存はなく、ブラウザ (ES モジュール) でも Node 18 以上でも動きます。

```js
import { defaultISA, assemble, Machine, PipelineModel } from './core/index.js';
```

## 命令セット — `isa.js`

| 名前 | 説明 |
|---|---|
| `defineExtension(spec)` | 拡張を検証して返す。項目は[拡張ガイド](extending.md) §4 |
| `createISA(extensions)` | 拡張の配列から命令セットを作る。衝突があれば例外 |
| `defaultISA()` | `createISA([BASE, MULDIV, ATOMIC])` (TOY-IMA) |
| `BASE`, `MULDIV`, `ATOMIC`, `XMRMW` | 標準の拡張 I・M・A と、見本の Xmrmw |
| `encode(ins)` / `decode(word, isa, index)` | 命令オブジェクト ⇄ 32 ビットの機械語 |
| `disassemble(ins, labelOf?)` | `"ADD r1, r2, r3"` の形の文字列 |
| `hexWord(w)` | `"0x01123000"` |
| `FORMATS`, `CLASSES`, `OPCODE_RANGES`, `NUM_REGS` | 定数 |
| `immRange(spec)` | 即値の `[最小, 最大]` |

`createISA` が返すオブジェクト: `name` (`'TOY-IMA'` など)、`extensions`、`defs` (ニーモニック → 定義の Map)、`pseudos`、`prefixes`、`def(m)`、`pseudo(m)`。

## アセンブラ — `assembler.js`

```js
const { program, errors } = assemble(source, { isa, dataBase: 0, symbols: { counter: 0 } });
```

- `errors`: `[{ line, message }]`。1 つでもあれば `program` は `null`。
- `program`:

| 項目 | 説明 |
|---|---|
| `instrs` | 命令の配列。各命令は `{ index, op, def, rd, rs, rt, imm, target, word, text, src, line, pseudo, lock, regions }` |
| `labels` | `{ 名前: { value, section: 'text' \| 'data' \| 'equ' \| 'predefined', line } }` |
| `data` | `[{ addr, bytes: Uint8Array, line }]` データメモリの初期値 |
| `lines` | ソースの各行 `{ text, instrs: [命令番号…] }` |
| `labelAt(index)` | その命令番号に付いたラベル名 (なければ `null`) |
| `symbol(name)` | 記号の値 |

## 機能シミュレータ — `machine.js`, `memory.js`

```js
const m = new Machine({ program, cores: 1, memSize: 65536, memory, port, init });
m.step(coreId)          // → 実行記録 | null
m.run({ core, maxSteps, onStep })           // → { steps, reason }
m.runScheduled(scheduler, { maxSteps, onStep })
m.trace({ maxSteps })   // → { trace: 完了した命令の記録[], steps, reason }
m.reset()
m.cores[i]              // { pc, regs, halted, haltReason, trap, uop, tmp, reservation, retired, steps }
m.halted, m.running     // 全コア停止か / 動いているコアの番号
```

実行記録の項目は[実行モデル](machine.md) §2。`operandRegs(ins)` は命令が読む・書くレジスタ (r0 を除く) を `{ src: [...], dst }` で返します。

`Memory`: `new Memory(size)`、`read(addr, size, signed)`、`write(addr, size, value)`、`readWord`、`writeWord`、`access(req)`、`words(from, count)`、`clear()`、`bytes` (Uint8Array)。

## スケジューラ — `sched.js`

| 名前 | 説明 |
|---|---|
| `roundRobin()` | 順番に 1 ステップずつ |
| `randomSwitch(p, rng)` | 確率 p で別のコアへ切り替える |
| `scripted(order)` | 決めた順 (コア番号の配列) に進める |

## タイミング — `pipeline.js`, `inorder.js`

```js
const pipe = new PipelineModel({ pipelined, width, forwarding, branch, units, memTime, serializeMemory, program });
pipe.push(rec)          // → entry { i, rec, ins, pc, cls, t[5], d[5], end, waits, fwd, branch, fetchDelay, wrongPath }
pipe.finish()           // → { cycles, instructions, ipc, cpi, ideal, lost, data, ctrl, other, mispredicts, branches, forwards, memSlow, latency }
pipe.stageOf(entry, c)  // → { stage: 0..4 | -1, stalled, flushed? }
pipe.stagesAt(c)        // → 5 段それぞれの [{ entry, stalled, flushed }]
pipe.retiredBy(c)       // サイクル c までに WB を終えた命令数
pipe.entries, pipe.squashed
```

`STAGES = ['IF', 'ID', 'EX', 'MEM', 'WB']`。MEM 時間の関数: `randomMissTime({ rate, penalty, seed })`、`cacheMemTime`。

```js
const io = new InOrderModel({ latency, unpipelined, mispredictPenalty, branch, mshr, hierarchy });
io.push(rec)            // → { i, from, issue, done, stall, cause, level, latency, mispredicted, penEnd }
io.finish()             // → { cycles, instructions, cpi, issued, mem, alu, brm, branches, mispredicts, loads }
io.cycles, io.t, io.ready
```

規則は[タイミングモデル](timing.md)。

## メモリ系 — `cache.js`, `hierarchy.js`

```js
const c = new Cache({ size, lineSize, ways, policy, write, writeAllocate, hitTime, missPenalty, backing, classify, seed });
c.access(req)           // ポートとして。→ { value, old, hit, set, way, tag, offset, block, base, missType, evicted, writeback, noAllocate, cycles }
c.find(addr), c.has(addr), c.line(addr), c.fill(addr, meta), c.touch(set, way)
c.decompose(addr)       // → { block, set, tag, offset }
c.baseOf(set, tag), c.flush(), c.reset(), c.geometry, c.stats, c.set[s].ways[w]
```

```js
const h = new MemoryHierarchy({ lineSize, levels: [{ name, size, ways, latency }], memoryLatency, memorySize, prefetch });
h.load(addr, t)         // → { level, latency }
h.store(addr, t), h.probe(addr), h.residentLines(level), h.stats, h.names
```

## 分岐予測と乱数 — `predictor.js`, `random.js`

```js
const p = createPredictor('bimodal', { entries: 0, init: 1 });
p.predict(pc), p.update(pc, taken), p.resolve(pc, taken) /* → { mispredicted, predicted } */, p.counter(pc)

const rng = mulberry32(42);  rng()  // 0 以上 1 未満
```
