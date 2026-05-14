import { describe, expect, it } from 'vitest'
import {
  getFeishuCallbackRedirect,
  getJobsBrokerEnabled,
  getListenHost,
  getRunBrokerKey,
  getRunBrokerUrl,
} from '../../packages/server/src/config'

describe('server config', () => {
  it('defaults to an IPv4 bind host', () => {
    expect(getListenHost({})).toBe('0.0.0.0')
  })

  it('uses BIND_HOST when provided', () => {
    expect(getListenHost({ BIND_HOST: ' :: ' })).toBe('::')
  })

  it('ignores blank BIND_HOST values', () => {
    expect(getListenHost({ BIND_HOST: ' ' })).toBe('0.0.0.0')
  })

  it('defaults Feishu OAuth callbacks to the chat route', () => {
    expect(getFeishuCallbackRedirect({})).toBe('/#/hermes/chat')
  })

  it('uses FEISHU_CALLBACK_REDIRECT when provided', () => {
    expect(getFeishuCallbackRedirect({ FEISHU_CALLBACK_REDIRECT: '/#/custom' })).toBe('/#/custom')
  })

  it('normalizes Run Broker URL values', () => {
    expect(getRunBrokerUrl({ HERMES_RUN_BROKER_URL: ' http://127.0.0.1:8766/// ' })).toBe('http://127.0.0.1:8766')
  })

  it('reads Run Broker shared secret values', () => {
    expect(getRunBrokerKey({ HERMES_RUN_BROKER_KEY: ' broker-secret ' })).toBe('broker-secret')
  })

  it('defaults jobs broker mode to the WebUI Run Broker switch', () => {
    expect(getJobsBrokerEnabled({ HERMES_WEBUI_RUN_BROKER: '1' })).toBe(true)
    expect(getJobsBrokerEnabled({ HERMES_WEBUI_RUN_BROKER: '0' })).toBe(false)
  })

  it('allows jobs broker mode to be controlled independently', () => {
    expect(getJobsBrokerEnabled({
      HERMES_WEBUI_RUN_BROKER: '1',
      HERMES_WEBUI_JOBS_BROKER: '0',
    })).toBe(false)
    expect(getJobsBrokerEnabled({
      HERMES_WEBUI_RUN_BROKER: '0',
      HERMES_WEBUI_JOBS_BROKER: 'true',
    })).toBe(true)
  })
})
