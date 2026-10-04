// キャッシュ — セットアソシアティブ、置換方式と書き込み方式を選べる
// 仕様: docs/timing.md「キャッシュ」
//
// 2通りに使える。
//  1. データを持つキャッシュ (backing にメモリを渡す): Machine の port に差し込むと、
//     ロード/ストアが実際にキャッシュを通る。ダーティなデータはメモリと食い違う。
//  2. タグだけのキャッシュ (backing なし): find / fill / touch で「載っているか」だけを追う。
//     階層モデル (hierarchy.js) が使う。

import { mulberry32 } from './random.js';

const log2 = n => Math.round(Math.log2(n));
const isPow2 = n => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

export const REPLACEMENT = { LRU: '最も長く使っていないものを追い出す', FIFO: '最も早く入ったものを追い出す', RANDOM: 'ランダムに追い出す' };
export const MISS_TYPES = { compulsory: '初期参照', capacity: '容量', conflict: '競合' };

export class Cache {
  /**
   * @param {object} o
   * @param {number} o.size          容量 (バイト)
   * @param {number} [o.lineSize=16] ラインの大きさ (バイト)
   * @param {number} [o.ways=1]      連想度。0 ならフルアソシアティブ
   * @param {'LRU'|'FIFO'|'RANDOM'} [o.policy='LRU']
   * @param {'back'|'through'} [o.write='back']
   * @param {boolean} [o.writeAllocate]  省略時は back なら true、through なら false
   * @param {number} [o.hitTime=1]      ヒット時のサイクル
   * @param {number} [o.missPenalty=20] メモリからライン1つを運ぶ (または書き戻す) サイクル
   * @param {object} [o.backing]        下位のメモリ (Memory)。省略するとタグだけのキャッシュ
   * @param {boolean} [o.classify=false] ミスを 3C (初期参照・容量・競合) に分類する
   * @param {number} [o.seed=1]         RANDOM 置換の乱数シード
   */
  constructor(o) {
    const { size, lineSize = 16, ways = 1, policy = 'LRU', write = 'back' } = o;
    if (!isPow2(size) || !isPow2(lineSize) || lineSize < 4 || size < lineSize) throw new Error('容量とライン長は2のべき乗で、ライン長 4 バイト以上・容量 ≥ ライン長です');
    if (!(policy in REPLACEMENT)) throw new Error(`置換方式 ${policy} は未定義です`);
    if (write !== 'back' && write !== 'through') throw new Error('書き込み方式は back か through です');
    const nLines = size / lineSize;
    const w = ways === 0 ? nLines : Math.min(ways, nLines);
    if (!isPow2(w)) throw new Error('連想度は2のべき乗です');
    this.name = o.name || 'cache';
    this.size = size; this.lineSize = lineSize; this.ways = w; this.sets = nLines / w; this.lines = nLines;
    this.policy = policy; this.write = write;
    this.writeAllocate = o.writeAllocate ?? write === 'back';
    this.hitTime = o.hitTime ?? 1; this.missPenalty = o.missPenalty ?? 20;
    this.backing = o.backing || null;
    this.classify = !!o.classify;
    this.seed = o.seed ?? 1;
    this.offsetBits = log2(lineSize);
    this.indexBits = log2(this.sets);
    this.addrBits = o.addrBits ?? (this.backing ? Math.max(this.offsetBits + this.indexBits, Math.ceil(Math.log2(this.backing.size))) : 32);
    this.tagBits = this.addrBits - this.offsetBits - this.indexBits;
    this.reset();
  }

  reset() {
    const data = !!this.backing;
    this.set = Array.from({ length: this.sets }, () => ({
      ways: Array.from({ length: this.ways }, () => ({
        valid: false, dirty: false, tag: 0, meta: null, loadedAt: 0, usedAt: 0,
        data: data ? new Uint8Array(this.lineSize) : null,
      })),
      index: new Map(), // tag → way
      order: new Map(), // way → true。先頭が次の追い出し候補 (LRU: 最も古く使った / FIFO: 最も早く入った)
      filled: 0,
    }));
    this.tick = 0;
    this.rng = mulberry32(this.seed);
    this.seen = new Set();
    this.shadow = new Map();
    this.stats = { accesses: 0, hits: 0, misses: 0, compulsory: 0, capacity: 0, conflict: 0, blockReads: 0, writebacks: 0, writeThroughs: 0, cycles: 0 };
  }

  /** 番地をライン番号・セット・タグ・オフセットに分ける */
  decompose(addr) {
    const block = Math.floor(addr / this.lineSize);
    return { block, set: block % this.sets, tag: Math.floor(block / this.sets), offset: addr % this.lineSize };
  }
  /** セットとタグからラインの先頭番地 */
  baseOf(set, tag) { return (tag * this.sets + set) * this.lineSize; }

  /** 載っていればウェイ番号、なければ −1 (状態は変えない) */
  find(addr) {
    const d = this.decompose(addr);
    const w = this.set[d.set].index.get(d.tag);
    return w === undefined ? -1 : w;
  }
  has(addr) { return this.find(addr) >= 0; }
  line(addr) { const w = this.find(addr); return w < 0 ? null : this.set[this.decompose(addr).set].ways[w]; }

  /** 使ったことを記録する (LRU の順番を更新) */
  touch(setIdx, way) {
    const S = this.set[setIdx];
    S.ways[way].usedAt = ++this.tick;
    if (this.policy === 'LRU') { S.order.delete(way); S.order.set(way, true); }
  }

  victim(S) {
    if (S.filled < this.ways) return S.filled; // 空きウェイ (小さい番号から)
    if (this.policy === 'RANDOM') return Math.floor(this.rng() * this.ways);
    return S.order.keys().next().value;
  }

  /**
   * ラインを載せる。すでにあれば使ったことにして meta を更新するだけ。
   * データを持つキャッシュでは、追い出すラインがダーティならメモリへ書き戻す。
   * @returns {{set, way, existed:boolean, evicted: null | {tag, base, dirty}}}
   */
  fill(addr, meta = null) {
    const d = this.decompose(addr);
    const S = this.set[d.set];
    const have = S.index.get(d.tag);
    if (have !== undefined) {
      this.touch(d.set, have);
      if (meta !== null) S.ways[have].meta = meta;
      return { set: d.set, way: have, existed: true, evicted: null };
    }
    const way = this.victim(S);
    const L = S.ways[way];
    let evicted = null;
    if (L.valid) {
      const base = this.baseOf(d.set, L.tag);
      evicted = { tag: L.tag, base, dirty: L.dirty };
      if (L.dirty && this.backing) { this.backing.bytes.set(L.data, base); this.stats.writebacks++; }
      S.index.delete(L.tag);
      S.order.delete(way);
    } else S.filled++;
    L.valid = true; L.dirty = false; L.tag = d.tag; L.meta = meta; L.loadedAt = ++this.tick; L.usedAt = this.tick;
    if (this.backing) {
      const base = this.baseOf(d.set, d.tag);
      L.data.set(this.backing.bytes.subarray(base, base + this.lineSize));
      this.stats.blockReads++;
    }
    S.index.set(d.tag, way);
    S.order.set(way, true);
    return { set: d.set, way, existed: false, evicted };
  }

  /** 同じ容量のフルアソシアティブ LRU で当たったか (3C 分類用) */
  _classifyStep(block) {
    const compulsory = !this.seen.has(block);
    this.seen.add(block);
    const shadowHit = this.shadow.has(block);
    if (shadowHit) this.shadow.delete(block);
    this.shadow.set(block, true);
    if (this.shadow.size > this.lines) this.shadow.delete(this.shadow.keys().next().value);
    return compulsory ? 'compulsory' : shadowHit ? 'conflict' : 'capacity';
  }

  /**
   * ポートとしての入口 (Machine から呼ばれる)。データを持つキャッシュ専用。
   * @returns {{value, old?, hit, set, way, tag, offset, block, base, missType, evicted, noAllocate, cycles}}
   */
  access(req) {
    if (!this.backing) throw new Error('タグだけのキャッシュには access できません (backing を渡してください)');
    const { addr, size } = req;
    const isW = req.type === 'write';
    const d = this.decompose(addr);
    const S = this.set[d.set];
    const kind = this.classify ? this._classifyStep(d.block) : null;
    let way = S.index.get(d.tag);
    if (way === undefined) way = -1;
    const res = {
      hit: way >= 0, set: d.set, tag: d.tag, offset: d.offset, block: d.block, base: d.block * this.lineSize,
      way, missType: null, evicted: null, noAllocate: false, writeback: false, cycles: this.hitTime, write: isW,
    };
    this.stats.accesses++;
    if (res.hit) this.stats.hits++;
    else {
      this.stats.misses++;
      if (kind) { res.missType = kind; this.stats[kind]++; }
      if (isW && !this.writeAllocate) {
        res.noAllocate = true;
        res.old = this.backing.read(addr, size, false);
        this.backing.write(addr, size, req.value);
        this.stats.writeThroughs++;
        res.value = req.value;
        this.stats.cycles += res.cycles;
        return res;
      }
      res.cycles += this.missPenalty;
      const f = this.fill(addr);
      way = res.way = f.way;
      res.evicted = f.evicted;
      if (f.evicted && f.evicted.dirty) { res.writeback = true; res.cycles += this.missPenalty; }
    }
    const L = S.ways[way];
    this.touch(d.set, way);
    const view = L.view || (L.view = new DataView(L.data.buffer));
    const o = d.offset;
    if (o + size > this.lineSize) throw new Error('ラインをまたぐアクセスはできません');
    const rd = (signed) => (size === 4 ? view.getInt32(o, true) : size === 1 ? (signed ? view.getInt8(o) : view.getUint8(o)) : signed ? view.getInt16(o, true) : view.getUint16(o, true));
    if (isW) {
      res.old = rd(false);
      if (size === 4) view.setInt32(o, req.value | 0, true); else if (size === 1) view.setUint8(o, req.value & 0xff); else view.setUint16(o, req.value & 0xffff, true);
      if (this.write === 'back') L.dirty = true;
      else { this.backing.write(addr, size, req.value); this.stats.writeThroughs++; }
      res.value = req.value;
    } else res.value = rd(!!req.signed);
    this.stats.cycles += res.cycles;
    return res;
  }

  /** ダーティなラインをすべてメモリへ書き戻す */
  flush() {
    if (!this.backing) return 0;
    let n = 0;
    this.set.forEach((S, s) => S.ways.forEach(L => {
      if (L.valid && L.dirty) { this.backing.bytes.set(L.data, this.baseOf(s, L.tag)); L.dirty = false; n++; }
    }));
    this.stats.writebacks += n;
    return n;
  }

  /** 追い出し順 (先頭ほど先に追い出される) のウェイ番号。表示用 */
  evictionOrder(setIdx) { return [...this.set[setIdx].order.keys()]; }

  get geometry() {
    return { size: this.size, lineSize: this.lineSize, sets: this.sets, ways: this.ways, lines: this.lines,
      offsetBits: this.offsetBits, indexBits: this.indexBits, tagBits: this.tagBits, addrBits: this.addrBits };
  }
}
