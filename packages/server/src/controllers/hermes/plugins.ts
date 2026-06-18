import { listHermesPlugins, type HermesPluginsResponse } from '../../services/hermes/plugins'

function isSuperAdmin(ctx: any): boolean {
  return ctx.state?.user?.role === 'super_admin'
}

function redactPluginInventory(response: HermesPluginsResponse): Partial<HermesPluginsResponse> {
  return {
    plugins: (response.plugins || []).map((plugin) => ({
      key: plugin.key,
      name: plugin.name,
      kind: plugin.kind,
      source: plugin.source,
      configStatus: plugin.configStatus,
      effectiveStatus: plugin.effectiveStatus,
      version: plugin.version,
      description: plugin.description,
      author: plugin.author,
      providesTools: plugin.providesTools || [],
      providesHooks: plugin.providesHooks || [],
    })),
    warnings: [],
  }
}

export async function list(ctx: any) {
  try {
    const response = await listHermesPlugins(ctx.state?.profile?.name)
    ctx.body = isSuperAdmin(ctx) ? response : redactPluginInventory(response)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message || 'Failed to discover Hermes plugins' }
  }
}
