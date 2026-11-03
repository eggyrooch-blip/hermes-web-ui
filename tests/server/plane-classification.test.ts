import { describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// chat plane 的权限闸 forbiddenInChatPlane() 兜底是 `path.startsWith('/api/hermes/')`
// —— **默认拒绝**。加一个新端点而不去那个函数里显式放行，飞书员工就吃 403，而作者在
// admin plane 本地测、或者绕开那一跳测，完全看不出来。同一个故事已经上线后被真人撞到三次：
//   1. /api/hermes/credentials/gitlab（2026-08-05，那个端点的目标用户就是 chat 面员工）
//   2. Files 的写操作
//   3. /api/hermes/workspace/folders（2026-08-13，工作区选择器列目录 403）
//
// 这个测试不改任何放行判定，只是把「每个已注册端点在 chat plane 是 allow 还是 deny」
// 钉成一份签入的清单。新增端点 → 清单 diff → 作者必须过一眼、明确表态。
//
// 用**纯文本 fixture** 而不是 vitest snapshot：`vitest -u` 会把权限变化整体盖章。
// 更新走 UPDATE_PLANE_FIXTURE=1，而它只产 .candidate 且**永远失败** —— 生成命令本身
// 不能把检查变绿，否则只是把 `-u` 换了句咒语（跨模型评审两轮 #p1）。

const FIXTURE = join(__dirname, '__fixtures__', 'plane-classification.txt')
const originalEnv = process.env

type RouteEntry = { method: string; path: string; gated: boolean }

/**
 * 枚举全部已注册路由，并**保留 public/protected 分界**。
 *
 * enforcePlaneAccess 挂在 authMiddleware 里（index.ts: authChain = [feishuOAuthAuth,
 * enforcePlaneAccess]），registerRoutes 先挂 public 路由、再挂 authChain、最后挂 protected。
 * 早期版本用 registerRoutes(app, []) 把这个分界抹平了，于是 /api/auth/login、
 * /api/hermes/tts、/api/hermes/openapi.json 这些**闸根本管不到**的 public 端点被错标成
 * DENY —— 清单与生产行为不符，而且把 protected 路由挪到 auth 之前（真实的权限放宽）
 * 也不会让测试变红（跨模型评审 #p1）。
 * 边界用**闸函数本身的身份**标记（见 use() 里的注释），不用合成哨兵。
 */
async function collectRegisteredRoutes(): Promise<RouteEntry[]> {
  const { registerRoutes } = await import('../../packages/server/src/routes/index')
  const { enforcePlaneAccess } = await import('../../packages/server/src/services/request-context')
  const routes: RouteEntry[] = []
  let pastGate = false

  const app = {
    use(middleware: any) {
      // 边界标记就是**闸函数本身**，不是一个合成哨兵：合成哨兵标的只是"auth 槽位"，
      // 有人把 enforcePlaneAccess 从链上摘掉、只留 auth，清单照样显示 DENY，
      // 而实际上没人管（跨模型评审第 2 轮 #p1）。用真身份，摘掉它这里就再也标不出 gated。
      if (middleware === enforcePlaneAccess) {
        pastGate = true
        return app
      }
      const router = middleware?.router
      if (!router?.stack) return app
      for (const layer of router.stack) {
        for (const method of layer.methods) {
          // HEAD 保留：koa-router 给每个 GET 自动配 HEAD，跳过它既看不到 GET 派生 HEAD 的
          // 真实判定，也让将来新增的显式 HEAD 端点完全不触发清单（跨模型评审 #p1）。
          routes.push({ method, path: layer.path, gated: pastGate })
        }
      }
      return app
    },
  }
  registerRoutes(app, [enforcePlaneAccess])
  return routes
}

/**
 * 上面那份清单只证明「**如果**闸接在链上，各端点会被怎么判」。
 * 这一条补上另一半：生产 bootstrap 里，凡是接飞书身份的 authMode，都必须把
 * enforcePlaneAccess 接进 authChain —— 摘掉它而保留 feishu auth，租户就能直达管理端点。
 * 源码级断言足够便宜，且能挡住"有人删了那一项"这种改动。
 */
function assertGateWiredInBootstrap(): void {
  const src = readFileSync(join(__dirname, '../../packages/server/src/index.ts'), 'utf8')
  const start = src.indexOf('const authChain =')
  const end = src.indexOf('registerRoutes(app, authChain)')
  // 两个 marker 都必须真存在且顺序正确。早先只写 slice(start, end) —— end 为 -1 时
  // slice(start, -1) 依然包含整段 authChain 定义，于是把真实调用换成
  // registerRoutes(app, [])／[...authChain]／[compose(authChain)] 这三种写法，
  // 断言全都照样通过，而生产其实已经绕过闸（跨模型评审第 3 轮用这三个变异证伪）。
  expect(start, 'index.ts 里找不到 authChain 构造 —— 请同步更新本测试').toBeGreaterThanOrEqual(0)
  expect(end, 'index.ts 不再以 registerRoutes(app, authChain) 挂载路由 —— 请同步更新本测试')
    .toBeGreaterThan(start)

  const chain = src.slice(start, end)
  for (const feishuMode of ['feishu-oauth-dev', 'trusted-feishu']) {
    expect(
      chain.includes(feishuMode),
      `index.ts 的 authChain 不再区分 ${feishuMode} —— 请同步更新本测试`,
    ).toBe(true)
  }
  const feishuBranches = chain.split('\n').filter(l => l.includes('feishuOAuthAuth') || l.includes('trustedFeishuAuth'))
  expect(feishuBranches.length, 'index.ts 的飞书 auth 分支不见了 —— 请同步更新本测试').toBe(2)
  for (const branch of feishuBranches) {
    expect(
      branch,
      '飞书 authMode 的 authChain 里少了 enforcePlaneAccess —— 租户可直达管理端点',
    ).toContain('enforcePlaneAccess')
  }
}

/**
 * koa-router 的 path 是**模式串**（含 :id），不是真实请求路径。直接拿模式串去问闸会失真：
 * `/api/hermes/kanban/:id` 用字面量 ':id' 判出 allow，而真实 id 若是 links / tasks /
 * events 这些保留名会命中 blocklist 判成 DENY；反过来从 blocklist 里删掉一个保留名
 * 会**放宽真实请求**而清单纹丝不动（跨模型评审 #p1）。
 * 所以带参数的模式一律展开成两个样例：普通 id 与保留 id。
 */
const RESERVED_ID_SAMPLE = 'links' // 取自 CHAT_PLANE_KANBAN_DETAIL_BLOCKLIST
function expand(path: string): Array<{ label: string; concrete: string }> {
  if (!path.includes(':') && !path.includes('*')) return [{ label: path, concrete: path }]
  const normal = path.replace(/:[^/]+/g, 'sample-id').replace(/\{?\*[^}]*\}?/g, 'sample/path')
  const reserved = path.replace(/:[^/]+/g, RESERVED_ID_SAMPLE).replace(/\{?\*[^}]*\}?/g, 'sample/path')
  if (normal === reserved) return [{ label: path, concrete: normal }]
  return [
    { label: `${path}  [id=sample-id]`, concrete: normal },
    { label: `${path}  [id=${RESERVED_ID_SAMPLE}]`, concrete: reserved },
  ]
}

describe('chat plane 端点归属清单', () => {
  it('每个已注册端点的 chat-plane 判定都与签入清单一致', async () => {
    vi.resetModules()
    // 环境必须封闭：HERMES_CHAT_PLANE_ALLOW_SETTINGS 一旦从外面继承进来，
    // /api/hermes/config 的 GET/PUT 就从 DENY 翻成 allow，清单当场对不上（跨模型评审 #p1）。
    process.env = { ...originalEnv, HERMES_WEB_PLANE: 'chat', HERMES_CHAT_PLANE_ALLOW_SETTINGS: '' }
    try {
      assertGateWiredInBootstrap()
      const routes = await collectRegisteredRoutes()
      const { enforcePlaneAccess } = await import('../../packages/server/src/services/request-context')

      expect(routes.length, '反射没抓到路由 —— 别产出一份空清单').toBeGreaterThan(50)
      expect(routes.some(r => !r.gated), 'public/protected 分界丢了：没有任何 ungated 路由').toBe(true)
      expect(routes.some(r => r.gated), 'public/protected 分界丢了：没有任何 gated 路由').toBe(true)

      const lines: string[] = []
      for (const entry of routes) {
        const samples = expand(entry.path)
        const judged: Array<{ label: string; verdict: string }> = []
        for (const { label, concrete } of samples) {
          let verdict: string
          if (!entry.gated) {
            // 注册在闸**之前**，这道闸根本管不到它。
            verdict = 'ungated'
          } else {
            const ctx = { path: concrete, method: entry.method, status: 200, body: undefined } as any
            const next = vi.fn(async () => {})
            await enforcePlaneAccess(ctx, next)
            verdict = next.mock.calls.length === 1 ? 'allow ' : 'DENY  '
          }
          judged.push({ label, verdict })
        }
        // 两个样例判定相同就只留一行：322 条参数行里有 158 条两样例完全一致，
        // 全留下来只会稀释权限 diff（跨模型评审第 2 轮）。真正有差异的（kanban 那几组）保留两行。
        const distinct = new Set(judged.map(j => j.verdict))
        const emit = distinct.size === 1 ? [{ label: entry.path, verdict: judged[0].verdict }] : judged
        for (const { label, verdict } of emit) lines.push(`${verdict}  ${entry.method.padEnd(6)} ${label}`)
      }
      lines.sort()
      const actual = `${lines.length} entries\n${lines.join('\n')}\n`

      if (process.env.UPDATE_PLANE_FIXTURE === '1') {
        // 只写 candidate，并且**永远失败**：直接覆盖 fixture 再让测试变绿，等于把 `-u`
        // 换了句咒语 —— CI 或本地一旦残留这个变量，任何权限变化都会被静默接受
        // （跨模型评审第 2 轮 #p1）。生成命令本身永远不能把检查变绿。
        writeFileSync(`${FIXTURE}.candidate`, actual)
        throw new Error(
          `已生成 ${FIXTURE}.candidate。请 diff 它与 ${FIXTURE}，逐行确认每个 allow/DENY 都是你要的，`
          + '再手动替换正式 fixture，然后**不带** UPDATE_PLANE_FIXTURE 重跑。',
        )
      }
      const expected = readFileSync(FIXTURE, 'utf8')
      expect(
        actual,
        '端点的 chat-plane 归属变了。这不是格式问题 —— 逐行确认每个 allow/DENY 都是你要的，'
        + '新端点默认落在 DENY 上（如果那不是你要的，去 request-context.ts 的 forbiddenInChatPlane() '
        + '里显式放行，别只改清单）。确认无误后用 UPDATE_PLANE_FIXTURE=1 npx vitest run '
        + 'tests/server/plane-classification.test.ts 重写清单。',
      ).toBe(expected)
    } finally {
      process.env = originalEnv
    }
  })

  it('踩过三次的那三条端点，判定与今天生产一致', async () => {
    // 清单太长，人容易翻不到。这三条是真出过事的，单独钉死，回归时一眼可见。
    vi.resetModules()
    process.env = { ...originalEnv, HERMES_WEB_PLANE: 'chat', HERMES_CHAT_PLANE_ALLOW_SETTINGS: '' }
    try {
      const { enforcePlaneAccess } = await import('../../packages/server/src/services/request-context')
      const cases: Array<[string, string, boolean]> = [
        ['/api/hermes/credentials/gitlab', 'POST', true],
        ['/api/hermes/files/list', 'GET', true],
        ['/api/hermes/workspace/folders', 'GET', false],
      ]
      for (const [path, method, expectedAllowed] of cases) {
        const ctx = { path, method, status: 200, body: undefined } as any
        const next = vi.fn(async () => {})
        await enforcePlaneAccess(ctx, next)
        expect(next.mock.calls.length === 1, `${method} ${path}`).toBe(expectedAllowed)
      }
    } finally {
      process.env = originalEnv
    }
  })
})
