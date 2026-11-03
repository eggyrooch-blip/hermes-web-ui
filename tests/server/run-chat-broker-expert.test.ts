import { describe, expect, it } from 'vitest'
import {
  buildRunBrokerRequest,
  buildRunBrokerHeaders,
} from '../../packages/server/src/services/hermes/run-chat/handle-broker-run'

// Regression coverage for the expert-catalog slot: an active expert selection must
// be forwarded to the Run Broker BOTH in the request body (`expert_id` + metadata)
// AND as the `X-Hermes-Expert-Id` header. When no expert is active, neither must
// appear — a stale/empty selection must never reach the broker.
describe('run-chat broker expert overlay propagation', () => {
  describe('request body', () => {
    it('forwards expert_id into the body and metadata when an expert is active', async () => {
      const request = await buildRunBrokerRequest({
        input: 'hello',
        profile: 'user_a',
        ownerOpenId: 'ou_owner',
        sessionId: 'session-1',
        expertId: 'it-helpdesk',
      })

      expect(request.expert_id).toBe('it-helpdesk')
      expect(request.metadata).toEqual(expect.objectContaining({ expert_id: 'it-helpdesk' }))
    })

    it('omits expert_id from body and metadata when no expert is active', async () => {
      const request = await buildRunBrokerRequest({
        input: 'hello',
        profile: 'user_a',
        ownerOpenId: 'ou_owner',
        sessionId: 'session-1',
        // expertId intentionally undefined
      })

      expect('expert_id' in request).toBe(false)
      expect('expert_id' in request.metadata).toBe(false)
    })

    it('omits expert_id when the active selection is an empty string', async () => {
      const request = await buildRunBrokerRequest({
        input: 'hello',
        profile: 'user_a',
        ownerOpenId: 'ou_owner',
        sessionId: 'session-1',
        expertId: '',
      })

      expect('expert_id' in request).toBe(false)
      expect('expert_id' in request.metadata).toBe(false)
    })
  })

  describe('request headers', () => {
    it('sets X-Hermes-Expert-Id when an expert is active', () => {
      const headers = buildRunBrokerHeaders({
        runBrokerKey: 'secret',
        ownerOpenId: 'ou_owner',
        expertId: 'it-helpdesk',
      })

      expect(headers['X-Hermes-Expert-Id']).toBe('it-helpdesk')
    })

    it('omits X-Hermes-Expert-Id when no expert is active', () => {
      const headers = buildRunBrokerHeaders({
        runBrokerKey: 'secret',
        ownerOpenId: 'ou_owner',
      })

      expect('X-Hermes-Expert-Id' in headers).toBe(false)
    })

    it('omits X-Hermes-Expert-Id when the active selection is an empty string', () => {
      const headers = buildRunBrokerHeaders({
        runBrokerKey: 'secret',
        ownerOpenId: 'ou_owner',
        expertId: '   ',
      })

      expect('X-Hermes-Expert-Id' in headers).toBe(false)
    })
  })
})
