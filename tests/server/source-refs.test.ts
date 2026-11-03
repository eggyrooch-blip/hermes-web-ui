import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { authorizeSourceRefs, normalizeSourceRefs } from '../../packages/server/src/services/hermes/source-refs'

let tempHome = ''

afterEach(() => {
  delete process.env.HERMES_HOME
  if (tempHome) rmSync(tempHome, { recursive: true, force: true })
  tempHome = ''
})

describe('source refs trust boundary', () => {
  it('consumes the fixed D contract and drops unsafe or inferred-looking values', () => {
    expect(normalizeSourceRefs([
      { id: 'web-guide', type: 'web', label: 'Guide', uri: 'https://docs.example.com/guide?token=drop#x' },
      { id: 'workspace-report', type: 'workspace', label: 'Report', locator: 'reports/source.txt' },
      { id: 'lark-policy', type: 'lark_doc', label: 'Policy', locator: 'doccnFixture123' },
      { id: 'bad', type: 'web', label: 'Bad', uri: 'javascript:alert(1)' },
      { id: 'encoded', type: 'lark_doc', label: 'hidden%20ou_secret', locator: 'docSafe' },
      { id: 'escape', type: 'workspace', label: 'Escape', locator: '../secret' },
    ])).toEqual([
      { id: 'web-guide', type: 'web', label: 'Guide', uri: 'https://docs.example.com/guide' },
      { id: 'workspace-report', type: 'workspace', label: 'Report', locator: 'reports/source.txt' },
      { id: 'lark-policy', type: 'lark_doc', label: 'Policy', locator: 'doccnFixture123' },
    ])
  })

  it('authorizes only files whose real path stays inside the routed profile workspace', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'source-ref-home-'))
    const workspace = join(tempHome, 'workspace')
    const outside = join(tempHome, 'outside.txt')
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'inside.txt'), 'ok')
    writeFileSync(outside, 'secret')
    symlinkSync(outside, join(workspace, 'escape.txt'))
    process.env.HERMES_HOME = tempHome

    const authorized = await authorizeSourceRefs({
      profile: 'default',
      ownerOpenId: 'ou_reader',
      messages: [{
        id: 1,
        role: 'assistant',
        run_id: 'run-1',
        source_refs: [
          { id: 'inside', type: 'workspace', label: 'Inside', locator: 'inside.txt' },
          { id: 'escape', type: 'workspace', label: 'Escape', locator: 'escape.txt' },
        ],
      }],
    })

    expect(authorized.get('1')).toEqual([
      { id: 'inside', type: 'workspace', label: 'Inside', open_path: '/workspace/inside.txt' },
    ])
  })
})
