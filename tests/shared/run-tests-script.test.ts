import { spawnSync } from 'node:child_process'

import { describe, expect, it, vi } from 'vitest'

import {
  buildCiTestPlan,
  ciCommonWorkers,
  ciEnabled,
  runVitest,
} from '../../scripts/run-tests.mjs'

const workspaceTest = 'tests/server/workspace-diff-tracker.test.ts'

describe('CI test split', () => {
  it('honours an explicit max-worker cap in common, clamps it, and keeps workspace-diff at 1', () => {
    expect(buildCiTestPlan(['--max-workers', '3'], '1')).toEqual({
      common: ['--maxWorkers=3', '--exclude', workspaceTest],
      isolated: [workspaceTest, '--maxWorkers=1', '--no-file-parallelism'],
    })
    // 封顶 4：8 个并行 job × 4 worker = 32 ≤ 188 主机 40 核；8 / 12 在 pipeline 546165 实测更慢且挤红时序用例
    expect(buildCiTestPlan(['--maxWorkers=99'], '1')?.common).toEqual([
      '--maxWorkers=4',
      '--exclude',
      workspaceTest,
    ])
    // 不传 / 传非法值 → 回到 08-30 起的串行基线
    expect(buildCiTestPlan([], '1')?.common).toContain('--maxWorkers=1')
    expect(buildCiTestPlan(['--maxWorkers=0'], '1')?.common).toContain('--maxWorkers=1')
    expect(buildCiTestPlan(['--maxWorkers=abc'], '1')?.common).toContain('--maxWorkers=1')
    expect(ciCommonWorkers(['--maxWorkers=2', '--max-workers', '3'])).toBe(3)
  })

  it('clamps the CI lanes exactly as .ftask/ci.yml invokes them (server 8 / client 12 → 4 / 4)', () => {
    // 与 .ftask/ci.yml 的 test-server / test-client cmd 同步；改一处必须改另一处。
    // 清单请求 8 / 12，运行时封顶到 4（见 scripts/run-tests.mjs CI_WORKER_CEILING）
    expect(buildCiTestPlan(['tests/server', '--maxWorkers=8'], '1')).toEqual({
      common: ['tests/server', '--maxWorkers=4', '--exclude', workspaceTest, '--passWithNoTests'],
      isolated: [workspaceTest, '--maxWorkers=1', '--no-file-parallelism'],
    })
    expect(buildCiTestPlan(['tests/client', '--maxWorkers=12'], '1')).toEqual({
      common: ['tests/client', '--maxWorkers=4', '--exclude', workspaceTest, '--passWithNoTests'],
      isolated: null,
    })
  })

  it('keeps CI isolation when a path filter includes workspace-diff', () => {
    expect(buildCiTestPlan(['tests/server'], '1')).toEqual({
      common: ['tests/server', '--maxWorkers=1', '--exclude', workspaceTest, '--passWithNoTests'],
      isolated: [workspaceTest, '--maxWorkers=1', '--no-file-parallelism'],
    })
    expect(buildCiTestPlan(['tests/client'], '1')).toEqual({
      common: ['tests/client', '--maxWorkers=1', '--exclude', workspaceTest, '--passWithNoTests'],
      isolated: null,
    })
    expect(buildCiTestPlan([workspaceTest], '1')?.isolated).toEqual([
      workspaceTest,
      '--maxWorkers=1',
      '--no-file-parallelism',
    ])
    expect(buildCiTestPlan(['--exclude', 'workspace-diff'], '1')).not.toBeNull()
  })

  it('strips every concurrency spelling so the CI cap cannot be defeated', () => {
    // --minWorkers 会跟 cap 的 max=1 打架；--poolOptions.*.max* 优先级更高会静默盖掉 cap，
    // 且 --poolOptions / --pool-options 两种前缀 vitest 都收
    for (const extra of [
      ['--minWorkers=8'],
      ['--min-workers', '8'],
      ['--poolOptions.forks.maxForks=8'],
      ['--poolOptions.threads.maxThreads', '8'],
      ['--poolOptions.vmForks.minForks=8'],
      ['--pool-options.forks.maxForks=8'],
      ['--pool-options.threads.maxThreads', '8'],
      ['--pool-options.vmThreads.minThreads=8'],
    ]) {
      expect(buildCiTestPlan(['tests/client', ...extra], '1')).toEqual({
        common: ['tests/client', '--maxWorkers=1', '--exclude', workspaceTest, '--passWithNoTests'],
        isolated: null,
      })
    }
    // 显式 max 放行，但同行的 min / poolOptions 仍被剥：留下的只有一条 --maxWorkers
    expect(buildCiTestPlan(['tests/client', '--maxWorkers=12', '--minWorkers=8', '--poolOptions.forks.maxForks=40'], '1')?.common)
      .toEqual(['tests/client', '--maxWorkers=4', '--exclude', workspaceTest, '--passWithNoTests'])
  })

  it('does not fail the common phase when a filter selects only the isolated file', () => {
    // 排掉隔离文件后一个用例都不剩，vitest 默认 "No test files found" 退 1 —— 又一条假红
    for (const filter of ['workspace-diff', workspaceTest, `./${workspaceTest}`]) {
      expect(buildCiTestPlan([filter], '1')?.common).toContain('--passWithNoTests')
    }
    // 未过滤的全量跑不放行空集：那时候空集是真的出问题了
    expect(buildCiTestPlan(['--maxWorkers=4'], '1')?.common).not.toContain('--passWithNoTests')
  })

  it('leaves filtered runs untouched outside CI', () => {
    // 显式传 '0'：传 undefined 会激活默认参数 process.env.CI，在 CI 里这条自己就红
    expect(buildCiTestPlan(['tests/server'], '0')).toBeNull()
  })

  it('keeps reporting options without clobbering phase-one artifacts', () => {
    const plan = buildCiTestPlan([
      '--coverage',
      '--reporter',
      'junit',
      '--outputFile',
      'reports/results.xml',
      '--coverage.reportsDirectory=coverage-ci',
    ], '1')

    expect(plan?.common).toContain('reports/results.xml')
    expect(plan?.isolated).toContain('reports/results.workspace-diff.xml')
    expect(plan?.isolated).toContain('--coverage.reportsDirectory=coverage-ci/workspace-diff')
    expect(plan?.isolated).toContain('junit')
  })

  it('isolates kebab output-file artifacts', () => {
    const plan = buildCiTestPlan(['--reporter=junit', '--output-file=reports/results.xml'], '1')

    expect(plan?.isolated).toContain('--output-file=reports/results.workspace-diff.xml')
  })

  it('recognizes explicit false CI values', () => {
    for (const value of [undefined, '', '0', 'false', 'FALSE', 'no', 'off']) {
      expect(ciEnabled(value)).toBe(false)
    }
    expect(ciEnabled('1')).toBe(true)
  })

  it('prints spawn errors and fails closed', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const status = runVitest([], () => ({ status: null, error: new Error('spawn denied') }))

    expect(status).toBe(1)
    expect(error).toHaveBeenCalledWith('Failed to start Vitest: spawn denied')
  })

  it('partitions the exact Vitest file set without gaps or overlap', () => {
    const list = (...args: string[]) => {
      const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'list', '--filesOnly', ...args], {
        encoding: 'utf8',
      })
      expect(result.status, result.stderr).toBe(0)
      return new Set(result.stdout.trim().split('\n').filter(Boolean))
    }
    const full = list()
    const common = list('--exclude', workspaceTest)
    const isolated = list(workspaceTest)

    expect([...common].filter(file => isolated.has(file))).toEqual([])
    expect(new Set([...common, ...isolated])).toEqual(full)
  })
})
