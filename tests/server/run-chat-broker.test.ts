import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildRunBrokerRequest,
  buildRunBrokerHeaders,
  mapRunBrokerFrameForChat,
  readSseFrames,
} from '../../packages/server/src/services/hermes/run-chat/handle-broker-run'

describe('run-chat broker compatibility module', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function makeProfile() {
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-run-chat-profile-'))
    roots.push(profileDir)
    mkdirSync(join(profileDir, 'skills', 'Keep', 'kep-hades-cli'), { recursive: true })
    mkdirSync(join(profileDir, 'skills', 'Keep', 'keep-record'), { recursive: true })
    writeFileSync(join(profileDir, 'skills', 'Keep', 'kep-hades-cli', 'SKILL.md'), [
      '---',
      'name: kep-hades-cli',
      'description: Query Hades 投放管理系统 through kep-cli.',
      '---',
      '# Hades CLI',
      'Run `/Users/kite/.hermes/bin/hades-cli --profile "$KEP_PROFILE" --env online misc get --id <id> --output json`.',
    ].join('\n'), 'utf-8')
    writeFileSync(join(profileDir, 'skills', 'Keep', 'keep-record', 'SKILL.md'), [
      '---',
      'name: keep-record',
      'description: Record diet, weight, exercise, sleep, and other Keep health data.',
      '---',
      '# Keep record',
      'preload: true',
      'Use `node {baseDir}/scripts/mcp-call.js record_tool \'{"text":"..."}\'` for diet records.',
    ].join('\n'), 'utf-8')
    return profileDir
  }

  it('builds broker requests with owner identity, channel, session history and metadata', async () => {
    const request = await buildRunBrokerRequest({
      input: 'hello broker',
      profile: 'sunke',
      ownerOpenId: 'ou_owner',
      sessionId: 'session-broker',
      model: 'gpt-5.4',
      provider: 'openai',
      instructions: 'answer briefly',
      workspace: '/workspace/project',
      messages: [
        { id: 1, session_id: 'session-broker', role: 'user', content: 'old question', timestamp: 1 },
        { id: 2, session_id: 'session-broker', role: 'assistant', content: 'old answer', timestamp: 2 },
      ],
    })

    expect(request).toEqual(expect.objectContaining({
      channel: 'webui',
      profile_name: 'sunke',
      user_key: 'ou_owner',
      content: 'hello broker',
      session_id: 'session-broker',
      delivery_mode: 'socket',
      credential_subject: 'ou_owner',
      requires_host_tools: true,
    }))
    expect(request.messages).toEqual([
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'hello broker' },
    ])
    expect(request.metadata).toEqual(expect.objectContaining({
      source: 'hermes-web-ui',
      model: 'gpt-5.4',
      provider: 'openai',
      conversation: 'webui:session-broker',
    }))
    expect(request.metadata.instructions).toContain('[Current working directory: /workspace/project]')
    expect(request.metadata.instructions).toContain('answer briefly')
  })

  it('rewrites profile-local skill slash commands before sending WebUI broker runs', async () => {
    const profileDir = makeProfile()
    const request = await buildRunBrokerRequest({
      input: '/hades get 69df030c1f01cb45ba7ff585',
      profile: 'feishu_sunke',
      profileDir,
    })

    expect(request.content).toContain('invoked the "kep-hades-cli" skill')
    expect(request.content).toContain('69df030c1f01cb45ba7ff585')
    expect(request.content).toContain('hades-cli')
    expect(request.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('kep-hades-cli'),
    })
  })

  it('injects relevant profile-local preload skills for natural WebUI requests', async () => {
    const profileDir = makeProfile()
    const request = await buildRunBrokerRequest({
      input: '在keep 记录下中午吃的肥肠面+鸡蛋+鸡腿+青椒',
      profile: 'feishu_sunke',
      profileDir,
    })

    expect(request.content).toBe('在keep 记录下中午吃的肥肠面+鸡蛋+鸡腿+青椒')
    expect(request.metadata.instructions).toContain('profile skill "keep-record"')
    expect(request.metadata.instructions).toContain('record_tool')
    expect(request.metadata.instructions).toContain(join(profileDir, 'skills', 'Keep', 'keep-record'))
  })

  it('builds broker headers without leaking profile identity into owner identity', () => {
    expect(buildRunBrokerHeaders({
      runBrokerKey: 'secret',
      ownerOpenId: 'ou_owner',
    })).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret',
      'X-Hermes-Owner-Open-Id': 'ou_owner',
      'X-Hermes-Feishu-OpenId': 'ou_owner',
    })
  })

  it('maps broker tool frames and persists useful preview as arguments', () => {
    expect(mapRunBrokerFrameForChat({
      kind: 'tool_started',
      run_id: 'run-1',
      name: 'terminal',
      payload: { preview: "printf 'ok'" },
    })).toEqual(expect.objectContaining({
      type: 'emit',
      event: 'tool.started',
      payload: expect.objectContaining({
        tool_call_id: 'broker_tool_run-1_terminal',
        arguments: JSON.stringify({ cmd: "printf 'ok'" }),
      }),
    }))
  })

  it('parses multi-line SSE data frames', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: chunk\ndata: {"a":1}\ndata: {"b":2}\n\n'))
        controller.close()
      },
    })

    const frames = []
    for await (const frame of readSseFrames(stream)) frames.push(frame)

    expect(frames).toEqual([{ event: 'chunk', data: '{"a":1}\n{"b":2}' }])
  })
})
