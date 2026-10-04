// テスト用の小道具
import { createISA, BASE, MULDIV, ATOMIC, XMRMW, assemble, Machine } from '../core/index.js';

export const isa = createISA([BASE, MULDIV, ATOMIC]);
export const isaX = createISA([BASE, MULDIV, ATOMIC, XMRMW]);

/** アセンブルし、エラーがあれば投げる */
export function asm(src, opts = {}) {
  const { program, errors } = assemble(src, { isa: opts.isa || isa, ...opts });
  if (errors.length) throw new Error(errors.map(e => `${e.line}: ${e.message}`).join('\n'));
  return program;
}

/** 1コアで最後まで実行し、マシンを返す */
export function run(src, opts = {}) {
  const program = asm(src, opts);
  const m = new Machine({ program, memSize: opts.memSize ?? 4096, init: opts.init });
  const res = m.run({ maxSteps: opts.maxSteps ?? 100000 });
  return { m, program, res, r: i => m.cores[0].regs[i] };
}

/** 実行してトレースを返す */
export function traceOf(src, opts = {}) {
  const program = asm(src, opts);
  const m = new Machine({ program, memSize: opts.memSize ?? 4096, init: opts.init });
  const { trace } = m.trace();
  return { program, trace, m };
}
