import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/agents'

export const agentRoutes = new Router()

agentRoutes.get('/api/hermes/agents/shared', ctrl.listSharedAgents)
agentRoutes.get('/api/hermes/agents/:agentId/shares', ctrl.listShares)
agentRoutes.post('/api/hermes/agents/:agentId/shares', ctrl.grantShare)
agentRoutes.delete('/api/hermes/agents/:agentId/shares/:granteeOpenId', ctrl.revokeShare)
