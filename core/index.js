// toy-cpu コア — まとめて読み込むための入口
//   import { createISA, BASE, MULDIV, ATOMIC, assemble, Machine } from '../../core/index.js';

export * from './isa.js';
export * from './assembler.js';
export * from './memory.js';
export * from './machine.js';
export * from './cache.js';
export * from './hierarchy.js';
export * from './predictor.js';
export * from './pipeline.js';
export * from './inorder.js';
export * from './sched.js';
export * from './random.js';
export { BASE } from './ext/base.js';
export { MULDIV } from './ext/muldiv.js';
export { ATOMIC } from './ext/atomic.js';
export { XMRMW } from './ext/xmrmw.js';

import { createISA } from './isa.js';
import { BASE } from './ext/base.js';
import { MULDIV } from './ext/muldiv.js';
import { ATOMIC } from './ext/atomic.js';

/** よく使う組み合わせ: 基本 + 乗除算 + アトミック (TOY-IMA) */
export const defaultISA = () => createISA([BASE, MULDIV, ATOMIC]);
