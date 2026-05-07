import { describe, expect, it } from 'vitest'

import { handleUpdate } from '../../packages/server/src/controllers/update'

function createMockCtx() {
  return {
    status: 200,
    body: null as unknown,
  }
}

describe('update controller', () => {
  it('rejects browser-triggered self-update requests', async () => {
    const ctx = createMockCtx()

    await handleUpdate(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({
      success: false,
      message: 'Web UI self-update is disabled. Run hermes-web-ui update from the server terminal instead.',
    })
  })
})
