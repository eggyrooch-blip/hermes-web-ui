// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

vi.mock('naive-ui', () => ({
  NAlert: { props: ['type'], template: '<div class="alert"><slot /></div>' },
  NButton: {
    props: ['disabled', 'type'],
    emits: ['click'],
    template: '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  NDataTable: {
    props: ['columns', 'data'],
    template: '<div class="table" :data-rows="data.length" :data-cols="columns.length" />',
  },
  NSpin: { props: ['show'], template: '<div class="spin"><slot /></div>' },
}))

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: { data: any }) => void) | null = null
  onerror: ((event: any) => void) | null = null
  sent: any[] = []
  terminated = false

  constructor(_url: URL, _options?: WorkerOptions) { FakeWorker.instances.push(this) }
  postMessage(message: any, _transfer?: any[]) { this.sent.push(message) }
  terminate() { this.terminated = true }
  reply(data: any) { this.onmessage?.({ data }) }
}

import SpreadsheetFilePreview from '@/components/hermes/files/SpreadsheetFilePreview.vue'

function cellsOf(wrapper: any): string[][] {
  return (wrapper.vm as any).$?.setupState?.rows ?? []
}

describe('SpreadsheetFilePreview', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    ;(globalThis as any).Worker = FakeWorker
    vi.clearAllMocks()
  })

  it('ignores a stale sheet reply that lands after a newer one', async () => {
    // Clicking Summary -> Detail leaves two parses in flight. Without a request
    // id the slower reply wins simply by arriving last, and the table shows the
    // sheet the user moved off while the tab still says Detail.
    const wrapper = mount(SpreadsheetFilePreview, { props: { data: new Uint8Array([1, 2, 3]).buffer } })
    const worker = FakeWorker.instances[0]
    expect(worker).toBeTruthy()

    const openRequest = worker.sent[0]
    expect(openRequest.type).toBe('open')
    worker.reply({
      type: 'loaded',
      requestId: openRequest.requestId,
      sheetNames: ['Summary', 'Detail'],
      activeSheet: 'Summary',
      rows: [['Region']],
      truncated: false,
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Summary')

    const sheetButtons = wrapper.findAll('.sheet-tabs button')
    await sheetButtons[1].trigger('click')
    const detailRequest = worker.sent[worker.sent.length - 1]
    expect(detailRequest).toMatchObject({ type: 'sheet', sheet: 'Detail' })

    // A reply carrying the FIRST request's id arrives after the Detail request
    // was issued. It is stale and must be dropped.
    worker.reply({
      type: 'sheet',
      requestId: openRequest.requestId,
      activeSheet: 'Summary',
      rows: [['stale']],
      truncated: false,
    })
    await wrapper.vm.$nextTick()
    expect(cellsOf(wrapper)).not.toEqual([['stale']])

    worker.reply({
      type: 'sheet',
      requestId: detailRequest.requestId,
      activeSheet: 'Detail',
      rows: [['Id', 'Note']],
      truncated: false,
    })
    await wrapper.vm.$nextTick()
    expect(cellsOf(wrapper)).toEqual([['Id', 'Note']])
    wrapper.unmount()
  })

  it('does not queue a second parse while one is already running', async () => {
    const wrapper = mount(SpreadsheetFilePreview, { props: { data: new Uint8Array([1, 2, 3]).buffer } })
    const worker = FakeWorker.instances[0]
    worker.reply({
      type: 'loaded',
      requestId: worker.sent[0].requestId,
      sheetNames: ['Summary', 'Detail'],
      activeSheet: 'Summary',
      rows: [['Region']],
      truncated: false,
    })
    await wrapper.vm.$nextTick()

    const sheetButtons = wrapper.findAll('.sheet-tabs button')
    await sheetButtons[1].trigger('click')
    const sentAfterFirstClick = worker.sent.length
    await sheetButtons[1].trigger('click')
    expect(worker.sent.length).toBe(sentAfterFirstClick)
    wrapper.unmount()
  })

  it('reports a worker error carrying the current request id', async () => {
    const errors: Error[] = []
    const wrapper = mount(SpreadsheetFilePreview, {
      props: { data: new Uint8Array([1, 2, 3]).buffer, onError: (error: Error) => errors.push(error) },
    })
    const worker = FakeWorker.instances[0]
    worker.reply({ type: 'error', requestId: worker.sent[0].requestId, error: 'Office archive is not safe to preview' })
    await wrapper.vm.$nextTick()
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toMatch(/not safe to preview/)
    wrapper.unmount()
  })
})
