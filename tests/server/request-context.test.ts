import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const originalEnv = process.env

async function loadRequestContext(env: Record<string, string | undefined> = {}) {
  vi.resetModules()
  process.env = { ...originalEnv, ...env }
  return import('../../packages/server/src/services/request-context')
}

function mockCtx(path: string, method = 'GET') {
  return {
    path,
    method,
    status: 200,
    body: undefined,
  } as any
}

describe('chat plane access control', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.doUnmock('../../packages/server/src/services/compat-user')
  })

  it('lets a chat-plane employee submit their OWN GitLab token', async () => {
    // 这个端点的目标用户就是 chat 面的员工，却因为落到 forbiddenInChatPlane 结尾的
    // catch-all 而一直被拒 —— 功能从上线起对它唯一的用户就没工作过（sunke 2026-08-05
    // 实机撞到 403: This endpoint is not available in chat plane）。
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const ctx = mockCtx('/api/hermes/credentials/gitlab', 'POST')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.status).toBe(200)
  })

  it('does not widen the hole: only POST on that exact path, neighbours stay blocked', async () => {
    // 放行一条路径最怕顺手放宽了一片。逐条钉死：动词、路径前缀、以及相邻的 ops 端点。
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const mustStayBlocked: Array<[string, string]> = [
      ['/api/hermes/credentials/gitlab', 'GET'],
      ['/api/hermes/credentials/gitlab', 'DELETE'],
      ['/api/hermes/credentials', 'POST'],
      ['/api/hermes/credentials/other', 'POST'],
      ['/api/hermes/gateways', 'GET'],
      ['/api/hermes/logs', 'GET'],
    ]
    for (const [path, method] of mustStayBlocked) {
      const ctx = mockCtx(path, method)
      const next = vi.fn(async () => {})
      await enforcePlaneAccess(ctx, next)
      expect(next, `${method} ${path} 不该被放行`).not.toHaveBeenCalled()
      expect(ctx.status, `${method} ${path} 应为 403`).toBe(403)
    }
  })

  it('is not bypassable by path casing — the gate must be at least as wide as the router', async () => {
    // 生产上活着的鉴权绕过（2026-08-14 由跨模型评审翻出并复验）：本闸逐字比较 ctx.path，
    // 而 @koa/router 的 sensitive 默认 false（不区分大小写）。于是 /API/HERMES/LOGS
    // 不命中兜底 startsWith('/api/hermes/') → 闸放行，路由却照样匹配到处理器。
    // 受影响的是整张黑名单：logs / config / gateways / profiles / coding-agents / auth/*。
    //
    // 这条用例逐一枚举路径写法，断言"闸放行且 router 匹配"的组合数为 0。
    // 同类穷举结论：只有大小写变体构成真绕过，其余写法 router 根本不匹配。
    const Router = (await import('@koa/router')).default
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const variants = [
      '/api/hermes/logs',
      '/API/HERMES/LOGS',
      '/api/hermes/LOGS',
      '/Api/Hermes/Logs',
      '/api/hermes/logs/',
      '//api/hermes/logs',
      '/api/hermes//logs',
      '/api/hermes/%6cogs',
      '/api/hermes/./logs',
      '/api/hermes/x/../logs',
      '/api/hermes/logs%20',
      '/./api/hermes/logs',
    ]
    const bypasses: string[] = []
    const observed = new Map<string, { gateAllowed: boolean; routerMatched: boolean }>()
    for (const path of variants) {
      const ctx = mockCtx(path, 'GET')
      const next = vi.fn(async () => {})
      await enforcePlaneAccess(ctx, next)
      const gateAllowed = next.mock.calls.length === 1

      const router = new Router()
      let routerMatched = false
      router.get('/api/hermes/logs', async () => { routerMatched = true })
      try {
        await router.routes()({ path, method: 'GET', params: {}, request: {} } as any, async () => {})
      } catch { /* 畸形路径可能让 router 抛错，那也说明它没匹配 */ }

      if (gateAllowed && routerMatched) bypasses.push(path)
      observed.set(path, { gateAllowed, routerMatched })
    }
    expect(bypasses, `这些路径写法绕过了 chat plane 闸: ${bypasses.join(', ')}`).toEqual([])

    // 光断言"绕过数为 0"是**空洞的**（跨模型评审 #p1）：万一 router 压根没跑、
    // 或者哪天不再匹配大小写变体，上面那条也会绿，却没证明"闸严于 router"。
    // 所以对这三条大小写路径正向钉死：router 确实匹配得上，而闸确实判 403。
    for (const path of ['/api/hermes/logs', '/API/HERMES/LOGS', '/Api/Hermes/Logs']) {
      const seen = observed.get(path)!
      expect(seen.routerMatched, `${path}: router 必须匹配，否则这条用例没有判别力`).toBe(true)
      expect(seen.gateAllowed, `${path}: 闸必须拒绝`).toBe(false)
    }
  })

  it('keeps allowed endpoints allowed regardless of casing', async () => {
    // 归一化是双向的：已放行端点的大小写变体也要与小写同判，
    // 否则就制造出新的"看得见够不着"。
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    for (const path of ['/api/hermes/sessions', '/API/HERMES/SESSIONS', '/Api/Hermes/Sessions']) {
      const ctx = mockCtx(path, 'GET')
      const next = vi.fn(async () => {})
      await enforcePlaneAccess(ctx, next)
      expect(next, `${path} 应放行`).toHaveBeenCalledOnce()
      expect(ctx.status, `${path} 应保持 200`).toBe(200)
    }
  })

  it('lets a chat-plane employee read their own task log', async () => {
    // 端点归属清单扫出的同类漏放行（本 slug 收敛后只剩这一条）。kanban/:id/log：详情本体和
    // block/assign/complete/unblock 这些**写**动作都放行了，唯独这个**读**没放。
    // taskLog() 与详情同款守卫：requireOpenId + requireOwnedTasks(..., openid)。
    //
    // skills/toggle 与 skills/pin 本来也在这一批，已**撤出**：它们是写入路径，
    // 而技能写入的软链守卫还不完整（叶子 .bak 未覆盖、lstat 与写入之间有时间差），
    // 根治要在 SafeFileStore 层做临时文件+原子 rename。等那条加固落地再放
    // （sunke 2026-08-14 拍板拆分）。
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const mustBeAllowed: Array<[string, string]> = [
      ['/api/hermes/kanban/task-123/log', 'GET'],
    ]
    for (const [path, method] of mustBeAllowed) {
      const ctx = mockCtx(path, method)
      const next = vi.fn(async () => {})
      await enforcePlaneAccess(ctx, next)
      expect(next, `${method} ${path} 应放行`).toHaveBeenCalledOnce()
      expect(ctx.status, `${method} ${path} 应保持 200`).toBe(200)
    }
  })

  it('does not widen the hole for the newly allowed endpoint', async () => {
    // 同上：放行端点最怕顺手放宽一片。钉死动词、撤出的 skills 写操作、以及 kanban
    // blocklist 里的保留段（别让 `/kanban/artifact/log` 这类混进来）。
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const mustStayBlocked: Array<[string, string]> = [
      // 注意：`GET /api/hermes/skills/*` 本来就是放行的（读技能内容走
      // `skills/{*path}` 那条 catch-all），所以这里不能拿 GET 当"应被拒"的负控制 ——
      // 我一开始写错过一次，被这条用例自己抓住了。
      // 撤出的两条：技能写入路径在加固落地前必须保持被拒。
      ['/api/hermes/skills/toggle', 'PUT'],
      ['/api/hermes/skills/pin', 'PUT'],
      ['/api/hermes/skills/toggle', 'DELETE'],
      ['/api/hermes/skills/pin', 'POST'],
      ['/api/hermes/skills/external-dirs', 'PUT'],
      ['/api/hermes/kanban/task-123/log', 'POST'],
      ['/api/hermes/kanban/task-123/log/extra', 'GET'],
      ['/api/hermes/kanban/artifact/log', 'GET'],
      ['/api/hermes/kanban/diagnostics/log', 'GET'],
      ['/api/hermes/kanban/diagnostics', 'GET'],
    ]
    for (const [path, method] of mustStayBlocked) {
      const ctx = mockCtx(path, method)
      const next = vi.fn(async () => {})
      await enforcePlaneAccess(ctx, next)
      expect(next, `${method} ${path} 不该被放行`).not.toHaveBeenCalled()
      expect(ctx.status, `${method} ${path} 应为 403`).toBe(403)
    }
  })

  it('allows model list endpoints in chat plane', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const ctx = mockCtx('/api/hermes/available-models')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.status).toBe(200)
  })

  it('keeps settings endpoints blocked in chat plane by default', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const ctx = mockCtx('/api/hermes/config')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(ctx, next)

    expect(next).not.toHaveBeenCalled()
    expect(ctx.status).toBe(403)
  })

  it('allows settings endpoints in chat plane when explicitly enabled', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({
      HERMES_WEB_PLANE: 'chat',
      HERMES_CHAT_PLANE_ALLOW_SETTINGS: '1',
    })
    const ctx = mockCtx('/api/hermes/config')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.status).toBe(200)
  })

  it('allows model listing and model selection but blocks credential writes in chat plane', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const allowedModelListCtx = mockCtx('/api/hermes/available-models', 'GET')
    const allowedModelCtx = mockCtx('/api/hermes/config/model', 'PUT')
    const blockedCredentialsCtx = mockCtx('/api/hermes/config/credentials', 'PUT')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(allowedModelListCtx, next)
    await enforcePlaneAccess(allowedModelCtx, next)
    await enforcePlaneAccess(blockedCredentialsCtx, next)

    expect(next).toHaveBeenCalledTimes(2)
    expect(allowedModelListCtx.status).toBe(200)
    expect(allowedModelCtx.status).toBe(200)
    expect(blockedCredentialsCtx.status).toBe(403)
  })

  it('allows profile memory edits and sandboxed file management in chat plane', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const memoryCtx = mockCtx('/api/hermes/memory', 'POST')
    const fileCtx = mockCtx('/api/hermes/files/list', 'GET')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(memoryCtx, next)
    await enforcePlaneAccess(fileCtx, next)

    expect(next).toHaveBeenCalledTimes(2)
    expect(memoryCtx.status).toBe(200)
    expect(fileCtx.status).toBe(200)
  })

  it('allows inline artifact preview alongside download in chat plane', async () => {
    // Regression: the embedded browser / 详情面板 GETs /api/hermes/preview. It
    // shares download's workspace-confined resolution, so it MUST be allowed in
    // chat plane — otherwise feishu users get 403 on every artifact preview.
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const previewCtx = mockCtx('/api/hermes/preview', 'GET')
    const downloadCtx = mockCtx('/api/hermes/download', 'GET')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(previewCtx, next)
    await enforcePlaneAccess(downloadCtx, next)

    expect(next).toHaveBeenCalledTimes(2)
    expect(previewCtx.status).toBe(200)
    expect(downloadCtx.status).toBe(200)
  })

  it('allows profile-local skill import and file edits while skill writes stay blocked in chat plane', async () => {
    // 历史：2026-08-13 我曾把 toggle/pin 从 403 翻成 200，理由是下面这段；
    // 2026-08-14 又**翻了回来** —— 技能写入路径的软链守卫覆盖不完整
    // （SafeFileStore 的 *.bak 备份目的地、importSkill/deleteSkill 动态目录未盖，
    //  且 lstat 与写入之间存在时间差），放行要等 slug skills-write-symlink-hardening。
    // 下面这段放行理由本身仍然成立，只是被安全前置条件挡住了，留档备查：
    // slug chat-plane-missing-allowlist-entries）。原来的 403 不是"员工不该开关技能"这个
    // 政策判断，而是 c66d5f44（webui-skill-import-chat-plane）的**不越界护栏** ——
    // 那一轮只想放行 `skills/import` 一条，于是顺手把邻居钉成 403 以证明自己没放宽一片。
    // 现在明确翻转它的理由：
    //  - 控制器本身按 profile 隔离（skills.ts toggle() → updateConfigYamlForProfile(requestedProfile(ctx))，
    //    pin_() → updatePinnedSkill(requestSkillsDir(ctx))），前置 refuseUnprovisionedProfile +
    //    refuseSymlinkedSkillsPath，不从请求体取身份；
    //  - 前端 SkillList.vue 的开关对 chat 面员工是**渲染出来的**（没有 super-admin 门），
    //    点下去就是 403 —— 与 credentials/gitlab 同一个故事：功能对它的目标用户从未工作过；
    //  - 员工已经能导入技能、能改技能文件，却不能启用它，这个组合不成立。
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const importCtx = mockCtx('/api/hermes/skills/import', 'POST')
    const editCtx = mockCtx('/api/hermes/skills/file', 'PUT')
    const toggleCtx = mockCtx('/api/hermes/skills/toggle', 'PUT')
    const pinCtx = mockCtx('/api/hermes/skills/pin', 'PUT')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(importCtx, next)
    await enforcePlaneAccess(editCtx, next)
    await enforcePlaneAccess(toggleCtx, next)
    await enforcePlaneAccess(pinCtx, next)

    expect(next).toHaveBeenCalledTimes(2)
    expect(importCtx.status).toBe(200)
    expect(editCtx.status).toBe(200)
    // toggle/pin 维持 403：见上方用例的说明，等 SafeFileStore 加固落地再放。
    expect(toggleCtx.status).toBe(403)
    expect(pinCtx.status).toBe(403)
  })

  it('allows profile-local write-gate review endpoints in chat plane', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const listCtx = mockCtx('/api/hermes/write-gate/pending', 'GET')
    const diffCtx = mockCtx('/api/hermes/write-gate/pending/skills/abc123/diff', 'GET')
    const approveCtx = mockCtx('/api/hermes/write-gate/pending/skills/abc123/approve', 'POST')
    const rejectCtx = mockCtx('/api/hermes/write-gate/pending/memory/def456/reject', 'POST')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(listCtx, next)
    await enforcePlaneAccess(diffCtx, next)
    await enforcePlaneAccess(approveCtx, next)
    await enforcePlaneAccess(rejectCtx, next)

    expect(next).toHaveBeenCalledTimes(4)
    expect(listCtx.status).toBe(200)
    expect(diffCtx.status).toBe(200)
    expect(approveCtx.status).toBe(200)
    expect(rejectCtx.status).toBe(200)
  })

  it('allows expert catalog and plugin avatar assets in chat plane as GET-only surfaces', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const expertsCtx = mockCtx('/api/hermes/experts', 'GET')
    const assetCtx = mockCtx('/api/hermes/plugin-assets/keep-resource-delivery/expert.png', 'GET')
    const blockedAssetPostCtx = mockCtx('/api/hermes/plugin-assets/keep-resource-delivery/expert.png', 'POST')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(expertsCtx, next)
    await enforcePlaneAccess(assetCtx, next)
    await enforcePlaneAccess(blockedAssetPostCtx, next)

    expect(next).toHaveBeenCalledTimes(2)
    expect(expertsCtx.status).toBe(200)
    expect(assetCtx.status).toBe(200)
    expect(blockedAssetPostCtx.status).toBe(403)
  })

  it('allows owner-scoped group chat endpoints in chat plane', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const listCtx = mockCtx('/api/hermes/group-chat/rooms', 'GET')
    const createCtx = mockCtx('/api/hermes/group-chat/rooms', 'POST')
    const updateCtx = mockCtx('/api/hermes/group-chat/rooms/room-1/config', 'PUT')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(listCtx, next)
    await enforcePlaneAccess(createCtx, next)
    await enforcePlaneAccess(updateCtx, next)

    expect(next).toHaveBeenCalledTimes(3)
    expect(listCtx.status).toBe(200)
    expect(createCtx.status).toBe(200)
    expect(updateCtx.status).toBe(200)
  })

  it('allows only owner-scoped kanban BFF endpoints in chat plane', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const listCtx = mockCtx('/api/hermes/kanban', 'GET')
    const createCtx = mockCtx('/api/hermes/kanban', 'POST')
    const detailCtx = mockCtx('/api/hermes/kanban/task-1', 'GET')
    const completeCtx = mockCtx('/api/hermes/kanban/complete', 'POST')
    const unblockCtx = mockCtx('/api/hermes/kanban/unblock', 'POST')
    const blockCtx = mockCtx('/api/hermes/kanban/task-1/block', 'POST')
    const assignCtx = mockCtx('/api/hermes/kanban/task-1/assign', 'POST')
    const assigneesCtx = mockCtx('/api/hermes/kanban/assignees', 'GET')
    const dispatchCtx = mockCtx('/api/hermes/kanban/dispatch', 'POST')
    const eventsCtx = mockCtx('/api/hermes/kanban/events', 'GET')
    const commentCtx = mockCtx('/api/hermes/kanban/task-1/comments', 'POST')
    const artifactCtx = mockCtx('/api/hermes/kanban/artifact', 'GET')
    const logCtx = mockCtx('/api/hermes/kanban/task-1/log', 'GET')
    const boardCreateCtx = mockCtx('/api/hermes/kanban/boards', 'POST')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(listCtx, next)
    await enforcePlaneAccess(createCtx, next)
    await enforcePlaneAccess(detailCtx, next)
    await enforcePlaneAccess(completeCtx, next)
    await enforcePlaneAccess(unblockCtx, next)
    await enforcePlaneAccess(blockCtx, next)
    await enforcePlaneAccess(assignCtx, next)
    await enforcePlaneAccess(assigneesCtx, next)
    await enforcePlaneAccess(dispatchCtx, next)
    await enforcePlaneAccess(eventsCtx, next)
    await enforcePlaneAccess(commentCtx, next)
    await enforcePlaneAccess(artifactCtx, next)
    await enforcePlaneAccess(logCtx, next)
    await enforcePlaneAccess(boardCreateCtx, next)

    // 9→10：`GET /kanban/:id/log` 从 403 翻成 200（2026-08-13，
    // slug chat-plane-missing-allowlist-entries）。详情本体和 block/assign/complete/unblock
    // 这些**写**动作早就放行了，唯独详情页这个**读**没放，是列举时漏掉。
    // taskLog() 与详情同款守卫：requireOpenId + requireOwnedTasks(..., openid)，非本人任务 404。
    expect(next).toHaveBeenCalledTimes(10)
    expect(listCtx.status).toBe(200)
    expect(createCtx.status).toBe(200)
    expect(detailCtx.status).toBe(200)
    expect(completeCtx.status).toBe(200)
    expect(unblockCtx.status).toBe(200)
    expect(blockCtx.status).toBe(200)
    expect(assignCtx.status).toBe(200)
    expect(assigneesCtx.status).toBe(200)
    expect(dispatchCtx.status).toBe(200)
    expect(eventsCtx.status).toBe(403)
    expect(commentCtx.status).toBe(403)
    expect(artifactCtx.status).toBe(403)
    expect(logCtx.status).toBe(200)
    expect(boardCreateCtx.status).toBe(403)
  })

  it('fails closed for malformed chat-plane kanban task ids', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const ctx = mockCtx('/api/hermes/kanban/%E0%A4%A', 'GET')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(ctx, next)

    expect(next).not.toHaveBeenCalled()
    expect(ctx.status).toBe(403)
  })

  it('allows owner-scoped profile listing and creation in chat plane but keeps profile admin actions blocked', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const listCtx = mockCtx('/api/hermes/profiles', 'GET')
    const createCtx = mockCtx('/api/hermes/profiles', 'POST')
    const detailCtx = mockCtx('/api/hermes/profiles/other', 'GET')
    const deleteCtx = mockCtx('/api/hermes/profiles/other', 'DELETE')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(listCtx, next)
    await enforcePlaneAccess(createCtx, next)
    await enforcePlaneAccess(detailCtx, next)
    await enforcePlaneAccess(deleteCtx, next)

    expect(next).toHaveBeenCalledTimes(2)
    expect(listCtx.status).toBe(200)
    expect(createCtx.status).toBe(200)
    expect(detailCtx.status).toBe(403)
    expect(deleteCtx.status).toBe(403)
  })

  it('allows slash registry lookup in chat plane', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const ctx = mockCtx('/api/hermes/slash/commands', 'GET')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.status).toBe(200)
  })

  it('allows authenticated Feishu UAT self-service endpoints in chat plane', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const statusCtx = mockCtx('/api/auth/feishu/uat/status', 'GET')
    const startCtx = mockCtx('/api/auth/feishu/uat/start', 'POST')
    const pollCtx = mockCtx('/api/auth/feishu/uat/sessions/sess-1', 'GET')
    const cancelCtx = mockCtx('/api/auth/feishu/uat/sessions/sess-1', 'DELETE')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(statusCtx, next)
    await enforcePlaneAccess(startCtx, next)
    await enforcePlaneAccess(pollCtx, next)
    await enforcePlaneAccess(cancelCtx, next)

    expect(next).toHaveBeenCalledTimes(4)
    expect(statusCtx.status).toBe(200)
    expect(startCtx.status).toBe(200)
    expect(pollCtx.status).toBe(200)
    expect(cancelCtx.status).toBe(200)
  })

  it('keeps sandboxed file management available when settings are explicitly enabled', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({
      HERMES_WEB_PLANE: 'chat',
      HERMES_CHAT_PLANE_ALLOW_SETTINGS: '1',
    })
    const ctx = mockCtx('/api/hermes/files/list')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.status).toBe(200)
  })

  it('does not reopen admin surface endpoints through the removed temporary flag', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({
      HERMES_WEB_PLANE: 'chat',
      HERMES_CHAT_PLANE_TEMP_OPEN_ADMIN: '1',
    })
    const allowed = [
      '/api/hermes/config',
      '/api/hermes/gateways',
      '/api/hermes/logs',
      '/api/hermes/channels',
      '/api/hermes/devices',
      '/api/hermes/cron-history',
      '/api/hermes/model-context',
      '/api/hermes/auth/copilot/check-token',
      '/api/hermes/weixin/qrcode',
      '/api/hermes/skills/toggle',
      '/api/coding-agents',
    ]

    for (const path of allowed) {
      const ctx = mockCtx(path, path.includes('toggle') ? 'POST' : 'GET')
      const next = vi.fn(async () => {})

      await enforcePlaneAccess(ctx, next)

      expect(next, path).not.toHaveBeenCalled()
      expect(ctx.status, path).toBe(403)
    }
  })

  it('allows plugin and MCP server inventory reads but blocks MCP tools and mutations in chat plane', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({ HERMES_WEB_PLANE: 'chat' })
    const allowed = [
      mockCtx('/api/hermes/plugins', 'GET'),
      mockCtx('/api/hermes/mcp/servers', 'GET'),
    ]
    const blocked = [
      mockCtx('/api/hermes/mcp/tools', 'GET'),
      mockCtx('/api/hermes/mcp/servers', 'POST'),
      mockCtx('/api/hermes/mcp/servers/github', 'PATCH'),
      mockCtx('/api/hermes/mcp/servers/github', 'DELETE'),
      mockCtx('/api/hermes/mcp/servers/github/test', 'POST'),
      mockCtx('/api/hermes/mcp/reload', 'POST'),
    ]
    const next = vi.fn(async () => {})

    for (const ctx of allowed) await enforcePlaneAccess(ctx, next)
    for (const ctx of blocked) await enforcePlaneAccess(ctx, next)

    expect(next).toHaveBeenCalledTimes(allowed.length)
    for (const ctx of allowed) expect(ctx.status, ctx.path).toBe(200)
    for (const ctx of blocked) expect(ctx.status, ctx.path).toBe(403)
  })

  it('keeps sandboxed files available even when the removed temporary flag is set', async () => {
    const { enforcePlaneAccess } = await loadRequestContext({
      HERMES_WEB_PLANE: 'chat',
      HERMES_CHAT_PLANE_TEMP_OPEN_ADMIN: '1',
    })
    const ctx = mockCtx('/api/hermes/files/list')
    const next = vi.fn(async () => {})

    await enforcePlaneAccess(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.status).toBe(200)
  })
})

describe('multitenancy profile resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  function makeRoutingDb(rows: Array<{ user_id: string; profile_name: string; open_id: string; active?: number; owner_open_id?: string; provenance?: string; kind?: string | null }>) {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-routing-'))
    const dbPath = join(dir, 'multitenancy.db')
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`
        CREATE TABLE multitenancy_routing (
          user_id TEXT PRIMARY KEY NOT NULL,
          profile_name TEXT NOT NULL,
          open_id TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          owner_open_id TEXT,
          kind TEXT DEFAULT 'user',
          provenance TEXT DEFAULT 'sync'
        );
      `)
      const stmt = db.prepare('INSERT INTO multitenancy_routing (user_id, profile_name, open_id, active, owner_open_id, kind, provenance) VALUES (?, ?, ?, ?, ?, ?, ?)')
      for (const row of rows) {
        stmt.run(row.user_id, row.profile_name, row.open_id, row.active ?? 1, row.owner_open_id ?? row.open_id, row.kind === undefined ? 'user' : row.kind, row.provenance ?? 'sync')
      }
    } finally {
      db.close()
    }
    return dbPath
  }

  it('resolves the profile bound by multitenancy routing', async () => {
    const dbPath = makeRoutingDb([{ user_id: 'user_a', profile_name: 'user_a', open_id: 'ou_user_a' }])
    const { resolveProfileForOpenId } = await loadRequestContext({ HERMES_MULTITENANCY_DB: dbPath })

    expect(resolveProfileForOpenId('ou_user_a')).toBe('user_a')
  })

  it('resolves only the canonical synced user row when an agent row reuses the same open_id', async () => {
    const dbPath = makeRoutingDb([
      {
        user_id: 'webui:ou_user_a:agent',
        profile_name: 'agent_profile',
        open_id: 'ou_user_a',
        owner_open_id: 'ou_user_a',
        kind: 'agent',
        provenance: 'sync',
      },
      {
        user_id: 'user_a',
        profile_name: 'feishu_user_a',
        open_id: 'ou_user_a',
        owner_open_id: 'ou_user_a',
        kind: 'user',
        provenance: 'sync',
      },
    ])
    const { resolveProfileForOpenId } = await loadRequestContext({ HERMES_MULTITENANCY_DB: dbPath })

    expect(resolveProfileForOpenId('ou_user_a')).toBe('feishu_user_a')
  })

  it('keeps OAuth profile binding compatible with migrated rows whose kind is still null', async () => {
    const dbPath = makeRoutingDb([{
      user_id: 'user_a',
      profile_name: 'feishu_user_a',
      open_id: 'ou_user_a',
      owner_open_id: 'ou_user_a',
      kind: null,
      provenance: 'sync',
    }])
    const { resolveProfileForOpenId } = await loadRequestContext({ HERMES_MULTITENANCY_DB: dbPath })

    expect(resolveProfileForOpenId('ou_user_a')).toBe('feishu_user_a')
  })

  it('prefers an explicit user kind over a legacy null-kind row for the same open_id', async () => {
    const dbPath = makeRoutingDb([
      {
        user_id: 'legacy',
        profile_name: 'legacy_sunke',
        open_id: 'ou_user_a',
        owner_open_id: 'ou_user_a',
        kind: null,
        provenance: 'sync',
      },
      {
        user_id: 'user_a',
        profile_name: 'feishu_user_a',
        open_id: 'ou_user_a',
        owner_open_id: 'ou_user_a',
        kind: 'user',
        provenance: 'sync',
      },
    ])
    const { resolveProfileForOpenId } = await loadRequestContext({ HERMES_MULTITENANCY_DB: dbPath })

    expect(resolveProfileForOpenId('ou_user_a')).toBe('feishu_user_a')
  })

  it('keeps OAuth profile binding compatible with migrated rows whose kind is empty', async () => {
    const dbPath = makeRoutingDb([{
      user_id: 'user_a',
      profile_name: 'feishu_user_a',
      open_id: 'ou_user_a',
      owner_open_id: 'ou_user_a',
      kind: '',
      provenance: 'sync',
    }])
    const { resolveProfileForOpenId } = await loadRequestContext({ HERMES_MULTITENANCY_DB: dbPath })

    expect(resolveProfileForOpenId('ou_user_a')).toBe('feishu_user_a')
  })

  it('rejects OAuth profile binding when the route is not the required canonical profile', async () => {
    const dbPath = makeRoutingDb([{ user_id: 'user_a', profile_name: 'feishu_user_a', open_id: 'ou_user_a' }])
    const { resolveProfileForOpenId } = await loadRequestContext({
      HERMES_MULTITENANCY_DB: dbPath,
      HERMES_REQUIRED_PROFILE: 'user_a',
    })

    expect(resolveProfileForOpenId('ou_user_a')).toBeNull()
  })

  it('preserves trusted Feishu display metadata on the authenticated user', async () => {
    const dbPath = makeRoutingDb([{ user_id: 'user_a', profile_name: 'feishu_user_a', open_id: 'ou_user_a' }])
    const ensureWebUserForFeishu = vi.fn(() => ({
      id: 42,
      username: 'feishu:ou_user_a',
      role: 'user',
      profiles: ['feishu_user_a'],
    }))
    vi.doMock('../../packages/server/src/services/compat-user', () => ({
      ensureWebUserForFeishu,
    }))
    const {
      signTrustedFeishuHeader,
      trustedFeishuAuth,
    } = await loadRequestContext({
      HERMES_MULTITENANCY_DB: dbPath,
      HERMES_TRUSTED_HEADER_SECRET: 'trusted-secret',
    })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const headers: Record<string, string> = {
      'x-feishu-openid': 'ou_user_a',
      'x-feishu-name': '孙可',
      'x-feishu-avatar-url': 'https://example.com/feishu-avatar.png',
      'x-hermes-auth-timestamp': timestamp,
      'x-hermes-auth-signature': signTrustedFeishuHeader('ou_user_a', timestamp, 'trusted-secret', {
        name: '孙可',
        avatarUrl: 'https://example.com/feishu-avatar.png',
      }),
    }
    const ctx = {
      state: {},
      get: (name: string) => headers[name.toLowerCase()] || '',
    } as any
    const next = vi.fn(async () => {})

    await trustedFeishuAuth(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ensureWebUserForFeishu).toHaveBeenCalledWith('ou_user_a', {
      name: '孙可',
      avatarUrl: 'https://example.com/feishu-avatar.png',
    })
    expect(ctx.state.user).toMatchObject({
      id: 42,
      username: 'feishu:ou_user_a',
      openid: 'ou_user_a',
      profile: 'feishu_user_a',
      name: '孙可',
      avatarUrl: 'https://example.com/feishu-avatar.png',
      profiles: ['feishu_user_a'],
    })
  })

  it('uses an owner-scoped selected profile header in chat plane', async () => {
    const dbPath = makeRoutingDb([
      { user_id: 'user_a', profile_name: 'feishu_user_a', open_id: 'ou_user_a' },
      { user_id: 'group:alpha', profile_name: 'feishu_group_alpha', open_id: '', owner_open_id: 'ou_user_a', provenance: 'group' },
    ])
    const { getRequestProfile } = await loadRequestContext({
      HERMES_WEB_PLANE: 'chat',
      HERMES_MULTITENANCY_DB: dbPath,
    })
    const ctx = {
      state: { user: { openid: 'ou_user_a', profile: 'feishu_user_a', role: 'user' } },
      get: (name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'feishu_group_alpha' : '',
      query: {},
    } as any

    expect(getRequestProfile(ctx)).toBe('feishu_group_alpha')
  })

  it('falls back to the bound profile when the selected chat-plane profile is not owned', async () => {
    const dbPath = makeRoutingDb([
      { user_id: 'user_a', profile_name: 'feishu_user_a', open_id: 'ou_user_a' },
      { user_id: 'other-group', profile_name: 'feishu_group_other', open_id: '', owner_open_id: 'ou_other', provenance: 'group' },
    ])
    const { getRequestProfile } = await loadRequestContext({
      HERMES_WEB_PLANE: 'chat',
      HERMES_MULTITENANCY_DB: dbPath,
    })
    const ctx = {
      state: { user: { openid: 'ou_user_a', profile: 'feishu_user_a', role: 'user' } },
      get: (name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'feishu_group_other' : '',
      query: {},
    } as any

    expect(getRequestProfile(ctx)).toBe('feishu_user_a')
  })
})
