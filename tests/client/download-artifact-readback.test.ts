// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'sunke',
  getApiKey: () => 'actor-token',
  getBaseUrlValue: () => 'https://hermes.example',
}))

import { parseArtifactPublication, readbackWorkspaceArtifact } from '@/api/hermes/download'

describe('workspace artifact user-entry readback', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it.each([undefined, '', '-1', '1e3', '0x10'])(
    'rejects a non-decimal publication byte count: %s',
    (bytes) => {
      const suffix = bytes === undefined ? '' : `&hermes_bytes=${bytes}`
      expect(parseArtifactPublication(`/workspace/report.txt?hermes_mime=text/plain${suffix}`).publication).toBeNull()
    },
  )

  it('completes only after the authenticated GET MIME and bytes match the publication', async () => {
    const cancelled = vi.fn()
    const response = new Response(new ReadableStream({
      pull() {
        throw new Error('readback must not consume the artifact body')
      },
      cancel() {
        cancelled()
      },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'Content-Length': '5',
        'Content-Disposition': "attachment; filename*=UTF-8''report.txt",
      },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)

    await expect(readbackWorkspaceArtifact('/workspace/report.txt', {
      mime: 'text/plain',
      bytes: 5,
    })).resolves.toEqual(expect.objectContaining({ complete: true }))
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(
      'path=%2Fworkspace%2Freport.txt&profile=sunke&token=actor-token',
    ))
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['404', new Response('missing', { status: 404 })],
    ['403', new Response('forbidden', { status: 403 })],
    ['MIME mismatch', new Response('hello', { status: 200, headers: {
      'Content-Type': 'text/html',
      'Content-Length': '5',
      'Content-Disposition': 'attachment; filename="report.txt"',
    } })],
    ['byte mismatch', new Response('hello!', { status: 200, headers: {
      'Content-Type': 'text/plain',
      'Content-Length': '6',
      'Content-Disposition': 'attachment; filename="report.txt"',
    } })],
  ])('does not complete after %s', async (_label, response) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    await expect(readbackWorkspaceArtifact('/workspace/report.txt', {
      mime: 'text/plain',
      bytes: 5,
    })).resolves.toEqual(expect.objectContaining({ complete: false }))
  })

  it('does not complete a zero-byte publication when Content-Length is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="empty.txt"',
      },
    }))

    await expect(readbackWorkspaceArtifact('/workspace/empty.txt', {
      mime: 'text/plain',
      bytes: 0,
    })).resolves.toEqual(expect.objectContaining({ complete: false, reason: 'bytes' }))
  })

  it('fails closed when the authenticated GET is redirected to a foreign workspace response', async () => {
    const response = new Response(null, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'Content-Length': '5',
        'Content-Disposition': 'attachment; filename="report.txt"',
      },
    })
    Object.defineProperties(response, {
      redirected: { value: true },
      url: { value: 'https://foreign.example/api/hermes/download?path=%2Fworkspace%2Freport.txt' },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)

    await expect(readbackWorkspaceArtifact('/workspace/report.txt', {
      mime: 'text/plain',
      bytes: 5,
    })).resolves.toEqual({ complete: false, reason: 'foreign' })
  })
})
