<script setup lang="ts">
import { computed, useSlots } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useSessionSearch } from '@/composables/useSessionSearch'
import KpIcon from '@/components/kippies/KpIcon.vue'
import KpNavIcon from '@/components/kippies/KpNavIcon.vue'
import KwLogo from '@/components/kippies/KwLogo.vue'
import KpModeSwitch, { type AppMode } from '@/components/kippies/KpModeSwitch.vue'
import KpOfflineRow from '@/components/kippies/KpOfflineRow.vue'

// Persist the chosen surface mode so a reload lands on the same plane. This
// nav only ever renders on Work surfaces (chat / history / group), so the
// switch shows Work lit here; picking Design navigates away to the Design
// plane, which renders its own switch with Design lit.
const APP_MODE_KEY = 'hermes.appMode'

function persistAppMode(mode: AppMode) {
  try {
    localStorage.setItem(APP_MODE_KEY, mode)
  } catch {
    /* storage unavailable (private mode / SSR) — navigation still works */
  }
}

type ActiveSection =
  | 'chat'
  | 'history'
  | 'group'
  | 'global'
  | 'expert'
  | 'agents'
  | 'automation'
  | 'settings'
  | 'apps'
  | 'files'
  | 'skills'
  | 'connectors'

const props = defineProps<{
  active: ActiveSection
  primaryLabel?: string
  collapsed?: boolean
  // Superadmin-only affordance: reveals a small secondary control beside the
  // primary "new task" row that opens the coding-agent config modal. Off by
  // default so ordinary roles never see it.
  showPrimaryConfig?: boolean
  primaryConfigLabel?: string
  // Highlights the "new task" row while on the chat home (empty composer or a
  // draft task), matching the prototype where 新建任务 (id=home) is active
  // whenever screen === "home".
  homeActive?: boolean
}>()

const emit = defineEmits<{
  primary: []
  primaryConfig: []
  collapse: []
}>()

const { t } = useI18n()
const router = useRouter()
const { openSessionSearch } = useSessionSearch()

// The market is ONE entry with three sections inside it, not three sidebar
// rows behind a fold. Three peer entries turned "browse the market" into three
// decisions before you had seen anything, and the fold added a fourth. The
// split now lives on the page, as a tab strip.
const MARKET_SECTIONS: readonly string[] = ['expert', 'skills', 'connectors']

function openMarket() {
  void router.push({ name: 'hermes.chat', query: { surface: 'expert' } })
}

function openLibrary() {
  void router.push({ name: 'hermes.chat', query: { surface: 'files' } })
}

const primaryText = computed(() => props.primaryLabel || t('chat.newTask'))

// With a `tasks` (and usually `footer`) slot the component renders the whole
// sidebar body the way the prototype does: header + mode switch pinned on
// top, ONE scroll region shared by the nav rows and the task list, then a
// full-bleed divider and the account row pinned at the bottom.
const slots = useSlots()
const hasBody = computed(() => !!slots.tasks || !!slots.footer)

function openBrandChat() {
  void router.push({ name: 'hermes.chat' })
}

function openAgents() {
  void router.push({ name: 'hermes.chat', query: { surface: 'agents' } })
}

function openAutomation() {
  void router.push({ name: 'hermes.chat', query: { surface: 'automation' } })
}

// Design is shown disabled (a coming-soon affordance), so the switch only ever
// emits `work` here. The Design plane / route stays intact, just not reachable
// from this switch.
function selectAppMode(mode: AppMode) {
  persistAppMode(mode)
  void router.push({ name: 'hermes.chat' })
}
</script>

<template>
  <div class="page-sidebar-nav" :class="{ collapsed }">
    <nav class="page-sidebar-tabs" aria-label="Chat actions">
      <div class="page-sidebar-head">
        <a class="page-sidebar-logo" href="/#/hermes/chat" @click.prevent="openBrandChat">
          <KwLogo />
        </a>
        <button
          class="page-sidebar-headbtn"
          type="button"
          :title="collapsed ? t('sidebar.expand') : t('sidebar.collapse')"
          @click="emit('collapse')"
        >
          <!-- Prototype PanelIcon (rounded panel + left rail), not a hamburger:
               the `line_sidebar` glyph renders as three bars, which reads as a
               menu, not a collapse-panel affordance. Matches AppSidebar. -->
          <svg width="17" height="17" viewBox="0 0 20 20" fill="none">
            <rect x="2.6" y="3.6" width="14.8" height="12.8" rx="3" stroke="currentColor" stroke-width="1.5" />
            <path d="M8.4 3.6V16.4" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </button>
        <button
          v-if="!collapsed"
          class="page-sidebar-headbtn"
          type="button"
          :title="t('sidebar.search')"
          @click="openSessionSearch"
        >
          <KpIcon name="line_search" :size="16" />
        </button>
      </div>

      <KpModeSwitch
        class="page-sidebar-mode"
        mode="work"
        :collapsed="collapsed"
        :disabled-modes="['design']"
        @update:mode="selectAppMode"
      />

      <div class="page-sidebar-scroll" :class="{ 'is-body': hasBody }">
      <div class="page-sidebar-primary-row">
        <button
          class="page-sidebar-tab"
          :class="{ active: homeActive }"
          type="button"
          :title="collapsed ? primaryText : undefined"
          @click="emit('primary')"
        >
          <span class="navico navin" style="animation-delay: 0ms">
            <KpNavIcon name="line_add" :size="18" />
          </span>
          <span>{{ primaryText }}</span>
        </button>
        <!-- Superadmin-only secondary entry: opens the coding-agent config
             modal. Kept subtle (icon-only) and hidden in the collapsed rail so
             the primary "new task" action stays the obvious path. -->
        <button
          v-if="showPrimaryConfig && !collapsed"
          class="page-sidebar-primary-config"
          type="button"
          :title="primaryConfigLabel || t('chat.newTaskConfig')"
          :aria-label="primaryConfigLabel || t('chat.newTaskConfig')"
          @click="emit('primaryConfig')"
        >
          <KpIcon name="line_setting" :size="15" />
        </button>
      </div>

      <button
        class="page-sidebar-tab"
        :class="{ active: active === 'agents' }"
        type="button"
        :title="collapsed ? t('agentsHub.title') : undefined"
        @click="openAgents"
      >
        <span class="navico navin" style="animation-delay: 40ms">
          <KpNavIcon name="line_comment_ai" :size="18" />
        </span>
        <span>{{ t('agentsHub.title') }}</span>
      </button>

      <!-- 应用 has no entry point yet: AppsView renders MOCK data (there is no
           apps API), and shipping a fake catalog to 1259 people reads as a
           broken product, not a preview. The route and the view stay so the
           entry is one uncommented block away once the endpoint lands. -->

      <button
        class="page-sidebar-tab"
        :class="{ active: MARKET_SECTIONS.includes(active) }"
        type="button"
        :title="collapsed ? t('sidebar.market') : undefined"
        @click="openMarket"
      >
        <span class="navico navin" style="animation-delay: 120ms">
          <KpNavIcon name="line_box" :size="18" />
        </span>
        <span>{{ t('sidebar.market') }}</span>
        <!-- A table of contents, not a control: it says what is inside without
             making you open anything. Drops out in the collapsed rail. -->
        <span v-if="!collapsed" class="t-meta page-sidebar-hint">{{ t('sidebar.marketHint') }}</span>
      </button>

      <button
        class="page-sidebar-tab"
        :class="{ active: active === 'automation' }"
        type="button"
        :title="collapsed ? t('sidebar.jobs') : undefined"
        @click="openAutomation"
      >
        <span class="navico navin" style="animation-delay: 160ms">
          <KpNavIcon name="line_time" :size="18" />
        </span>
        <span>{{ t('sidebar.jobs') }}</span>
      </button>

      <button
        class="page-sidebar-tab"
        :class="{ active: active === 'files' }"
        type="button"
        :title="collapsed ? t('sidebar.files') : undefined"
        @click="openLibrary"
      >
        <span class="navico navin" style="animation-delay: 200ms">
          <KpNavIcon name="line_drawer" :size="18" />
        </span>
        <span>{{ t('sidebar.files') }}</span>
      </button>

      <!-- Prototype: a fixed 24px of air between the nav block and the task
           list; both live in the same scroll region. -->
      <template v-if="$slots.tasks">
        <div class="page-sidebar-spacer" aria-hidden="true" />
        <slot name="tasks" />
      </template>
      </div>
    </nav>

    <template v-if="$slots.footer">
      <div class="page-sidebar-divider" aria-hidden="true" />
      <!-- Above the account row, below the divider — and it renders nothing at
           all while the network is fine. -->
      <KpOfflineRow :collapsed="collapsed" />
      <slot name="footer" />
    </template>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.page-sidebar-nav {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.page-sidebar-tabs {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

// Body mode (tasks/footer slots): the nav rows and the task list share ONE
// scroll region, exactly like the prototype's `.sidescroll` — full-bleed
// against the aside's 12px padding so row tints can run edge to edge while
// content stays inset.
.page-sidebar-scroll {
  display: flex;
  flex-direction: column;

  &.is-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    margin: 0 -12px;
    padding: 0 12px;
  }
}

.page-sidebar-spacer {
  flex: 0 0 24px;
  height: 24px;
}

// Full-bleed hairline above the account row (prototype Divider margin
// "0 -12px 12px").
.page-sidebar-divider {
  flex: 0 0 auto;
  height: 1px;
  margin: 0 -12px 12px;
  background: var(--divider);
}

.page-sidebar-head {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 40px;
  padding: 0 4px 0 12px;
  margin-bottom: 8px;
}

.page-sidebar-logo {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  text-decoration: none;
}

.page-sidebar-headbtn {
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--fg-aux);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-std);

  &:hover {
    background: var(--gray-f2);
    color: var(--fg-primary);
  }
}

// Table-of-contents line on the market row: right-aligned, muted, and it must
// not wrap — this row sits inside a container whose width animates, and a
// wrapping label makes the row grow mid-transition.
.page-sidebar-hint {
  margin-left: auto;
  padding-left: 8px;
  white-space: nowrap;
  // --fg-aux, not --fg-disabled: this is readable secondary content, not a
  // disabled control (and on dark, --fg-disabled is the weakest step there is).
  color: var(--fg-aux);
}

// The primary "new task" row shares its line with an optional icon-only
// config button. The primary tab flexes to fill; the config button trails it.
.page-sidebar-primary-row {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 2px;

  .page-sidebar-tab {
    flex: 1;
    min-width: 0;
  }
}

.page-sidebar-primary-config {
  flex: 0 0 30px;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: var(--r-ctl);
  background: transparent;
  color: var(--fg-aux);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-std),
    color var(--motion-fast) var(--ease-std);

  &:hover {
    background: var(--gray-f2);
    color: var(--fg-primary);
  }
}

// Row geometry matches the app rail exactly: 36px tall, 12px side padding, a
// 16px glyph and an 8px gutter. Rest state carries no frame at all — the tint
// only appears on hover or when active.
.page-sidebar-tab {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  flex: 0 0 auto;
  height: 36px;
  margin-bottom: 2px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-ctl);
  background: transparent;
  color: var(--fg-primary);
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition: background var(--motion-fast) var(--ease-std);

  // The nav icon is 18, not the 16 used inside buttons: here it is the row's
  // primary identifier — in the collapsed rail it is the only content — and at
  // 16 it reads lighter than the 14px label beside it. §9.1's fs x 1.5 ratio
  // governs icons *inside* buttons, where the icon is the supporting element.
  // Both carriers read this: the hand-drawn SVG strokes with `currentColor`,
  // and KpIcon's glyph is written `color: inherit` inline.
  .navico {
    color: var(--fg-aux);
  }

  &:hover {
    background: var(--surface-3);
  }

  &.active {
    background: var(--selected-bg);
    color: var(--fg-title);
    font-weight: var(--w-medium);

    .navico {
      color: var(--fg-title);
    }
  }

  // The label only. `.navico` and the market row's table-of-contents line are
  // direct child spans as well; giving either `flex: 1` plus the fade mask
  // stretches the icon box / eats the hint's tail.
  > span:not(.navico):not(.page-sidebar-hint) {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    // Fade the tail rather than cutting with an ellipsis.
    mask-image: linear-gradient(90deg, #000 calc(100% - 16px), transparent);
    -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 16px), transparent);
  }
}

// ─── Collapsed rail (64px) ──────────────────────────────────
// Matches AppSidebar's rail geometry: the container is padded 12, so a 40px
// inner box; a 32px row centered with `margin: auto` lands its 16px glyph at
// center 32 — the middle of the 64px rail — and nothing has to switch to
// `center` alignment.
.page-sidebar-nav.collapsed {
  .page-sidebar-head {
    padding: 0;
  }

  // A zero-width `flex: 1` label would still claim the row's space and push the
  // toggle off-center, so the logo collapses to `flex: 0 0 0`.
  .page-sidebar-logo {
    flex: 0 0 0;
    opacity: 0;
    overflow: hidden;
  }

  // The primary row is a flex container; in the rail it must not stretch its
  // single button, or `margin: 0 auto` can no longer center the glyph.
  .page-sidebar-primary-row .page-sidebar-tab {
    flex: 0 0 32px;
  }

  .page-sidebar-tab {
    width: 32px;
    height: 32px;
    justify-content: center;
    gap: 0;
    margin: 0 auto 2px;
    padding: 0;

    // The label only. `.navico` is a direct child span as well, and hiding it
    // here would empty the rail of the one thing it still shows.
    > span:not(.navico) {
      display: none;
    }
  }
}
</style>
