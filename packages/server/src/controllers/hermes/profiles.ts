import { createReadStream, createWriteStream, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { mkdir, unlink, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { pipeline } from 'stream/promises'
import busboy from 'busboy'

const MAX_PROFILE_IMPORT_SIZE = 50 * 1024 * 1024 // 50MB
const PROFILE_IMPORT_TIMEOUT_MS = 120_000
const ALLOWED_PROFILE_IMPORT_EXTS = new Set(['.gz', '.zip', '.tgz'])
import * as hermesCli from '../../services/hermes/hermes-cli'
import { SessionDeleter } from '../../services/hermes/session-deleter'
import { getGatewayManagerInstance } from '../../services/gateway-bootstrap'
import { logger } from '../../services/logger'
import { smartCloneCleanup } from '../../services/hermes/profile-credentials'
import { config, getWebUiHome } from '../../config'
import { listOwnedProfileMetadata, ownerOwnsProfile, registerOwnedProfile } from '../../services/hermes/agent-ownership'
import { provisionOwnedProfileViaBroker } from '../../services/hermes/profile-provisioning'
import { getRequestProfile } from '../../services/request-context'
import { HermesSkillInjector } from '../../services/hermes/skill-injector'

interface ProfileAvatarMeta {
  type: 'generated' | 'image'
  seed?: string
  file?: string
  mime?: string
  updatedAt?: number
}

interface ProfileAvatarResponse {
  type: 'generated' | 'image'
  seed?: string
  dataUrl?: string
  updatedAt?: number
}

function profileMetadataDir(name: string): string {
  const segment = Buffer.from(name || 'default', 'utf-8').toString('base64url')
  return join(getWebUiHome(), 'profile-metadata', segment)
}

function profileAvatarMetaPath(name: string): string {
  return join(profileMetadataDir(name), 'avatar.json')
}

function profileAvatarImagePath(name: string, file = 'avatar.bin'): string {
  return join(profileMetadataDir(name), file)
}

function readProfileAvatar(name: string): ProfileAvatarResponse | null {
  const metaPath = profileAvatarMetaPath(name)
  if (!existsSync(metaPath)) return null
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as ProfileAvatarMeta
    if (meta.type === 'generated') {
      return {
        type: 'generated',
        seed: typeof meta.seed === 'string' ? meta.seed : name,
        updatedAt: meta.updatedAt,
      }
    }
    if (meta.type === 'image' && meta.file && meta.mime) {
      const imagePath = profileAvatarImagePath(name, meta.file)
      if (!existsSync(imagePath)) return null
      const data = readFileSync(imagePath).toString('base64')
      return {
        type: 'image',
        dataUrl: `data:${meta.mime};base64,${data}`,
        updatedAt: meta.updatedAt,
      }
    }
  } catch (err) {
    logger.warn(err, '[profiles] failed to read avatar metadata for profile "%s"', name)
  }
  return null
}

function withProfileAvatar<T extends { name: string }>(profile: T): T & { avatar?: ProfileAvatarResponse } {
  const avatar = readProfileAvatar(profile.name)
  return avatar ? { ...profile, avatar } : profile
}

function parseAvatarDataUrl(dataUrl: string): { mime: string; buffer: Buffer } {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/=]+)$/)
  if (!match) throw new Error('Avatar image must be a PNG, JPEG, or WebP data URL')
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length > 1024 * 1024) throw new Error('Avatar image must be 1MB or smaller')
  return { mime: match[1], buffer }
}

function ensureCanWriteProfileMetadata(ctx: any, name: string): boolean {
  if (config.webPlane !== 'chat') return true
  const user = ctx.state?.user as { openid?: string; profile?: string } | undefined
  if (!user?.openid) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return false
  }
  if (name === user.profile || ownerOwnsProfile(user.openid, name)) return true
  ctx.status = 403
  ctx.body = { error: `Profile "${name}" is not available for this user` }
  return false
}

async function injectBundledSkillsForProfile(name: string): Promise<void> {
  try {
    const targetDir = HermesSkillInjector.resolveTargetDirForProfile(name)
    const result = await new HermesSkillInjector(undefined, targetDir).injectMissingSkills()
    const target = result.targets[0]
    if (target && (target.injected.length > 0 || target.updated.length > 0)) {
      logger.info({
        profile: name,
        targetDir,
        injected: target.injected,
        updated: target.updated,
      }, '[profiles] synced bundled skills for profile')
    }
  } catch (err: any) {
    logger.warn(err, '[profiles] failed to sync bundled skills for profile "%s"', name)
  }
}

export async function list(ctx: any) {
  try {
    const user = ctx.state?.user as { openid?: string; profile?: string } | undefined
    if (config.webPlane === 'chat' && user?.openid) {
      const owned = listOwnedProfileMetadata(user.openid)
      if (user.profile && !owned.has(user.profile)) {
        owned.set(user.profile, { profileName: user.profile, kind: 'user', ownerOpenId: user.openid })
      }
      const activeProfileName = getRequestProfile(ctx)
      ctx.body = {
        profiles: Array.from(owned.values()).map(meta => withProfileAvatar({
          name: meta.profileName,
          active: meta.profileName === activeProfileName,
          model: '',
          gateway: '',
          alias: '',
          ...(meta.displayLabel ? { displayLabel: meta.displayLabel } : {}),
          ...(meta.kind ? { kind: meta.kind } : {}),
          ...(meta.ownerOpenId ? { ownerOpenId: meta.ownerOpenId } : {}),
          ...(meta.agentId ? { agentId: meta.agentId } : {}),
        })),
      }
      return
    }

    const profiles = await hermesCli.listProfiles()

    // Override active flag from the authoritative source (active_profile file)
    // CLI output may be stale, but the file is written by hermes profile use
    const { getActiveProfileName } = await import('../../services/hermes/hermes-profile')
    const activeProfileName = getActiveProfileName()

    // Check if CLI's active flag matches the file (warn if inconsistent)
    const cliActive = profiles.find(p => p.active)
    if (cliActive?.name !== activeProfileName) {
      logger.warn('[listProfiles] CLI active flag (%s) differs from active_profile file (%s) - using file as authoritative source',
        cliActive?.name || 'none', activeProfileName)
    }

    // Fix the active flag based on the actual active_profile file
    profiles.forEach(p => {
      p.active = (p.name === activeProfileName)
    })

    ctx.body = { profiles: profiles.map(profile => withProfileAvatar(profile)) }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function create(ctx: any) {
  const { name, clone, description } = ctx.request.body as { name?: string; clone?: boolean; description?: string }
  if (!name) {
    ctx.status = 400
    ctx.body = { error: 'Missing profile name' }
    return
  }
  try {
    const user = ctx.state?.user as { openid?: string; profile?: string } | undefined
    const userMode = config.webPlane === 'chat' && !!user?.openid
    const normalizedDescription = typeof description === 'string' ? description.trim() || undefined : undefined
    const cloneFrom = userMode && clone ? user?.profile?.trim() : undefined
    if (userMode && clone && !cloneFrom) {
      ctx.status = 400
      ctx.body = { error: 'Cannot clone profile without a trusted source profile' }
      return
    }
    const createOptions: {
      clone: boolean
      cloneFrom?: string
      description?: string
      noAlias: boolean
    } = {
      clone: !!clone,
      description: normalizedDescription,
      noAlias: userMode,
    }
    if (cloneFrom) createOptions.cloneFrom = cloneFrom
    const output = await hermesCli.createProfile(name, createOptions)

    // clone=true 时执行智能清理：
    //   - 删除 .env 中的独占平台凭据（Weixin / Telegram / Slack / ...）
    //   - 禁用 config.yaml 中对应的平台节点
    // 避免新 profile 与源 profile 共享同一个 bot token 导致互斥冲突。
    let strippedCredentials: string[] = []
    let disabledPlatforms: string[] = []
    let strippedConfigCredentials: string[] = []
    if (clone) {
      try {
        const cleanup = smartCloneCleanup(name)
        strippedCredentials = cleanup.strippedCredentials
        disabledPlatforms = cleanup.disabledPlatforms
        strippedConfigCredentials = cleanup.strippedConfigCredentials
        if (
          strippedCredentials.length > 0 ||
          disabledPlatforms.length > 0 ||
          strippedConfigCredentials.length > 0
        ) {
          logger.info(
            'Smart clone cleanup for "%s": stripped %d env credentials (%s), disabled %d platforms (%s), stripped %d config credentials (%s)',
            name,
            strippedCredentials.length, strippedCredentials.join(','),
            disabledPlatforms.length, disabledPlatforms.join(','),
            strippedConfigCredentials.length, strippedConfigCredentials.join(','),
          )
        }
      } catch (err: any) {
        // 清理失败不应阻断 profile 创建，仅记日志
        logger.error(err, 'Smart clone cleanup failed for "%s"', name)
      }
    }

    const mgr = getGatewayManagerInstance()
    if (mgr) {
      try { await mgr.start(name) } catch (err: any) {
        logger.error(err, 'Failed to start gateway for profile "%s"', name)
      }
    }
    if (userMode && user?.openid) {
      const provisioned = await provisionOwnedProfileViaBroker({
        ownerOpenId: user.openid,
        profileName: name,
        upstreamProfile: user.profile,
        displayLabel: name,
        description: normalizedDescription,
      })
      if (!provisioned) {
        registerOwnedProfile(user.openid, name, user.profile)
      }
    }

    await injectBundledSkillsForProfile(name)

    ctx.body = {
      success: true,
      message: output.trim(),
      strippedCredentials,
      disabledPlatforms,
      strippedConfigCredentials,
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function get(ctx: any) {
  try {
    const profile = await hermesCli.getProfile(ctx.params.name)
    ctx.body = { profile: withProfileAvatar(profile) }
  } catch (err: any) {
    ctx.status = err.message.includes('not found') ? 404 : 500
    ctx.body = { error: err.message }
  }
}

export async function updateAvatar(ctx: any) {
  const name = String(ctx.params.name || '').trim() || 'default'
  if (!ensureCanWriteProfileMetadata(ctx, name)) return
  const body = ctx.request.body as { type?: string; seed?: string; dataUrl?: string }
  try {
    const dir = profileMetadataDir(name)
    await mkdir(dir, { recursive: true })
    const updatedAt = Date.now()

    if (body.type === 'generated') {
      const seed = String(body.seed || name).trim() || name
      const meta: ProfileAvatarMeta = { type: 'generated', seed, updatedAt }
      rmSync(profileAvatarImagePath(name), { force: true })
      await writeFile(profileAvatarMetaPath(name), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 })
      ctx.body = { avatar: readProfileAvatar(name) }
      return
    }

    if (body.type === 'image' && typeof body.dataUrl === 'string') {
      const { mime, buffer } = parseAvatarDataUrl(body.dataUrl)
      const meta: ProfileAvatarMeta = { type: 'image', file: 'avatar.bin', mime, updatedAt }
      await writeFile(profileAvatarImagePath(name), buffer, { mode: 0o600 })
      await writeFile(profileAvatarMetaPath(name), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 })
      ctx.body = { avatar: readProfileAvatar(name) }
      return
    }

    ctx.status = 400
    ctx.body = { error: 'Invalid avatar payload' }
  } catch (err: any) {
    ctx.status = 400
    ctx.body = { error: err.message }
  }
}

export async function deleteAvatar(ctx: any) {
  const name = String(ctx.params.name || '').trim() || 'default'
  if (!ensureCanWriteProfileMetadata(ctx, name)) return
  rmSync(profileMetadataDir(name), { recursive: true, force: true })
  ctx.body = { success: true }
}

export async function remove(ctx: any) {
  const { name } = ctx.params
  if (name === 'default') {
    ctx.status = 400
    ctx.body = { error: 'Cannot delete the default profile' }
    return
  }
  try {
    const mgr = getGatewayManagerInstance()
    if (mgr) { try { await mgr.stop(name) } catch { } }
    const ok = await hermesCli.deleteProfile(name)
    if (ok) {
      ctx.body = { success: true }
    } else {
      ctx.status = 500
      ctx.body = { error: 'Failed to delete profile' }
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function rename(ctx: any) {
  const { new_name } = ctx.request.body as { new_name?: string }
  if (!new_name) {
    ctx.status = 400
    ctx.body = { error: 'Missing new_name' }
    return
  }
  try {
    const ok = await hermesCli.renameProfile(ctx.params.name, new_name)
    if (ok) {
      ctx.body = { success: true }
    } else {
      ctx.status = 500
      ctx.body = { error: 'Failed to rename profile' }
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function switchProfile(ctx: any) {
  const { name } = ctx.request.body as { name?: string }
  if (!name) {
    ctx.status = 400
    ctx.body = { error: 'Missing profile name' }
    return
  }
  try {
    const output = await hermesCli.useProfile(name)

    // Verify the active_profile file immediately (Hermes CLI writes synchronously)
    // Quick verification with 2 retries to handle edge cases (filesystem delays, concurrency)
    const { getActiveProfileName } = await import('../../services/hermes/hermes-profile')
    let actualActive = getActiveProfileName()

    // Quick retry (max 2 times, 100ms delay each)
    for (let i = 0; i < 2; i++) {
      if (actualActive === name) break
      logger.debug('[switchProfile] Quick retry %d: current=%s, expected=%s', i + 1, actualActive, name)
      await new Promise(r => setTimeout(r, 100))
      actualActive = getActiveProfileName()
    }

    if (actualActive !== name) {
      logger.error('[switchProfile] Verification failed: active_profile is %s (expected %s)', actualActive, name)
      ctx.status = 500
      ctx.body = { error: `Profile switch verification failed - active profile is ${actualActive}` }
      return
    }

    // Update GatewayManager to match the authoritative source
    const mgr = getGatewayManagerInstance()
    if (mgr) { mgr.setActiveProfile(name) }

    try {
      const detail = await hermesCli.getProfile(name)
      logger.debug('Profile detail.path = %s', detail.path)
      if (!existsSync(join(detail.path, 'config.yaml'))) {
        try { await hermesCli.setupReset() } catch { }
      }
      const profileEnv = join(detail.path, '.env')
      if (!existsSync(profileEnv)) {
        writeFileSync(profileEnv, '# Hermes Agent Environment Configuration\n', 'utf-8')
        logger.info('Created .env for: %s', detail.path)
      }
    } catch (err: any) {
      logger.error(err, 'Ensure config failed')
    }

    await injectBundledSkillsForProfile(name)

    const drainResult = await SessionDeleter.getInstance().drain(name)
    SessionDeleter.getInstance().switchProfile(name)
    logger.info('[switchProfile] drain result for profile "%s": %d deleted, %d failed', name, drainResult.deleted.length, drainResult.failed.length)
    if (drainResult.failed.length > 0) {
      logger.warn({ profile: name, failed: drainResult.failed }, 'Failed to drain some pending session deletes after profile switch')
    }

    ctx.body = {
      success: true,
      message: output.trim(),
      drained_session_deletes: drainResult.deleted.length,
      failed_session_deletes: drainResult.failed.length,
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function exportProfile(ctx: any) {
  const { name } = ctx.params
  const outputPath = join(tmpdir(), `hermes-profile-${name}.tar.gz`)
  try {
    await hermesCli.exportProfile(name, outputPath)
    if (!existsSync(outputPath)) {
      ctx.status = 500
      ctx.body = { error: 'Export file not found' }
      return
    }
    const filename = basename(outputPath)
    ctx.set('Content-Disposition', `attachment; filename="${filename}"`)
    ctx.set('Content-Type', 'application/gzip')
    ctx.body = createReadStream(outputPath)
    ctx.res.on('finish', () => { try { unlinkSync(outputPath) } catch { } })
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function importProfile(ctx: any) {
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400
    ctx.body = { error: 'Expected multipart/form-data' }
    return
  }

  const declaredLen = parseInt(ctx.get('content-length') || '0', 10)
  if (declaredLen > MAX_PROFILE_IMPORT_SIZE) {
    ctx.status = 413
    ctx.body = { error: `Profile archive too large (max ${MAX_PROFILE_IMPORT_SIZE / 1024 / 1024}MB)` }
    return
  }

  const tmpDir = join(tmpdir(), 'hermes-import')
  await mkdir(tmpDir, { recursive: true })

  let archivePath = ''
  let limitExceeded = false
  let unsupportedExt = false
  let timedOut = false

  const abortTimer = setTimeout(() => {
    timedOut = true
    try { ctx.req.destroy(new Error('Profile import deadline exceeded')) } catch { /* socket already gone */ }
  }, PROFILE_IMPORT_TIMEOUT_MS)

  const bb = busboy({
    headers: ctx.req.headers,
    limits: { fileSize: MAX_PROFILE_IMPORT_SIZE, files: 1, fieldSize: 1024 * 64 },
  })

  const done = new Promise<void>((resolve, reject) => {
    bb.on('file', async (_field, fileStream, info) => {
      try {
        const original = info.filename || 'archive'
        const ext = extname(original).toLowerCase()
        if (!ALLOWED_PROFILE_IMPORT_EXTS.has(ext)) {
          unsupportedExt = true
          fileStream.resume()
          return
        }
        // SECURITY: ignore the user-supplied filename for the filesystem path.
        // Random hex + allow-listed extension means a crafted "../../etc/x.gz"
        // cannot escape tmpDir.
        const safeName = randomBytes(16).toString('hex') + ext
        archivePath = join(tmpDir, safeName)
        fileStream.on('limit', () => { limitExceeded = true })
        await pipeline(fileStream, createWriteStream(archivePath))
      } catch (err) {
        reject(err)
      }
    })
    bb.on('error', err => reject(err))
    bb.on('close', () => resolve())
    bb.on('finish', () => resolve())
  })

  try {
    ctx.req.pipe(bb)
    await done
  } catch (err) {
    clearTimeout(abortTimer)
    if (archivePath) { try { await unlink(archivePath) } catch { /* best-effort */ } }
    if (timedOut) { ctx.status = 408; ctx.body = { error: 'Upload timed out' }; return }
    throw err
  }
  clearTimeout(abortTimer)

  if (limitExceeded) {
    if (archivePath) { try { await unlink(archivePath) } catch { /* best-effort */ } }
    ctx.status = 413
    ctx.body = { error: `Profile archive too large (max ${MAX_PROFILE_IMPORT_SIZE / 1024 / 1024}MB)` }
    return
  }
  if (unsupportedExt || !archivePath) {
    ctx.status = 400
    ctx.body = { error: 'No archive file found (.gz, .zip, .tgz)' }
    return
  }
  try {
    const result = await hermesCli.importProfile(archivePath)
    try { unlinkSync(archivePath) } catch { }
    ctx.body = { success: true, message: result.trim() }
  } catch (err: any) {
    try { unlinkSync(archivePath) } catch { }
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}
