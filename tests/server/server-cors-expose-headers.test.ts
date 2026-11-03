import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The client half of this deal is tests/client/download-origin-guard.test.ts: it
// rejects any download/preview/export response that arrives without a
// Content-Disposition header, because a WAF error page cannot produce one.
// Content-Disposition is not CORS-safelisted, so a cross-origin client only sees
// it if the server exposes it explicitly. Drop this line and every cross-origin
// download starts failing with "下载被拦截" (zhouyifei 2026-08-04).
describe('bootstrap CORS', () => {
  it('exposes Content-Disposition so cross-origin clients can verify file responses', () => {
    const source = readFileSync('packages/server/src/index.ts', 'utf8')

    expect(source).toMatch(/cors\(\{[\s\S]*exposeHeaders:\s*\[\s*'Content-Disposition'\s*\][\s\S]*\}\)/)
  })
})
