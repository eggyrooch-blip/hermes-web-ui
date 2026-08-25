<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAppStore } from "@/stores/hermes/app";
import { useProfilesStore } from "@/stores/hermes/profiles";
import { usePersistentRecord } from '@/composables/usePersistentRecord'
import { useSessionSearch } from '@/composables/useSessionSearch'
import RouteLinkItem from '@/components/common/RouteLinkItem.vue'
import KpIcon from '@/components/kippies/KpIcon.vue'
import KwLogo from '@/components/kippies/KwLogo.vue'
import KpThemeSeg from '@/components/kippies/KpThemeSeg.vue'
import KpOfflineRow from '@/components/kippies/KpOfflineRow.vue'
import ModelSelector from "@/components/layout/ModelSelector.vue";
import ProfileSelector from "@/components/layout/ProfileSelector.vue";
import LanguageSwitch from "@/components/layout/LanguageSwitch.vue";
import { fetchCurrentUser } from "@/api/auth";
import { getStoredUsername, isStoredSuperAdmin, isServerSessionAuthMode } from "@/api/client";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const profilesStore = useProfilesStore();
const { openSessionSearch } = useSessionSearch();
const selectedKey = computed(() => {
  return route.name as string;
});
// One nav row, three destinations: whichever market section you are on, the
// row stays lit.
const MARKET_ROUTES = ["hermes.expert", "hermes.skills", "hermes.connectors"];
const isMarketSelected = computed(() => MARKET_ROUTES.includes(selectedKey.value));
const isSuperAdmin = computed(() => isStoredSuperAdmin());
// Console is for Feishu-session users (developer default, union_id admin). Hide it
// from web-plane (username/password) sessions, which carry no openid and would only
// get 401s from /api/console/* — the server guards it either way; this hides the dead link.
const showConsole = computed(() => isServerSessionAuthMode());

// Everything operational lives behind one secondary group rather than in the
// primary rail: the KippiesWork navigation is task-shaped (make something, then
// find something you made), and gateway/model/log plumbing is neither.
const showOpsGroup = computed(() => isSuperAdmin.value);

const currentUsername = computed(() => getStoredUsername());
const currentUser = computed(() => profilesStore.currentUser);

function hasRoute(name: string): boolean {
  return router.hasRoute(name);
}
const { record: collapsedGroups, persist: persistCollapsedGroups } = usePersistentRecord('hermes.sidebar.collapsedGroups');

function toggleGroup(key: string) {
  collapsedGroups[key] = !collapsedGroups[key];
  persistCollapsedGroups();
}

function isGroupCollapsed(key: string) {
  return !!collapsedGroups[key];
}

function handleSidebarClick(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target : null;

  if (!target?.closest(".route-link-item")) {
    return;
  }

  if (typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches) {
    appStore.closeSidebar();
  }
}

async function handleLogout() {
  try {
    await fetch("/api/auth/feishu/logout", {
      method: "POST",
      credentials: "same-origin",
    });
  } catch {
    // Local logout should still clear stale browser state if the server call fails.
  } finally {
    localStorage.clear();
    window.location.reload();
  }
}

async function refreshCurrentUser() {
  try {
    const user = await fetchCurrentUser();
    if (user.profile) {
      profilesStore.setBoundProfile(user.profile, user);
    } else {
      profilesStore.setCurrentUser(user);
    }
  } catch {
    // Sidebar user chrome is optional; auth guards own redirect behavior.
  }
}

onMounted(() => {
  void refreshCurrentUser();
});

// ─── Bottom user row → UserMenu popover (prototype) ─────────
// Same pattern as the chat sidebar's account row: the whole row is the
// affordance; profile/model/language/settings/appearance/sign-out all live in
// the upward menu instead of being flattened into the rail.
const sidebarUserName = computed(
  () => currentUser.value?.name || currentUsername.value || profilesStore.activeProfileName || "—",
);
const sidebarUserAvatar = computed(() => currentUser.value?.avatarUrl || "");
const sidebarUserInitial = computed(() => sidebarUserName.value.trim().charAt(0) || "?");

const showUserMenu = ref(false);
const userMenuStyle = ref<Record<string, string>>({});
const userMenuEl = ref<HTMLElement | null>(null);

function openUserMenu(e: MouseEvent) {
  const anchor = e.currentTarget as HTMLElement | null;
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  // Align to the SIDEBAR: the menu starts at the rail's left inset and is as
  // wide as the rail's content box, reading as the account area growing out
  // of the rail (see ChatPanel's UserMenu).
  const aside = anchor.closest("aside");
  const a = aside ? aside.getBoundingClientRect() : r;
  userMenuStyle.value = {
    left: `${Math.round(Math.max(12, a.left + 12))}px`,
    bottom: `${Math.round(Math.max(12, window.innerHeight - r.top + 8))}px`,
  };
  showUserMenu.value = !showUserMenu.value;
}

function closeUserMenu() {
  showUserMenu.value = false;
}

function onUserMenuAway(e: MouseEvent) {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  if (userMenuEl.value?.contains(target)) return;
  if (target.closest?.(".sidebar-user__trigger")) return;
  closeUserMenu();
}

function onUserMenuKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") closeUserMenu();
}

watch(showUserMenu, (open) => {
  if (open) {
    document.addEventListener("mousedown", onUserMenuAway, true);
    document.addEventListener("keydown", onUserMenuKeydown);
  } else {
    document.removeEventListener("mousedown", onUserMenuAway, true);
    document.removeEventListener("keydown", onUserMenuKeydown);
  }
});

onUnmounted(() => {
  document.removeEventListener("mousedown", onUserMenuAway, true);
  document.removeEventListener("keydown", onUserMenuKeydown);
});

function handleUserMenuSettings() {
  closeUserMenu();
  void router.push({ name: "hermes.settings" });
}

const userHandleCopied = ref(false);
let userHandleCopyTimer: ReturnType<typeof setTimeout> | null = null;

function copyUserHandle() {
  const handle = currentUsername.value || sidebarUserName.value;
  if (!handle) return;
  void navigator.clipboard?.writeText(handle).catch(() => {});
  userHandleCopied.value = true;
  if (userHandleCopyTimer) clearTimeout(userHandleCopyTimer);
  userHandleCopyTimer = setTimeout(() => {
    userHandleCopied.value = false;
  }, 1400);
}
</script>

<template>
  <aside class="sidebar" :class="{ open: appStore.sidebarOpen, collapsed: appStore.sidebarCollapsed }" @click="handleSidebarClick">
    <!-- Header. Collapsed, the left padding must go to zero: the button is
         32 wide, so with `padding-left: 0` + `gap: 4` it lands at 4–36 of the
         rail's content box, plus the aside's own 12 that is 16–48 — center 32,
         which is exactly where every nav row's icon sits. With a constant 12
         the center lands at 44 and the toggle reads as 12px off the column. -->
    <div class="sidebar-head">
      <RouteLinkItem class="sidebar-logo" :to="{ name: 'hermes.chat' }" :active="selectedKey === 'hermes.chat'">
        <KwLogo />
      </RouteLinkItem>
      <button
        class="head-btn"
        :title="appStore.sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')"
        @click="appStore.toggleSidebarCollapsed()"
      >
        <svg width="17" height="17" viewBox="0 0 20 20" fill="none">
          <rect x="2.6" y="3.6" width="14.8" height="12.8" rx="3" stroke="currentColor" stroke-width="1.5" />
          <path d="M8.4 3.6V16.4" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </button>
      <button
        v-if="!appStore.sidebarCollapsed"
        class="head-btn"
        :title="t('sidebar.search')"
        @click="openSessionSearch"
      >
        <KpIcon name="line_search" :size="16" />
      </button>
    </div>

    <nav class="sidebar-nav">
      <RouteLinkItem class="nav-item" :to="{ name: 'hermes.chat' }" :active="selectedKey === 'hermes.chat'">
        <KpIcon name="line_add" :size="16" />
        <span>{{ t("sidebar.newTask") }}</span>
      </RouteLinkItem>

      <RouteLinkItem v-if="hasRoute('hermes.agents')" class="nav-item" :to="{ name: 'hermes.agents' }" :active="selectedKey === 'hermes.agents'">
        <KpIcon name="line_comment_ai" :size="16" />
        <span>{{ t("sidebar.agents") }}</span>
      </RouteLinkItem>

      <!-- 看板 / 记忆 / 用量 / 技能用量 and the whole 群系统 group moved into
           设置 as tabs (2026-08-18) so there is only one sidebar in the product.
           Their old paths still resolve — the router redirects each to its tab. -->

      <!-- The market is ONE entry with three sections inside it. Three peer
           rows behind a fold turned "browse the market" into three decisions
           before you had seen anything; the split now lives on the page as a
           tab strip. The trailing line is a table of contents, not a control. -->
      <template v-if="isSuperAdmin">
        <RouteLinkItem class="nav-item" :to="{ name: 'hermes.expert' }" :active="isMarketSelected">
          <KpIcon name="line_box" :size="16" />
          <span>{{ t("sidebar.market") }}</span>
          <span class="t-meta nav-hint">{{ t("sidebar.marketHint") }}</span>
        </RouteLinkItem>
      </template>

      <RouteLinkItem v-if="isSuperAdmin" class="nav-item" :to="{ name: 'hermes.jobs' }" :active="selectedKey === 'hermes.jobs'">
        <KpIcon name="line_time" :size="16" />
        <span>{{ t("sidebar.jobs") }}</span>
      </RouteLinkItem>

      <RouteLinkItem class="nav-item" :to="{ name: 'hermes.files' }" :active="selectedKey === 'hermes.files'">
        <KpIcon name="line_drawer" :size="16" />
        <span>{{ t("sidebar.files") }}</span>
      </RouteLinkItem>

      <!-- Operations. Same folding pattern as Extensions, kept at the bottom
           and admin-only so the primary rail stays task-shaped. -->
      <template v-if="showOpsGroup">
        <button class="nav-item nav-group-toggle" @click="toggleGroup('ops')">
          <KpIcon name="line_control" :size="16" />
          <span>{{ t("sidebar.groupSystem") }}</span>
          <KpIcon
            name="line_arrow_right"
            :size="12"
            class="nav-arrow"
            :class="{ open: !isGroupCollapsed('ops') }"
          />
        </button>
        <div class="nav-subgroup nav-subgroup--ops" :class="{ open: !isGroupCollapsed('ops') }">
          <RouteLinkItem v-if="showConsole" class="nav-item nav-subitem" :to="{ name: 'hermes.console' }" :active="selectedKey === 'hermes.console'">
            <span>Console</span>
          </RouteLinkItem>
          <!-- 渠道 / 模型 / 日志 / 性能 / 插件 / MCP / 编码代理 / 版本预览 /
               设备 are 设置 tabs now — see the note at the top of this nav. -->
          <!-- Label reuses profiles.title (the page's own heading), not
               sidebar.profiles — that key is also ProfileSelector's own
               heading just below, and having both say the exact same word
               back-to-back with no separator read like duplicated/glitched
               content. -->
          <RouteLinkItem class="nav-item nav-subitem" :to="{ name: 'hermes.profiles' }" :active="selectedKey === 'hermes.profiles'">
            <span>{{ t("profiles.title") }}</span>
          </RouteLinkItem>
        </div>
      </template>

      <div class="nav-spacer" />
    </nav>

    <!-- Footer: one account row (prototype). Everything that used to be
         flattened here — profile/model pickers, settings, language, theme,
         sign-out — lives in the upward UserMenu. -->
    <div class="sidebar-footer">
      <!-- Absent entirely while the network is fine — see KpOfflineRow. -->
      <KpOfflineRow :collapsed="appStore.sidebarCollapsed" />
      <button
        class="sidebar-user__trigger"
        :class="{ 'is-open': showUserMenu }"
        type="button"
        data-testid="app-sidebar-user-trigger"
        :title="t('sidebar.accountAndSettings')"
        @click="openUserMenu"
      >
        <span class="sidebar-user__avatar">
          <img v-if="sidebarUserAvatar" class="user-avatar" :src="sidebarUserAvatar" alt="" />
          <template v-else>{{ sidebarUserInitial }}</template>
        </span>
        <span
          class="sidebar-user__dot"
          :class="{ 'is-on': appStore.connected }"
          :title="appStore.connected ? t('sidebar.connected') : t('sidebar.disconnected')"
          aria-hidden="true"
        />
        <span class="sidebar-user__name">{{ sidebarUserName }}</span>
      </button>
    </div>

    <!-- UserMenu popover: fixed + teleported so the rail's overflow never
         clips it; dismissed by mousedown-away or Escape (no backdrop). -->
    <Teleport to="body">
      <template v-if="showUserMenu">
        <div ref="userMenuEl" class="user-menu fadein" :style="userMenuStyle">
          <div class="user-menu__head">
            <span class="user-menu__head-name">{{ sidebarUserName }}</span>
            <button
              class="user-menu__copy"
              type="button"
              :title="t('common.copy')"
              @click="copyUserHandle"
            >
              <KpIcon
                :name="userHandleCopied ? 'line_check' : 'line_library'"
                :size="14"
                :class="{ 'is-copied': userHandleCopied }"
              />
            </button>
          </div>
          <div class="user-menu__divider" />
          <!-- Admin utilities folded out of the rail: active profile + model. -->
          <div class="user-menu__block">
            <ProfileSelector />
            <ModelSelector />
          </div>
          <div class="user-menu__divider" />
          <button class="user-menu__item" type="button" @click="handleUserMenuSettings">
            <KpIcon name="line_setting" :size="15" class="user-menu__icon" />
            <span>{{ t('sidebar.settings') }}</span>
          </button>
          <div class="user-menu__item user-menu__item--appearance">
            <KpIcon name="line_photo_filter" :size="15" class="user-menu__icon" />
            <span>{{ t('sidebar.appearance') }}</span>
            <KpThemeSeg />
          </div>
          <div v-if="isSuperAdmin" class="user-menu__item user-menu__item--appearance">
            <KpIcon name="line_comment" :size="15" class="user-menu__icon" />
            <span>{{ t('language.label') }}</span>
            <LanguageSwitch class="user-menu__language" />
          </div>
          <div class="user-menu__divider" />
          <button class="user-menu__item" type="button" data-testid="user-menu-logout" @click="handleLogout">
            <KpIcon name="full_arrow_back" :size="15" class="user-menu__icon" />
            <span>{{ t('sidebar.logout') }}</span>
          </button>
        </div>
      </template>
    </Teleport>

    <div class="sidebar-top-actions">
      <RouteLinkItem class="nav-item sidebar-return-tab" :to="{ name: 'hermes.chat' }" :title="t('sidebar.backToChat')">
        <KpIcon name="line_arrow_left" :size="16" />
        <span>{{ t("sidebar.backToChat") }}</span>
      </RouteLinkItem>
    </div>
  </aside>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.sidebar {
  position: relative;
  width: $sidebar-width;
  height: calc(100 * var(--vh));
  background-color: var(--bg-softer);
  border-right: 0.5px solid var(--divider);
  display: flex;
  flex-direction: column;
  padding: 12px 12px 16px;
  flex-shrink: 0;
  overflow: hidden;
  // Width and flex-basis move together so the rail never tears mid-animation.
  transition: width var(--motion-page) var(--ease-std),
    flex-basis var(--motion-page) var(--ease-std);
}

.sidebar-head {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 40px;
  padding: 0 4px 0 12px;
  margin-bottom: 8px;
  // The padding animates too, so collapsing has no jump frame.
  transition: padding var(--motion-page) var(--ease-std);
}

.sidebar-logo {
  display: flex;
  align-items: center;
  // Collapsed this must go to `0 0 0px`. A zero-width label still claims the
  // remaining 4px at flex:1 and pushes the toggle right, putting its center at
  // 36 instead of 32.
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-decoration: none;
  transition: opacity 200ms var(--ease-out) 140ms;
}

.head-btn {
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
  transition: opacity var(--motion-base) var(--ease-std);

  &:active {
    opacity: 0.6;
  }

  &:hover {
    background: var(--gray-f2);
    color: var(--fg-primary);
  }
}

.sidebar-nav {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  min-height: 0;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.nav-spacer {
  flex: 1;
  min-height: 0;
}

// Row geometry is identical in both states: rail inner width is 40 and the
// row's left padding is 12, so a 16px glyph sits at 24–40 — center 32, the
// middle of the 64px rail. Nothing has to switch to `center` and the icon
// does not move at all while the width animates.
.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  margin-bottom: 2px;
  padding: 0 12px;
  border-radius: var(--r-ctl);
  cursor: pointer;
  overflow: hidden;
  border: 0;
  width: 100%;
  // As a flex child of .sidebar-nav (column), rows must not shrink: without
  // this, once the ops/ext subgroups push total content past the nav's
  // available height, flexbox compresses rows (and the subgroups' own
  // max-height boxes) below their content size instead of letting
  // .sidebar-nav's own overflow-y:auto take over — the compressed subgroup's
  // `overflow: hidden` then silently clips its last row mid-line, which reads
  // as garbled/overlapping text right where the next section begins.
  flex-shrink: 0;
  background: transparent;
  color: var(--fg-primary);
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
  text-decoration: none;
  text-align: left;
  transition: background var(--motion-fast) var(--ease-std),
    width var(--motion-page) var(--ease-std),
    height var(--motion-page) var(--ease-std),
    padding var(--motion-page) var(--ease-std);

  :deep(.kp-icon-font) {
    color: var(--fg-aux);
    flex: none;
  }

  &:hover {
    background: var(--gray-f2);
  }

  &.active,
  &.router-link-active {
    background: var(--gray-f2);
    color: var(--fg-title);
    font-weight: var(--w-medium);

    :deep(.kp-icon-font) {
      color: var(--fg-title);
    }
  }

  > span {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    // Long labels fade at the right edge instead of being cut with an
    // ellipsis: the rail is already animating its width, and a "…" that pops
    // in and out draws more attention than a fade. The fade zone only covers
    // the last 16px, so short labels never touch it.
    mask-image: linear-gradient(90deg, #000 calc(100% - 16px), transparent);
    -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 16px), transparent);
  }
}

// Sub-rows carry no icon — one indent step plus the label is enough. Giving
// children icons too would put two columns of glyphs in the rail and make the
// hierarchy harder to read, not easier. The 36px indent lines the child label
// up with the parent label.
// Table-of-contents line on the market row: right-aligned, muted, no wrap.
.nav-hint {
  margin-left: auto;
  padding-left: 8px;
  white-space: nowrap;
  color: var(--fg-disabled);
}

.nav-subitem {
  padding: 0 12px 0 36px;
  color: var(--fg-secondary);

  &.active,
  &.router-link-active {
    color: var(--fg-title);
  }
}

.nav-group-toggle {
  font-family: var(--font-cn);
}

.nav-arrow {
  flex: none;
  color: var(--fg-disabled);
  transition: transform var(--motion-base) var(--ease-std);

  &.open {
    transform: rotate(90deg);
  }
}

.nav-subgroup {
  overflow: hidden;
  max-height: 0;
  opacity: 0;
  // See .nav-item: without this, a tall subgroup (many optional routes) gets
  // squeezed by the flex column instead of genuinely overflowing into
  // .sidebar-nav's own scroll.
  flex-shrink: 0;
  transition: max-height var(--motion-page) var(--ease-std),
    opacity 200ms var(--ease-out) 0ms;

  &.open {
    max-height: 3 * 38px;
    opacity: 1;
    // Fade the labels in only once the height has started to settle.
    transition: max-height var(--motion-page) var(--ease-std),
      opacity 200ms var(--ease-out) 80ms;
  }
}

.nav-subgroup--ops.open {
  max-height: 11 * 38px;
}

.sidebar-footer {
  padding-top: 12px;
  border-top: 0.5px solid var(--divider);
  margin: 0 -12px;
  padding-left: 12px;
  padding-right: 12px;
  display: flex;
}

// ─── Account row (prototype: the whole row opens the UserMenu) ──
.sidebar-user__trigger {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--r-ctl);
  background: transparent;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-std);

  &.is-open {
    background: var(--selected-bg);
  }

  &:hover {
    background: var(--gray-f2);
  }
}

.sidebar-user__avatar {
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border-radius: var(--r-pill);
  background: var(--keep-700);
  color: var(--white);
  display: grid;
  place-items: center;
  overflow: hidden;
  font: var(--w-medium) var(--t-12) / var(--lh-1) var(--font-cn);

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

// Gateway status, compressed to a dot beside the avatar (the old card spelled
// out 已连接/未连接 as a text row).
.sidebar-user__dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  margin-left: -4px;
  border-radius: var(--r-pill);
  background: var(--danger);

  &.is-on {
    background: var(--keep-green);
  }
}

.sidebar-user__name {
  flex: 1;
  min-width: 0;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-secondary);
}

.sidebar-return-tab {
  display: none;
}

// ─── UserMenu popover (teleported; mirrors ChatPanel's) ─────
.user-menu {
  position: fixed;
  z-index: 3001;
  width: 224px;
  padding: 6px;
  background: var(--bg);
  border-radius: var(--r-card);
  box-shadow: var(--shadow-notification);
}

.user-menu__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 12px;
}

.user-menu__head-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font: var(--w-semibold) var(--t-16) / var(--lh-1) var(--font-cn);
  color: var(--fg-title);
}

.user-menu__copy {
  flex: 0 0 auto;
  display: inline-flex;
  padding: 4px;
  border: 0;
  border-radius: var(--r-ctl);
  background: transparent;
  cursor: pointer;

  :deep(.kp-icon-font) {
    color: var(--fg-aux);
  }

  :deep(.kp-icon-font.is-copied) {
    color: var(--keep-green);
  }
}

// The profile/model pickers folded in from the old rail bottom.
.user-menu__block {
  padding: 2px 4px;

  :deep(.profile-selector),
  :deep(.model-selector) {
    padding: 4px 0;
  }
}

.user-menu__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 36px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-ctl);
  background: transparent;
  color: var(--fg-primary);
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
  text-align: left;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-std);

  > span:not(.kp-theme-seg) {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  :deep(.kp-icon-font) {
    color: var(--fg-aux);
    flex: none;
  }

  :deep(.kp-theme-seg) {
    flex: none;
  }

  &:hover {
    background: var(--gray-f2);
  }

  &--appearance {
    cursor: default;
  }
}

.user-menu__language {
  flex: 0 0 auto;
  width: 108px;
}

.user-menu__divider {
  height: 1px;
  margin: 6px 0;
  background: var(--divider);

  &:first-of-type {
    margin-top: 0;
  }
}

// ─── Collapsed rail ─────────────────────────────────────────

.sidebar.collapsed {
  width: $sidebar-collapsed-width;
  flex-basis: $sidebar-collapsed-width;

  .sidebar-head {
    padding: 0;
  }

  .sidebar-logo {
    flex: 0 0 0px;
    opacity: 0;
    transition: opacity 200ms var(--ease-out) 0ms;
  }

  // Labels stay mounted and cross-fade rather than being added and removed —
  // an unmount has no intermediate state, so the text used to snap into a
  // still-64px-wide box while the width was mid-animation. Expanding delays
  // the fade 140ms so the letters appear after the box settles; collapsing
  // fades immediately so they are gone before they would be squeezed.
  //
  // `flex` must collapse to 0 here too: a zero-width `flex: 1` label still
  // claims the row's remaining space and pushes the icon off-center.
  .nav-item > span,
  .sidebar-user__name {
    flex: 0 0 0px;
    opacity: 0;
    transform: translateX(-6px);
    transition: opacity 200ms var(--ease-out) 0ms,
      transform 240ms var(--ease-out) 0ms;
  }

  // The tint shrinks to a centered 32×32 square instead of staying a
  // full-width bar — a 40-wide tinted row around a 16px icon reads as "a
  // block of color", not "an icon is selected".
  .nav-item {
    width: 32px;
    height: 32px;
    justify-content: center;
    gap: 0;
    margin: 0 auto 2px;
    padding: 0;
  }

  .nav-arrow,
  .nav-subgroup,
  .sidebar-user__dot {
    display: none;
  }

  // Rail account row: the 24px avatar centers on the icon column.
  .sidebar-user__trigger {
    padding: 0;
    justify-content: center;
    gap: 0;
  }
}

.sidebar:not(.collapsed) {
  .nav-item > span,
  .sidebar-user__name {
    opacity: 1;
    transform: none;
    transition: opacity 200ms var(--ease-out) 140ms,
      transform 240ms var(--ease-out) 140ms;
  }
}

// ─── Mobile drawer ──────────────────────────────────────────

@media (max-width: $breakpoint-mobile) {
  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 300;
    transform: translateX(-100%);
    transition: transform var(--motion-page) var(--ease-std);

    &.open {
      transform: none;
    }
  }
}
</style>
