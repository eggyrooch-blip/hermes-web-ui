// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'

function makeSession(messages: Message[]): Session {
  return {
    id: 'session-artifacts',
    title: 'Artifacts',
    messages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('chat store sessionArtifacts', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('collects assistant workspace MEDIA artifacts in first-seen order and dedupes by path', () => {
    const store = useChatStore()
    store.activeSessionId = 'session-artifacts'
    store.activeSession = makeSession([
      {
        id: 'user-1',
        role: 'user',
        content: 'MEDIA:/tmp/ignore-user.html',
        timestamp: 1,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: [
          'Done',
          'MEDIA:/tmp/project/workspace/reports/daily report.html',
          'MEDIA:/tmp/project/workspace/reports/summary.md',
          'MEDIA:/tmp/project/other/not-in-workspace.txt',
        ].join('\n'),
        timestamp: 2,
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: [
          'Another result',
          '  MEDIA:/tmp/project/workspace/reports/daily report.html',
          'MEDIA:/tmp/project/workspace/charts/plot final.png',
        ].join('\n'),
        timestamp: 3,
      },
    ])

    expect(store.sessionArtifacts).toEqual([
      {
        name: 'daily report.html',
        path: '/workspace/reports/daily%20report.html',
      },
      {
        name: 'summary.md',
        path: '/workspace/reports/summary.md',
      },
      {
        name: 'plot final.png',
        path: '/workspace/charts/plot%20final.png',
      },
    ])
  })
})
