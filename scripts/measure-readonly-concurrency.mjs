// P0-0 基线测量脚本（不挂 CI）：测量当前只读操作派发路径的并发墙钟。
// 用法：node scripts/measure-readonly-concurrency.mjs
// 断言版并发行为测试见 Tests/desktop/worker/operation-scheduler.test.ts（随 P0-3b 提交），
// 本脚本只输出数字供 docs/AGENT_REFACTOR_ROADMAP.md 基线表记录前后对照。
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import console from 'node:console';
import { serialCall } from '../packages/core/src/serial-call.ts';

const DELAY_MS = 50;
const CONCURRENT = 4;

// 当前生产派发路径：task-runner 对全部工具调用统一 serialCall 串行（task-runner.ts）。
const dispatch = serialCall(async (index) => {
  await delay(DELAY_MS);
  return index;
});

const singleStart = performance.now();
await dispatch(0);
const singleMs = performance.now() - singleStart;

const batchStart = performance.now();
await Promise.all(Array.from({ length: CONCURRENT }, (_, index) => dispatch(index + 1)));
const batchMs = performance.now() - batchStart;

console.log(`单条只读操作（${DELAY_MS}ms 模拟延迟）：${singleMs.toFixed(1)}ms`);
console.log(`${CONCURRENT} 条只读操作并发提交墙钟：${batchMs.toFixed(1)}ms（≈单条 ×${(batchMs / singleMs).toFixed(2)}）`);
