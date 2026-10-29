import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 等待类断言要等冷启动（Pi 插件加载、模型 fixture、IPC）完成，
  // vitest 默认 testTimeout 5000ms / waitFor 1000ms 在慢机器上余量不足。
  test: {
    include: ['Tests/**/*.{test,spec}.{ts,tsx,mts,cts,js,mjs,cjs}'],
    environment: 'node',
    testTimeout: 30_000
  }
});
