import Router from '@koa/router'
import { previewFeishuLinks } from '../../controllers/hermes/link-previews'

export const linkPreviewRoutes = new Router()

linkPreviewRoutes.post('/api/hermes/link-previews', previewFeishuLinks)
