import type { Context, Next } from 'koa'
import { getRequestProfile, type WebUser } from '../services/request-context'

export type UserRole = WebUser['role']

export interface AuthenticatedUser extends WebUser {
  id: string | number
  username: string
  role: UserRole
  profiles?: string[]
}

export interface RequestProfile {
  name: string
}

declare module 'koa' {
  interface DefaultState {
    user?: WebUser | AuthenticatedUser
    profile?: RequestProfile
    serverTokenAuth?: boolean
  }
}

function normalizeRole(role: unknown): UserRole {
  return role === 'admin' ? 'admin' : 'user'
}

function uniqueProfiles(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map(value => value?.trim()).filter(Boolean) as string[]))
}

export function toAuthenticatedUser(user: Partial<WebUser & AuthenticatedUser>): AuthenticatedUser {
  const openid = typeof user.openid === 'string' ? user.openid : ''
  const username = typeof user.username === 'string' && user.username.trim()
    ? user.username.trim()
    : typeof user.name === 'string' && user.name.trim()
      ? user.name.trim()
      : openid || 'anonymous'
  const profile = typeof user.profile === 'string' ? user.profile : ''
  const existingProfiles = Array.isArray(user.profiles) ? user.profiles : []

  return {
    ...user,
    id: (user.id ?? openid) || username,
    username,
    role: normalizeRole(user.role),
    openid,
    profile,
    profiles: uniqueProfiles([...existingProfiles, profile]),
  }
}

export function resolveRequestedProfile(ctx: Context): string {
  return getRequestProfile(ctx).trim()
}

export async function populateHermesUserProfile(ctx: Context, next: Next): Promise<void> {
  if (ctx.state.user) {
    ctx.state.user = toAuthenticatedUser(ctx.state.user)
  }

  const profileName = resolveRequestedProfile(ctx)
  if (profileName) {
    ctx.state.profile = { name: profileName }
  }

  await next()
}

export async function requireUserProfile(ctx: Context, next: Next): Promise<void> {
  if (!ctx.state.profile?.name) {
    ctx.status = 400
    ctx.body = { error: 'Profile is required' }
    return
  }
  await next()
}

export const userAuthMiddleware = [populateHermesUserProfile]
