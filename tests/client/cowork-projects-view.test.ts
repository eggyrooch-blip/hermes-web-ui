// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const router = { push: vi.fn(), replace: vi.fn() }
const route = { params: { projectId: 'project-a' }, query: { profile: 'research' } }
const chatStore = {
  newChat: vi.fn(() => ({ id: 'session-new', profile: 'research' })),
  setSessionProject: vi.fn(),
}

vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => router }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => ({ activeProfileName: 'research' }) }))
vi.mock('@/stores/hermes/chat', () => ({ useChatStore: () => chatStore }))
vi.mock('naive-ui', () => ({
  NButton: defineComponent({ emits: ['click'], template: '<button @click="$emit(\'click\')"><slot /></button>' }),
  NEmpty: defineComponent({ props: ['description'], template: '<p class="empty">{{ description }}</p>' }),
  NInput: defineComponent({ inheritAttrs: false, props: ['value'], emits: ['update:value'], template: '<input :value="value" />' }),
  NSpin: defineComponent({ template: '<div><slot /></div>' }),
  useMessage: () => ({ error: vi.fn(), success: vi.fn() }),
}))
vi.mock('@/api/hermes/cowork', () => ({
  archiveCoworkProject: vi.fn(),
  getCoworkProject: vi.fn(),
  listCoworkProjectSessions: vi.fn(),
  listCoworkProjects: vi.fn(),
  updateCoworkProject: vi.fn(),
}))
vi.mock('@/api/hermes/sessions', () => ({ fetchHermesSession: vi.fn() }))

import CoworkProjectsView from '@/views/hermes/CoworkProjectsView.vue'
import { getCoworkProject, listCoworkProjectSessions, listCoworkProjects } from '@/api/hermes/cowork'
import { fetchHermesSession } from '@/api/hermes/sessions'

const project = {
  id: 'project-a', name: 'Alpha', description: 'Quarterly work', instructions: 'Use concise tables.',
  icon: 'A', color: '#5b67f1', primary_folder: 'reports/alpha', status: 'active', created_at: 1, updated_at: 1,
}

describe('CoworkProjectsView', () => {
  beforeEach(() => {
    route.params.projectId = 'project-a'
    route.query.profile = 'research'
    router.push.mockReset()
    router.replace.mockReset()
    chatStore.newChat.mockClear()
    chatStore.setSessionProject.mockClear()
    vi.mocked(fetchHermesSession).mockReset()
    vi.mocked(listCoworkProjects).mockResolvedValue([project] as any)
    vi.mocked(getCoworkProject).mockResolvedValue(project as any)
    vi.mocked(listCoworkProjectSessions).mockResolvedValue([{ session_id: 'session-a', created_at: 20 }])
    vi.mocked(fetchHermesSession).mockResolvedValue({
      id: 'session-a', title: 'Prepare Alpha brief', profile: 'research', source: 'cli', model: 'test',
      started_at: 10, ended_at: null, message_count: 2, tool_call_count: 0, input_tokens: 0,
      output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
      billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null, cost_status: 'ok',
      messages: [{
        id: 1, session_id: 'session-a', role: 'assistant', content: 'Done\nMEDIA:/tmp/workspace/reports/alpha-brief.md',
        tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 15, token_count: null,
        finish_reason: 'stop', reasoning: null,
      }],
    } as any)
  })

  it('keeps the current profile when selecting the first Project', async () => {
    route.params.projectId = ''
    mount(CoworkProjectsView)
    await flushPromises()

    expect(router.replace).toHaveBeenCalledWith({
      name: 'hermes.coworkProject',
      params: { projectId: 'project-a' },
      query: { profile: 'research' },
    })
  })

  it('renders authoritative Project tasks and persisted artifacts', async () => {
    const wrapper = mount(CoworkProjectsView)
    await flushPromises()
    await flushPromises()

    expect(wrapper.get('.project-task').text()).toContain('Prepare Alpha brief')
    expect(wrapper.get('.project-artifact').text()).toContain('alpha-brief.md')
    expect(wrapper.text()).not.toContain('/tmp/workspace')

    await wrapper.get('.project-task').trigger('click')
    expect(router.push).toHaveBeenCalledWith({
      name: 'hermes.session', params: { sessionId: 'session-a' }, query: { profile: 'research' },
    })
  })

  it('keeps the current profile when opening a Project from the manager', async () => {
    const wrapper = mount(CoworkProjectsView)
    await flushPromises()

    await wrapper.get('.project-row').trigger('click')

    expect(router.push).toHaveBeenCalledWith({
      name: 'hermes.coworkProject',
      params: { projectId: 'project-a' },
      query: { profile: 'research' },
    })
  })

  it('does not block Project context while a new task has no readable session yet', async () => {
    vi.mocked(fetchHermesSession).mockReturnValue(new Promise(() => {}))

    const wrapper = mount(CoworkProjectsView)
    await flushPromises()

    expect(wrapper.findAll('input').some(input => input.attributes('value') === 'Quarterly work')).toBe(true)
    expect(wrapper.get('.project-task').text()).toContain('session-a')
  })

  it('always starts a fresh Project task', async () => {
    const wrapper = mount(CoworkProjectsView)
    await flushPromises()

    await wrapper.get('.header-actions button').trigger('click')

    expect(chatStore.newChat).toHaveBeenCalledWith({ profile: 'research', source: 'cli', agent: 'hermes' })
    expect(chatStore.setSessionProject).toHaveBeenCalledWith('session-new', project)
    expect(router.push).toHaveBeenCalledWith({
      name: 'hermes.session', params: { sessionId: 'session-new' }, query: { profile: 'research' },
    })
  })

  it('deduplicates a new task while navigation is in flight', async () => {
    let finishNavigation!: () => void
    router.push.mockReturnValueOnce(new Promise<void>(resolve => { finishNavigation = resolve }))
    const wrapper = mount(CoworkProjectsView)
    await flushPromises()
    const button = wrapper.get('.header-actions button')

    await button.trigger('click')
    await button.trigger('click')

    expect(chatStore.newChat).toHaveBeenCalledTimes(1)
    expect(button.attributes('disabled')).toBeDefined()
    finishNavigation()
    await flushPromises()
  })

  it('renders an unknown date instead of crashing on an invalid timestamp', async () => {
    vi.mocked(listCoworkProjectSessions).mockResolvedValue([{ session_id: 'session-a', created_at: undefined } as any])

    const wrapper = mount(CoworkProjectsView)
    await flushPromises()

    expect(wrapper.get('.project-task small').text()).toBe('—')
  })

  it('bounds full Session hydration while keeping all task cards', async () => {
    vi.mocked(listCoworkProjectSessions).mockResolvedValue(Array.from({ length: 55 }, (_, index) => ({
      session_id: `session-${index}`,
      created_at: index + 1,
    })))

    const wrapper = mount(CoworkProjectsView)
    await flushPromises()
    await flushPromises()

    expect(wrapper.findAll('.project-task')).toHaveLength(55)
    expect(fetchHermesSession).toHaveBeenCalledTimes(50)
  })
})
