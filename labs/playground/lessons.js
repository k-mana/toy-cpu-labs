// 命令セット・ラボのプログラム
export const EXAMPLES = [
  { name: '1〜10 の合計', code: `; 1 + 2 + … + 10 を r2 に求めて、result に書く
        LI   r1, 10
        LI   r2, 0
loop:   ADD  r2, r2, r1
        SUBI r1, r1, 1
        BNEZ r1, loop
        SW   r2, result
        HALT

.data
.org 0x100
result: .word 0`, expect: { regs: { 2: 55 }, mem: { 0x100: 55 } } },
  { name: '配列の最大値', code: `; data の 8 個のうち最大のものを r3 に
        LA   r1, data        ; 先頭番地
        LI   r2, 8           ; 個数
        LW   r3, 0(r1)
loop:   LW   r4, 0(r1)
        BGE  r3, r4, skip
        MOV  r3, r4
skip:   ADDI r1, r1, 4
        SUBI r2, r2, 1
        BNEZ r2, loop
        HALT

.data
.org 0x40
data:   .word 12, -5, 99, 7, 42, 99, 0, 63`, expect: { regs: { 3: 99 } } },
  { name: 'サブルーチン (CALL/RET)', code: `; square を2回呼ぶ: r1 = (3²)² = 81
        LI   r1, 3
        CALL square
        CALL square
        HALT

square: MUL  r1, r1, r1
        RET`, expect: { regs: { 1: 81 } } },
  { name: '文字列の長さ', code: `; ゼロで終わるバイト列の長さを r2 に
        LA   r1, text
        LI   r2, 0
loop:   LBU  r3, 0(r1)
        BEQZ r3, done
        ADDI r2, r2, 1
        ADDI r1, r1, 1
        J    loop
done:   HALT

.data
text:   .byte 'T', 'O', 'Y', '-', 'C', 'P', 'U', 0`, expect: { regs: { 2: 7 } } },
];
