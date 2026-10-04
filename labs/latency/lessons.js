// レイテンシ・ラボのレッスン
// レッスンを足すときは LESSONS に { title, body, tasks, point, variants:[{ name, init?, code }] } を加える。
// init(mem) はデータメモリの初期値を書く関数 (省略可)。docs/extending.md も参照。

import { mulberry32 } from '../../core/random.js';

export const MEM_BYTES = 1 << 20;       // 1 MiB
export const IDX_BASE = 0x40000;        // 添字配列・番地の配列を置く場所 (256KB 目)

function shuffle(a, r) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/** 配列 A (ワード i に i & 255) と、ランダムな番地の添字配列 */
export const initArray = m => {
  for (let i = 0; i < 65536; i++) m.writeWord(i * 4, i & 255);
  const r = mulberry32(7);
  for (let i = 0; i < 512; i++) m.writeWord(IDX_BASE + i * 4, Math.floor(r() * 65536) * 4); // 256KB のどこか
};
/** 0〜255 の乱数 256 個 (sorted なら小さい順) */
export const initBranch = sorted => m => {
  const r = mulberry32(11), a = [];
  for (let i = 0; i < 256; i++) a.push(Math.floor(r() * 256));
  if (sorted) a.sort((x, y) => x - y);
  a.forEach((v, i) => m.writeWord(i * 4, v));
};
/** 1024 個のノードからなる連結リスト (ノードは別々のラインにばらまく) と、ノード番地の配列 */
export const initList = m => {
  const r = mulberry32(23), lines = shuffle([...Array(4095)].map((_, i) => i + 1), r), p = [0, ...lines.slice(0, 1023)];
  for (let k = 0; k < 1024; k++) { m.writeWord(p[k] * 64, p[(k + 1) % 1024] * 64); m.writeWord(IDX_BASE + k * 4, p[k] * 64); }
};

const wsCode = (bytes, label) => {
  const lines = bytes / 64;
  return `; ${label}の配列を、1ラインに1回ずつ何周も読む
        LI   r5, 8192         ; ロードの総数
outer:
        LI   r1, 0            ; 配列の先頭
        LI   r3, ${lines}${' '.repeat(Math.max(1, 13 - String(lines).length))}; 1周のロード数（= ライン数）
inner:
        LW   r2, 0(r1)
        ADD  r10, r10, r2
        ADDI r1, r1, 64       ; 次のラインへ
        SUBI r5, r5, 1
        SUBI r3, r3, 1
        BNEZ r3, inner
        BNEZ r5, outer
        HALT`;
};

export const LESSONS = [
  { title: 'アクセスパターン',
    body: ['CPU はメモリを1語ずつではなく、64バイト（16語）のキャッシュライン単位で取ってきます。1語目でラインを DRAM から運べば、同じラインの残り15語は L1 から 4 サイクルで読めます。',
      '3つのプログラムはどれも512回ロードします。違うのは読む順番だけです。'],
    tasks: ['「順次」を数命令ずつ進め、パイプライン図で DRAM の長いバーのあと L1 の短いバーが15回続くのを見る。',
      '「ストライド 64B」に切り替える。毎回新しいラインに触るので、すべてのロードが DRAM まで行く。比較欄で大きな差を確かめる。',
      'ハードウェア設定でプリフェッチャを有効にする。順次アクセスは次のラインが先に届いて速くなるが、ランダムには効かない。'],
    point: '速さを決めるのはロードの回数ではなく、触るキャッシュラインの数。',
    variants: [
      { name: '順次', init: initArray, code:
`; 配列 A を先頭から順に 512 語読んで合計する
        LI   r1, 0            ; A の番地
        LI   r3, 512          ; 残り回数
loop:
        LW   r2, 0(r1)        ; A[i]
        ADD  r10, r10, r2     ; 合計に足す（ロードを待つ）
        ADDI r1, r1, 4        ; 次の語（同じラインが16回続く）
        SUBI r3, r3, 1
        BNEZ r3, loop
        HALT` },
      { name: 'ストライド 64B', init: initArray, code:
`; 16語おき = 毎回別のキャッシュラインを読む
        LI   r1, 0
        LI   r3, 512
loop:
        LW   r2, 0(r1)
        ADD  r10, r10, r2
        ADDI r1, r1, 64       ; 64バイト先 = 次のライン
        SUBI r3, r3, 1
        BNEZ r3, loop
        HALT` },
      { name: 'ランダム', init: initArray, code:
`; 添字配列 idx（0x40000〜）に入ったランダムな番地を読む
        LI   r4, 0x40000      ; idx の番地
        LI   r3, 512
loop:
        LW   r1, 0(r4)        ; idx[i]（順番に読む）
        LW   r2, 0(r1)        ; A[idx[i]]（どこに飛ぶかわからない）
        ADD  r10, r10, r2
        ADDI r4, r4, 4
        SUBI r3, r3, 1
        BNEZ r3, loop
        HALT` }] },
  { title: 'ワーキングセット',
    body: ['キャッシュは小さいほど速く、L1（4KB）、L2（32KB）、L3（128KB）、DRAM の順に大きく遅くなります。',
      '同じ配列をくり返し読むとき、配列全体（ワーキングセット）がどの階層に収まるかで、1回のロードにかかる時間が階段状に変わります。4つのプログラムはどれも 8192 回ロードします。'],
    tasks: ['比較欄で4つのサイズのサイクル数を見比べる。段差の位置が L1・L2・L3 の容量に対応している。',
      '「64KB」を最後まで実行し、メモリマップで配列全体が L3 の色に染まり、L1 と L2 には最後に触った部分しか残らないことを見る。',
      '「256KB」は L3 にも収まらない。LRU は一番古いラインから追い出すので、次に使うラインがちょうど追い出されて2周目もすべて DRAM になる。'],
    point: 'データが1段上のキャッシュに収まるかどうかで、速さが数倍変わる。',
    variants: [
      { name: '2KB（512語）', init: initArray, code: wsCode(2048, '2KB（512語）') },
      { name: '16KB（4096語）', init: initArray, code: wsCode(16384, '16KB（4096語）') },
      { name: '64KB（16384語）', init: initArray, code: wsCode(65536, '64KB（16384語）') },
      { name: '256KB（65536語）', init: initArray, code: wsCode(262144, '256KB（65536語）') }] },
  { title: '依存チェーン',
    body: ['MUL は結果が出るまで3サイクルかかりますが、乗算器はパイプライン化されているので毎サイクル新しい MUL を投入できます。',
      '前の結果を使う命令が続く「依存チェーン」では、3サイクルの待ちがそのまま積み重なります。独立した計算を並べれば、待っている間に次の MUL を進められます。これが命令レベル並列性（ILP）です。'],
    tasks: ['「MUL 1本の鎖」を数命令ずつ進め、パイプライン図で各 MUL が前の MUL の終わりを待っている（斜線）様子を見る。',
      '「MUL 4本の鎖」に切り替える。MUL のバーが階段状に重なり、ループ1周のサイクルが約半分になる。',
      '「DIV 4本の鎖」では、独立していても DIV はパイプライン化されていないので重ねられない。'],
    point: 'レイテンシを隠すには、待っている間にできる独立した仕事が必要。',
    variants: [
      { name: 'MUL 1本の鎖', code:
`; すべての MUL が直前の結果 r1 を使う
        LI   r11, 3
        LI   r12, 5
        LI   r13, 7
        LI   r14, 9
        LI   r1, 1
        LI   r7, 256          ; ループ回数
loop:
        MUL  r1, r1, r11
        MUL  r1, r1, r12
        MUL  r1, r1, r13
        MUL  r1, r1, r14
        SUBI r7, r7, 1
        BNEZ r7, loop
        HALT` },
      { name: 'MUL 4本の鎖', code:
`; 4つのレジスタに分けて、互いに独立させる
        LI   r11, 3
        LI   r12, 5
        LI   r13, 7
        LI   r14, 9
        LI   r1, 1
        LI   r2, 1
        LI   r3, 1
        LI   r4, 1
        LI   r7, 256
loop:
        MUL  r1, r1, r11
        MUL  r2, r2, r12
        MUL  r3, r3, r13
        MUL  r4, r4, r14
        SUBI r7, r7, 1
        BNEZ r7, loop
        HALT` },
      { name: 'DIV 4本の鎖', code:
`; 独立していても、DIV は1つずつしか進まない
        LI   r11, 1
        LI   r1, 99999
        LI   r2, 99999
        LI   r3, 99999
        LI   r4, 99999
        LI   r7, 64
loop:
        DIV  r1, r1, r11
        DIV  r2, r2, r11
        DIV  r3, r3, r11
        DIV  r4, r4, r11
        SUBI r7, r7, 1
        BNEZ r7, loop
        HALT` }] },
  { title: '分岐予測',
    body: ['CPU は分岐の結果が出る前にどちらへ進むかを予測し、先に命令を流します。外れると流した命令を捨ててやり直すので、15 サイクルほどを失います。',
      'この予測器は分岐ごとに2ビットのカウンタで「最近どちらへ進んだか」を覚えるだけです。0〜255 の乱数 256 個（L1 に収まる大きさ）を 8 周しながら、128 以上のものだけを足します。乱数が 128 以上かどうかは、覚えようがありません。'],
    tasks: ['「ランダム」を最後まで実行し、時間の内訳で分岐ミスが占める割合と、プログラム欄で BLT の行が熱くなっているのを見る。',
      '「ソート済み」に切り替える。データを並べ替えただけで、予測がほぼ当たるようになる。',
      '「分岐なし」は比較結果をマスクにして足す。命令は増えるが、データがランダムでも速い。'],
    point: '分岐のコストは命令数ではなく、予測が外れる頻度で決まる。',
    variants: [
      { name: 'ランダム', init: initBranch(false), code:
`; A[i] が 128 以上のものだけ合計する
        LI   r1, 0
        LI   r3, 2048
        LI   r7, 128
loop:
        ANDI r6, r1, 255      ; 256 個の値を 8 周くり返し使う
        SLLI r6, r6, 2        ; 語の番号 → 番地
        LW   r2, 0(r6)
        BLT  r2, r7, skip     ; 128 未満なら足さない
        ADD  r10, r10, r2
skip:
        ADDI r1, r1, 1
        SUBI r3, r3, 1
        BNEZ r3, loop
        HALT` },
      { name: 'ソート済み', init: initBranch(true), code:
`; 同じデータを小さい順に並べ替えてある
        LI   r1, 0
        LI   r3, 2048
        LI   r7, 128
loop:
        ANDI r6, r1, 255      ; 256 個の値を 8 周くり返し使う
        SLLI r6, r6, 2
        LW   r2, 0(r6)
        BLT  r2, r7, skip     ; 前半は毎回 skip、後半は毎回通過
        ADD  r10, r10, r2
skip:
        ADDI r1, r1, 1
        SUBI r3, r3, 1
        BNEZ r3, loop
        HALT` },
      { name: '分岐なし', init: initBranch(false), code:
`; 比較結果からマスクを作り、条件分岐を消す
        LI   r1, 0
        LI   r3, 2048
loop:
        ANDI r6, r1, 255
        SLLI r6, r6, 2
        LW   r2, 0(r6)
        SLTI r4, r2, 128      ; 128 未満なら 1、以上なら 0
        SUBI r4, r4, 1        ; 1→0、0→-1（全ビット1）
        AND  r5, r2, r4       ; 128 以上なら r2、未満なら 0
        ADD  r10, r10, r5
        ADDI r1, r1, 1
        SUBI r3, r3, 1
        BNEZ r3, loop
        HALT` }] },
  { title: 'メモリレベル並列性',
    body: ['DRAM の 200 サイクルは1回ずつ待つと重いですが、ミスを同時にいくつも出せば待ち時間を重ねられます。この CPU は同時に8つまでミスを処理できます（MSHR）。',
      '連結リストのように「次に読む番地が前のロードの結果」だと、ミスを1つずつしか出せません。3つのプログラムはどれも同じ 1024 個のノードを同じ順番で読みます。'],
    tasks: ['「ポインタ追跡」を進め、パイプライン図で DRAM のバーが重ならずに1本ずつ並ぶのを見る。',
      '「独立ロード（展開なし）」は番地の配列からノードの番地を読むので互いに独立だが、読んだ値をすぐ使うため、この in-order CPU では結局1つずつ待たされる。',
      '「独立ロード（4つ展開）」で DRAM のバーが4本ずつ重なる。設定で MSHR を 1 にすると重なりが消える。'],
    point: 'レイテンシは減らせなくても、重ねればスループットは上がる。',
    variants: [
      { name: 'ポインタ追跡', init: initList, code:
`; 各ノードの先頭語に「次のノードの番地」が入っている
        LI   r1, 0            ; 先頭ノード
        LI   r3, 1024
loop:
        LW   r1, 0(r1)        ; r1 = 次のノード（前の結果がないと始められない）
        SUBI r3, r3, 1
        BNEZ r3, loop
        HALT` },
      { name: '独立ロード（展開なし）', init: initList, code:
`; ノードの番地を並べた配列（0x40000〜）を使う
        LI   r4, 0x40000
        LI   r3, 1024
loop:
        LW   r1, 0(r4)        ; ノードの番地
        LW   r2, 0(r1)        ; ノードを読む
        ADD  r10, r10, r2     ; すぐ使うので、ここで待つ
        ADDI r4, r4, 4
        SUBI r3, r3, 1
        BNEZ r3, loop
        HALT` },
      { name: '独立ロード（4つ展開）', init: initList, code:
`; 4つのロードを先に全部出してから使う
        LI   r4, 0x40000
        LI   r3, 256
loop:
        LW   r1, 0(r4)
        LW   r2, 4(r4)
        LW   r5, 8(r4)
        LW   r6, 12(r4)
        LW   r1, 0(r1)        ; 4つのミスが同時に飛ぶ
        LW   r2, 0(r2)
        LW   r5, 0(r5)
        LW   r6, 0(r6)
        ADD  r10, r10, r1     ; ここで初めて待つ
        ADD  r10, r10, r2
        ADD  r10, r10, r5
        ADD  r10, r10, r6
        ADDI r4, r4, 16
        SUBI r3, r3, 1
        BNEZ r3, loop
        HALT` }] },
];
