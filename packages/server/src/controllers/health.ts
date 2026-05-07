import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import * as hermesCli from '../services/hermes/hermes-cli'
import { getGatewayManagerInstance } from '../services/gateway-bootstrap'
import { config } from '../config'

declare const __APP_VERSION__: string

type PackageInfo = {
  name: string
  version: string
}

function readPackageInfo(): PackageInfo | null {
  const candidatePaths = [
    // ts-node dev: packages/server/src/controllers -> repo root
    resolve(__dirname, '../../../../package.json'),
    // bundled server: dist/server -> repo root/package root
    resolve(__dirname, '../../package.json'),
    // fallback for dev/test processes started at the repo root
    resolve(process.cwd(), 'package.json'),
  ]

  for (const packagePath of candidatePaths) {
    if (!existsSync(packagePath)) continue

    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'))
      if (pkg?.name && pkg?.version) {
        return {
          name: String(pkg.name),
          version: String(pkg.version),
        }
      }
    } catch {
      // Try the next candidate path.
    }
  }

  return null
}

const PACKAGE_INFO = readPackageInfo()
const LOCAL_VERSION = typeof __APP_VERSION__ !== 'undefined'
  ? __APP_VERSION__
  : PACKAGE_INFO?.version || ''
const HERMES_VERSION_CACHE_TTL_MS = 60_000
let cachedHermesVersionRaw = ''
let cachedHermesVersionAt = 0
let pendingHermesVersion: Promise<string> | null = null

async function getCachedHermesVersion(): Promise<string> {
  const now = Date.now()
  if (cachedHermesVersionAt && now - cachedHermesVersionAt < HERMES_VERSION_CACHE_TTL_MS) {
    return cachedHermesVersionRaw
  }

  if (!pendingHermesVersion) {
    pendingHermesVersion = hermesCli.getVersion()
      .catch(() => '')
      .then((raw) => {
        cachedHermesVersionRaw = raw
        cachedHermesVersionAt = Date.now()
        return raw
      })
      .finally(() => {
        pendingHermesVersion = null
      })
  }

  return pendingHermesVersion
}

export async function healthCheck(ctx: any) {
  const raw = await getCachedHermesVersion()
  const hermesVersion = raw.split('\n')[0].replace('Hermes Agent ', '') || ''
  let gatewayOk = false
  try {
    const mgr = getGatewayManagerInstance()
    const upstream = mgr?.getUpstream() || config.upstream
    const res = await fetch(`${upstream.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(5000) })
    gatewayOk = res.ok
  } catch { }
  ctx.body = {
    status: gatewayOk ? 'ok' : 'error',
    platform: 'hermes-agent',
    version: hermesVersion,
    gateway: gatewayOk ? 'running' : 'stopped',
    webui_version: LOCAL_VERSION,
    node_version: process.versions.node,
    plane: config.webPlane,
    auth_mode: config.authMode,
  }
}
