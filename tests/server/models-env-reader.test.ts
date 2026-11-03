import { describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/db', () => ({ getDb: vi.fn() }))

import { envReader } from '../../packages/server/src/controllers/hermes/models'

// 上游 EKKOLearnAI/hermes-web-ui #2884（703bd4f95）：`^KEY\s*=\s*(.+)` 的 \s* 会吃掉换行，
// 空值 KEY 因此把下一整行（含下一个 KEY 名）当成自己的值。
describe('models envReader (upstream #2884)', () => {
  const env = 'KIMI_BASE_URL=\nKIMI_API_KEY=sk-kimi\nEMPTY_TAIL=\n'

  it('空值 KEY 不读到下一行', () => {
    const { envHasValue, envGetValue } = envReader(env)
    expect(envGetValue('KIMI_BASE_URL')).toBe('')
    expect(envHasValue('KIMI_BASE_URL')).toBe(false)
  })

  it('有值的 KEY 照常读取，等号两侧空格/制表符仍允许', () => {
    const { envHasValue, envGetValue } = envReader('A = one\nB=\ttwo\n')
    expect(envGetValue('A')).toBe('one')
    expect(envGetValue('B')).toBe('two')
    expect(envHasValue('A')).toBe(true)
    expect(envGetValue('KIMI_API_KEY')).toBe('')
    expect(envReader(env).envGetValue('KIMI_API_KEY')).toBe('sk-kimi')
  })

  it('KEY 与 = 之间也不跨行', () => {
    const { envHasValue, envGetValue } = envReader('A\n=one\nB=two\n')
    expect(envGetValue('A')).toBe('')
    expect(envHasValue('A')).toBe(false)
    expect(envGetValue('B')).toBe('two')
  })
})
