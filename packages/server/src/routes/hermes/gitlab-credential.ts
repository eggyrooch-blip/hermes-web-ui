import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/gitlab-credential'

export const gitlabCredentialRoutes = new Router()

gitlabCredentialRoutes.post('/api/hermes/credentials/gitlab', ctrl.submitGitlabToken)
gitlabCredentialRoutes.post('/api/hermes/credentials/github', ctrl.submitGithubToken)
gitlabCredentialRoutes.delete('/api/hermes/credentials/github', ctrl.revokeGithubToken)
gitlabCredentialRoutes.delete('/api/hermes/credentials/figma', ctrl.revokeFigmaCredential)
