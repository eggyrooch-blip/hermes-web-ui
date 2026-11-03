import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/console'
import { requireConsoleAdmin, requireConsoleUser } from '../../middleware/console-auth'

/**
 * Console routes — two planes, each with its OWN guard on the route (design §8c
 * A1: the chat-plane blocklist does NOT cover /api/console/*, so authorization
 * must be per-route here, never inherited from a plane gate).
 */
export const consoleRoutes = new Router()

// Admin plane — full fleet, requires an admin union_id (else 404).
consoleRoutes.get('/api/console/overview', requireConsoleAdmin, ctrl.overview)
consoleRoutes.get('/api/console/profiles', requireConsoleAdmin, ctrl.profiles)
consoleRoutes.get('/api/console/profiles/:name', requireConsoleAdmin, ctrl.profileDetail)
consoleRoutes.get('/api/console/reauth-pending', requireConsoleAdmin, ctrl.reauthPending)

// Developer plane — any logged-in user, self-scoped to their own session.
consoleRoutes.get('/api/console/dev/me', requireConsoleUser, ctrl.devMe)
