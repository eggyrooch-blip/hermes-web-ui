import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/gitlab-credential'

export const gitlabCredentialRoutes = new Router()

gitlabCredentialRoutes.post('/api/hermes/credentials/gitlab', ctrl.submitGitlabToken)
