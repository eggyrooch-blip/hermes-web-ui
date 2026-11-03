import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'packages/client/src'),
      '/logo.png': resolve(__dirname, 'packages/client/src/assets/logo.png'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // 这两个是"机器慢也别假红"的裕量，不是被测行为的契约。server 侧不少用例真的
    // spawn git / node-pty 子进程，还刻意让子进程 sleep 数秒去逼出超时分支；开发机
    // 上绰绰有余，CI runner（node:24 容器 + --maxWorkers=4）就会踩线：2026-08-06 连续
    // 三条流水线全红在同一批文件、每次红的子用例都不同，错误清一色是
    // `Test timed out in 15000ms` / `Hook timed out in 10000ms`，零断言失败 —— main
    // 自己的 #536039 也一样。真正的"有界完成"契约写在用例内部
    // （如 workspace-diff-tracker 的 expect(elapsed).toBeLessThan(3_500)），那些断言原样
    // 保留，这里只是不让 harness 先于断言掐断。
    // ponytail: 天花板是"真挂起要多等 30s 才报"，可接受;若哪天用例真需要 >30s，
    // 该修的是那个用例，不是继续往上加这个数。
    testTimeout: 30_000,
    // hookTimeout 之前吃的是 vitest 默认 10s —— 而 afterEach 要 await 子进程 settle，
    // 里面可能正躺着一个测试故意制造的 4s 停顿，10s 根本不够。
    hookTimeout: 30_000,
  },
})
