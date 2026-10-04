// データメモリ — バイト単位の番地、リトルエンディアン
// 仕様: docs/machine.md「メモリ」
//
// メモリは「ポート」の一種。ポートは access(req) を持ち、
//   req = { type: 'read' | 'write', addr, size: 1 | 4, value?, signed? }
// を受け取って { value, ...付加情報 } を返す。キャッシュ (cache.js) も同じ形のポートなので、
// Machine にはどちらでも差し込める。

export class Memory {
  constructor(size = 65536) {
    if (!Number.isInteger(size) || size <= 0) throw new Error('メモリの大きさは正の整数です');
    this.size = size;
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }
  clear() { this.bytes.fill(0); }
  inRange(addr, size) { return Number.isInteger(addr) && addr >= 0 && addr + size <= this.size; }

  read(addr, size = 4, signed = false) {
    if (size === 4) return this.view.getInt32(addr, true);
    if (size === 1) return signed ? this.view.getInt8(addr) : this.view.getUint8(addr);
    if (size === 2) return signed ? this.view.getInt16(addr, true) : this.view.getUint16(addr, true);
    throw new Error(`大きさ ${size} の読み出しはできません`);
  }
  write(addr, size, value) {
    if (size === 4) this.view.setInt32(addr, value | 0, true);
    else if (size === 1) this.view.setUint8(addr, value & 0xff);
    else if (size === 2) this.view.setUint16(addr, value & 0xffff, true);
    else throw new Error(`大きさ ${size} の書き込みはできません`);
  }
  readWord(addr) { return this.read(addr, 4); }
  writeWord(addr, value) { this.write(addr, 4, value); }

  /** ポートとしての入口 */
  access(req) {
    if (req.type === 'read') return { value: this.read(req.addr, req.size, req.signed) };
    const old = this.read(req.addr, req.size, false);
    this.write(req.addr, req.size, req.value);
    return { value: req.value, old };
  }

  /** アセンブラの data チャンクを書き込む */
  loadChunks(chunks) {
    for (const c of chunks) {
      if (c.addr < 0 || c.addr + c.bytes.length > this.size)
        throw new Error(`${c.line ?? '?'}行目のデータ (番地 ${c.addr}〜) がメモリ (${this.size} バイト) に収まりません`);
      this.bytes.set(c.bytes, c.addr);
    }
  }
  /** ワードの配列として取り出す (表示用) */
  words(from = 0, count = this.size >> 2) {
    const out = new Int32Array(count);
    for (let i = 0; i < count; i++) out[i] = this.view.getInt32(from + i * 4, true);
    return out;
  }
}
