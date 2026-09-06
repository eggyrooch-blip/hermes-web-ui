import { describe, expect, it } from 'vitest'
import {
  mapRunBrokerFrameForChat,
  rememberBrokerWorkflowEvent,
} from '../../packages/server/src/services/hermes/run-chat/handle-broker-run'

describe('Harness workflow events', () => {
  it('maps stages and A-F gates onto the existing chat stream', () => {
    expect(mapRunBrokerFrameForChat({
      kind: 'workflow_stage',
      run_id: 'run-1',
      payload: {
        stage: 'pre_deploy',
        status: 'running',
        summary: 'Deploying preview',
        related_ids: { mr: '123', version: 'v7' },
        audit_id: 'audit-7',
      },
    })).toEqual(expect.objectContaining({
      type: 'emit',
      event: 'workflow.stage',
      payload: expect.objectContaining({
        stage: 'pre_deploy',
        status: 'running',
        related_ids: { mr: '123', version: 'v7' },
        audit_id: 'audit-7',
      }),
    }))

    expect(mapRunBrokerFrameForChat({
      kind: 'gate_required',
      payload: { gate: 'E', approval_id: 'gate-e', description: 'Preview check', checklist: ['smoke passed'] },
    })).toEqual(expect.objectContaining({
      type: 'emit',
      event: 'approval.requested',
      payload: expect.objectContaining({
        approval_id: 'gate-e',
        gate: 'E',
        checklist: ['smoke passed'],
        choices: ['approve', 'reject', 'rework'],
      }),
    }))
  })

  it('keeps pending gate and latest stage available to socket resume', () => {
    const state = { events: [] as Array<{ event: string; data: any }> }
    const gate = { approval_id: 'gate-d', choices: ['approve', 'reject', 'rework'] }

    rememberBrokerWorkflowEvent(state, 'workflow.stage', { stage: 'review', status: 'running' })
    rememberBrokerWorkflowEvent(state, 'workflow.stage', { stage: 'pre_deploy', status: 'waiting' })
    rememberBrokerWorkflowEvent(state, 'approval.requested', gate)
    rememberBrokerWorkflowEvent(state, 'run.status', { text: 'alive' })

    expect(state.events).toEqual([
      { event: 'workflow.stage', data: { stage: 'pre_deploy', status: 'waiting' } },
      { event: 'approval.requested', data: gate },
    ])

    rememberBrokerWorkflowEvent(state, 'approval.resolved', { approval_id: 'gate-d' })
    expect(state.events).toEqual([
      { event: 'workflow.stage', data: { stage: 'pre_deploy', status: 'waiting' } },
    ])

    rememberBrokerWorkflowEvent(state, 'auth.required', {
      workflow_id: 'wf-1', credential_kind: 'mobius', connector_id: 'mobius',
    })
    expect(state.events.at(-1)).toEqual(expect.objectContaining({ event: 'auth.required' }))
    rememberBrokerWorkflowEvent(state, 'auth.resolved', { workflow_id: 'wf-1' })
    expect(state.events.some(item => item.event === 'auth.required')).toBe(false)
  })
})
