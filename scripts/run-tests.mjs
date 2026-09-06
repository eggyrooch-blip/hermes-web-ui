import { spawnSync } from 'node:child_process'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCLI } from 'vitest/node'

const WORKSPACE_DIFF_TEST = 'tests/server/workspace-diff-tracker.test.ts'

// Vitest 有好几个入口能设并发度，cap 要真生效就得先把 caller 的所有写法清掉：
// `--minWorkers=8` 会跟我们加的 max=1 直接打架（Tinypool 抛错），而
// `--poolOptions.<pool>.max*` 优先级高于 `--maxWorkers`，会**静默**盖掉 cap。
// `--poolOptions` 与 `--pool-options` 两种前缀 Vitest 都收，都要剥。
const WORKER_OPTIONS = new Set([
  '--maxWorkers',
  '--max-workers',
  '--minWorkers',
  '--min-workers',
  ...['--poolOptions', '--pool-options'].flatMap(prefix => [
    ...['forks', 'vmForks'].flatMap(pool => [
      `${prefix}.${pool}.maxForks`,
      `${prefix}.${pool}.minForks`,
    ]),
    ...['threads', 'vmThreads'].flatMap(pool => [
      `${prefix}.${pool}.maxThreads`,
      `${prefix}.${pool}.minThreads`,
    ]),
  ]),
])
const args = process.argv.slice(2)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const vitestBin = resolve(scriptDir, '../node_modules/vitest/vitest.mjs')

export function runVitest(runArgs, spawn = spawnSync) {
  const result = spawn(process.execPath, [vitestBin, 'run', ...runArgs], {
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) console.error(`Failed to start Vitest: ${result.error.message}`)
  return result.status ?? 1
}

export function ciEnabled(value) {
  return value !== undefined && !/^(?:|0|false|no|off)$/i.test(value.trim())
}

function stripOptions(rawArgs, valueOptions, booleanOptions = new Set()) {
  const kept = []
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]
    const name = arg.split('=', 1)[0]
    if (booleanOptions.has(name)) continue
    if (!valueOptions.has(name)) {
      kept.push(arg)
      continue
    }
    if (!arg.includes('=')) index += 1
  }
  return kept
}

function withIsolatedArtifactPaths(rawArgs, coverageEnabled) {
  const rewritten = []
  let hasCoverageDirectory = false

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]
    const equalAt = arg.indexOf('=')
    const name = equalAt < 0 ? arg : arg.slice(0, equalAt)
    const isOutputFile = /^--output-?(?:F|f)ile(?:\.[^.]+)?$/.test(name)
    const isCoverageDirectory = name === '--coverage.reportsDirectory' || name === '--coverage.reports-directory'
    if (!isOutputFile && !isCoverageDirectory) {
      rewritten.push(arg)
      continue
    }

    hasCoverageDirectory ||= isCoverageDirectory
    const value = equalAt < 0 ? rawArgs[++index] : arg.slice(equalAt + 1)
    const isolatedValue = isCoverageDirectory
      ? join(value, 'workspace-diff')
      : value === '-'
        ? value
        : `${value.slice(0, value.length - extname(value).length)}.workspace-diff${extname(value)}`
    rewritten.push(equalAt < 0 ? name : `${name}=${isolatedValue}`)
    if (equalAt < 0) rewritten.push(isolatedValue)
  }

  if (coverageEnabled && !hasCoverageDirectory) {
    rewritten.push('--coverage.reportsDirectory=coverage/workspace-diff')
  }
  return rewritten
}

export function buildCiTestPlan(rawArgs, ciValue = process.env.CI) {
  if (!ciEnabled(ciValue)) return null

  const parsed = parseCLI(['vitest', 'run', ...rawArgs])
  const filters = parsed.filter.map(filter => filter.replace(/^\.\//, ''))
  const includesWorkspaceDiff = filters.length === 0
    || filters.some(filter => WORKSPACE_DIFF_TEST.includes(filter))

  const workerOptions = WORKER_OPTIONS
  const isolatedValueOptions = new Set([...workerOptions, '--exclude'])
  const isolatedBooleanOptions = new Set([
    '--fileParallelism',
    '--file-parallelism',
    '--no-fileParallelism',
    '--no-file-parallelism',
  ])
  const common = [
    ...stripOptions(rawArgs, workerOptions),
    '--maxWorkers=1',
    '--exclude',
    WORKSPACE_DIFF_TEST,
    // filter 只命中被隔离的那个文件时（`npm test -- workspace-diff`），common 阶段
    // 排掉它就一个文件都不剩，vitest 会以 "No test files found" 退 1 —— 又是一条假红。
    // 这里放行空集不会掩盖"整轮没跑用例"：isolated 阶段一定会跑到那个文件。
    ...(filters.length > 0 ? ['--passWithNoTests'] : []),
  ]
  const isolated = includesWorkspaceDiff
    ? [
        ...withIsolatedArtifactPaths(
          stripOptions(rawArgs, isolatedValueOptions, isolatedBooleanOptions)
            .filter(arg => !parsed.filter.includes(arg)),
          parsed.options.coverage?.enabled === true,
        ),
        WORKSPACE_DIFF_TEST,
        '--maxWorkers=1',
        '--no-file-parallelism',
      ]
    : null
  return { common, isolated }
}

export function main(rawArgs = args, ciValue = process.env.CI) {
  const plan = buildCiTestPlan(rawArgs, ciValue)
  if (plan === null) return runVitest(rawArgs)

  const suiteStatus = runVitest(plan.common)
  if (suiteStatus !== 0) process.exit(suiteStatus)

  return plan.isolated === null ? 0 : runVitest(plan.isolated)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
