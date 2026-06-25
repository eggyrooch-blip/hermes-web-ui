import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/experts'

export const expertRoutes = new Router()

expertRoutes.get('/api/hermes/experts', ctrl.list)
