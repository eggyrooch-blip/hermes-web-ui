import { describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/lib/llm-prompt', () => ({
  getSystemPrompt: (prompt: string) => prompt,
}))

import { buildAgentInstructions } from '../../packages/server/src/services/hermes/context-engine/prompt'

describe('group-chat context prompt', () => {
  it('anchors an agent to its own profile when room history mentions other profiles', () => {
    const instructions = buildAgentInstructions({
      agentName: 'hello',
      agentProfile: 'hello',
      roomName: 'room-1',
      agentDescription: 'Writing agent',
      memberNames: ['feishu_user_a', 'hello'],
      members: [
        { userId: 'owner', name: 'feishu_user_a', description: 'Owner profile' },
        { userId: 'hello', name: 'hello', description: 'Writing agent' },
      ],
    } as any)

    expect(instructions).toContain('当前 profile：hello')
    expect(instructions).toContain('不要声称自己是其它成员或其它 profile')
    expect(instructions).toContain('当你收到群聊任务时，说明系统已经判断你需要回复')
    expect(instructions).toContain('不要主动 @ 任何人，除非最新消息明确要求你转交')
  })
})
