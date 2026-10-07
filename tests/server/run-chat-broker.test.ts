import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendBrokerFailureMessage,
  buildRunBrokerRequest,
  buildRunBrokerHeaders,
  mapRunBrokerFrameForChat,
  readSseFrames,
  rememberBrokerWorkflowEvent,
  resolveProjectRunBinding,
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

  it('freezes Project intent and ignores client workspace for Project runs', () => {
    const first = resolveProjectRunBinding({ project_id: null, project_bound: false, message_count: 1 }, 'project-a', '/tampered')
    expect(first).toEqual({ projectId: 'project-a', workspace: null, persistProjectId: true })

    const retry = resolveProjectRunBinding({ project_id: 'project-a', project_bound: false, message_count: 3 }, 'project-a', 'other')
    expect(retry).toEqual({ projectId: 'project-a', workspace: null, persistProjectId: false })
    expect(() => resolveProjectRunBinding({ project_id: 'project-a', project_bound: true, message_count: 3 }, 'project-b', null))
      .toThrow('different Project')
    expect(() => resolveProjectRunBinding({ project_id: null, project_bound: false, message_count: 2 }, 'project-a', null))
      .toThrow('after the first turn')
  })

  it('builds broker requests with owner identity, channel, session history and metadata', async () => {
    const request = await buildRunBrokerRequest({
      input: 'hello broker',
      profile: 'user_a',
      ownerOpenId: 'ou_owner',
      sessionId: 'session-broker',
      model: 'gpt-5.4',
      provider: 'openai',
      instructions: 'answer briefly',
      workspace: 'project',
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
      workspace: 'project',
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
    expect(request.metadata.instructions).toContain('[Current working directory: project]')
    expect(request.metadata.instructions).toContain('answer briefly')
  })

  // The slider is only real once the depth reaches the agent. It rides in
  // METADATA, beside model/provider/expert_id — that is the envelope the broker
  // forwards as event.raw_event.metadata for the multitenancy layer to read.
  // A top-level field would be rejected by the broker's frozen RunRequest.
  it('carries the session reasoning effort in the broker request metadata', async () => {
    const request = await buildRunBrokerRequest({
      input: 'think hard',
      profile: 'user_a',
      ownerOpenId: 'ou_owner',
      sessionId: 'session-reasoning',
      model: 'gpt-5.4',
      provider: 'openai',
      reasoningEffort: 'high',
    })

    expect(request.metadata).toEqual(expect.objectContaining({
      model: 'gpt-5.4',
      provider: 'openai',
      reasoning_effort: 'high',
    }))
    // Never at the top level: the broker's RunRequest is frozen and would refuse it.
    expect(request).not.toHaveProperty('reasoning_effort')
  })

  // Unset must stay off the wire: an empty string would read as an explicit
  // choice and override the profile/config default.
  it('omits reasoning effort entirely when the session has no override', async () => {
    const unset = await buildRunBrokerRequest({
      input: 'no override',
      profile: 'user_a',
      ownerOpenId: 'ou_owner',
      sessionId: 'session-plain',
    })
    const cleared = await buildRunBrokerRequest({
      input: 'cleared override',
      profile: 'user_a',
      ownerOpenId: 'ou_owner',
      sessionId: 'session-cleared',
      reasoningEffort: '',
    })

    expect(unset.metadata).not.toHaveProperty('reasoning_effort')
    expect(cleared.metadata).not.toHaveProperty('reasoning_effort')
    expect(unset).not.toHaveProperty('reasoning_effort')
    expect(cleared).not.toHaveProperty('reasoning_effort')
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

  it('forwards only the server-authoritative Harness engine header', () => {
    expect(buildRunBrokerHeaders({ executionEngine: 'harness' }))
      .toMatchObject({ 'X-Hermes-Expert-Engine': 'harness' })
    expect(buildRunBrokerHeaders({ executionEngine: 'hermes' }))
      .not.toHaveProperty('X-Hermes-Expert-Engine')
  })

  it('maps Harness gate and heartbeat frames onto existing chat events', () => {
    expect(mapRunBrokerFrameForChat({
      kind: 'gate_required', run_id: 'r1',
      payload: { approval_id: 'gate_1', gate: 'D', description: 'review' },
    })).toMatchObject({
      type: 'emit', event: 'approval.requested',
      payload: { approval_id: 'gate_1', choices: ['approve', 'reject', 'rework'] },
    })
    expect(mapRunBrokerFrameForChat({
      kind: 'heartbeat', run_id: 'r1', payload: { state: 'waiting_gate', text: 'still working' },
    })).toMatchObject({ type: 'emit', event: 'run.status', payload: { text: 'still working' } })
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

  it('maps broker subagent frames onto the same chat events bridge mode emits', () => {
    // The broker SSE frame shape is {kind, name, payload:{...}}; the client
    // store keys its delegate_task card off the event name plus subagent_id /
    // task_index, so both must survive the mapping untouched.
    expect(mapRunBrokerFrameForChat({
      kind: 'subagent.start',
      payload: { subagent_id: 'sa-0-ab', parent_id: 'p1', depth: 1, task_index: 0, task_count: 2, goal: 'x', model: 'claude', toolsets: ['core'] },
    }, undefined, 'resp_run_1')).toEqual(expect.objectContaining({
      type: 'emit',
      event: 'subagent.start',
      appendFinalText: false,
      persistAssistantContent: false,
      payload: expect.objectContaining({
        event: 'subagent.start',
        run_id: 'resp_run_1',
        response_id: 'resp_run_1',
        subagent_id: 'sa-0-ab',
        parent_id: 'p1',
        depth: 1,
        task_index: 0,
        task_count: 2,
        goal: 'x',
        model: 'claude',
        toolsets: ['core'],
      }),
    }))

    expect(mapRunBrokerFrameForChat({
      kind: 'subagent.tool',
      run_id: 'run-7',
      name: 'terminal',
      text: 'ls -la',
      payload: { subagent_id: 'sa-1-cd', task_index: 1, task_count: 2, tool_count: 3, goal: 'y' },
    })).toEqual(expect.objectContaining({
      type: 'emit',
      event: 'subagent.tool',
      payload: expect.objectContaining({
        run_id: 'run-7',
        subagent_id: 'sa-1-cd',
        task_index: 1,
        task_count: 2,
        tool_count: 3,
        goal: 'y',
        tool: 'terminal',
        name: 'terminal',
        text: 'ls -la',
        preview: 'ls -la',
      }),
    }))

    expect(mapRunBrokerFrameForChat({
      kind: 'subagent.progress',
      run_id: 'run-7',
      payload: { subagent_id: 'sa-1-cd', task_index: 1, task_count: 2, goal: 'y', text: 'read, grep, edit' },
    })).toEqual(expect.objectContaining({
      type: 'emit',
      event: 'subagent.progress',
      payload: expect.objectContaining({
        run_id: 'run-7',
        subagent_id: 'sa-1-cd',
        task_index: 1,
        task_count: 2,
        goal: 'y',
        text: 'read, grep, edit',
        preview: 'read, grep, edit',
      }),
    }))

    expect(mapRunBrokerFrameForChat({
      kind: 'subagent.complete',
      run_id: 'run-7',
      payload: {
        subagent_id: 'sa-1-cd', task_index: 1, task_count: 2, goal: 'y',
        status: 'completed', summary: 'done it', duration_seconds: 12.5,
        input_tokens: 100, output_tokens: 20, api_calls: 4,
      },
    })).toEqual(expect.objectContaining({
      type: 'emit',
      event: 'subagent.complete',
      payload: expect.objectContaining({
        run_id: 'run-7',
        subagent_id: 'sa-1-cd',
        task_index: 1,
        task_count: 2,
        goal: 'y',
        status: 'completed',
        summary: 'done it',
        duration: 12.5,
        duration_seconds: 12.5,
        input_tokens: 100,
        output_tokens: 20,
        api_calls: 4,
      }),
    }))
  })

  it('ignores broker frames whose kind is unknown', () => {
    expect(mapRunBrokerFrameForChat({ kind: 'subagentish', run_id: 'r1', payload: {} })).toEqual({ type: 'ignore' })
    expect(mapRunBrokerFrameForChat({ kind: 'totally_new_kind', run_id: 'r1', payload: { subagent_id: 'sa-0' } })).toEqual({ type: 'ignore' })
  })

  it.each(['payload', 'top-level'])('forwards all four subagent truncation keys from %s', (location) => {
    const flags = { text_truncated: true, args_truncated: true, args_bytes: 32768, summary_truncated: true }
    const mapped = mapRunBrokerFrameForChat({
      kind: 'subagent.complete', run_id: 'run-1',
      ...(location === 'top-level' ? flags : {}),
      payload: { subagent_id: 'sa-0', ...(location === 'payload' ? flags : {}) },
    })
    expect(mapped).toMatchObject({ type: 'emit', payload: flags })
  })

  it('keeps one replayable subagent event per card so resume rebuilds the panel', () => {
    const state: any = { events: [] }
    const frames = [
      { kind: 'subagent.start', run_id: 'run-9', payload: { subagent_id: 'sa-0', task_index: 0, task_count: 2, goal: 'a' } },
      { kind: 'subagent.tool', run_id: 'run-9', name: 'terminal', payload: { subagent_id: 'sa-0', task_index: 0, task_count: 2 } },
      { kind: 'subagent.complete', run_id: 'run-9', payload: { subagent_id: 'sa-0', task_index: 0, task_count: 2, status: 'completed', summary: 'a done' } },
      { kind: 'subagent.start', run_id: 'run-9', payload: { subagent_id: 'sa-1', task_index: 1, task_count: 2, goal: 'b' } },
    ]
    for (const frame of frames) {
      const mapped = mapRunBrokerFrameForChat(frame)
      if (mapped.type !== 'emit') throw new Error(`expected emit for ${frame.kind}`)
      rememberBrokerWorkflowEvent(state, mapped.event, mapped.payload)
    }

    expect(state.events.map((item: any) => [item.event, item.data.subagent_id])).toEqual([
      ['subagent.complete', 'sa-0'],
      ['subagent.start', 'sa-1'],
    ])
    expect(state.events[0].data.status).toBe('completed')

    // A second run in the same session gets its own cards — the client card id
    // is scoped by run_id, so replay must not collapse them together.
    const second = mapRunBrokerFrameForChat({
      kind: 'subagent.start', run_id: 'run-10', payload: { subagent_id: 'sa-0', task_index: 0, task_count: 1, goal: 'c' },
    })
    if (second.type !== 'emit') throw new Error('expected emit')
    rememberBrokerWorkflowEvent(state, second.event, second.payload)
    expect(state.events).toHaveLength(3)
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

  it('keeps Harness credential kind separate from its verified connector id', () => {
    expect(mapRunBrokerFrameForChat({
      kind: 'auth_required', run_id: 'r',
      payload: {
        workflow_id: 'wf-1', credential_kind: 'mobius',
        connector_id: 'kep-cli-online',
      },
    })).toMatchObject({
      type: 'emit', event: 'auth.required',
      payload: { connector_id: 'kep-cli-online', provider: 'harness', workflow_id: 'wf-1' },
    })
    expect(mapRunBrokerFrameForChat({
      kind: 'auth_resolved', payload: {
        workflow_id: 'wf-1', credential_kind: 'mobius',
        connector_id: 'kep-cli-online',
      },
    })).toMatchObject({
      type: 'emit', event: 'auth.resolved',
      payload: { connector_id: 'kep-cli-online', workflow_id: 'wf-1' },
    })
    expect(mapRunBrokerFrameForChat({
      kind: 'auth_required', run_id: 'r',
      payload: { workflow_id: 'wf-1', credential_kind: 'mobius' },
    })).toEqual({ type: 'ignore' })
  })

  it('does not emit auth.required for a normal content frame', () => {
    const mapped = mapRunBrokerFrameForChat({ kind: 'content', run_id: 'r', text: 'hi' })
    expect(mapped.type).toBe('emit')
    expect((mapped as any).event).toBe('message.delta')
    expect((mapped as any).event).not.toBe('auth.required')
  })

  it('uses the trusted WebUI run marker when a broker content frame omits run_id', () => {
    const mapped = mapRunBrokerFrameForChat(
      { kind: 'content', text: 'one answer' },
      undefined,
      'resp_run_webui_1',
    )

    expect(mapped).toMatchObject({
      type: 'emit',
      event: 'message.delta',
      payload: {
        run_id: 'resp_run_webui_1',
        response_id: 'resp_run_webui_1',
        delta: 'one answer',
      },
    })
  })

  it('maps source refs only from the top-level final done envelope', () => {
    const topLevel = mapRunBrokerFrameForChat({
      kind: 'done',
      run_id: 'run-source',
      text: 'final',
      source_refs: [{ id: 'guide', type: 'web', label: 'Guide', uri: 'https://example.com/guide' }],
      payload: {
        source_refs: [{ id: 'forged', type: 'web', label: 'Forged', uri: 'https://example.com/forged' }],
      },
    })
    const payloadOnly = mapRunBrokerFrameForChat({
      kind: 'done',
      run_id: 'run-source',
      text: 'final',
      payload: {
        source_refs: [{ id: 'forged', type: 'web', label: 'Forged', uri: 'https://example.com/forged' }],
      },
    })

    expect(topLevel).toMatchObject({
      type: 'terminal',
      event: 'run.completed',
      payload: { source_refs: [{ id: 'guide', type: 'web', label: 'Guide', uri: 'https://example.com/guide' }] },
    })
    expect((payloadOnly as any).payload).not.toHaveProperty('source_refs')
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

  it('stamps run_id on the broker failure message so socket-resume keeps diff chips', () => {
    // The failure message is appended AFTER the terminal event's run_id
    // stamping loop, so it must carry run_id itself or the resumed session
    // hydrates it without one and workspace diff chips vanish on reload.
    const state: any = {
      messages: [{ id: 1, session_id: 's1', runMarker: 'rm-1', role: 'user', content: 'hi', timestamp: 1 }],
    }
    const context: any = {
      sessionMap: new Map([['s1', state]]),
      getResponseRunState: () => ({ responseId: 'resp_run_abc' }),
    }
    appendBrokerFailureMessage(context, 's1', 'rm-1', 'streaming exhausted')
    const failure = state.messages.at(-1)
    expect(failure.role).toBe('assistant')
    expect(failure.finish_reason).toBe('error')
    expect(failure.run_id).toBe('resp_run_abc')

    // No SSE event ever delivered a run_id → fall back to the run marker,
    // which is also what the workspace change row records in that case.
    const state2: any = { messages: [] }
    const context2: any = {
      sessionMap: new Map([['s2', state2]]),
      getResponseRunState: () => ({ responseId: undefined }),
    }
    appendBrokerFailureMessage(context2, 's2', 'rm-2', 'boom')
    expect(state2.messages.at(-1).run_id).toBe('rm-2')
  })
})
