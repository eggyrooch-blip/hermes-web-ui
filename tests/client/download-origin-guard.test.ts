// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// zhouyifei 2026-08-04: off-VPN DNS sent /api/hermes/download to the public Keep
// WAF, which 302'd to www.gotokeep.com and answered 200 + ACAO. `res.ok` was true,
// so the client saved 118 KB of marketing HTML under the user's .xlsx name.
// These tests pin the rule: bytes that did not come from Hermes never reach disk.
//
// Two deployment shapes are covered: SAME-ORIGIN (prod webui, base URL '') and a
// CROSS-ORIGIN backend (custom server URL). Content-Disposition is not
// CORS-safelisted, so the server exposes it explicitly (index.ts cors
// exposeHeaders) and the client can demand it in BOTH shapes — see
// server-cors-expose-headers.test.ts, which pins the server half of that deal.
const state = vi.hoisted(() => ({ baseUrl: '' }))

vi.mock('@/api/client', () => ({
  request: vi.fn(),
  getApiKey: () => 'test-token',
  getBaseUrlValue: () => state.baseUrl,
  getActiveProfileName: () => null,
}))

import { downloadFile, fetchFileText, isForeignResponse } from '@/api/hermes/download'
import { exportSession } from '@/api/hermes/sessions'

const PAGE = 'http://localhost:3000'
const REMOTE_BACKEND = 'https://hermes.example.com'
const XLSX_NAME = '整理结果.xlsx'
const DISPOSITION = `attachment; filename="${encodeURIComponent(XLSX_NAME)}"; filename*=UTF-8''${encodeURIComponent(XLSX_NAME)}`

type FakeInit = { url?: string; redirected?: boolean; headers?: Record<string, string>; body?: string }

function fakeResponse(init: FakeInit): Response {
  const body = init.body ?? 'payload'
  return {
    ok: true,
    status: 200,
    url: init.url ?? `${PAGE}/api/hermes/download?path=x`,
    redirected: init.redirected ?? false,
    headers: new Headers(init.headers ?? { 'Content-Disposition': DISPOSITION }),
    blob: async () => new Blob([body]),
    text: async () => body,
    json: async () => ({}),
  } as unknown as Response
}

/** The exact shape of the incident: 302 to the marketing site, HTML, no disposition. */
function hijackedResponse(): Response {
  return fakeResponse({
    url: 'https://www.gotokeep.com/?path=x.xlsx',
    redirected: true,
    headers: { 'Content-Type': 'text/html' },
    body: '<!DOCTYPE html><html lang="zh-Hans"><head><title>Keep</title>',
  })
}

let downloadedNames: string[]
let savedObjectUrl: [typeof URL.createObjectURL, typeof URL.revokeObjectURL]

beforeEach(() => {
  state.baseUrl = ''
  downloadedNames = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloadedNames.push(this.download)
  })
  // jsdom ships no object-URL support.
  savedObjectUrl = [URL.createObjectURL, URL.revokeObjectURL]
  URL.createObjectURL = () => 'blob:mock'
  URL.revokeObjectURL = () => {}
})

afterEach(() => {
  ;[URL.createObjectURL, URL.revokeObjectURL] = savedObjectUrl
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('isForeignResponse — same-origin backend (prod webui)', () => {
  it('flags a cross-origin redirect (the WAF hijack)', () => {
    expect(isForeignResponse(hijackedResponse())).toBe(true)
  })

  it('flags a response that lost the server Content-Disposition', () => {
    expect(isForeignResponse(fakeResponse({ headers: { 'Content-Type': 'text/html' } }))).toBe(true)
  })

  it('flags a cross-origin response even without the redirected flag', () => {
    expect(
      isForeignResponse(fakeResponse({ url: 'https://www.gotokeep.com/x' })),
    ).toBe(true)
  })

  it('accepts a genuine same-origin Hermes response', () => {
    expect(isForeignResponse(fakeResponse({}))).toBe(false)
  })
})

// Codex review, round 1 then round 2: Content-Disposition is not CORS-safelisted,
// so a cross-origin backend used to hide it — but treating "unreadable" as
// acceptable is fail-open (a WAF parked on the backend origin answers 200 HTML
// with no redirect). Resolution: the server exposes the header (cors
// exposeHeaders) and the client requires it unconditionally.
describe('isForeignResponse — cross-origin backend (custom server URL)', () => {
  beforeEach(() => {
    state.baseUrl = REMOTE_BACKEND
  })

  it('accepts a genuine response that exposes Content-Disposition', () => {
    expect(
      isForeignResponse(fakeResponse({ url: `${REMOTE_BACKEND}/api/hermes/download?path=x` })),
    ).toBe(false)
  })

  it('rejects a no-redirect 200 from the backend origin with no Content-Disposition (WAF on the backend)', () => {
    expect(
      isForeignResponse(
        fakeResponse({
          url: `${REMOTE_BACKEND}/api/hermes/download?path=x`,
          headers: { 'Content-Type': 'text/html' },
          body: '<!DOCTYPE html><title>Keep</title>',
        }),
      ),
    ).toBe(true)
  })

  it('still flags the hijack, which lands on neither the page nor the backend origin', () => {
    expect(isForeignResponse(hijackedResponse())).toBe(true)
  })
})

describe('downloadFile', () => {
  it('refuses hijacked bytes and writes nothing to disk', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => hijackedResponse()))
    await expect(downloadFile('Downloads/K5pro.xlsx', 'K5pro.xlsx')).rejects.toThrow('下载被拦截')
    expect(downloadedNames).toEqual([])
  })

  // Codex review #p1: `url !== filePath` let an ABSOLUTE Hermes download URL look
  // like a remote passthrough and skip the guard. MessageItem hands ContentBlock
  // paths straight to downloadFile, so this entry point is real.
  it('guards an absolute Hermes download URL, not just relative paths', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => hijackedResponse()))
    await expect(
      downloadFile(`${PAGE}/api/hermes/download?path=Downloads/K5pro.xlsx`, 'K5pro.xlsx'),
    ).rejects.toThrow('下载被拦截')
    expect(downloadedNames).toEqual([])
  })

  it("saves under the server's Content-Disposition name, not the requested one", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({})))
    await downloadFile('Downloads/whatever-we-asked-for.xlsx', 'whatever-we-asked-for.xlsx')
    expect(downloadedNames).toEqual([XLSX_NAME])
  })

  it('falls back to the inferred name when the server sends no filename', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ headers: { 'Content-Disposition': 'attachment' } })))
    await downloadFile('Downloads/poster.jpg', 'poster.jpg')
    expect(downloadedNames).toEqual(['poster.jpg'])
  })

  // Regression: remote CDN/VOD URLs are cross-origin BY DESIGN (chenggaowei
  // 2026-06-08 broken images). getDownloadUrl passes them through untouched, so
  // the origin guard must not fire on them.
  it('leaves the remote-URL passthrough unguarded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({ url: 'https://251000800.vod2.myqcloud.com/a/img.jpg', headers: {} }),
      ),
    )
    await downloadFile('https://251000800.vod2.myqcloud.com/a/img.jpg', 'img.jpg')
    expect(downloadedNames).toEqual(['img.jpg'])
  })

  it('downloads normally from a cross-origin backend that exposes the disposition', async () => {
    state.baseUrl = REMOTE_BACKEND
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse({ url: `${REMOTE_BACKEND}/api/hermes/download?path=x` })),
    )
    await downloadFile('Downloads/report.xlsx', 'report.xlsx')
    expect(downloadedNames).toEqual([XLSX_NAME])
  })

  // Codex review round 2: hardcoding pathname === '/api/hermes/download' let a
  // path-prefixed base URL generate URLs the guard did not recognise as its own.
  it('guards its own URLs when the base URL carries a path prefix', async () => {
    state.baseUrl = `${REMOTE_BACKEND}/hermes`
    vi.stubGlobal('fetch', vi.fn(async () => hijackedResponse()))
    await expect(downloadFile('Downloads/report.xlsx', 'report.xlsx')).rejects.toThrow('下载被拦截')
    expect(downloadedNames).toEqual([])
  })

  it('guards an absolute URL with a trailing slash or odd casing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => hijackedResponse()))
    await expect(
      downloadFile(`${PAGE}/API/hermes/download/?path=Downloads/x.xlsx`, 'x.xlsx'),
    ).rejects.toThrow('下载被拦截')
    expect(downloadedNames).toEqual([])
  })
})

describe('fetchFileText (preview)', () => {
  it('refuses to render hijacked HTML as file content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => hijackedResponse()))
    await expect(fetchFileText('Downloads/notes.md', 'notes.md')).rejects.toThrow('预览被拦截')
  })

  it('guards an absolute Hermes preview URL too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => hijackedResponse()))
    await expect(
      fetchFileText(`${PAGE}/api/hermes/download?path=Downloads/notes.md`, 'notes.md'),
    ).rejects.toThrow('预览被拦截')
  })

  it('returns genuine Hermes content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ body: '# 报告' })))
    await expect(fetchFileText('Downloads/notes.md', 'notes.md')).resolves.toBe('# 报告')
  })
})

describe('exportSession', () => {
  it('refuses hijacked bytes and writes nothing to disk', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => hijackedResponse()))
    await expect(exportSession('sess-1')).rejects.toThrow('导出被拦截')
    expect(downloadedNames).toEqual([])
  })

  it('exports a genuine response under the server filename', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({
          url: `${PAGE}/api/hermes/sessions/sess-1/export`,
          headers: { 'Content-Disposition': `attachment; filename="${encodeURIComponent('会话.json')}"` },
        }),
      ),
    )
    await exportSession('sess-1')
    expect(downloadedNames).toEqual(['会话.json'])
  })
})
