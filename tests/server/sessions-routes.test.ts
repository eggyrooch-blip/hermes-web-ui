import { beforeEach, describe, expect, it, vi } from 'vitest'

const listConversationsMock = vi.fn(async (ctx: any) => { ctx.body = { sessions: [{ id: 'conversation-1' }] } })
const getConversationMessagesMock = vi.fn(async (ctx: any) => { ctx.body = { session_id: ctx.params.id, messages: [] } })
const getConversationMessagesPaginatedMock = vi.fn(async (ctx: any) => { ctx.body = { session_id: ctx.params.id, messages: [], pagination: {} } })
const listMock = vi.fn(async (ctx: any) => { ctx.body = { sessions: [{ id: 's1' }] } })
const listHermesSessionsMock = vi.fn(async (ctx: any) => { ctx.body = { sessions: [{ id: 'hermes-1' }] } })
const getHermesSessionMock = vi.fn(async (ctx: any) => { ctx.body = { session: { id: ctx.params.id } } })
const importHermesSessionMock = vi.fn(async (ctx: any) => { ctx.body = { session_id: ctx.params.id } })
const searchMock = vi.fn(async (ctx: any) => { ctx.body = { results: [{ id: 'search-1' }] } })
const getMock = vi.fn(async (ctx: any) => { ctx.body = { session: { id: ctx.params.id } } })
const listWorkspaceRunChangesMock = vi.fn(async (ctx: any) => { ctx.body = { changes: [] } })
const getWorkspaceRunChangeMock = vi.fn(async (ctx: any) => { ctx.body = { change: { change_id: ctx.params.changeId } } })
const getWorkspaceRunChangeFileMock = vi.fn(async (ctx: any) => { ctx.body = { file: { id: Number(ctx.params.fileId) } } })
const removeMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const renameMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const archiveSessionMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true, archived: true } })
const unarchiveSessionMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true, archived: false } })
const setWorkspaceMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const setModelMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const listWorkspaceFoldersMock = vi.fn(async (ctx: any) => { ctx.body = { folders: [] } })
const createWorkspaceFolderMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const renameWorkspaceFolderMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const deleteWorkspaceFolderMock = vi.fn(async (ctx: any) => { ctx.body = { ok: true } })
const usageBatchMock = vi.fn(async (ctx: any) => { ctx.body = {} })
const usageSingleMock = vi.fn(async (ctx: any) => { ctx.body = { input_tokens: 0, output_tokens: 0 } })
const usageStatsMock = vi.fn(async (ctx: any) => { ctx.body = { total_input_tokens: 0, total_output_tokens: 0 } })
const contextLengthMock = vi.fn(async (ctx: any) => { ctx.body = { context_length: 256000 } })
const batchRemoveMock = vi.fn(async (ctx: any) => { ctx.body = { deleted: 1, failed: 0, errors: [] } })
const exportSessionMock = vi.fn(async (ctx: any) => { ctx.body = JSON.stringify({ id: ctx.params.id }) })

vi.mock('../../packages/server/src/controllers/hermes/sessions', () => ({
  listConversations: listConversationsMock,
  getConversationMessages: getConversationMessagesMock,
  getConversationMessagesPaginated: getConversationMessagesPaginatedMock,
  list: listMock,
  listHermesSessions: listHermesSessionsMock,
  getHermesSession: getHermesSessionMock,
  importHermesSession: importHermesSessionMock,
  search: searchMock,
  get: getMock,
  listWorkspaceRunChanges: listWorkspaceRunChangesMock,
  getWorkspaceRunChange: getWorkspaceRunChangeMock,
  getWorkspaceRunChangeFile: getWorkspaceRunChangeFileMock,
  remove: removeMock,
  batchRemove: batchRemoveMock,
  rename: renameMock,
  archiveSession: archiveSessionMock,
  unarchiveSession: unarchiveSessionMock,
  setWorkspace: setWorkspaceMock,
  setModel: setModelMock,
  listWorkspaceFolders: listWorkspaceFoldersMock,
  createWorkspaceFolder: createWorkspaceFolderMock,
  renameWorkspaceFolder: renameWorkspaceFolderMock,
  deleteWorkspaceFolder: deleteWorkspaceFolderMock,
  usageBatch: usageBatchMock,
  usageSingle: usageSingleMock,
  usageStats: usageStatsMock,
  contextLength: contextLengthMock,
  exportSession: exportSessionMock,
}))

describe('session routes', () => {
  beforeEach(() => {
    vi.resetModules()
    listConversationsMock.mockClear()
    getConversationMessagesMock.mockClear()
    getConversationMessagesPaginatedMock.mockClear()
    listMock.mockClear()
    listHermesSessionsMock.mockClear()
    getHermesSessionMock.mockClear()
    importHermesSessionMock.mockClear()
    searchMock.mockClear()
    getMock.mockClear()
    listWorkspaceRunChangesMock.mockClear()
    getWorkspaceRunChangeMock.mockClear()
    getWorkspaceRunChangeFileMock.mockClear()
    removeMock.mockClear()
    renameMock.mockClear()
    archiveSessionMock.mockClear()
    unarchiveSessionMock.mockClear()
    setModelMock.mockClear()
    listWorkspaceFoldersMock.mockClear()
    createWorkspaceFolderMock.mockClear()
    renameWorkspaceFolderMock.mockClear()
    deleteWorkspaceFolderMock.mockClear()
  })

  it('registers conversations, session list, and search routes', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const paths = sessionRoutes.stack.map((entry: any) => entry.path)

    expect(paths).toEqual(expect.arrayContaining([
      '/api/hermes/sessions/conversations',
      '/api/hermes/sessions/conversations/:id/messages',
      '/api/hermes/sessions/conversations/:id/messages/paginated',
      '/api/hermes/sessions',
      '/api/hermes/sessions/hermes',
      '/api/hermes/sessions/hermes/:id',
      '/api/hermes/sessions/hermes/:id/import',
      '/api/hermes/search/sessions',
      '/api/hermes/sessions/search',
      '/api/hermes/sessions/usage',
      '/api/hermes/usage/stats',
      '/api/hermes/sessions/context-length',
      '/api/hermes/sessions/:id/workspace-run-changes',
      '/api/hermes/sessions/:id/workspace-run-changes/:changeId',
      '/api/hermes/sessions/:id/workspace-run-changes/:changeId/files/:fileId',
      '/api/hermes/sessions/:id',
      '/api/hermes/sessions/:id/export',
      '/api/hermes/sessions/:id/usage',
      '/api/hermes/sessions/:id/archive',
      '/api/hermes/sessions/:id/unarchive',
      '/api/hermes/sessions/:id/rename',
      '/api/hermes/sessions/:id/model',
      '/api/hermes/workspace/folders',
      '/api/hermes/workspace/folders/rename',
    ]))
  })

  it('delegates workspace folder routes to the controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const listLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/workspace/folders' && entry.methods.includes('HEAD'))
    const createLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/workspace/folders' && entry.methods.includes('POST'))
    const renameLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/workspace/folders/rename')
    const deleteLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/workspace/folders' && entry.methods.includes('DELETE'))

    const listCtx: any = { query: {}, request: { body: {} }, body: null, params: {} }
    await listLayer.stack[0](listCtx)
    expect(listWorkspaceFoldersMock).toHaveBeenCalledWith(listCtx)

    const createCtx: any = { query: {}, request: { body: { parentPath: '', name: 'new-folder' } }, body: null, params: {} }
    await createLayer.stack[0](createCtx)
    expect(createWorkspaceFolderMock).toHaveBeenCalledWith(createCtx)

    const renameCtx: any = { query: {}, request: { body: { path: 'old-folder', name: 'new-folder' } }, body: null, params: {} }
    await renameLayer.stack[0](renameCtx)
    expect(renameWorkspaceFolderMock).toHaveBeenCalledWith(renameCtx)

    const deleteCtx: any = { query: {}, request: { body: { path: 'new-folder' } }, body: null, params: {} }
    await deleteLayer.stack[0](deleteCtx)
    expect(deleteWorkspaceFolderMock).toHaveBeenCalledWith(deleteCtx)
  })

  it('delegates session search to the controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const layer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/search/sessions')
    const handler = layer.stack[0]
    const ctx: any = { query: { q: 'docker', limit: '8' }, body: null, params: {} }

    await handler(ctx)

    expect(searchMock).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ results: [{ id: 'search-1' }] })
  })

  it('registers workspace run change routes before the generic session detail route', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const paths = sessionRoutes.stack.map((entry: any) => entry.path)

    const listIndex = paths.indexOf('/api/hermes/sessions/:id/workspace-run-changes')
    const changeIndex = paths.indexOf('/api/hermes/sessions/:id/workspace-run-changes/:changeId')
    const fileIndex = paths.indexOf('/api/hermes/sessions/:id/workspace-run-changes/:changeId/files/:fileId')
    const detailIndex = paths.indexOf('/api/hermes/sessions/:id')

    expect(listIndex).toBeGreaterThanOrEqual(0)
    expect(changeIndex).toBeGreaterThanOrEqual(0)
    expect(fileIndex).toBeGreaterThanOrEqual(0)
    expect(listIndex).toBeLessThan(detailIndex)
    expect(changeIndex).toBeLessThan(detailIndex)
    expect(fileIndex).toBeLessThan(detailIndex)
  })

  it('delegates workspace run change routes to the controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const listLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions/:id/workspace-run-changes')
    const changeLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions/:id/workspace-run-changes/:changeId')
    const fileLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions/:id/workspace-run-changes/:changeId/files/:fileId')

    const listCtx: any = { params: { id: 'session-1' }, query: {}, body: null }
    await listLayer.stack[0](listCtx)
    expect(listWorkspaceRunChangesMock).toHaveBeenCalledWith(listCtx)
    expect(listCtx.body).toEqual({ changes: [] })

    const changeCtx: any = { params: { id: 'session-1', changeId: 'change-1' }, query: {}, body: null }
    await changeLayer.stack[0](changeCtx)
    expect(getWorkspaceRunChangeMock).toHaveBeenCalledWith(changeCtx)
    expect(changeCtx.body).toEqual({ change: { change_id: 'change-1' } })

    const fileCtx: any = { params: { id: 'session-1', changeId: 'change-1', fileId: '7' }, query: {}, body: null }
    await fileLayer.stack[0](fileCtx)
    expect(getWorkspaceRunChangeFileMock).toHaveBeenCalledWith(fileCtx)
    expect(fileCtx.body).toEqual({ file: { id: 7 } })
  })

  it('keeps the legacy search path wired to the same controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const layer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions/search')
    const handler = layer.stack[0]
    const ctx: any = { query: { q: 'docker' }, body: null, params: {} }

    await handler(ctx)

    expect(searchMock).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ results: [{ id: 'search-1' }] })
  })

  it('delegates conversations list and detail routes', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const listLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions/conversations')
    const detailLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions/conversations/:id/messages')

    const listCtx: any = { query: {}, body: null, params: {} }
    await listLayer.stack[0](listCtx)
    expect(listConversationsMock).toHaveBeenCalledWith(listCtx)
    expect(listCtx.body).toEqual({ sessions: [{ id: 'conversation-1' }] })

    const detailCtx: any = { params: { id: 'child-session' }, query: {}, body: null }
    await detailLayer.stack[0](detailCtx)
    expect(getConversationMessagesMock).toHaveBeenCalledWith(detailCtx)
    expect(detailCtx.body).toEqual({ session_id: 'child-session', messages: [] })
  })

  it('delegates Hermes session import to the controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const layer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions/hermes/:id/import')
    const handler = layer.stack[0]
    const ctx: any = { params: { id: 'hermes-abc' }, query: {}, request: { body: { profile: 'default' } }, body: null }

    await handler(ctx)

    expect(importHermesSessionMock).toHaveBeenCalledWith(ctx)
    expect(ctx.body).toEqual({ session_id: 'hermes-abc' })
  })

  it('delegates session export to the controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const layer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions/:id/export')
    const handler = layer.stack[0]
    const ctx: any = { params: { id: 'session-abc' }, query: {}, body: null, set: vi.fn() }

    await handler(ctx)

    expect(exportSessionMock).toHaveBeenCalledWith(ctx)
  })

  it('delegates archive and unarchive routes to the controller', async () => {
    const { sessionRoutes } = await import('../../packages/server/src/routes/hermes/sessions')
    const archiveLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions/:id/archive')
    const unarchiveLayer = sessionRoutes.stack.find((entry: any) => entry.path === '/api/hermes/sessions/:id/unarchive')

    const archiveCtx: any = { params: { id: 'session-abc' }, query: {}, body: null }
    await archiveLayer.stack[0](archiveCtx)
    expect(archiveSessionMock).toHaveBeenCalledWith(archiveCtx)
    expect(archiveCtx.body).toEqual({ ok: true, archived: true })

    const unarchiveCtx: any = { params: { id: 'session-abc' }, query: {}, body: null }
    await unarchiveLayer.stack[0](unarchiveCtx)
    expect(unarchiveSessionMock).toHaveBeenCalledWith(unarchiveCtx)
    expect(unarchiveCtx.body).toEqual({ ok: true, archived: false })
  })
})
