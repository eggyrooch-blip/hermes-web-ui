import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/cowork'

export const coworkRoutes = new Router()

coworkRoutes.get('/api/hermes/cowork/projects', ctrl.listProjects)
coworkRoutes.post('/api/hermes/cowork/projects', ctrl.createProject)
coworkRoutes.get('/api/hermes/cowork/projects/:projectId', ctrl.getProject)
coworkRoutes.patch('/api/hermes/cowork/projects/:projectId', ctrl.updateProject)
coworkRoutes.delete('/api/hermes/cowork/projects/:projectId', ctrl.archiveProject)
coworkRoutes.get('/api/hermes/cowork/projects/:projectId/sessions', ctrl.listProjectSessions)
coworkRoutes.get('/api/hermes/cowork/sessions/:sessionId/project', ctrl.getSessionProject)
