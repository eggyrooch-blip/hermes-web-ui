import { describe, expect, it } from 'vitest'
import { getSystemPrompt } from '../../packages/server/src/lib/llm-prompt'

describe('LLM output format prompt', () => {
  it('instructs agents to reference generated artifacts with workspace-relative paths', () => {
    const prompt = getSystemPrompt()

    expect(prompt).toContain('相对路径')
    expect(prompt).toContain('![图片描述](screenshot.png)')
    expect(prompt).not.toContain('/tmp/screenshot.png')
  })

  it('instructs agents to link HTML animations instead of embedding them as images', () => {
    const prompt = getSystemPrompt()

    expect(prompt).toContain('[动画名称](animation.html)')
    expect(prompt).toContain('不要使用 `![描述](animation.html)`')
  })
})
