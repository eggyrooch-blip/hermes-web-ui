import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/slash'

export const slashRoutes = new Router()

slashRoutes.get('/api/hermes/slash/commands', ctrl.listSlashCommands)
