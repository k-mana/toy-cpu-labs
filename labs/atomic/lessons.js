// アトミック・ラボ (AL-2 構成: 2コア) のレッスン
// 足すときは LESSONS に { title, body, tasks, point, variants:[{ name, safe, code }] } を加える。
// プログラムでは記号 counter (番地 0x00) と lock (番地 0x04) が使える。
// .region cs 〜 .endregion で囲んだ範囲がクリティカルセクション。

export const SYMBOLS = { counter: 0x00, lock: 0x04 };
export const ADDR_NAME = { 0: 'counter', 4: 'lock' };
export const EXPECTED = 6;

export const LESSONS = [
  { title: '競合状態', body: [
      'C言語の counter++ は、機械語では「読む（LW）」「足す（ADDI）」「書く（SW）」の3命令です。',
      '2つのコアが同時に動くと、命令の順番は好きなように混ざります。両方が同じ古い値を読んでから書き戻すと、片方の +1 が上書きされて消えます。これが更新消失（lost update）です。'],
    tasks: ['切り替え確率「交互」で、スペースキーを8回押す。2回目の SW で counter が増えないことを確かめる。', '「1000回ランダムに実行」で、最終値が 6 にならない割合を見る。', '切り替え確率を「まれ」にすると失敗は減るが、0 にはならない。これが本番環境で見つけにくいバグになる理由。'],
    point: '<b>ポイント</b> 1命令ずつは正しく動いても、命令の「並び」が混ざると結果が壊れる。',
    variants: [{ name: 'LW / ADDI / SW', safe: false, code:
`; counter++ を3回くり返す
        LI    r3, 3           ; 残り回数
loop:
        LW    r1, counter     ; ① 読む
        ADDI  r1, r1, 1       ; ② 足す
        SW    r1, counter     ; ③ 書く
        SUBI  r3, r3, 1
        BNEZ  r3, loop
        HALT` }] },
  { title: 'LOCK と fetch-and-add', body: [
      'メモリを直接 +1 する INCM counter は1命令に見えますが、CPU の内部では「読み出し」と「書き込み」の2つのマイクロ操作（μop）に分かれます。その間に他のコアが割り込めます。（INCM は x86 の INC [mem] にあたる、このラボ用の独自拡張命令です。）',
      'LOCK を付けると、CPU はキャッシュラインやバスを押さえたまま読み出しから書き込みまでを一度に行います。AMOADD は加算前の値も返す fetch-and-add で、x86 の LOCK XADD や C++ の fetch_add に当たります。'],
    tasks: ['「INCM（LOCK なし）」を交互に実行し、μop1 と μop2 の間に相手のコアが入り込む様子をトレースで見る。', '「LOCK INCM」に切り替えて同じ操作をする。BUS LOCK のランプが点き、結果が常に 6 になる。', '1000回試行で、LOCK の有無による分布の違いを比べる。'],
    point: '<b>ポイント</b> 「1命令だから安全」とは限らない。不可分性はハードウェアが保証したときだけ成り立つ。',
    variants: [
      { name: 'INCM（LOCK なし）', safe: false, code:
`        LI    r3, 3
loop:
        INCM  counter         ; 読み出し→書き込みの2 μop
        SUBI  r3, r3, 1
        BNEZ  r3, loop
        HALT` },
      { name: 'LOCK INCM', safe: true, code:
`        LI    r3, 3
loop:
        LOCK INCM counter     ; 不可分な +1
        SUBI  r3, r3, 1
        BNEZ  r3, loop
        HALT` },
      { name: 'AMOADD', safe: true, code:
`        LI    r3, 3
        LI    r2, 1
loop:
        AMOADD r1, r2, counter  ; r1 ← 旧値、counter += r2
        SUBI  r3, r3, 1
        BNEZ  r3, loop
        HALT` }] },
  { title: 'CAS ループ', body: [
      'CAS（compare-and-swap）は「メモリがまだ期待値のままなら新しい値を書く」を不可分に行い、メモリにあった値を返します。返ってきた値が期待値と同じなら成功です。',
      '失敗したときは最新の値を受け取って計算し直し、もう一度 CAS します。ロックを持たずに共有データを更新する lock-free アルゴリズムの基本形です。'],
    tasks: ['交互に実行し、コア1 の CAS が失敗して retry に戻る様子を見る（トレースでは打ち消し線）。', '失敗したコアの r1 に、相手が書いた最新値が入っていることを確かめる。', '1000回試行で、結果は常に 6。コアの「失敗/待ち」回数が増えるだけで値は壊れない。'],
    point: '<b>ポイント</b> CAS は競合を防ぐのではなく、競合を検出してやり直す。',
    variants: [{ name: 'CAS で +1', safe: true, code:
`        LI    r3, 3
loop:
        LW    r1, counter       ; 期待値 = 今の値
retry:
        ADDI  r2, r1, 1         ; 新しい値 = 期待値 + 1
        MOV   r4, r1            ; 期待値を覚えておく
        CAS   r1, r2, counter   ; r1 ← メモリの旧値（期待値と同じなら r2 を書く）
        BNE   r1, r4, retry     ; 違えば失敗: r1 に最新値が入っている
        SUBI  r3, r3, 1
        BNEZ  r3, loop
        HALT` }] },
  { title: 'スピンロック', body: [
      'ロックで守る場合も、ロックの取得そのものが不可分でなければ意味がありません。',
      '「lock が 0 か確かめる（LW）」と「1 を書く（SW）」を別々に行うと、その間に相手も 0 を見てしまい、2つのコアが同時にクリティカルセクションに入ります。XCHG は「1 を書き、元の値を受け取る」を一度に行うので、0 を受け取れるのは必ず1コアだけです。'],
    tasks: ['「読んでから書く」を交互に実行する。10ステップ目で2コアが同時にクリティカルセクション（黄色の行）に入り、状態欄に警告が出る。', '「XCHG」に切り替えて同じ操作をする。片方のコアは XCHG と BNEZ を回り続けて待つ（スピン）。', '切り替え確率を下げると、スピンの回数（失敗/待ち）がどう変わるか見る。'],
    point: '<b>ポイント</b> ロックは、アトミック命令の上に作られた仕組み。',
    variants: [
      { name: '読んでから書く', safe: false, code:
`        LI    r3, 3
loop:
acquire:
        LW    r4, lock
        BNEZ  r4, acquire     ; 使用中なら待つ
        LI    r4, 1
        SW    r4, lock        ; 取ったつもり
.region cs
        LW    r1, counter
        ADDI  r1, r1, 1
        SW    r1, counter
.endregion
        SW    r0, lock        ; 解放 (r0 は常に 0)
        SUBI  r3, r3, 1
        BNEZ  r3, loop
        HALT` },
      { name: 'XCHG（test-and-set）', safe: true, code:
`        LI    r3, 3
loop:
acquire:
        LI    r4, 1
        XCHG  r4, lock        ; 1 を書き、旧値を r4 へ
        BNEZ  r4, acquire     ; 旧値が 1 なら他コアが保持中
.region cs
        LW    r1, counter
        ADDI  r1, r1, 1
        SW    r1, counter
.endregion
        SW    r0, lock        ; 解放
        SUBI  r3, r3, 1
        BNEZ  r3, loop
        HALT` }] },
  { title: 'LL / SC', body: [
      'ARM や RISC-V は CAS の代わりに LL（load-linked）と SC（store-conditional）の組を使います。LL は値を読むと同時にその番地を「予約」し、SC は予約が残っているときだけ書き込みに成功します。',
      'LL と SC の間に誰かがその番地へ書くと予約は消えます。値が元に戻っていても書き込みがあれば失敗するので、CAS で問題になる ABA 問題が起きにくい方式です。'],
    tasks: ['交互に実行し、共有メモリの counter に付く予約タグ（C0/C1）を見る。', 'コア0 の SC が成功した瞬間にコア1 の予約が消え、コア1 の SC が失敗することを確かめる。', '1000回試行で、結果が常に 6 になることを確かめる。'],
    point: '<b>ポイント</b> LL/SC は「値」ではなく「書き込みがあったか」で競合を検出する。',
    variants: [{ name: 'LL / SC で +1', safe: true, code:
`        LI    r3, 3
loop:
        LL    r1, counter     ; 読み込み + 予約
        ADDI  r1, r1, 1
        SC    r4, r1, counter ; 予約が残っていれば書く (r4 ← 1)。なければ r4 ← 0
        BEQZ  r4, loop        ; 失敗ならやり直し
        SUBI  r3, r3, 1
        BNEZ  r3, loop
        HALT` }] },
];
