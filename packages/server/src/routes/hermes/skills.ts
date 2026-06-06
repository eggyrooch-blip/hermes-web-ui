import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/skills'

export const skillRoutes = new Router()

skillRoutes.get('/api/hermes/skills', ctrl.list)
skillRoutes.post('/api/hermes/skills/skillhub/install', ctrl.installFromSkillHub)
skillRoutes.put('/api/hermes/skills/toggle', ctrl.toggle)
skillRoutes.put('/api/hermes/skills/pin', ctrl.pin_)
skillRoutes.put('/api/hermes/skills/file', ctrl.updateFile_)
// Skills Usage stats — MUST be before the ':category/:skill' + '{*path}' catch-alls.
skillRoutes.get('/api/hermes/skills/usage/stats', ctrl.usageStats)
skillRoutes.get('/api/hermes/skills/:category/:skill/files', ctrl.listFiles)
skillRoutes.get('/api/hermes/skills/{*path}', ctrl.readFile_)
