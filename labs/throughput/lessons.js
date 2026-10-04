// スループット・ラボのプログラムと課題
// プログラムを足すときは PRESETS に1つ加える。課題は CHALLENGES に (docs/extending.md)

export const MEM_BYTES = 1024;
/** データメモリの初期値: ワード n (番地 4n) に n + 1 */
export const initMemory = mem => { for (let i = 0; i < MEM_BYTES / 4; i++) mem.writeWord(i * 4, i + 1); };

export const PRESETS = [
  { id: 'indep', name: '独立命令', tag: '24命令・依存なし', desc: '互いに依存しない命令の列。ハザードがないので、パイプラインと発行幅の効果がそのまま出ます。',
    src: `; 依存関係のない命令を並べる
ADDI r1, r0, 1
ADDI r2, r0, 2
ADDI r3, r0, 3
ADDI r4, r0, 4
ADDI r5, r0, 5
ADDI r6, r0, 6
ADDI r7, r0, 7
ADDI r8, r0, 8
ADD  r9, r1, r2
ADD  r10, r3, r4
ADD  r11, r5, r6
ADD  r12, r7, r8
SUB  r13, r1, r2
SUB  r14, r3, r4
OR   r15, r5, r6
AND  r9, r7, r8
ADDI r1, r0, 9
ADDI r2, r0, 10
ADDI r3, r0, 11
ADDI r4, r0, 12
ADDI r5, r0, 13
ADDI r6, r0, 14
ADDI r7, r0, 15
ADDI r8, r0, 16` },
  { id: 'chain', name: '依存チェーン', tag: '直前の結果を毎回使う', desc: '各命令が直前の命令の結果を使います。フォワーディングの有無で大きく差が出ます。2命令幅にしても速くなりません。',
    src: `; r1 を毎回 2 倍にする
ADDI r1, r0, 1
ADD  r1, r1, r1
ADD  r1, r1, r1
ADD  r1, r1, r1
ADD  r1, r1, r1
ADD  r1, r1, r1
ADD  r1, r1, r1
ADD  r1, r1, r1
ADD  r1, r1, r1
ADD  r1, r1, r1
ADD  r1, r1, r1
ADD  r1, r1, r1
SW   r1, 128(r0)`,
    expectMem: { 128: 2048 } },
  { id: 'sum', name: '配列の合計', tag: 'ループ・ロード・分岐', desc: '16要素の配列を合計して メモリ[64] に保存します（正解は 136）。ロード直後の使用と、ループの分岐がハザードを生みます。',
    src: `; 配列 (番地 0〜60) の合計を求める
      ADDI r1, r0, 0     ; 番地
      ADDI r2, r0, 16    ; 残り回数
      ADDI r5, r0, 0     ; 合計
loop: LW   r3, 0(r1)
      ADD  r5, r5, r3    ; ロード直後に使用
      ADDI r1, r1, 4
      ADDI r2, r2, -1
      BNE  r2, r0, loop
      SW   r5, 64(r0)`,
    expectMem: { 64: 136 } },
  { id: 'dot', name: '内積', tag: 'MUL・2本のロード', desc: '2つのベクトル(8要素)の内積。乗算器のレイテンシとキャッシュミス率の影響を見るのに向いています。',
    src: `; a[i] (0〜28) と b[i] (32〜60) の内積
      ADDI r1, r0, 0
      ADDI r2, r0, 8
      ADDI r6, r0, 0
loop: LW   r3, 0(r1)
      LW   r4, 32(r1)
      MUL  r5, r3, r4
      ADD  r6, r6, r5
      ADDI r1, r1, 4
      ADDI r2, r2, -1
      BNE  r2, r0, loop
      SW   r6, 128(r0)`,
    expectMem: { 128: 492 } },
];

/** 課題。ok(run) が true になると達成。run は app.js の S.run */
export const CHALLENGES = [
  { id: 'c1', t: 'パイプラインの威力', d: '「独立命令」をパイプライン5段で実行し、IPC 0.8 以上を出す（非パイプラインの 0.20 と比べてみよう）。',
    ok: r => r.preset === 'indep' && !r.edited && r.cfg.pipelined && r.N / r.total >= 0.8 },
  { id: 'c2', t: 'ループを速く', d: '「配列の合計」を書き換えずに IPC 0.75 以上にする。',
    ok: r => r.preset === 'sum' && !r.edited && r.cfg.miss === 0 && r.N / r.total >= 0.75 },
  { id: 'c3', t: 'コンパイラになる', d: '「配列の合計」の命令を並べ替えて、フォワーディングありでデータハザードを 0 にする。結果（136）は正しいまま。',
    ok: r => r.preset === 'sum' && r.cfg.forwarding && r.cfg.pipelined && r.data === 0 && r.mem.readWord(64) === 136 && r.N >= 80 },
  { id: 'c4', t: '周波数に頼らない', d: 'クロック 800 MHz 以下のまま、「独立命令」で 1,000 MIPS 以上を出す。',
    ok: r => r.preset === 'indep' && !r.edited && r.cfg.freq <= 800 && r.N / r.total * r.cfg.freq >= 1000 },
];
