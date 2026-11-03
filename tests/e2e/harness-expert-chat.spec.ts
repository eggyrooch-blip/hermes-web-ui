import { expect, test, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'
import { mapRunBrokerFrameForChat } from '../../packages/server/src/services/hermes/run-chat/handle-broker-run'

const inputPlaceholder = 'Type a message... (Enter to send, Shift+Enter for new line)'

type LiveCodexRig = {
  root: string
  repo: string
  codexHome: string
  marker: string
  threadId?: string
}

async function command(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), 180_000)
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${file} exited ${code}: ${stderr.slice(-2000)}`))
    })
  })
}

async function createLiveCodexRig(): Promise<LiveCodexRig> {
  const root = await mkdtemp(join(tmpdir(), 'hermes-harness-browser-'))
  const repo = join(root, 'repo')
  const codexHome = join(root, 'codex-home')
  const source = process.env.HERMES_HARNESS_SOURCE_REPO || '/Users/dev/code/hermes-web-ui'
  const auth = process.env.HERMES_HARNESS_CODEX_AUTH || join(homedir(), '.codex', 'auth.json')
  await command('git', ['clone', '--quiet', '--local', '--no-hardlinks', source, repo])
  await mkdir(codexHome, { recursive: true, mode: 0o700 })
  await copyFile(auth, join(codexHome, 'auth.json'))
  await chmod(join(codexHome, 'auth.json'), 0o600)
  return { root, repo, codexHome, marker: `harness-browser-${Date.now()}` }
}

async function runLiveCodexTurn(rig: LiveCodexRig, prompt: string) {
  const shared = [
    '--json',
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_mode="workspace-write"',
    '--ignore-user-config',
    '--ignore-rules',
    '--disable', 'remote_plugin',
    '--disable', 'plugins',
  ]
  const args = rig.threadId
    ? ['exec', 'resume', ...shared, rig.threadId, prompt]
    : ['exec', ...shared, '-C', rig.repo, prompt]
  const { stdout } = await command('codex', args, {
    cwd: rig.repo,
    env: { ...process.env, CODEX_HOME: rig.codexHome },
  })
  const events = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
  const threadId = events.find(event => event.type === 'thread.started')?.thread_id
  const final = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').at(-1)?.item?.text
  const commandEvent = events.find(event => event.type === 'item.completed'
    && event.item?.type === 'command_execution' && event.item?.exit_code === 0)
  expect(threadId).toBeTruthy()
  expect(events.some(event => event.type === 'item.completed'
    && event.item?.type === 'command_execution' && event.item?.exit_code === 0)).toBe(true)
  expect(events.some(event => event.type === 'item.completed' && event.item?.type === 'file_change')).toBe(true)
  if (rig.threadId) expect(threadId).toBe(rig.threadId)
  rig.threadId = threadId
  return { final: String(final || ''), command: String(commandEvent?.item?.command || '') }
}

async function sourceStatusHash() {
  const source = process.env.HERMES_HARNESS_SOURCE_REPO || '/Users/dev/code/hermes-web-ui'
  const { stdout } = await command('git', ['status', '--porcelain=v1'], { cwd: source })
  return createHash('sha256').update(stdout).digest('hex')
}

async function send(page: Page, text: string) {
  await page.getByPlaceholder(inputPlaceholder).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

async function runAt(page: Page, index: number) {
  const handle = await page.waitForFunction((wanted) => {
    const runs = (window as any).__PW_CHAT_SOCKET__?.emitted
      ?.filter((item: any) => item.event === 'run') || []
    return runs[wanted]?.payload || null
  }, index)
  return handle.jsonValue() as Promise<any>
}

async function mockCodexModelCatalog(page: Page) {
  await page.route('**/api/hermes/available-models*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      default: 'auto',
      default_provider: 'custom:litellm-sre',
      groups: [{
        provider: 'custom:litellm-sre', label: 'LiteLLM', base_url: '', api_key: '',
        models: ['auto', 'claude-sonnet-5', 'GPT-5.5-priority', 'gpt-5.4'],
      }],
      allProviders: [],
      model_aliases: {},
      model_visibility: {},
    }),
  }))
}

async function triggerBrokerFrame(page: Page, sessionId: string, frame: Record<string, unknown>) {
  const mapped = mapRunBrokerFrameForChat(frame)
  expect(mapped.type).toBe('emit')
  if (mapped.type !== 'emit') return
  await page.evaluate(({ sid, event, payload }) => {
    ;(window as any).__PW_CHAT_SOCKET__.latest.__trigger(event, { ...payload, session_id: sid })
  }, { sid: sessionId, event: mapped.event, payload: mapped.payload })
}

test('Harness expert keeps its engine, stage and pending gate across conversation resume', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const sessions: any[] = []
  const api = await mockHermesApi(page, {
    sessions,
    harnessEnabled: true,
    experts: [{ id: 'server-dev', name: 'Server Dev', title: 'Server Dev', skills: ['Repository work'], harness_available: true }],
    expertWorkRecords: {
      user: {
        expert_id: 'server-dev', mode: 'user', window_days: 30,
        partitions: {
          sessions: { status: 'available', items: [] },
          jobs: { status: 'unavailable', items: [] },
          feedback: { status: 'available', items: [] },
        },
      },
    },
  })
  await mockCodexModelCatalog(page)
  await page.route('**/api/hermes/sessions/conversations/*/messages/paginated*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ messages: [], total: 0, offset: 0, limit: 150, has_more: false }),
  }))
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat?surface=expert')
  await page.locator('.expert-card', { hasText: 'Server Dev' }).click()
  await page.locator('input[value="harness"]').check()
  await page.locator('.action-primary').click()

  await expect(page.getByText('Codex · Default workspace')).toBeVisible()
  await expect(page.locator('.header-model-button')).toContainText('GPT-5.5-priority')
  await page.locator('.header-model-button').click()
  await expect(page.locator('.session-model-item')).toHaveCount(2)
  await expect(page.locator('.session-model-custom')).not.toBeVisible()
  await expect(page.locator('.session-model-list')).not.toContainText('auto')
  await expect(page.locator('.session-model-list')).not.toContainText('claude-sonnet-5')
  await page.locator('.session-model-item', { hasText: 'gpt-5.4' }).click()
  await expect(page.locator('.header-model-button')).toContainText('gpt-5.4')
  await page.reload()
  await expect(page.locator('.header-model-button')).toContainText('gpt-5.4')
  await expect(page.locator('.expert-session-identity')).toContainText('Server Dev')
  await expect(page.locator('.expert-slot-button')).toBeEnabled()
  expect(api.requests.some(request => request.method === 'POST' && request.pathname.endsWith('/model'))).toBe(true)
  await send(page, 'Inspect the repository')
  const first = await runAt(page, 0)
  expect(first.execution_engine).toBe('harness')
  expect(first.model).toBe('gpt-5.4')

  await triggerBrokerFrame(page, first.session_id, {
    kind: 'heartbeat', run_id: 'run-1', payload: { text: 'Harness is still working' },
  })
  await expect(page.getByText('Harness is still working')).toBeVisible()
  await triggerBrokerFrame(page, first.session_id, {
    kind: 'workflow_stage', run_id: 'run-1', payload: {
      stage: 'pre_deploy', status: 'waiting', summary: 'Gate E preview review',
      related_ids: { mr: '123' }, audit_id: 'audit-1',
    },
  })
  await triggerBrokerFrame(page, first.session_id, {
    kind: 'gate_required', run_id: 'run-1', payload: {
      gate: 'E', approval_id: 'gate-e', description: 'Preview smoke check',
      checklist: ['Preview smoke passed'],
    },
  })

  await expect(page.getByText('pre_deploy · waiting')).toBeVisible()
  await expect(page.getByText(/Gate E preview review · mr:123 · audit:audit-1/)).toBeVisible()
  await expect(page.getByText('Preview smoke passed')).toBeVisible()
  await expect(page.getByText(/Approval gate-e/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Agree' })).toBeVisible()
  await page.getByPlaceholder('Add a decision comment (optional)').fill('looks good')
  await page.getByRole('button', { name: 'Agree' }).click()
  await expect.poll(async () => page.evaluate(() => (
    (window as any).__PW_CHAT_SOCKET__.emitted
      .filter((item: any) => item.event === 'approval.respond')
      .at(-1)?.payload?.choice
  ))).toBe('approve')
  await expect.poll(async () => page.evaluate(() => (
    (window as any).__PW_CHAT_SOCKET__.emitted
      .filter((item: any) => item.event === 'approval.respond')
      .at(-1)?.payload?.comment
  ))).toBe('looks good')

  await triggerBrokerFrame(page, first.session_id, {
    kind: 'gate_resolved', run_id: 'run-1', payload: { approval_id: 'gate-e', decision: 'approve' },
  })
  await triggerBrokerFrame(page, first.session_id, {
    kind: 'auth_required', payload: {
      run_id: 'auth-run', workflow_id: 'workflow-1', credential_kind: 'mobius', connector_id: 'kep-cli-online',
    },
  })
  await expect(page.getByTestId('reauth-action')).toContainText('kep-cli-online')
  await triggerBrokerFrame(page, first.session_id, {
    kind: 'auth_resolved', payload: { workflow_id: 'workflow-1', credential_kind: 'mobius', connector_id: 'kep-cli-online' },
  })
  await expect(page.getByTestId('reauth-action')).not.toBeVisible()

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('message.delta', {
      event: 'message.delta', session_id: sid, run_id: 'run-1', delta: 'Repository understood.',
    })
    socket.__trigger('run.completed', {
      event: 'run.completed', session_id: sid, run_id: 'run-1', output: 'Repository understood.',
    })
  }, first.session_id)

  await send(page, 'Continue from that context')
  const second = await runAt(page, 1)
  expect(second.session_id).toBe(first.session_id)
  expect(second.execution_engine).toBe('harness')
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.failed', {
      event: 'run.failed', session_id: sid, run_id: 'run-2',
      error: 'Gate D approval required; protected operation was not executed.',
    })
  }, second.session_id)
  await expect(page.getByText('Gate D approval required; protected operation was not executed.')).toBeVisible()

  Object.assign(sessions.find(session => session.id === first.session_id)!, {
    id: first.session_id,
    profile: 'research', source: 'cli', model: 'test-model', provider: 'test-provider',
    workspace: 'team/project-a',
    title: 'Harness session', preview: 'Continue from that context', started_at: 1,
    ended_at: null, last_active: 2, message_count: 2, tool_call_count: 0,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
    reasoning_tokens: 0, billing_provider: null, estimated_cost_usd: 0,
    actual_cost_usd: null, cost_status: 'estimated', expert_id: 'server-dev',
    expert_label: 'Server Dev', execution_engine: 'harness',
  })
  const resumedStage = mapRunBrokerFrameForChat({
    kind: 'workflow_stage', payload: {
      stage: 'pre_deploy', status: 'waiting', summary: 'Resume review',
      related_ids: { mr: '124' }, audit_id: 'audit-2',
    },
  })
  const resumedGate = mapRunBrokerFrameForChat({
    kind: 'gate_required', payload: {
      gate: 'E', approval_id: 'gate-e-2', description: 'Resume review', checklist: ['Review again'],
    },
  })
  if (resumedStage.type !== 'emit' || resumedGate.type !== 'emit') throw new Error('Harness resume fixture did not map')
  await page.addInitScript(({ sid, stage, gate }) => {
    window.localStorage.setItem('hermes_active_session_research', sid)
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
      [sid]: {
        session_id: sid,
        messages: [],
        isWorking: true,
        events: [
          { event: stage.event, data: { ...stage.payload, session_id: sid } },
          { event: gate.event, data: { ...gate.payload, session_id: sid } },
        ],
      },
    }
  }, {
    sid: first.session_id,
    stage: resumedStage,
    gate: resumedGate,
  })
  await page.reload()

  await expect(page.getByText('Codex · project-a')).toBeVisible()
  await expect(page.getByText('pre_deploy · waiting')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Rework' })).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('Harness expert completes two browser turns with a real resumed Codex thread', async ({ page }, testInfo) => {
  test.skip(process.env.HERMES_HARNESS_LIVE_CODEX !== '1', 'opt-in local Codex acceptance')
  test.setTimeout(240_000)
  const sourceBefore = await sourceStatusHash()
  const rig = await createLiveCodexRig()
  try {
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    await mockHermesApi(page, {
      sessions: [],
      harnessEnabled: true,
      experts: [{ id: 'server-dev', name: 'Server Dev', title: 'Server Dev', skills: ['Repository work'], harness_available: true }],
      expertWorkRecords: {
        user: {
          expert_id: 'server-dev', mode: 'user', window_days: 30,
          partitions: {
            sessions: { status: 'available', items: [] },
            jobs: { status: 'unavailable', items: [] },
            feedback: { status: 'available', items: [] },
          },
        },
      },
    })
    await mockCodexModelCatalog(page)
    await page.route('**/api/hermes/sessions/conversations/*/messages/paginated*', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: [], total: 0, offset: 0, limit: 150, has_more: false }),
    }))
    await mockChatSocket(page)
    await page.goto('/#/hermes/chat?surface=expert')
    await page.locator('.expert-card', { hasText: 'Server Dev' }).click()
    await page.locator('input[value="harness"]').check()
    await page.locator('.action-primary').click()
    await expect(page.getByText('Codex · Default workspace')).toBeVisible()

    await send(page, 'Create and verify the local Harness proof file')
    const firstPayload = await runAt(page, 0)
    expect(firstPayload.execution_engine).toBe('harness')
    const firstTurn = await runLiveCodexTurn(rig,
      `Create harness-live-proof.txt containing exactly ${rig.marker}. Run a shell assertion that its content equals that marker. Edit no other file, do not commit or push, and finish with exactly LIVE_ROUND1_OK ${rig.marker}.`)
    expect(firstTurn.final).toBe(`LIVE_ROUND1_OK ${rig.marker}`)
    await page.evaluate(({ sid, turn }) => {
      const socket = (window as any).__PW_CHAT_SOCKET__.latest
      socket.__trigger('tool.started', { event: 'tool.started', session_id: sid, run_id: 'live-1', tool_call_id: 'live-tool-1', tool: 'exec_command', preview: turn.command })
      socket.__trigger('tool.completed', { event: 'tool.completed', session_id: sid, run_id: 'live-1', tool_call_id: 'live-tool-1', tool: 'exec_command', output: 'exit 0', duration: 1 })
      socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'live-1', delta: turn.final })
      socket.__trigger('run.completed', { event: 'run.completed', session_id: sid, run_id: 'live-1', output: turn.final })
    }, { sid: firstPayload.session_id, turn: firstTurn })
    await expect(page.getByText(firstTurn.final)).toBeVisible()
    await expect(page.locator('.message.tool .tool-line').filter({ hasText: 'exec_command' })).toHaveCount(1)

    await send(page, 'Resume the same Codex thread and verify the first-round marker')
    const secondPayload = await runAt(page, 1)
    expect(secondPayload.session_id).toBe(firstPayload.session_id)
    const secondTurn = await runLiveCodexTurn(rig,
      'Read harness-live-proof.txt, preserve line 1, append exactly LIVE_ROUND2, and run one shell assertion that line 1 is the first-round marker already in this thread, line 2 is LIVE_ROUND2, and there are exactly two lines. Edit no other file, do not commit or push, and finish with exactly LIVE_ROUND2_OK followed by the first-round marker.')
    expect(secondTurn.final).toBe(`LIVE_ROUND2_OK ${rig.marker}`)
    await page.evaluate(({ sid, turn }) => {
      const socket = (window as any).__PW_CHAT_SOCKET__.latest
      socket.__trigger('tool.started', { event: 'tool.started', session_id: sid, run_id: 'live-2', tool_call_id: 'live-tool-2', tool: 'exec_command', preview: turn.command })
      socket.__trigger('tool.completed', { event: 'tool.completed', session_id: sid, run_id: 'live-2', tool_call_id: 'live-tool-2', tool: 'exec_command', output: 'exit 0', duration: 1 })
      socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'live-2', delta: turn.final })
      socket.__trigger('run.completed', { event: 'run.completed', session_id: sid, run_id: 'live-2', output: turn.final })
    }, { sid: secondPayload.session_id, turn: secondTurn })
    await expect(page.getByText(secondTurn.final)).toBeVisible()
    await expect(page.locator('.message.tool .tool-line').filter({ hasText: 'exec_command' })).toHaveCount(2)

    expect(await readFile(join(rig.repo, 'harness-live-proof.txt'), 'utf8'))
      .toBe(`${rig.marker}\nLIVE_ROUND2\n`)
    const { stdout: cloneStatus } = await command('git', ['status', '--porcelain=v1'], { cwd: rig.repo })
    expect(cloneStatus.trim()).toBe('?? harness-live-proof.txt')
    expect(await sourceStatusHash()).toBe(sourceBefore)
    await page.screenshot({ path: testInfo.outputPath('harness-live-codex.png'), fullPage: true })
    console.log(JSON.stringify({
      live_codex: true,
      thread_fingerprint: createHash('sha256').update(rig.threadId || '').digest('hex').slice(0, 16),
      source_unchanged: true,
      isolated_change: 'harness-live-proof.txt',
    }))
  } finally {
    await rm(rig.root, { recursive: true, force: true })
  }
})
