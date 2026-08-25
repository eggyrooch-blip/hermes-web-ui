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

  // A `write_file` run reports its output through the workspace diff, not a
  // MEDIA: line. Reading only MEDIA: meant the transcript showed a file card
  // while 产物 said "这个任务没有生成文件".
  it('collects artifacts from the workspace diff when there is no MEDIA: line', () => {
    const store = useChatStore()
    store.activeSessionId = 'session-artifacts'
    store.activeSession = makeSession([
      { id: 'assistant-1', role: 'assistant', content: 'Wrote the page.', timestamp: 1 },
    ])
    store.upsertWorkspaceDiff('session-artifacts', {
      change_id: 'c1',
      run_id: 'run-1',
      files: [
        { id: 1, path: 'index.html', additions: 682, deletions: 0 },
        { id: 2, path: 'assets/app main.css', additions: 12, deletions: 3 },
      ],
    } as never)

    expect(store.sessionArtifacts).toEqual([
      { name: 'index.html', path: '/workspace/index.html' },
      { name: 'app main.css', path: '/workspace/assets/app%20main.css' },
    ])
  })

  it('does not list the same file twice when it is in both MEDIA: and the diff', () => {
    const store = useChatStore()
    store.activeSessionId = 'session-artifacts'
    store.activeSession = makeSession([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'MEDIA:/tmp/project/workspace/index.html',
        timestamp: 1,
      },
    ])
    store.upsertWorkspaceDiff('session-artifacts', {
      change_id: 'c1',
      run_id: 'run-1',
      files: [{ id: 1, path: 'index.html', additions: 1, deletions: 0 }],
    } as never)

    expect(store.sessionArtifacts).toEqual([
      { name: 'index.html', path: '/workspace/index.html' },
    ])
  })

  it('ignores another session\'s diff', () => {
    const store = useChatStore()
    store.activeSessionId = 'session-artifacts'
    store.activeSession = makeSession([])
    store.upsertWorkspaceDiff('someone-else', {
      change_id: 'c1',
      run_id: 'run-1',
      files: [{ id: 1, path: 'leaked.html', additions: 1, deletions: 0 }],
    } as never)

    expect(store.sessionArtifacts).toEqual([])
  })
})
