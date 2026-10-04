// キャッシュ・ラボのプログラム
// 足すときは PRESETS に { name, goal, tryText, src } を1つ加える (docs/extending.md)

export const MEM_BYTES = 1024;
/** データメモリの初期値: ワード n (番地 4n) に n */
export const initMemory = mem => { for (let i = 0; i < MEM_BYTES / 4; i++) mem.writeWord(i * 4, i); };

export const PRESETS = [
{
  name: "配列の合計 (連続アクセス)",
  goal: "配列 a[0..31] を先頭から順に読む。空間的局所性の基本形。",
  tryText: "ライン長を 4B → 16B → 32B と変えてヒット率を比べよう。ミスはすべて「初期参照」になるはず。",
  src:
`# 配列 a[0..31] (0x100〜0x17F) の合計を r3 に求める
      li   r1, 0x100     # ポインタ
      li   r2, 0x180     # 終端
      li   r3, 0         # 合計
loop: lw   r4, 0(r1)     # a[i] を読む
      add  r3, r3, r4
      addi r1, r1, 4     # 次の要素 (4バイト先)
      blt  r1, r2, loop
      halt`
},
{
  name: "2配列の加算 (競合ミス)",
  goal: "c[i] = a[i] + b[i]。a, b, c が 128B 間隔に並ぶので、ダイレクトマップでは同じセットを奪い合う。",
  tryText: "ダイレクトマップ → 2ウェイ → 4ウェイと変えてみよう。3つの配列が同じセットに入るので、2ウェイでもまだ足りない。",
  src:
`# c[i] = a[i] + b[i]   (i = 0..15)
# a: 0x000〜  b: 0x080〜  c: 0x100〜
      li   r1, 0         # r1 = i*4
      li   r2, 64        # 16要素 * 4バイト
loop: lw   r4, 0x000(r1) # a[i]
      lw   r5, 0x080(r1) # b[i]
      add  r6, r4, r5
      sw   r6, 0x100(r1) # c[i]
      addi r1, r1, 4
      blt  r1, r2, loop
      halt`
},
{
  name: "行列の列方向走査",
  goal: "8×8 の行列 (行優先で格納) を列ごとに読む。1行=32B なので、隣の要素はラインの外にある。",
  tryText: "ライン長 16B、容量 128B のままでは空間的局所性を活かせない。容量を 256B にするとどう変わるか。",
  src:
`# 8x8 行列 M (0x000〜0x0FF, 行優先) を列方向に合計
      li   r3, 0
      li   r5, 0         # 列オフセット j*4
      li   r6, 32        # 8列
col:  addi r1, r5, 0     # p = &M[0][j]
      li   r2, 256
row:  lw   r4, 0(r1)
      add  r3, r3, r4
      addi r1, r1, 32    # 次の行へ (32バイト先)
      blt  r1, r2, row
      addi r5, r5, 4
      blt  r5, r6, col
      halt`
},
{
  name: "ストライドアクセス",
  goal: "64B 間隔で16か所を読み、それを2周する。読み込んだラインの残りは使われない。",
  tryText: "128B では16ラインが入りきらず2周目も全部「容量」ミス。容量 256B にしてフルアソシアティブと直接マップを比べよう。容量が足りても、直接マップでは「競合」ミスが残る。",
  src:
`# 0x000, 0x040, 0x080 ... と64バイト間隔で読む × 2周
      li   r5, 0
      li   r6, 2
outer: li  r1, 0
      li   r2, 0x400
loop: lw   r4, 0(r1)
      addi r1, r1, 64
      blt  r1, r2, loop
      addi r5, r5, 1
      blt  r5, r6, outer
      halt`
},
{
  name: "小さな配列の反復 (時間的局所性)",
  goal: "8要素(32B)の配列を4回くり返し合計する。2周目以降はキャッシュに残っている。",
  tryText: "どの構成でもミスは最初の1周だけ。ヒット率の上限を確認したら、容量を 64B、ライン長 4B にしても崩れないか試そう。",
  src:
`# a[0..7] (0x200〜) を4回くり返し合計する
      li   r3, 0
      li   r5, 0
      li   r6, 4
outer: li  r1, 0x200
      li   r2, 0x220
loop: lw   r4, 0(r1)
      add  r3, r3, r4
      addi r1, r1, 4
      blt  r1, r2, loop
      addi r5, r5, 1
      blt  r5, r6, outer
      halt`
}
];
