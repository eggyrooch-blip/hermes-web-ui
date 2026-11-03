// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'

const routeState = vi.hoisted(() => ({
  query: { board: 'project-a' } as Record<string, string>,
}))

const routerReplace = vi.hoisted(() => vi.fn())

const storeState = vi.hoisted(() => ({
  tasks: [] as Array<{ id: string; title: string; status: string; created_at: number; assignee?: string | null }>,
  stats: { by_status: { todo: 1, done: 0 }, by_assignee: {}, total: 1 } as Record<string, any>,
  assignees: [] as Array<{ name: string; counts: Record<string, number> | null }>,
  activeBoards: [] as Array<{ slug: string; name: string; icon?: string; total?: number }>,
  loading: false,
  boardsLoading: false,
  selectedBoard: 'default',
  boardWarning: null as string | null,
  capabilities: null as Record<string, any> | null,
  filterStatus: null as string | null,
  filterAssignee: null as string | null,
}))

const mockFetchBoards = vi.hoisted(() => vi.fn())
const mockFetchCapabilities = vi.hoisted(() => vi.fn())
const mockRefreshAll = vi.hoisted(() => vi.fn())
const mockFetchTasks = vi.hoisted(() => vi.fn())
const mockFetchStats = vi.hoisted(() => vi.fn())
const mockSetFilter = vi.hoisted(() => vi.fn())
const mockRecoverSelectedBoard = vi.hoisted(() => vi.fn())
const mockCreateBoard = vi.hoisted(() => vi.fn())
const mockArchiveSelectedBoard = vi.hoisted(() => vi.fn())
const mockDispatch = vi.hoisted(() => vi.fn())
const mockStartEventStream = vi.hoisted(() => vi.fn())
const mockStopEventStream = vi.hoisted(() => vi.fn())
const mockFetchProfiles = vi.hoisted(() => vi.fn())
const mockCompleteTasks = vi.hoisted(() => vi.fn())
const mockBlockTask = vi.hoisted(() => vi.fn())
const mockUnblockTasks = vi.hoisted(() => vi.fn())
const mockBulkUpdateTasks = vi.hoisted(() => vi.fn())
const mockMessage = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn() }))
const profilesState = vi.hoisted(() => ({
  profiles: [] as Array<{ name: string; avatar?: Record<string, any> | null }>,
}))

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({ replace: routerReplace }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/stores/hermes/kanban', () => ({
  DEFAULT_KANBAN_BOARD: 'default',
  useKanbanStore: () => ({
    ...storeState,
    fetchBoards: mockFetchBoards,
    fetchCapabilities: mockFetchCapabilities,
    refreshAll: mockRefreshAll,
    fetchTasks: mockFetchTasks,
    fetchStats: mockFetchStats,
    setFilter: mockSetFilter,
    recoverSelectedBoard: mockRecoverSelectedBoard,
    createBoard: mockCreateBoard,
    archiveSelectedBoard: mockArchiveSelectedBoard,
    dispatch: mockDispatch,
    startEventStream: mockStartEventStream,
    stopEventStream: mockStopEventStream,
    completeTasks: mockCompleteTasks,
    blockTask: mockBlockTask,
    unblockTasks: mockUnblockTasks,
    bulkUpdateTasks: mockBulkUpdateTasks,
  }),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({
    profiles: profilesState.profiles,
    fetchProfiles: mockFetchProfiles,
  }),
}))

vi.mock('@/components/hermes/kanban/KanbanTaskCard.vue', () => ({
  default: defineComponent({
    name: 'KanbanTaskCard',
    props: { task: { type: Object, required: true }, assigneeAvatar: { type: Object, required: false } },
    emits: ['click', 'dragStart', 'dragEnd'],
    template: '<div class="kanban-task-card-stub" :data-task-id="task.id" :data-avatar-seed="assigneeAvatar?.seed || null" @dragstart="$emit(\'dragStart\', task.id)" @dragend="$emit(\'dragEnd\')">{{ task.title }}</div>',
  }),
}))

vi.mock('@/components/hermes/kanban/KanbanTaskDrawer.vue', () => ({
  default: defineComponent({
    name: 'KanbanTaskDrawer',
    emits: ['updated', 'close'],
    template: '<button class="drawer-updated" @click="$emit(\'updated\')">drawer</button>',
  }),
}))

vi.mock('@/components/hermes/kanban/KanbanCreateForm.vue', () => ({
  default: defineComponent({
    name: 'KanbanCreateForm',
    emits: ['created', 'close'],
    template: '<button class="form-created" @click="$emit(\'created\')">form</button>',
  }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => mockMessage,
  NButton: defineComponent({
    name: 'NButton',
    emits: ['click'],
    template: '<button class="n-button-stub" @click="$emit(\'click\')"><slot /><slot name="icon" /></button>',
  }),
  NSelect: defineComponent({
    name: 'NSelect',
    props: { value: null, options: { type: Array, default: () => [] }, loading: Boolean },
    emits: ['update:value'],
    template: '<button class="n-select-stub" @click="$emit(\'update:value\', options[1]?.value || value)"><span v-for="option in options" :key="option.value">{{ option.label }}</span>{{ value }}</button>',
  }),
  NInput: defineComponent({
    name: 'NInput',
    props: { value: { type: String, default: '' }, placeholder: { type: String, required: false } },
    emits: ['update:value'],
    template: '<input class="n-input-stub" :placeholder="placeholder" :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
  }),
  NModal: defineComponent({
    name: 'NModal',
    props: { show: Boolean },
    emits: ['update:show', 'close'],
    template: '<div v-if="show" class="n-modal-stub"><slot /><slot name="action" /></div>',
  }),
  NSpin: defineComponent({
    name: 'NSpin',
    template: '<div class="n-spin-stub"><slot /></div>',
  }),
  NCollapse: defineComponent({
    name: 'NCollapse',
    props: { expandedNames: { type: Array, required: false }, defaultExpandedNames: { type: Array, required: false } },
    emits: ['update:expandedNames'],
    template: '<div class="n-collapse-stub" :data-expanded="JSON.stringify(expandedNames ?? null)" :data-default-expanded="JSON.stringify(defaultExpandedNames ?? null)"><slot /></div>',
  }),
  NCollapseItem: defineComponent({
    name: 'NCollapseItem',
    props: { title: { type: String, required: false }, name: { type: String, required: false } },
    template: '<section class="n-collapse-item-stub" :data-name="name"><slot /></section>',
  }),
}))

import KanbanView from '@/views/hermes/KanbanView.vue'
import {
  KANBAN_DROP_TARGET_STATUSES,
  isKanbanDropTarget,
  resolveKanbanDropAction,
} from '@/utils/hermes/kanban-drag'

describe('kanban drag transitions', () => {
  it('offers only the three statuses the chat plane allows a write for', () => {
    expect([...KANBAN_DROP_TARGET_STATUSES]).toEqual(['ready', 'blocked', 'done'])
    for (const status of ['triage', 'todo', 'scheduled', 'running', 'review', 'archived'] as const) {
      expect(isKanbanDropTarget(status), status).toBe(false)
    }
  })

  it('maps each accepted move to the endpoint core will honour', () => {
    expect(resolveKanbanDropAction('todo', 'done')).toBe('complete')
    expect(resolveKanbanDropAction('running', 'done')).toBe('complete')
    expect(resolveKanbanDropAction('blocked', 'done')).toBe('complete')
    expect(resolveKanbanDropAction('ready', 'blocked')).toBe('block')
    expect(resolveKanbanDropAction('running', 'blocked')).toBe('block')
    expect(resolveKanbanDropAction('blocked', 'ready')).toBe('unblock')
    expect(resolveKanbanDropAction('scheduled', 'ready')).toBe('unblock')
  })

  it('refuses moves core would reject', () => {
    // `hermes kanban unblock` exits non-zero for anything not blocked/scheduled.
    expect(resolveKanbanDropAction('todo', 'ready')).toBeNull()
    expect(resolveKanbanDropAction('done', 'ready')).toBeNull()
    // done and archived are terminal.
    expect(resolveKanbanDropAction('done', 'blocked')).toBeNull()
    expect(resolveKanbanDropAction('archived', 'blocked')).toBeNull()
    expect(resolveKanbanDropAction('archived', 'done')).toBeNull()
    // Columns with no chat-plane-safe endpoint are never targets.
    for (const target of ['triage', 'todo', 'scheduled', 'running', 'review', 'archived'] as const) {
      expect(resolveKanbanDropAction('ready', target), target).toBeNull()
    }
  })

  it('treats a drop back onto the same column as a no-op', () => {
    for (const status of ['ready', 'blocked', 'done'] as const) {
      expect(resolveKanbanDropAction(status, status), status).toBeNull()
    }
  })
})

describe('KanbanView', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    routeState.query = { board: 'project-a' }
    routerReplace.mockResolvedValue(undefined)
    storeState.tasks = [
      { id: 'task-1', title: 'Task one', status: 'todo', created_at: 10 },
      { id: 'task-2', title: 'Task two', status: 'done', created_at: 20 },
    ]
    storeState.stats = {
      by_status: { triage: 0, todo: 1, ready: 0, running: 0, blocked: 0, done: 1, archived: 0 },
      by_assignee: {},
      total: 2,
    }
    storeState.assignees = []
    storeState.activeBoards = [
      { slug: 'default', name: 'Default', total: 0 },
      { slug: 'project-a', name: 'Project A', total: 2 },
    ]
    storeState.loading = false
    storeState.boardsLoading = false
    storeState.selectedBoard = 'default'
    storeState.boardWarning = null
    storeState.capabilities = null
    storeState.filterStatus = null
    storeState.filterAssignee = null
    profilesState.profiles = []
    mockFetchBoards.mockResolvedValue(undefined)
    mockFetchCapabilities.mockResolvedValue(undefined)
    mockRefreshAll.mockResolvedValue(undefined)
    mockFetchTasks.mockResolvedValue(undefined)
    mockFetchStats.mockResolvedValue(undefined)
    mockFetchProfiles.mockResolvedValue(undefined)
    mockCreateBoard.mockResolvedValue({ slug: 'new-board' })
    mockArchiveSelectedBoard.mockResolvedValue(undefined)
    mockRecoverSelectedBoard.mockImplementation((candidate: string) => {
      storeState.selectedBoard = candidate || 'default'
      return { board: storeState.selectedBoard, recovered: false }
    })
    mockSetFilter.mockImplementation((key: 'status' | 'assignee', value: string | null) => {
      if (key === 'status') storeState.filterStatus = value
      else storeState.filterAssignee = value
    })
    mockDispatch.mockResolvedValue({ spawned: 1 })
    mockCompleteTasks.mockResolvedValue(undefined)
    mockBlockTask.mockResolvedValue(undefined)
    mockUnblockTasks.mockResolvedValue(undefined)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
  })

  it('initializes board from route query and refreshes stats alongside tasks', async () => {
    const wrapper = mount(KanbanView)
    await flushPromises()

    expect(mockFetchBoards).toHaveBeenCalledOnce()
    expect(mockFetchCapabilities).toHaveBeenCalledOnce()
    expect(mockFetchProfiles).toHaveBeenCalledOnce()
    expect(mockRecoverSelectedBoard).toHaveBeenCalledWith('project-a')
    expect(mockRefreshAll).toHaveBeenCalledOnce()
    expect(routerReplace).not.toHaveBeenCalled()
    expect(wrapper.find('.n-collapse-stub').attributes('data-expanded')).toBe('["triage","todo","scheduled","ready","running","blocked","review","done","archived"]')

    await wrapper.find('.drawer-updated').trigger('click')
    expect(mockFetchTasks).toHaveBeenCalledTimes(1)
    expect(mockFetchStats).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(15000)
    await flushPromises()

    expect(mockFetchBoards).toHaveBeenCalledTimes(2)
    expect(mockFetchTasks).toHaveBeenCalledTimes(2)
    expect(mockFetchStats).toHaveBeenCalledTimes(2)
  })

  it('renders board count labels and compact assignee profile labels', async () => {
    storeState.assignees = [{ name: 'alice', counts: { todo: 2, done: 1 } }]
    const wrapper = mount(KanbanView)
    await flushPromises()

    expect(wrapper.text()).toContain('kanban.title: Default · kanban.stats.tasks: 0')
    expect(wrapper.text()).toContain('kanban.title: Project A · kanban.stats.tasks: 2')
    const assigneeSelect = wrapper.findAll('.n-select-stub')[2]
    expect(assigneeSelect.text()).toContain('alice')
    expect(assigneeSelect.text()).not.toContain('default')
    expect(wrapper.text()).not.toContain('kanban.detail.assignee: alice')
    expect(wrapper.text()).not.toContain('alice · kanban.stats.tasks')
  })

  it('passes matching profile avatars to task cards', async () => {
    storeState.tasks = [{ id: 'task-1', title: 'Task one', status: 'todo', created_at: 10, assignee: 'alice' }]
    profilesState.profiles = [{ name: 'alice', avatar: { type: 'generated', seed: 'alice-seed' } }]

    const wrapper = mount(KanbanView)
    await flushPromises()

    expect(wrapper.find('.kanban-task-card-stub').attributes('data-avatar-seed')).toBe('alice-seed')
  })

  it('filters the visible board columns from stats chips', async () => {
    storeState.filterStatus = 'done'

    const wrapper = mount(KanbanView)
    await flushPromises()

    const columns = wrapper.findAll('.n-collapse-item-stub')
    expect(wrapper.find('.n-collapse-stub').attributes('data-expanded')).toBe('["done"]')
    expect(columns).toHaveLength(1)
    expect(columns[0].attributes('data-name')).toBe('done')
    expect(wrapper.text()).toContain('Task two')
    expect(wrapper.text()).not.toContain('Task one')

    await wrapper.find('.stat-chip.todo').trigger('click')
    await flushPromises()

    expect(mockSetFilter).toHaveBeenCalledWith('status', 'todo')
    expect(mockFetchTasks).toHaveBeenCalledTimes(1)

    await wrapper.find('.stat-chip.total').trigger('click')
    await flushPromises()

    expect(mockSetFilter).toHaveBeenCalledWith('status', null)
    expect(mockFetchTasks).toHaveBeenCalledTimes(2)
  })

  // hermes-agent core 0.21.3 `kanban stats --json` has no `total` key and nests
  // `by_assignee` per status. The server bridge derives a flat total from
  // by_status; these two guard that what it derives reaches the stats bar, and
  // that a stats payload without a total never renders as blank or NaN.
  it('renders the board total the server derived from core 0.21.3 stats', async () => {
    storeState.stats = {
      by_status: { triage: 0, todo: 2, ready: 1, running: 0, blocked: 0, done: 1, archived: 1 },
      by_assignee: { alice: 3, default: 2 },
      total: 5,
    }

    const wrapper = mount(KanbanView)
    await flushPromises()

    const total = wrapper.find('.stat-chip.total .stat-count')
    expect(total.text()).toBe('5')
    expect(Number.isNaN(Number(total.text()))).toBe(false)
    expect(wrapper.find('.stat-chip.todo .stat-count').text()).toBe('2')
    expect(wrapper.find('.stat-chip.archived .stat-count').text()).toBe('1')
  })

  it('shows zero rather than a blank or NaN total when stats arrive without one', async () => {
    storeState.stats = {
      by_status: { triage: 0, todo: 1, ready: 0, running: 0, blocked: 0, done: 0, archived: 0 },
      by_assignee: {},
    }

    const wrapper = mount(KanbanView)
    await flushPromises()

    const total = wrapper.find('.stat-chip.total .stat-count')
    expect(total.text()).toBe('0')
    expect(total.text()).not.toBe('')
    expect(total.text()).not.toBe('NaN')
    expect(total.text()).not.toBe('undefined')
  })

  // Dragging a card between columns is the Done line's "拖动任务". The board must
  // route it through complete/unblock/block: POST /kanban/tasks/bulk is not on
  // the chat-plane allowlist (request-context.ts isChatPlaneKanbanTaskAction)
  // and 403s for every chat-plane user.
  async function dragCard(wrapper: any, taskId: string, targetStatus: string) {
    const card = wrapper.find(`.kanban-task-card-stub[data-task-id="${taskId}"]`)
    expect(card.exists()).toBe(true)
    await card.trigger('dragstart')
    const column = wrapper.find(`.task-list[data-drop-status="${targetStatus}"]`)
    expect(column.exists()).toBe(true)
    await column.trigger('dragover')
    await column.trigger('drop')
    await flushPromises()
    return column
  }

  it('completes a task dragged onto the done column', async () => {
    const wrapper = mount(KanbanView)
    await flushPromises()

    await dragCard(wrapper, 'task-1', 'done')

    expect(mockCompleteTasks).toHaveBeenCalledWith(['task-1'])
    expect(mockBlockTask).not.toHaveBeenCalled()
    expect(mockUnblockTasks).not.toHaveBeenCalled()
    expect(mockMessage.success).toHaveBeenCalledWith('kanban.message.taskCompleted')
  })

  it('blocks a task dragged onto the blocked column with a reason', async () => {
    const wrapper = mount(KanbanView)
    await flushPromises()

    await dragCard(wrapper, 'task-1', 'blocked')

    expect(mockBlockTask).toHaveBeenCalledWith('task-1', 'kanban.drag.blockReason')
    expect(mockCompleteTasks).not.toHaveBeenCalled()
  })

  it('unblocks a blocked task dragged back onto the ready column', async () => {
    storeState.tasks = [{ id: 'task-b', title: 'Blocked one', status: 'blocked', created_at: 30 }]
    const wrapper = mount(KanbanView)
    await flushPromises()

    await dragCard(wrapper, 'task-b', 'ready')

    expect(mockUnblockTasks).toHaveBeenCalledWith(['task-b'])
    expect(mockMessage.success).toHaveBeenCalledWith('kanban.message.taskUnblocked')
  })

  it('never routes a drag through the chat-plane-forbidden bulk endpoint', async () => {
    const wrapper = mount(KanbanView)
    await flushPromises()

    await dragCard(wrapper, 'task-1', 'done')

    // The board must reach for the allowlisted single-task routes only.
    expect(mockCompleteTasks).toHaveBeenCalledTimes(1)
    expect(mockBulkUpdateTasks).not.toHaveBeenCalled()
  })

  it('refuses a drag onto a column core would reject and issues no request', async () => {
    // ready -> ready is a no-op; done is already terminal so it cannot be blocked.
    storeState.tasks = [{ id: 'task-d', title: 'Done one', status: 'done', created_at: 40 }]
    const wrapper = mount(KanbanView)
    await flushPromises()

    const column = await dragCard(wrapper, 'task-d', 'blocked')

    expect(column.attributes('data-drop-allowed')).toBe('false')
    expect(mockBlockTask).not.toHaveBeenCalled()
    expect(mockCompleteTasks).not.toHaveBeenCalled()
    expect(mockUnblockTasks).not.toHaveBeenCalled()
  })

  it('restores the original column and reports the error when the move fails', async () => {
    // Stand in for a store that already moved the card before the write failed,
    // which is what the rollback exists to undo.
    mockCompleteTasks.mockImplementation(async (ids: string[]) => {
      const moved = storeState.tasks.find(task => task.id === ids[0])
      if (moved) moved.status = 'done'
      throw new Error('cannot complete task-1')
    })
    const wrapper = mount(KanbanView)
    await flushPromises()
    expect(storeState.tasks[0].status).toBe('todo')

    await dragCard(wrapper, 'task-1', 'done')

    expect(storeState.tasks[0].status).toBe('todo')
    expect(mockMessage.error).toHaveBeenCalledWith('cannot complete task-1')
    expect(mockMessage.success).not.toHaveBeenCalled()
  })

  it('ignores a second drop while the first transition is still in flight', async () => {
    let release: (() => void) | null = null
    mockCompleteTasks.mockImplementation(() => new Promise<void>(resolve => { release = () => resolve() }))
    const wrapper = mount(KanbanView)
    await flushPromises()

    const card = wrapper.find('.kanban-task-card-stub[data-task-id="task-1"]')
    const column = wrapper.find('.task-list[data-drop-status="done"]')
    await card.trigger('dragstart')
    await column.trigger('dragover')
    await column.trigger('drop')
    await card.trigger('dragstart')
    await column.trigger('dragover')
    await column.trigger('drop')
    release?.()
    await flushPromises()

    expect(mockCompleteTasks).toHaveBeenCalledTimes(1)
  })

  it('creates and archives boards from the board toolbar', async () => {
    storeState.selectedBoard = 'project-a'
    const wrapper = mount(KanbanView)
    await flushPromises()

    await wrapper.findAll('.n-button-stub')[0].trigger('click')
    await flushPromises()
    const inputs = wrapper.findAll('.n-input-stub')
    await inputs[0].setValue('new-board')
    await inputs[1].setValue('New Board')
    await wrapper.findAll('.n-button-stub').at(-1)!.trigger('click')
    await flushPromises()

    expect(mockCreateBoard).toHaveBeenCalledWith({ slug: 'new-board', name: 'New Board' })
    expect(routerReplace).toHaveBeenCalledWith({ query: { board: 'new-board' } })

    vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockArchiveSelectedBoard).toHaveBeenCalled()
    expect(routerReplace).toHaveBeenCalledWith({ query: { board: 'default' } })
  })

  it('makes default board explicit when route query is absent', async () => {
    routeState.query = {}
    mockRecoverSelectedBoard.mockImplementation(() => {
      storeState.selectedBoard = 'default'
      return { board: 'default', recovered: false }
    })

    mount(KanbanView)
    await flushPromises()

    expect(routerReplace).toHaveBeenCalledWith({ query: { board: 'default' } })
    expect(mockRefreshAll).toHaveBeenCalledOnce()
  })
})
