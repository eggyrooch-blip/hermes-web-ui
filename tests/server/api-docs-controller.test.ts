import { describe, expect, it, vi } from 'vitest'
import { openapi } from '../../packages/server/src/controllers/api-docs'

describe('api docs controller', () => {
  it('returns the OpenAPI route catalog', async () => {
    const ctx = {
      set: vi.fn(),
      status: 200,
      body: undefined as any,
    }

    await openapi(ctx as any)

    expect(ctx.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(ctx.body.openapi).toBe('3.0.3')
    expect(ctx.body.paths['/api/openapi.json']).toBeTruthy()
    expect(ctx.body.paths['/api/auth/login'].post.requestBody.content['application/json'].schema.required).toEqual([
      'password',
      'username',
    ])
    expect(ctx.body.paths['/api/auth/users/{id}'].put.parameters).toEqual([
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    ])
    expect(ctx.body.paths['/api/hermes/kanban/search-sessions'].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'task_id', in: 'query', required: true }),
        expect.objectContaining({ name: 'profile', in: 'query', required: true }),
        expect.objectContaining({ name: 'q', in: 'query', required: false }),
      ]),
    )
    expect(
      ctx.body.paths['/api/chat-run/runs'].post.requestBody.content['application/json'].schema.properties.source.enum,
    ).toEqual(['cli', 'coding_agent', 'global_agent'])
    const catalogConnect = ctx.body.paths['/api/auth/skill-credentials/catalog/connect'].post
      .requestBody.content['application/json'].schema
    expect(catalogConnect.properties.row_key.type).toBe('string')
    expect(catalogConnect.properties.fields.maxProperties).toBe(32)
    expect(ctx.body.paths['/api/auth/skill-credentials/catalog/status'].post
      .requestBody.content['application/json'].schema.properties.row_key.type).toBe('string')
    expect(ctx.body.paths['/api/auth/skill-credentials/catalog/oauth/callback'].get.security).toEqual([])
    expect(ctx.body.paths['/api/auth/skill-credentials/catalog'].get.parameters.map((item: any) => item.name)).toEqual(['view'])
  })
})
