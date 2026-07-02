import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
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
      'Run `<local-home>/.hermes/bin/hades-cli --profile "$KEP_PROFILE" --env online misc get --id <id> --output json`.',
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

  function addMeegleSkill(profileDir: string) {
    mkdirSync(join(profileDir, 'skills', 'meegle'), { recursive: true })
    writeFileSync(join(profileDir, 'skills', 'meegle', 'SKILL.md'), [
      '---',
      'name: meegle',
      'description: 飞书项目（Meego/Meegle）操作工具。支持查询和管理工作项、节点流转、视图查询、个人待办、排期统计等功能。',
      '---',
      '# 飞书项目 (Meego/Meegle) 操作指南',
      '本技能通过 Meegle CLI 来操作飞书项目数据。',
      '写操作必须先给执行计划和将要写入的字段，等用户确认后再执行。',
    ].join('\n'), 'utf-8')
  }

  function addNonMeegleSkillThatMentionsMeegleCli(profileDir: string) {
    mkdirSync(join(profileDir, 'skills', 'project-note'), { recursive: true })
    writeFileSync(join(profileDir, 'skills', 'project-note', 'SKILL.md'), [
      '---',
      'name: project-note',
      'description: Internal project notes that compare tools including Meegle CLI.',
      '---',
      '# Project note',
      'This skill mentions Meegle CLI as background only.',
    ].join('\n'), 'utf-8')
  }

  it('builds broker requests with owner identity, channel, session history and metadata', async () => {
    const request = await buildRunBrokerRequest({
      input: 'hello broker',
      profile: 'user_a',
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
      profile_name: 'user_a',
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

  it('uses an explicit per-turn idempotency key for WebUI broker runs', async () => {
    const first = await buildRunBrokerRequest({
      input: 'same text',
      profile: 'user_a',
      ownerOpenId: 'ou_owner',
      sessionId: 'session-a',
      idempotencyKey: 'webui:session-a:turn-1',
    })
    const second = await buildRunBrokerRequest({
      input: 'same text',
      profile: 'user_a',
      ownerOpenId: 'ou_owner',
      sessionId: 'session-b',
      idempotencyKey: 'webui:session-b:turn-1',
    })

    expect(first).toMatchObject({
      content: 'same text',
      idempotency_key: 'webui:session-a:turn-1',
    })
    expect(second).toMatchObject({
      content: 'same text',
      idempotency_key: 'webui:session-b:turn-1',
    })
    expect(first.idempotency_key).not.toBe(second.idempotency_key)
  })

  it('sends image uploads to the broker as workspace-readable tool context', async () => {
    const request = await buildRunBrokerRequest({
      input: [
        { type: 'text', text: '讲一讲这张图片' },
        { type: 'image', name: 'receipt.png', path: 'uploads/receipt.png', media_type: 'image/png' },
      ],
      profile: 'feishu_user_a',
      appendInputToMessages: false,
    })

    expect(request.content).toContain('讲一讲这张图片')
    expect(request.content).toContain('[Attached image: receipt.png]')
    expect(request.content).toContain('Local image path for tools: uploads/receipt.png')
    expect(request.content).toContain('call vision_analyze with image_url "uploads/receipt.png" directly')
    expect(request.content).toContain('Do not use delegate_task for image recognition.')
    expect(request.content).not.toContain('/workspace/uploads/receipt.png')
    expect(request.content).not.toContain('"type":"image"')
    expect(request.messages).toEqual([])
  })

  it('rewrites profile-local skill slash commands before sending WebUI broker runs', async () => {
    const profileDir = makeProfile()
    const request = await buildRunBrokerRequest({
      input: '/hades get 69df030c1f01cb45ba7ff585',
      profile: 'feishu_user_a',
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

  it('rewrites profile-local skill slash commands installed as directory symlinks', async () => {
    const profileDir = makeProfile()
    const sharedSkill = join(profileDir, '..', 'shared', 'Keep', 'kep-prd-analysis')
    mkdirSync(sharedSkill, { recursive: true })
    writeFileSync(join(sharedSkill, 'SKILL.md'), [
      '---',
      'name: kep-prd-analysis',
      'description: Analyze Keep PRDs.',
      '---',
      '# KEP PRD analysis',
      'Read the PRD and build a technical plan.',
    ].join('\n'), 'utf-8')
    symlinkSync(sharedSkill, join(profileDir, 'skills', 'Keep', 'kep-prd-analysis'), 'dir')

    const request = await buildRunBrokerRequest({
      input: '/kep-prd-analysis 260',
      profile: 'feishu_user_a',
      profileDir,
    })

    expect(request.content).toContain('invoked the "kep-prd-analysis" skill')
    expect(request.content).toContain('260')
  })

  it('injects relevant profile-local preload skills for natural WebUI requests', async () => {
    const profileDir = makeProfile()
    const request = await buildRunBrokerRequest({
      input: '在keep 记录下中午吃的肥肠面+鸡蛋+鸡腿+青椒',
      profile: 'feishu_user_a',
      profileDir,
    })

    expect(request.content).toBe('在keep 记录下中午吃的肥肠面+鸡蛋+鸡腿+青椒')
    expect(request.metadata.instructions).toContain('profile skill "keep-record"')
    expect(request.metadata.instructions).toContain('record_tool')
    expect(request.metadata.instructions).toContain(join(profileDir, 'skills', 'Keep', 'keep-record'))
  })

  it('injects the Meegle profile skill for Feishu Project natural WebUI requests', async () => {
    const profileDir = makeProfile()
    addMeegleSkill(profileDir)

    const request = await buildRunBrokerRequest({
      input: '请在飞书项目里准备创建一个测试任务，标题为「Hermes Meegle 验证测试」，先给我执行计划和将要写入的字段，不要执行，等我确认。',
      profile: 'feishu_user_a',
      profileDir,
    })

    expect(request.content).toBe('请在飞书项目里准备创建一个测试任务，标题为「Hermes Meegle 验证测试」，先给我执行计划和将要写入的字段，不要执行，等我确认。')
    expect(request.metadata.instructions).toContain('profile skill "meegle"')
    expect(request.metadata.instructions).toContain('Meegle CLI')
    expect(request.metadata.instructions).toContain('写操作必须先给执行计划')
    expect(request.metadata.instructions).toContain(join(profileDir, 'skills', 'meegle'))
  })

  it('does not treat non-Meegle skills that mention Meegle CLI as the Meegle skill', async () => {
    const profileDir = makeProfile()
    addNonMeegleSkillThatMentionsMeegleCli(profileDir)

    const request = await buildRunBrokerRequest({
      input: '请在飞书项目里准备创建一个测试任务',
      profile: 'feishu_user_a',
      profileDir,
    })

    expect(request.metadata.instructions).not.toContain('profile skill "project-note"')
    expect(request.metadata.instructions).not.toContain('This skill mentions Meegle CLI')
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

  it('maps an auth_required frame to an auth.required chat event', () => {
    expect(mapRunBrokerFrameForChat({
      kind: 'auth_required',
      run_id: 'sig-run-9',
      payload: { connector_id: 'lark-cli', provider: 'feishu', run_id: 'sig-run-9' },
    })).toEqual(expect.objectContaining({
      type: 'emit',
      event: 'auth.required',
      payload: expect.objectContaining({
        event: 'auth.required',
        run_id: 'sig-run-9',
        connector_id: 'lark-cli',
        provider: 'feishu',
      }),
    }))
  })

  it('ignores an auth_required frame without a connector_id', () => {
    expect(mapRunBrokerFrameForChat({ kind: 'auth_required', run_id: 'r', payload: {} }))
      .toEqual({ type: 'ignore' })
  })

  it('does not emit auth.required for a normal content frame', () => {
    const mapped = mapRunBrokerFrameForChat({ kind: 'content', run_id: 'r', text: 'hi' })
    expect(mapped.type).toBe('emit')
    expect((mapped as any).event).toBe('message.delta')
    expect((mapped as any).event).not.toBe('auth.required')
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
