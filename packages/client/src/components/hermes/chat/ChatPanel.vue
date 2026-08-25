<script setup lang="ts">
import { renameSession, setSessionWorkspace, batchDeleteSessions, exportSession } from "@/api/hermes/sessions";
import type { AvailableModelGroup } from "@/api/hermes/system";
import {
  fetchCodingAgentsStatus,
  inferCodingAgentApiMode,
  normalizeCodingAgentApiMode,
  type CodingAgentApiMode,
  type CodingAgentId,
} from "@/api/coding-agents";
import { modelCapabilities } from "../../../../../server/src/shared/model-capabilities";
import { useChatStore, type Session } from "@/stores/hermes/chat";
import { useAppStore } from "@/stores/hermes/app";
import { useFilesStore } from "@/stores/hermes/files";
import { useProfilesStore } from "@/stores/hermes/profiles";
import { useSessionBrowserPrefsStore } from "@/stores/hermes/session-browser-prefs";
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NInput,
  NModal,
  NSelect,
  NTooltip,
  NPopconfirm,
  NRadioButton,
  NRadioGroup,
  useDialog,
} from "naive-ui";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { copyToClipboard } from "@/utils/clipboard";
import { explicitSessionWorkspace, sessionWorkspaceLabel } from "@/utils/hermes/session-workspace";
import { listWorkspaceFolders } from "@/utils/hermes/workspace-folder-api";
import FolderPicker from "./FolderPicker.vue";
import ChatInput from "./ChatInput.vue";
import ConversationMonitorPane from "./ConversationMonitorPane.vue";
import MessageList from "./MessageList.vue";
import SessionListItem from "./SessionListItem.vue";
import RunPanel from "./RunPanel.vue";
import DetailPanel from "./DetailPanel.vue";
import TerminalPanel from "./TerminalPanel.vue";
import PageSidebarNav from "@/components/layout/PageSidebarNav.vue";
import ExpertCatalogView from "@/views/hermes/ExpertCatalogView.vue";
import AgentsView from "@/views/hermes/AgentsView.vue";
import JobsView from "@/views/hermes/JobsView.vue";
import SettingsView from "@/views/hermes/SettingsView.vue";
import AppsView from "@/views/hermes/AppsView.vue";
import FilesView from "@/views/hermes/FilesView.vue";
import SkillsView from "@/views/hermes/SkillsView.vue";
import CredentialsView from "@/views/hermes/CredentialsView.vue";
import { isStoredSuperAdmin } from "@/api/client";
import { agentDisplayName } from "@/utils/hermes/agent-identity";
import KpStarterBoard from "@/components/kippies/KpStarterBoard.vue";
import { prefillComposer } from "@/composables/useComposerPrefill";
import KpSplitText from "@/components/kippies/KpSplitText.vue";
import KpMascot from "@/components/kippies/KpMascot.vue";
import KpIcon from "@/components/kippies/KpIcon.vue";
import KpThemeSeg from "@/components/kippies/KpThemeSeg.vue";

const chatStore = useChatStore();
const appStore = useAppStore();
const filesStore = useFilesStore();
const profilesStore = useProfilesStore();
const sessionBrowserPrefsStore = useSessionBrowserPrefsStore();
const route = useRoute();
const router = useRouter();
const dialog = useDialog();
const { t } = useI18n();
const isSuperAdmin = computed(() => isStoredSuperAdmin());

const showRunPanel = ref(false);
const messageListRef = ref<InstanceType<typeof MessageList> | null>(null);
const chatContentWrapperRef = ref<HTMLElement | null>(null);
const showToolPanel = ref(false);
const toolPanelMounted = ref(false);
const activeToolPanel = ref<"files" | "terminal">("files");
const TOOL_PANEL_MIN_WIDTH = 360;
const TOOL_PANEL_DEFAULT_WIDTH = 560;
const TOOL_PANEL_STORAGE_KEY = "hermes.chat.toolPanelWidth";
const toolPanelWidth = ref(loadToolPanelWidth());
const toolResizeStart = ref<{ x: number; width: number } | null>(null);

const currentMode = ref<"chat" | "live">("chat");

// Batch selection mode
const isBatchMode = ref(false);
const selectedSessionKeys = ref<Set<string>>(new Set());
const showBatchDeleteConfirm = ref(false);
const isBatchDeleting = ref(false);

// Initialize synchronously from the media query so first paint is correct.
// On narrow viewports the session list is an absolute-positioned overlay
// (z-index 10) on top of the chat area; if we default to `true`, onMounted
// only flips it to `false` AFTER the first render, causing a visible flash
// where the session list covers the chat content ("auto-fixes after a
// moment" — that was the race).
const showSessions = ref(
  typeof window === "undefined" ||
    !window.matchMedia("(max-width: 768px)").matches,
);
let mobileQuery: MediaQueryList | null = null;
const isMobile = ref(false);
const toolPanelStyle = computed(() => ({
  width: isMobile.value ? "100%" : `${toolPanelWidth.value}px`,
}));
type ChatSidebarSurface =
  | "expert"
  | "agents"
  | "automation"
  | "settings"
  | "apps"
  | "files"
  | "skills"
  | "connectors";
const CHAT_SIDEBAR_SURFACES: readonly ChatSidebarSurface[] = [
  "expert",
  "agents",
  "automation",
  "settings",
  "apps",
  "files",
  "skills",
  "connectors",
];
const chatSidebarSurface = computed<ChatSidebarSurface | null>(() => {
  const surface = route.query.surface;
  if (typeof surface === "string" && (CHAT_SIDEBAR_SURFACES as readonly string[]).includes(surface))
    return surface as ChatSidebarSurface;
  return null;
});
const pageSidebarActive = computed(() =>
  chatSidebarSurface.value ||
  (chatStore.runtimeMode === "global_agent" ? "global" : "chat"),
);

function sessionHref(sessionId: string, profile?: string | null) {
  return router.resolve({
    name: chatStore.runtimeMode === "global_agent" ? "hermes.globalAgentSession" : "hermes.session",
    params: { sessionId },
    query: profile ? { profile } : undefined,
  }).href;
}

function openSessionInNewTab(sessionId: string) {
  if (typeof window === "undefined") return;
  window.open(sessionHref(sessionId, sessionProfile(sessionId)), "_blank", "noopener,noreferrer");
}

// The run panel points at whole messages (a step, the reasoning), not at a
// heading inside one, so the anchor is empty — the virtual list only uses it
// for the final fine alignment.
function handleRunPanelNavigate(messageId: string) {
  messageListRef.value?.scrollToAnchor(messageId, "");
  if (isMobile.value) showRunPanel.value = false;
}

function loadToolPanelWidth() {
  if (typeof window === "undefined") return TOOL_PANEL_DEFAULT_WIDTH;
  const saved = Number.parseInt(
    window.localStorage.getItem(TOOL_PANEL_STORAGE_KEY) || "",
    10,
  );
  return Number.isFinite(saved) ? Math.round(saved) : TOOL_PANEL_DEFAULT_WIDTH;
}

function toolPanelMaxWidth() {
  if (typeof window === "undefined") return 1180;
  if (isMobile.value) return window.innerWidth;
  const available = chatContentWrapperRef.value?.clientWidth || window.innerWidth;
  return Math.max(320, Math.min(Math.floor(available * 0.88), available - 120));
}

function clampToolPanelWidth(width: number) {
  const maxWidth = toolPanelMaxWidth();
  const minWidth = Math.min(TOOL_PANEL_MIN_WIDTH, maxWidth);
  return Math.min(maxWidth, Math.max(minWidth, Math.round(width)));
}

function handleToolPanelViewportResize() {
  if (isMobile.value) return;
  toolPanelWidth.value = clampToolPanelWidth(toolPanelWidth.value);
}

function handleToolResizeMove(event: PointerEvent) {
  const start = toolResizeStart.value;
  if (!start) return;
  const delta = start.x - event.clientX;
  toolPanelWidth.value = clampToolPanelWidth(start.width + delta);
}

function stopToolResize() {
  if (!toolResizeStart.value) return;
  toolResizeStart.value = null;
  window.removeEventListener("pointermove", handleToolResizeMove);
  window.removeEventListener("pointerup", stopToolResize);
  if (!isMobile.value) {
    window.localStorage.setItem(TOOL_PANEL_STORAGE_KEY, String(toolPanelWidth.value));
  }
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
}

function startToolResize(event: PointerEvent) {
  if (isMobile.value) return;
  event.preventDefault();
  toolResizeStart.value = {
    x: event.clientX,
    width: toolPanelWidth.value,
  };
  window.addEventListener("pointermove", handleToolResizeMove);
  window.addEventListener("pointerup", stopToolResize);
  document.body.style.userSelect = "none";
  document.body.style.cursor = "col-resize";
}

async function handleSessionClick(session: Session) {
  chatStore.clearSessionCompletedUnread(session.id);
  await router.push({
    name: chatStore.runtimeMode === "global_agent" ? "hermes.globalAgentSession" : "hermes.session",
    params: { sessionId: session.id },
    query: session.profile ? { profile: session.profile } : undefined,
  });
  if (mobileQuery?.matches) showSessions.value = false;
}

function handleMobileChange(e: MediaQueryListEvent | MediaQueryList) {
  isMobile.value = e.matches;
  if (e.matches && showSessions.value) {
    showSessions.value = false;
  }
}

function openPageSidebar() {
  showSessions.value = true;
}

onMounted(() => {
  mobileQuery = window.matchMedia("(max-width: 768px)");
  handleMobileChange(mobileQuery);
  mobileQuery.addEventListener("change", handleMobileChange);
  window.addEventListener("hermes:open-page-sidebar", openPageSidebar);
  window.addEventListener("resize", handleToolPanelViewportResize);
  handleToolPanelViewportResize();
  if (profilesStore.profiles.length === 0) {
    void profilesStore.fetchProfiles();
  }
});

onUnmounted(() => {
  mobileQuery?.removeEventListener("change", handleMobileChange);
  window.removeEventListener("hermes:open-page-sidebar", openPageSidebar);
  window.removeEventListener("resize", handleToolPanelViewportResize);
  stopToolResize();
});
watch(showToolPanel, async (visible) => {
  if (visible) toolPanelMounted.value = true;
  if (!visible || isMobile.value) return;
  await nextTick();
  handleToolPanelViewportResize();
});
watch(() => filesStore.previewPanelRequestedAt, () => {
  showToolPanel.value = true;
  activeToolPanel.value = "files";
});
// A chat HTML-artifact click requests the embedded browser; open the tool panel
// so DetailPanel mounts and (via its onMounted) loads the artifact in 浏览器 mode.
watch(() => filesStore.browserArtifactRequestedAt, () => {
  showToolPanel.value = true;
});

function closeToolPanel() {
  showToolPanel.value = false;
}

/**
 * Which session row is being renamed in place, if any.
 *
 * Renaming used to open an NModal over the list. It is now edited where it sits:
 * a dialog covers the row you are renaming (so you cannot see what its
 * neighbours are called) and is a second surface to keep in visual step for no
 * gain, when the thing being edited is already on screen. Only one row may edit
 * at a time, which is why this is a single id here and not a flag on the row.
 */
/**
 * One resident notice for this panel, replacing the toasts.
 *
 * Nearly every success here is already visible: the row leaves the list, the
 * title changes under the cursor, the dialog closes, the model pill repaints,
 * the browser announces the download. What is NOT visible, and so still gets
 * said: a partial batch delete (the survivors look identical to rows that were
 * never selected), a copy that never reached the clipboard, the once-per-session
 * model-family notice, and the reason we are about to navigate you to the
 * coding-agents page.
 *
 * Carries a tone so a failure and a piece of information do not look alike, is
 * dismissible, and never self-clears.
 */
const notice = ref<{ text: string; tone: "error" | "info" } | null>(null);

function setNotice(text: string, tone: "error" | "info") {
  notice.value = { text, tone };
}

/** Non-empty while a compressed export is being built. */
const exportingLabel = ref("");

const renamingSessionId = ref<string | null>(null);
const sessionProfileFilter = computed(() => chatStore.sessionProfileFilter);
const workspaceFilter = ref<{ profile: string; workspace: string } | null>(null);
const workspaceGroupsCollapsed = ref(false);
const profileFilterOptions = computed(() => [
  { label: t("chat.allProfiles"), value: "__all__" },
  ...profilesStore.profiles.map((profile) => ({
    label: agentDisplayName(profile, t("agentsHub.unnamedGroup")),
    value: profile.name,
  })),
]);

async function handleProfileFilterChange(value: string) {
  workspaceFilter.value = null;
  chatStore.sessionProfileFilter = value === "__all__" ? null : value;
  if (chatStore.sessionProfileFilter) {
    const ok = await profilesStore.switchProfile(chatStore.sessionProfileFilter);
    if (!ok) {
      setNotice(t("profiles.switchFailed"), "error");
      return;
    }
  }
  await chatStore.loadSessions(chatStore.sessionProfileFilter);
  const active = chatStore.activeSession;
  if (chatStore.sessionProfileFilter && (!active || active.profile !== chatStore.sessionProfileFilter)) {
    chatStore.clearActiveSession();
    await router.replace({ name: "hermes.chat" });
    return;
  }
  if (active?.id) {
    await router.replace({
      name: chatStore.runtimeMode === "global_agent" ? "hermes.globalAgentSession" : "hermes.session",
      params: { sessionId: active.id },
      query: active.profile ? { profile: active.profile } : undefined,
    });
  }
}

function sortSessionsForSidebar(items: Session[]): Session[] {
  return [...items].sort((a, b) => {
    const aLive = chatStore.isSessionLive(a.id);
    const bLive = chatStore.isSessionLive(b.id);
    if (aLive !== bLive) return aLive ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

function matchesWorkspaceFilter(session: Session) {
  const filter = workspaceFilter.value;
  return !filter || ((session.profile || "default") === filter.profile
    && explicitSessionWorkspace(session.workspace) === filter.workspace);
}

const workspaceGroups = computed(() => {
  const groups = new Map<string, { profile: string; workspace: string; count: number; latest: Session }>();
  for (const session of chatStore.sessions) {
    const workspace = explicitSessionWorkspace(session.workspace);
    if (!workspace) continue;
    const profile = session.profile || "default";
    const key = `${profile}\0${workspace}`;
    const current = groups.get(key);
    if (!current) groups.set(key, { profile, workspace, count: 1, latest: session });
    else {
      current.count += 1;
      if ((session.updatedAt || 0) > (current.latest.updatedAt || 0)) current.latest = session;
    }
  }
  return [...groups.values()].sort((a, b) => (b.latest.updatedAt || 0) - (a.latest.updatedAt || 0));
});

async function selectWorkspaceGroup(group: { profile: string; workspace: string; latest: Session }) {
  workspaceFilter.value = { profile: group.profile, workspace: group.workspace };
  await handleSessionClick(group.latest);
}

const pinnedSessions = computed(() =>
  sortSessionsForSidebar(
    chatStore.sessions.filter((session) =>
      sessionBrowserPrefsStore.isPinned(session.id) && matchesWorkspaceFilter(session),
    ),
  ),
);

const unpinnedSessions = computed(() =>
  sortSessionsForSidebar(
    chatStore.sessions.filter(
      (session) => !sessionBrowserPrefsStore.isPinned(session.id),
    ).filter(matchesWorkspaceFilter),
  ),
);

// --- 任务列表 grouped by agent -----------------------------------------------
// Rows are grouped under the agent that owns them, using the same section-header
// shape the workspace groups in the filter popover already use (12px medium
// label in --fg-disabled + a caret). Pinned rows stay OUT of the grouping: they
// are the "sorts first, no header" block, and burying a pinned row inside a
// collapsed group would hide the one thing the user pinned to keep in sight.
//
// Group order follows the newest session in each group, so the agent you just
// talked to is on top — the same rule sortSessionsForSidebar uses within a group
// and workspaceGroups uses between groups.
const collapsedAgentGroups = ref<Record<string, boolean>>({});

const sessionAgentGroups = computed(() => {
  const groups = new Map<string, { profile: string; label: string; sessions: Session[] }>();
  for (const session of unpinnedSessions.value) {
    const profile = session.profile || "default";
    const existing = groups.get(profile);
    if (existing) existing.sessions.push(session);
    else {
      const known = profilesStore.profiles.find((p) => p.name === profile);
      groups.set(profile, {
        profile,
        // An unknown profile (deleted agent, or a list that has not landed yet)
        // still gets its raw name rather than dropping its sessions.
        label: known ? agentDisplayName(known, t("agentsHub.unnamedGroup")) : profile,
        sessions: [session],
      });
    }
  }
  return [...groups.values()];
});

// One agent in play (a profile filter, or simply one agent) needs no header —
// it would label the only group there is.
const showAgentGroupHeaders = computed(() => sessionAgentGroups.value.length > 1);

function isAgentGroupCollapsed(profile: string): boolean {
  return showAgentGroupHeaders.value && !!collapsedAgentGroups.value[profile];
}

function toggleAgentGroup(profile: string) {
  collapsedAgentGroups.value = {
    ...collapsedAgentGroups.value,
    [profile]: !collapsedAgentGroups.value[profile],
  };
}

watch(
  () => [
    chatStore.sessionsLoaded,
    ...chatStore.sessions.map((session) => session.id),
  ],
  (value) => {
    const sessionIds = value.slice(1) as string[];
    if (!value[0] || sessionIds.length === 0) return;
    sessionBrowserPrefsStore.pruneMissingSessions(sessionIds);
  },
  { immediate: true },
);

const activeSessionTitle = computed(
  () => chatStore.activeSession?.title || t("chat.newChat"),
);

// A session with nothing in it is the home screen, not a chat with zero
// messages: no title bar, and the composer sits in the centered column under
// the wordmark rather than being pinned to the floor of the viewport.
const sidebarUserName = computed(
  () => profilesStore.currentUser?.name || profilesStore.activeProfileName || '',
);
const sidebarUserAvatar = computed(() => profilesStore.currentUser?.avatarUrl || '');
const sidebarUserInitial = computed(() => sidebarUserName.value.trim().charAt(0) || '?');

const isHomeState = computed(
  () => currentMode.value === "chat" && chatStore.messages.length === 0 && !chatStore.isStreaming,
);
// Avatars whose <img> failed to load (deleted/404 catalog asset): fall back to
// the initial instead of a broken image.
const failedExpertAvatars = ref(new Set<string>());
function onExpertAvatarError(avatar: string) {
  const next = new Set(failedExpertAvatars.value);
  next.add(avatar);
  failedExpertAvatars.value = next;
}

const activeSessionExpert = computed(() => {
  const session = chatStore.activeSession;
  if (!session?.expertId || session.source === "coding_agent" || session.source === "global_agent") return null;
  const label = session.expertLabel || session.expertId;
  const avatar = session.expertAvatar || "";
  return {
    label,
    avatar: avatar && !failedExpertAvatars.value.has(avatar) ? avatar : "",
    initial: Array.from(label.trim() || "?")[0],
  };
});

function openExpertCapabilities() {
  void router.push({ name: "hermes.chat", query: { surface: "expert" } });
}

const activeSessionModelLabel = computed(() => {
  const session = chatStore.activeSession;
  if (!session?.model) return t("models.selectModel");
  return appStore.displayModelName(session.model, session.provider);
});

// Prototype: the run-screen header shows the task title, which IS the first
// thing the user typed. Prefer the first user message (a typed slash command
// counts) and fall back to the stored session title while messages load.
const firstUserMessageTitle = computed(() => {
  const msg = chatStore.messages.find((m) => {
    const content = m.content?.trim();
    if (!content) return false;
    if (m.role === "user") return true;
    return m.role === "command" && content.startsWith("/");
  });
  return msg?.content?.trim() || "";
});

const headerTitle = computed(() =>
  currentMode.value === "live"
    ? t("chat.liveSessions")
    : chatSidebarSurface.value === "expert"
      ? t("sidebar.expert")
      : chatSidebarSurface.value === "automation"
        ? t("jobs.title")
    : firstUserMessageTitle.value || activeSessionTitle.value,
);

const headerStartedAt = computed(() => {
  if (currentMode.value !== "chat" || chatSidebarSurface.value) return "";
  const started = chatStore.activeSession?.createdAt;
  if (!started) return "";
  const d = new Date(started * (started < 1e12 ? 1000 : 1));
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
});

const showNewChatModal = ref(false);
const newChatAgent = ref<"hermes" | "claude-code" | "codex">("hermes");
const newChatAgentMode = ref<"global" | "scoped">("scoped");
const newChatProfile = ref<string>("default");
const newChatProvider = ref<string>("");
const newChatModel = ref<string>("");
const newChatBaseUrl = ref<string>("");
const newChatApiKey = ref<string>("");
const newChatApiMode = ref<"chat_completions" | "codex_responses" | "anthropic_messages">("codex_responses");
const newChatWorkspace = ref("");
const newChatLoading = ref(false);
const CODING_AGENT_AUTH_PROVIDER_KEYS = new Set(["openai-codex", "copilot", "xai-oauth", "nous", "google-gemini-cli", "claude-oauth"]);

const newChatAgentOptions = computed(() => [
  { label: "Hermes", value: "hermes" },
  ...(isSuperAdmin.value
    ? [
        { label: "Claude Code", value: "claude-code" },
        { label: "Codex", value: "codex" },
      ]
    : []),
]);

const newChatApiModeOptions = computed(() => [
  { label: t("codingAgents.protocolOpenAiChat"), value: "chat_completions" },
  { label: t("codingAgents.protocolOpenAiResponses"), value: "codex_responses" },
  { label: t("codingAgents.protocolAnthropicMessages"), value: "anthropic_messages" },
]);

const newChatAgentModeOptions = computed(() => [
  { label: t("codingAgents.launchModeGlobal"), value: "global" },
  { label: t("codingAgents.launchModeScoped"), value: "scoped" },
]);

function getModelGroupsForProfile(profile: string) {
  const profileModels = appStore.profileModelGroups.find(
    (entry) => entry.profile === profile,
  );
  return profileModels?.groups?.length ? profileModels.groups : appStore.modelGroups;
}

function isCodingAgentAuthProvider(provider?: string) {
  return CODING_AGENT_AUTH_PROVIDER_KEYS.has(String(provider || "").toLowerCase());
}

function isNewChatProviderAllowed(group: AvailableModelGroup) {
  if (!(newChatAgent.value !== "hermes" && newChatAgentMode.value === "scoped")) return true;
  return !isCodingAgentAuthProvider(group.provider);
}

function getSelectableModelGroupsForProfile(profile: string) {
  return getModelGroupsForProfile(profile).filter(isNewChatProviderAllowed);
}

function getDefaultModelForProfile(profile: string) {
  const groups = getSelectableModelGroupsForProfile(profile);
  const activeProfileName = profilesStore.activeProfileName || "default";
  const selectedProvider = appStore.selectedProvider || "";
  const selectedModel = appStore.selectedModel || "";
  const selectedGroup = selectedProvider
    ? groups.find((group) => group.provider === selectedProvider)
    : undefined;
  const selectedGroupCustomModels = selectedGroup ? appStore.customModels[selectedGroup.provider] || [] : [];
  if (
    profile === activeProfileName &&
    selectedGroup &&
    (selectedGroup.models.includes(selectedModel) || selectedGroupCustomModels.includes(selectedModel))
  ) {
    return {
      provider: selectedProvider,
      model: selectedModel,
    };
  }
  const profileModels = appStore.profileModelGroups.find(
    (entry) => entry.profile === profile,
  );
  const defaultProvider = profileModels?.default_provider || appStore.selectedProvider || "";
  const defaultModel = profileModels?.default || appStore.selectedModel || "";
  const providerGroup = defaultProvider
    ? groups.find((group) => group.provider === defaultProvider)
    : undefined;
  const providerCustomModels = providerGroup ? appStore.customModels[providerGroup.provider] || [] : [];
  if (providerGroup && (providerGroup.models.includes(defaultModel) || providerCustomModels.includes(defaultModel))) {
    return {
      provider: providerGroup.provider,
      model: defaultModel,
    };
  }
  const fallbackGroup = groups.find((group) => group.models.length > 0);
  return {
    provider: fallbackGroup?.provider || "",
    model: fallbackGroup?.models[0] || "",
  };
}

const newChatProfileOptions = computed(() =>
  (profilesStore.profiles.length > 0 ? profilesStore.profiles : [{ name: "default" }]).map((profile) => ({
    label: agentDisplayName(profile, t("agentsHub.unnamedGroup")),
    value: profile.name,
  })),
);

const newChatModelGroups = computed(() => {
  return getSelectableModelGroupsForProfile(newChatProfile.value);
});

const newChatProviderOptions = computed(() =>
  newChatModelGroups.value.map((group) => ({
    label: group.label || group.provider,
    value: group.provider,
  })),
);

const newChatModelOptions = computed(() => {
  const group = newChatModelGroups.value.find(
    (item) => item.provider === newChatProvider.value,
  );
  return (group?.models || []).map((model) => ({
    label: appStore.displayModelName(model, group?.provider),
    value: model,
  }));
});

const selectedNewChatProviderGroup = computed(() =>
  newChatModelGroups.value.find((item) => item.provider === newChatProvider.value),
);

const isNewChatCodingAgent = computed(() => newChatAgent.value !== "hermes");
const isNewChatGlobalCodingAgent = computed(() =>
  isNewChatCodingAgent.value && newChatAgentMode.value === "global",
);
const newChatUsesProviderModel = computed(() => !isNewChatGlobalCodingAgent.value);
const newChatNeedsBaseUrl = computed(() =>
  isNewChatCodingAgent.value && newChatAgentMode.value === "scoped" && !selectedNewChatProviderGroup.value?.base_url,
);
const newChatNeedsApiKey = computed(() =>
  isNewChatCodingAgent.value && newChatAgentMode.value === "scoped" && !selectedNewChatProviderGroup.value?.api_key,
);
const canConfirmNewChat = computed(() => {
  if (!newChatProfile.value) return false;
  if (!newChatUsesProviderModel.value) return true;
  if (!newChatProvider.value || !newChatModel.value) return false;
  if (!isNewChatCodingAgent.value) return true;
  if (!newChatApiMode.value) return false;
  if (newChatNeedsBaseUrl.value && !newChatBaseUrl.value.trim()) return false;
  if (newChatNeedsApiKey.value && !newChatApiKey.value.trim()) return false;
  return true;
});

function defaultNewChatApiMode(group?: AvailableModelGroup) {
  if (group?.api_mode) return group.api_mode;
  const providerKey = String(group?.provider || newChatProvider.value || "").toLowerCase();
  const baseUrl = String(group?.base_url || newChatBaseUrl.value || "").toLowerCase();
  if (
    providerKey.includes("claude") ||
    providerKey === "anthropic" ||
    baseUrl.includes("anthropic") ||
    baseUrl.includes("/anthropic")
  ) {
    return "anthropic_messages";
  }
  if (
    providerKey === "deepseek" ||
    providerKey === "lmstudio" ||
    baseUrl.includes("deepseek") ||
    baseUrl.includes("127.0.0.1") ||
    baseUrl.includes("localhost")
  ) {
    return "chat_completions";
  }
  return "codex_responses";
}

function syncNewChatApiMode() {
  newChatApiMode.value = defaultNewChatApiMode(selectedNewChatProviderGroup.value);
}

function syncNewChatModelSelection() {
  const defaults = getDefaultModelForProfile(newChatProfile.value);
  newChatProvider.value = defaults.provider;
  newChatModel.value = defaults.model;
  newChatBaseUrl.value = "";
  newChatApiKey.value = "";
  syncNewChatApiMode();
}

function ensureNewChatProviderSelection() {
  if (!newChatUsesProviderModel.value) return;
  const currentGroup = selectedNewChatProviderGroup.value;
  if (currentGroup && currentGroup.models.includes(newChatModel.value)) {
    syncNewChatApiMode();
    return;
  }
  syncNewChatModelSelection();
}

watch(
  () => [newChatAgent.value, newChatAgentMode.value, newChatProfile.value],
  () => ensureNewChatProviderSelection(),
);

watch(isSuperAdmin, (canUseHostAgents) => {
  if (!canUseHostAgents && newChatAgent.value !== "hermes") {
    newChatAgent.value = "hermes";
  }
}, { immediate: true });

function resetNewChatInteractionState() {
  isBatchMode.value = false;
  selectedSessionKeys.value.clear();
  showBatchDeleteConfirm.value = false;
}

function resolveDefaultNewChatProfile() {
  const profileNames = new Set(profilesStore.profiles.map((profile) => profile.name));
  const activeName = profilesStore.activeProfileName || "";
  if (activeName && profileNames.has(activeName)) return activeName;
  return (
    profilesStore.profiles.find((profile) => profile.active)?.name ||
    profilesStore.profiles[0]?.name ||
    ""
  );
}

async function ensureNewChatDefaultsLoaded() {
  if (profilesStore.profiles.length === 0) await profilesStore.fetchProfiles();
  if (appStore.modelGroups.length === 0 && appStore.profileModelGroups.length === 0) {
    await appStore.loadModels();
  }
}

async function createNewChatSession(options: {
  profile?: string;
  provider?: string;
  model?: string;
  source?: "api_server" | "cli" | "coding_agent" | "global_agent";
  agent?: "hermes" | "claude" | "codex";
  codingAgentId?: "claude-code" | "codex";
  codingAgentMode?: "global" | "scoped";
  workspace?: string | null;
  baseUrl?: string;
  apiKey?: string;
  apiMode?: "chat_completions" | "codex_responses" | "anthropic_messages";
}) {
  const session = chatStore.newChat(options);
  const profile = session.profile || options.profile;
  const routeName = options.source === "global_agent" || (!options.source && chatStore.runtimeMode === "global_agent")
    ? "hermes.globalAgentSession"
    : "hermes.session";
  await router.push({
    name: routeName,
    params: { sessionId: session.id },
    query: profile ? { profile } : undefined,
  });
  return session;
}

async function openNewChatModal() {
  resetNewChatInteractionState();
  showNewChatModal.value = true;
  newChatLoading.value = true;
  try {
    await ensureNewChatDefaultsLoaded();
    newChatWorkspace.value = "";
    newChatProfile.value = resolveDefaultNewChatProfile();
    syncNewChatModelSelection();
  } finally {
    newChatLoading.value = false;
  }
}

async function handleNewChatPrimary() {
  // Prototype onNewTask is instant: a client-side draft appears at once and its
  // empty composer is ready — no waiting, no resume load. The old path first
  // AWAITED model defaults and then resumed the session over the socket (the
  // "wait a few seconds, then jump to another page" the draft is created
  // synchronously via newChat() — which now skips the pointless resume for a
  // fresh draft (see chat store) — so the empty composer shows immediately. We
  // only replace the URL to the draft's own route; the router watcher sees it is
  // already the active session and does not reload sessions. The server session
  // is created on the first send. The superadmin coding-agent config modal stays
  // behind the secondary entry (handleNewChatPrimaryConfig).
  const profile = workspaceFilter.value?.profile || resolveDefaultNewChatProfile();
  // No authorized profile resolved (list unavailable, or every switch failed):
  // do NOTHING. Creating a session with an empty profile used to land on an
  // ambient server-side default, which is exactly the cross-tenant hole
  // agents-digital-employee-conflicts closed.
  if (!profile) return;
  const defaults = getDefaultModelForProfile(profile);
  const session = chatStore.newChat({
    profile,
    provider: defaults.provider || undefined,
    model: defaults.model || undefined,
    source: "cli",
    agent: "hermes",
    workspace: workspaceFilter.value?.workspace || null,
  });
  // source is always "cli" here, so this is an ordinary session route (mirrors
  // createNewChatSession's routeName logic, which keys off source, not runtime).
  await router.replace({
    name: "hermes.session",
    params: { sessionId: session.id },
    query: session.profile ? { profile: session.profile } : undefined,
  });
  // Mirrors handleSessionClick: on mobile the session list is a full-screen
  // overlay above the composer, so picking "新建任务" must close it too —
  // otherwise the new draft is created but hidden behind the still-open list,
  // which reads as "nothing happened" / landing in the wrong place.
  if (mobileQuery?.matches) showSessions.value = false;
}

async function handleNewChatPrimaryConfig() {
  await openNewChatModal();
}

function handleNewChatProfileChange(value: string) {
  newChatProfile.value = value;
  syncNewChatModelSelection();
}

function handleNewChatProviderChange(value: string) {
  newChatProvider.value = value;
  newChatModel.value = newChatModelOptions.value[0]?.value || "";
  newChatBaseUrl.value = "";
  newChatApiKey.value = "";
  syncNewChatApiMode();
}

async function confirmNewChat() {
  if (newChatAgent.value !== "hermes") {
    newChatLoading.value = true;
    try {
      const agentId = newChatAgent.value as CodingAgentId;
      const status = await fetchCodingAgentsStatus();
      const tool = status.tools.find((item) => item.id === agentId);
      if (!tool?.installed) {
        const fallbackName = agentId === "codex" ? "Codex" : "Claude Code";
        setNotice(t("codingAgents.installRequired", { agent: tool?.name || fallbackName }), "info");
        showNewChatModal.value = false;
        await router.push({ name: "hermes.codingAgents" });
        return;
      }
    } catch {
      setNotice(t("codingAgents.loadFailed"), "error");
      return;
    } finally {
      newChatLoading.value = false;
    }
  }

  const group = selectedNewChatProviderGroup.value;
  const source = newChatAgent.value === "hermes"
    ? (chatStore.runtimeMode === "global_agent" ? "global_agent" : "cli")
    : "coding_agent";
  const isGlobalCodingAgent = source === "coding_agent" && newChatAgentMode.value === "global";
  const agent = newChatAgent.value === "codex"
    ? "codex"
    : newChatAgent.value === "claude-code"
      ? "claude"
      : "hermes";
  await createNewChatSession({
    profile: newChatProfile.value,
    provider: isGlobalCodingAgent ? undefined : newChatProvider.value,
    model: isGlobalCodingAgent ? undefined : newChatModel.value,
    source,
    agent,
    codingAgentId: newChatAgent.value === "hermes" ? undefined : newChatAgent.value,
    codingAgentMode: source === "coding_agent" ? newChatAgentMode.value : undefined,
    workspace: newChatWorkspace.value || null,
    baseUrl: source === "coding_agent" && !isGlobalCodingAgent ? group?.base_url || newChatBaseUrl.value.trim() || undefined : undefined,
    apiKey: source === "coding_agent" && !isGlobalCodingAgent ? group?.api_key || newChatApiKey.value.trim() || undefined : undefined,
    apiMode: source === "coding_agent" && !isGlobalCodingAgent ? newChatApiMode.value : undefined,
  });
  showNewChatModal.value = false;
}

function sessionProfile(sessionId: string): string | null {
  return chatStore.sessions.find((session) => session.id === sessionId)?.profile || null;
}

function buildSessionUrl(sessionId: string, profile?: string | null): string {
  const href = router.resolve({
    name: chatStore.runtimeMode === "global_agent" ? "hermes.globalAgentSession" : "hermes.session",
    params: { sessionId },
    query: profile ? { profile } : undefined,
  }).href;
  return `${window.location.origin}${window.location.pathname}${href}`;
}

async function copySessionLink(id?: string) {
  const sessionId = id || chatStore.activeSessionId;
  if (sessionId) {
    const ok = await copyToClipboard(buildSessionUrl(sessionId, sessionProfile(sessionId)));
    if (!ok) setNotice(t("chat.copyFailed"), "error");
  }
}

async function copySessionId(id?: string) {
  const sessionId = id || chatStore.activeSessionId;
  if (sessionId) {
    const ok = await copyToClipboard(sessionId);
    if (!ok) setNotice(t("chat.copyFailed"), "error");
  }
}

async function handleDeleteSession(id: string) {
  const ok = await chatStore.deleteSession(id);
  if (!ok) {
    setNotice(t("common.deleteFailed"), "error");
    return;
  }
  // The row leaving the list is the report.
  sessionBrowserPrefsStore.removePinned(id);
}

function toggleBatchMode() {
  if (isBatchDeleting.value) return;
  isBatchMode.value = !isBatchMode.value;
  if (!isBatchMode.value) {
    selectedSessionKeys.value.clear();
    showBatchDeleteConfirm.value = false;
  }
}

function sessionSelectionKey(session: Pick<Session, "id" | "profile">): string {
  return `${session.profile || "default"}\u0000${session.id}`;
}

function toggleSessionSelection(session: Session) {
  if (isBatchDeleting.value) return;
  const key = sessionSelectionKey(session);
  if (selectedSessionKeys.value.has(key)) {
    selectedSessionKeys.value.delete(key);
  } else {
    selectedSessionKeys.value.add(key);
  }
  selectedSessionKeys.value = new Set(selectedSessionKeys.value);
  if (selectedSessionKeys.value.size === 0) {
    showBatchDeleteConfirm.value = false;
  }
}

function isSessionSelected(session: Session): boolean {
  return selectedSessionKeys.value.has(sessionSelectionKey(session));
}

async function handleBatchDelete() {
  if (selectedSessionKeys.value.size === 0 || isBatchDeleting.value) return;

  const sessionsByKey = new Map(chatStore.sessions.map((session) => [sessionSelectionKey(session), session]));
  const targets = Array.from(selectedSessionKeys.value)
    .map((key) => sessionsByKey.get(key))
    .filter((session): session is Session => Boolean(session))
    .map((session) => ({ id: session.id, profile: session.profile || null }));
  if (targets.length === 0) return;
  isBatchDeleting.value = true;
  try {
    const result = await batchDeleteSessions(targets);
    if (result.deleted > 0) {
      // Remove from pinned sessions
      for (const target of targets) {
        sessionBrowserPrefsStore.removePinned(target.id);
      }

      // Remove deleted sessions from local store (without calling API again)
      // Use loadSessions to refresh from server instead of manual filtering
      await chatStore.loadSessions(chatStore.sessionProfileFilter);

      // The rows disappearing reports the ones that worked. A PARTIAL failure is
      // invisible — the survivors look no different from rows never selected —
      // so only that gets said.
      if (result.failed > 0) {
        setNotice(t("chat.batchDeletePartial", { failed: result.failed }), "error");
      }
    } else {
      setNotice(t("chat.batchDeleteFailed"), "error");
    }
  } catch {
    setNotice(t("chat.batchDeleteFailed"), "error");
  } finally {
    isBatchDeleting.value = false;
    showBatchDeleteConfirm.value = false;
    isBatchMode.value = false;
    selectedSessionKeys.value.clear();
  }
}

function handleBatchDeleteConfirm() {
  void handleBatchDelete();
  return false;
}

function selectAllSessions() {
  if (isBatchDeleting.value) return;
  selectedSessionKeys.value.clear();
  for (const session of chatStore.sessions) {
    if (session.id !== chatStore.activeSessionId) {
      selectedSessionKeys.value.add(sessionSelectionKey(session));
    }
  }
  selectedSessionKeys.value = new Set(selectedSessionKeys.value);
}

const selectedCount = computed(() => selectedSessionKeys.value.size);
const canSelectAll = computed(() => {
  return chatStore.sessions.some(s => s.id !== chatStore.activeSessionId);
});

const contextSessionId = ref<string | null>(null);
const contextSessionPinned = computed(() =>
  contextSessionId.value
    ? sessionBrowserPrefsStore.isPinned(contextSessionId.value)
    : false,
);

// Prototype TaskMenu, verbatim: a fixed 176px card (pad 6, r-card,
// notification shadow, fadein) of exactly four 36px icon+label rows —
// 置顶 / 重命名 / 工作区(arrow → hover submenu) / divider / 删除(danger).
// The workspace row behaves like the prototype's 移动到项目: no click action,
// hovering it opens a +180px submenu of targets and clicking one applies
// directly — no modal. The old extras (set model / export / links / archive)
// were cut on the strict-parity pass; their handler keys still work if ever
// re-added.
type SessionMenuEntry =
  | { divider: true }
  | { key: string; label: string; icon: string; danger?: boolean; arrow?: boolean };

const sessionMenuItems = computed<SessionMenuEntry[]>(() => [
  {
    key: "pin",
    label: t(contextSessionPinned.value ? "chat.unpin" : "chat.pin"),
    icon: contextSessionPinned.value ? "full_flag" : "line_top",
  },
  { key: "rename", label: t("chat.rename"), icon: "line_write" },
  { key: "workspace", label: t("chat.setWorkspace"), icon: "line_drawer", arrow: true },
  { divider: true },
  { key: "delete", label: t("common.delete"), icon: "line_delete", danger: true },
]);

const sessionMenuEl = ref<HTMLElement | null>(null);
const sessionSubmenuEl = ref<HTMLElement | null>(null);
const sessionMenuStyle = computed(() => ({
  left: `${contextMenuX.value}px`,
  top: `${contextMenuY.value}px`,
}));
// Aligns with the "设置工作区" row (3rd in sessionMenuItems: pin, rename, then
// this one — each 36px, under the menu's 6px top padding). Reusing the menu's
// own top edge here would float the submenu up near 置顶 instead of the row
// that actually opened it.
const sessionSubmenuStyle = computed(() => ({
  left: `${contextMenuX.value + 180}px`,
  top: `${contextMenuY.value + 6 + 36 * 2}px`,
}));

// Workspace submenu targets — the profile's top-level workspace folders (the
// same list the FolderPicker starts from), fetched when the menu opens.
const showWorkspaceSubmenu = ref(false);
const workspaceMenuFolders = ref<{ name: string; path: string }[]>([]);
const workspaceMenuLoading = ref(false);

async function loadWorkspaceMenuFolders() {
  workspaceMenuLoading.value = true;
  try {
    // Plane-aware: chat plane doesn't have `/api/hermes/workspace/folders` on its
    // allow list (403s there), so this goes through the same helper FolderPicker
    // uses — it picks `/api/hermes/files/*` under chat plane automatically.
    const res = await listWorkspaceFolders();
    workspaceMenuFolders.value = res.folders || [];
  } catch {
    workspaceMenuFolders.value = [];
  } finally {
    workspaceMenuLoading.value = false;
  }
}

function onSessionMenuEnter(entry: SessionMenuEntry) {
  if ("divider" in entry) return;
  showWorkspaceSubmenu.value = !!entry.arrow;
}

function onSessionMenuClick(entry: SessionMenuEntry) {
  if ("divider" in entry || entry.arrow) return;
  void handleContextMenuSelect(entry.key);
}

// Clicking a submenu row applies the workspace immediately (prototype: pick a
// target, done) — reusing the modal's confirm logic wholesale.
async function applyWorkspaceFromMenu(path: string) {
  const id = contextSessionId.value;
  closeContextMenu();
  if (!id) return;
  workspaceSessionId.value = id;
  workspaceValue.value = path;
  await handleWorkspaceConfirm();
}

function openSettingsPage() {
  // Settings opens as a surface inside the chat shell so the sidebar stays put
  // (prototype behaviour). The standalone hermes.settings route is kept for
  // AppSidebar / admin / deep links.
  router.push({ name: "hermes.chat", query: { surface: "settings" } });
}

// Bottom user area → a small popover UserMenu. Built as a plain fixed-position
// element (per the DS "menus are position:fixed + JS coords" rule) rather than
// a naive-ui popover: the trigger row must stay in the DOM unconditionally, and
// a teleporting wrapper would also drop the avatar/name in the unit tests.
const showUserMenu = ref(false);
const userMenuStyle = ref<Record<string, string>>({});
const userMenuEl = ref<HTMLElement | null>(null);

function openUserMenu(e: MouseEvent) {
  const anchor = e.currentTarget as HTMLElement | null;
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  // Align to the SIDEBAR, not the trigger: the menu starts at the rail's left
  // inset and is exactly as wide as the rail's content box (248 - 12*2 = 224),
  // so it reads as the account area growing out of the rail.
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

// Dismissal matches the prototype: mousedown anywhere outside closes the menu
// (the click still lands on its target — no swallowing backdrop) and Escape
// closes it. The trigger rows are excluded so their own click handler toggles.
function onUserMenuAway(e: MouseEvent) {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  if (userMenuEl.value?.contains(target)) return;
  if (target.closest?.(".sidebar-user__trigger, .sidebar-user__avatar--rail")) return;
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
  openSettingsPage();
}

const userHandleCopied = ref(false);
let userHandleCopyTimer: ReturnType<typeof setTimeout> | null = null;

function copyUserHandle() {
  const handle = profilesStore.currentUser?.username || sidebarUserName.value;
  if (!handle) return;
  void navigator.clipboard?.writeText(handle).catch(() => {});
  userHandleCopied.value = true;
  if (userHandleCopyTimer) clearTimeout(userHandleCopyTimer);
  userHandleCopyTimer = setTimeout(() => {
    userHandleCopied.value = false;
  }, 1400);
}

// Mirrors AppSidebar.handleLogout: best-effort Feishu session clear, then wipe
// local state and reload regardless of the server call's outcome.
async function handleLogout() {
  closeUserMenu();
  try {
    await fetch("/api/auth/feishu/logout", {
      method: "POST",
      credentials: "same-origin",
    });
  } catch {
    // Local logout should still clear stale browser state if the call fails.
  } finally {
    localStorage.clear();
    window.location.reload();
  }
}

// 筛选 popover — the prototype's task-list header carries exactly one control
// (the filter icon), so profile filtering, workspace groups, batch management
// and the full-history page all live behind it. Fixed-position and in-tree
// (not teleported) for the same reasons as the UserMenu.
const showFilterPanel = ref(false);
const filterPanelStyle = ref<Record<string, string>>({});

function toggleFilterPanel(e: MouseEvent) {
  if (showFilterPanel.value) {
    showFilterPanel.value = false;
    return;
  }
  const anchor = e.currentTarget as HTMLElement | null;
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  // Align to the sidebar's left inset (like the UserMenu) so the panel reads
  // as the rail unfolding rather than a floating card.
  const aside = anchor.closest("aside");
  const left = aside ? aside.getBoundingClientRect().left + 12 : r.left;
  filterPanelStyle.value = {
    left: `${Math.round(Math.max(12, left))}px`,
    top: `${Math.round(r.bottom + 4)}px`,
  };
  showFilterPanel.value = true;
}

function closeFilterPanel() {
  showFilterPanel.value = false;
}

function startBatchFromFilter() {
  closeFilterPanel();
  if (!isBatchMode.value) toggleBatchMode();
}

function openHistoryPage() {
  closeFilterPanel();
  void router.push({ name: "hermes.history" });
}

const SESSION_MENU_W = 176;

function handleContextMenu(e: MouseEvent, sessionId: string) {
  e.preventDefault();
  // Re-clicking the same row's "⋯" toggles the menu closed (prototype).
  if (showContextMenu.value && contextSessionId.value === sessionId && e.type === "click") {
    closeContextMenu();
    return;
  }
  contextSessionId.value = sessionId;
  // Prototype TaskMenu placement: at the trigger's right edge (+4), clamped
  // into the viewport; flips up when it can't fit down (H = 4 rows + divider
  // + padding, the prototype's own formula).
  const anchor = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
  let left: number;
  let top: number;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    left = r.right + 4;
    top = r.top;
  } else {
    left = e.clientX;
    top = e.clientY;
  }
  const menuHeight = 4 * 36 + 21;
  // Reserve room for the workspace hover submenu at +180 (prototype formula).
  contextMenuX.value = Math.max(12, Math.min(left, window.innerWidth - SESSION_MENU_W * 2 - 12));
  contextMenuY.value = Math.max(12, Math.min(top, window.innerHeight - menuHeight - 12));
  showContextMenu.value = true;
  void loadWorkspaceMenuFolders();
}

const showContextMenu = ref(false);
const contextMenuX = ref(0);
const contextMenuY = ref(0);

function closeContextMenu() {
  showContextMenu.value = false;
  showWorkspaceSubmenu.value = false;
}

// Prototype dismissal: mousedown-away and Escape close it, and — because the
// menu is fixed while its row scrolls — any scroll or resize closes it too
// (an anchored menu drifting apart from its row is worse than closing).
function onSessionMenuAway(e: MouseEvent) {
  const target = e.target as Node | null;
  if (!target) return;
  if (sessionMenuEl.value?.contains(target)) return;
  if (sessionSubmenuEl.value?.contains(target)) return;
  // Row "⋯" triggers handle open/toggle/re-anchor themselves on click.
  if ((target as HTMLElement).closest?.(".session-item-menu")) return;
  closeContextMenu();
}

function onSessionMenuKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") closeContextMenu();
}

watch(showContextMenu, (open) => {
  if (open) {
    document.addEventListener("mousedown", onSessionMenuAway, true);
    document.addEventListener("keydown", onSessionMenuKeydown);
    window.addEventListener("scroll", closeContextMenu, true);
    window.addEventListener("resize", closeContextMenu);
  } else {
    document.removeEventListener("mousedown", onSessionMenuAway, true);
    document.removeEventListener("keydown", onSessionMenuKeydown);
    window.removeEventListener("scroll", closeContextMenu, true);
    window.removeEventListener("resize", closeContextMenu);
  }
});

onUnmounted(() => {
  document.removeEventListener("mousedown", onSessionMenuAway, true);
  document.removeEventListener("keydown", onSessionMenuKeydown);
  window.removeEventListener("scroll", closeContextMenu, true);
  window.removeEventListener("resize", closeContextMenu);
});

function parseExportKey(key: string): { mode: 'full' | 'compressed'; ext: 'json' | 'txt' } | null {
  if (key === 'export-full-json') return { mode: 'full', ext: 'json' }
  if (key === 'export-full-txt') return { mode: 'full', ext: 'txt' }
  if (key === 'export-compressed-json') return { mode: 'compressed', ext: 'json' }
  if (key === 'export-compressed-txt') return { mode: 'compressed', ext: 'txt' }
  return null
}

async function handleContextMenuSelect(key: string) {
  closeContextMenu();
  if (!contextSessionId.value) return;
  if (key === "pin") {
    sessionBrowserPrefsStore.togglePinned(contextSessionId.value);
    return;
  }
  if (key === "copy-link") {
    copySessionLink(contextSessionId.value);
  } else if (key === "copy-id") {
    copySessionId(contextSessionId.value);
  } else if (key === "open-link") {
    openSessionInNewTab(contextSessionId.value);
  } else if (key === "archive") {
    const archived = await chatStore.archiveSession(contextSessionId.value);
    if (archived) {
      // The row leaving the list is the report.
      sessionBrowserPrefsStore.removePinned(contextSessionId.value);
    } else {
      setNotice(t("chat.archiveFailed"), "error");
    }
  } else if (parseExportKey(key)) {
    const { mode, ext } = parseExportKey(key)!;
    // Compressing can take a while, so it gets a resident line rather than a
    // toast — and the finished download is announced by the browser itself.
    exportingLabel.value = mode === "compressed" ? t("chat.exportCompressing") : "";
    try {
      await exportSession(contextSessionId.value, mode, ext);
    } catch {
      setNotice(t("chat.exportFailed"), "error");
    } finally {
      exportingLabel.value = "";
    }
  } else if (key === "delete") {
    const id = contextSessionId.value;
    dialog.warning({
      title: t("chat.deleteSession"),
      positiveText: t("common.ok"),
      negativeText: t("common.cancel"),
      onPositiveClick: () => {
        void handleDeleteSession(id);
      },
    });
  } else if (key === "workspace") {
    const session = chatStore.sessions.find(
      (s) => s.id === contextSessionId.value,
    );
    workspaceSessionId.value = contextSessionId.value;
    workspaceValue.value = session?.workspace || "";
    showWorkspaceModal.value = true;
  } else if (key === "model") {
    await openSessionModelModal(contextSessionId.value);
  } else if (key === "rename") {
    // The row itself becomes writable — no dialog. Which row is editing is list
    // state (only one at a time), so it lives here rather than in the row.
    renamingSessionId.value = contextSessionId.value;
  }
}

async function handleRenameCommit(sessionId: string, title: string) {
  renamingSessionId.value = null;
  const ok = await renameSession(sessionId, title);
  if (ok) {
    const session = chatStore.sessions.find((s) => s.id === sessionId);
    if (session) session.title = title;
    if (chatStore.activeSession?.id === sessionId) {
      chatStore.activeSession.title = title;
    }
    // The row's own title changing is the report.
  } else {
    setNotice(t("chat.renameFailed"), "error");
  }
}

const showWorkspaceModal = ref(false);
const workspaceValue = ref("");
const workspaceSessionId = ref<string | null>(null);
// The chip states what THIS session is bound to and nothing else. It must not
// borrow the sidebar filter: an unbound session opened while a workspace filter is
// active would otherwise advertise a binding that does not exist, and the picker
// would pre-fill it — one blind OK and the user is bound to a folder never chosen.
// The filter only preselects a workspace for a session being CREATED (below).

// A locally created row can carry no `source` at all, so the visibility rule and
// the rebind rule must read it the same way or they disagree about the same session.
// Which sessions are ordinary Hermes chats — the ones a workspace can be bound to.
// Deliberately an EXCLUDE list: the WebUI creates sessions client-side as "cli" but
// the server persists them as "api_server", so an include list of {cli} makes the
// workspace entry point vanish the moment a session is read back (refresh, opening
// it from history, list hydration). Everything that is not a coding-agent or a
// global-agent run is a chat session here.
const composerWorkspace = computed(() => explicitSessionWorkspace(chatStore.activeSession?.workspace) || "");

function openComposerWorkspacePicker() {
  const session = chatStore.activeSession;
  if (!isHermesChatSession(session)) return;
  workspaceSessionId.value = session?.id || null;
  workspaceValue.value = composerWorkspace.value || (session?.id ? "" : workspaceFilter.value?.workspace || "");
  showWorkspaceModal.value = true;
}

function isHermesChatSession(session?: { source?: string | null } | null): boolean {
  const source = session?.source || "";
  return source !== "coding_agent" && source !== "global_agent";
}

async function handleWorkspaceConfirm() {
  if (!workspaceSessionId.value) {
    await ensureNewChatDefaultsLoaded();
    const profile = workspaceFilter.value?.profile || resolveDefaultNewChatProfile();
    const defaults = getDefaultModelForProfile(profile);
    const nextWorkspace = workspaceValue.value || null;
    await createNewChatSession({
      profile,
      provider: defaults.provider || undefined,
      model: defaults.model || undefined,
      source: "cli",
      agent: "hermes",
      workspace: nextWorkspace,
    });
    workspaceFilter.value = nextWorkspace ? { profile, workspace: nextWorkspace } : null;
    showWorkspaceModal.value = false;
    return;
  }
  const current = chatStore.sessions.find((s) => s.id === workspaceSessionId.value)
    || (chatStore.activeSession?.id === workspaceSessionId.value ? chatStore.activeSession : undefined);
  const nextWorkspace = workspaceValue.value || null;
  if (!current || explicitSessionWorkspace(current.workspace) === nextWorkspace) {
    showWorkspaceModal.value = false;
    return;
  }
  if (isHermesChatSession(current) && (current.messageCount || current.messages.length) > 0) {
    await createNewChatSession({
      profile: current.profile,
      provider: current.provider,
      model: current.model,
      source: "cli",
      agent: "hermes",
      workspace: nextWorkspace,
    });
    workspaceFilter.value = nextWorkspace
      ? { profile: current.profile || "default", workspace: nextWorkspace }
      : null;
    showWorkspaceModal.value = false;
    return;
  }
  const ok = await setSessionWorkspace(
    workspaceSessionId.value,
    nextWorkspace,
  );
  if (ok) {
    const session = chatStore.sessions.find(
      (s) => s.id === workspaceSessionId.value,
    );
    if (session) session.workspace = nextWorkspace;
    if (chatStore.activeSession?.id === workspaceSessionId.value) {
      chatStore.activeSession.workspace = nextWorkspace;
    }
    // The workspace chip on the session updates, which is the report.
  } else {
    setNotice(t("chat.workspaceSetFailed"), "error");
  }
  showWorkspaceModal.value = false;
}

const showSessionModelModal = ref(false);
const showSessionModelModeModal = ref(false);
const sessionModelSessionId = ref<string | null>(null);
const sessionModelSearch = ref("");
const sessionModelCollapsedGroups = ref<Record<string, boolean>>({});
const sessionModelValue = ref("");
const sessionModelProvider = ref("");
const sessionModelCustomInput = ref("");
const sessionModelCustomProvider = ref("");
const sessionModelApiMode = ref<CodingAgentApiMode>("codex_responses");
const pendingSessionModelSwitch = ref<{ model: string; provider: string } | null>(null);

const sessionModelProfile = computed<string | null>(() => {
  const session = chatStore.sessions.find((s) => s.id === sessionModelSessionId.value);
  return session?.profile || null;
});

const sessionModelSession = computed(() =>
  chatStore.sessions.find((s) => s.id === sessionModelSessionId.value) ||
  (chatStore.activeSession?.id === sessionModelSessionId.value ? chatStore.activeSession : undefined),
);

const isSessionModelScopedCodingAgent = computed(() =>
  sessionModelSession.value?.source === "coding_agent" &&
  sessionModelSession.value?.codingAgentMode !== "global",
);

// Reasoning effort is NOT a user-facing choice. It follows whatever the model
// (agent config) is set to, so the client never sends an override and the model
// picker offers no effort control — see the model menu below, which is
// model-only.

const sessionModelBaseGroups = computed(() =>
  sessionModelProfile.value
    ? getModelGroupsForProfile(sessionModelProfile.value).filter((group) => (
        !isSessionModelScopedCodingAgent.value || !isCodingAgentAuthProvider(group.provider)
      ))
    : [],
);

const sessionModelProviderOptions = computed(() =>
  sessionModelBaseGroups.value.map((group) => ({ label: group.label, value: group.provider })),
);

const sessionModelGroupsWithCustom = computed(() =>
  sessionModelBaseGroups.value.map((group) => ({
    ...group,
    models: [
      ...group.models,
      ...(appStore.customModels[group.provider] || []).filter(
        (model) => !group.models.includes(model),
      ),
    ],
  })),
);

const filteredSessionModelGroups = computed(() => {
  const query = sessionModelSearch.value.trim().toLowerCase();
  if (!query) return sessionModelGroupsWithCustom.value;
  return sessionModelGroupsWithCustom.value
    .map((group) => ({
      ...group,
      models: group.models.filter((model) => {
        const displayName = appStore.displayModelName(model, group.provider);
        return model.toLowerCase().includes(query) || displayName.toLowerCase().includes(query);
      }),
    }))
    .filter((group) => group.models.length > 0 || group.label.toLowerCase().includes(query));
});

async function openSessionModelModal(sessionId: string) {
  if (appStore.modelGroups.length === 0 && appStore.profileModelGroups.length === 0) {
    await appStore.loadModels();
  }
  const session =
    chatStore.sessions.find((s) => s.id === sessionId) ||
    (chatStore.activeSession?.id === sessionId ? chatStore.activeSession : undefined);
  sessionModelSessionId.value = sessionId;
  const groups = sessionModelBaseGroups.value;
  const providerGroup = session?.provider
    ? groups.find((group) => group.provider === session.provider)
    : undefined;
  const fallbackGroup = providerGroup || groups.find((group) => group.models.length > 0);
  const defaults = {
    provider: fallbackGroup?.provider || "",
    model: fallbackGroup?.models.includes(session?.model || "")
      ? session?.model || ""
      : fallbackGroup?.models[0] || "",
  };
  sessionModelValue.value = providerGroup ? session?.model || defaults.model || "" : defaults.model || "";
  sessionModelProvider.value = providerGroup ? session?.provider || "" : defaults.provider || "";
  sessionModelCustomProvider.value = sessionModelProvider.value;
  sessionModelSearch.value = "";
  sessionModelCustomInput.value = "";
  sessionModelCollapsedGroups.value = {};
}

// --- Model picker popover (prototype ModePicker): a two-level hover menu that
// replaces the old modal. Level 1 = the 模型 row; hovering it fans out a
// left-side flyout of options (name + optional desc + check). ---------------
const showModelMenu = ref(false);
const modelMenuSub = ref<null | "model" | "effort">(null);
const modelMenuLastSub = ref<null | "model" | "effort">(null);
const modelMenuPos = ref<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
const modelMenuBtnRef = ref<HTMLElement | null>(null);
let modelMenuCloseT: ReturnType<typeof setTimeout> | null = null;

// Provider-grouped model list (no search box — strict prototype). Custom models
// already published for a provider still show, so nothing the user added is lost.
const modelMenuGroups = computed(() => sessionModelGroupsWithCustom.value.filter((g) => g.models.length > 0));

// 推理强度 (sunke 2026-08-21: keep it user-selectable). It rides in the SAME
// menu as the model — one pill, one menu, two rows — rather than the standalone
// composer popselect it used to be, so the composer tool row stays as the
// prototype drew it. Reads and writes the session bound to this menu
// (sessionModelSessionId) through the chat store, which also persists it.
const reasoningEffortOptions = computed(() => [
  { label: t("chat.reasoningEffort.options.default"), value: "" },
  { label: t("chat.reasoningEffort.options.none"), value: "none" },
  { label: t("chat.reasoningEffort.options.minimal"), value: "minimal" },
  { label: t("chat.reasoningEffort.options.low"), value: "low" },
  { label: t("chat.reasoningEffort.options.medium"), value: "medium" },
  { label: t("chat.reasoningEffort.options.high"), value: "high" },
  { label: t("chat.reasoningEffort.options.xhigh"), value: "xhigh" },
]);
const sessionModelReasoningEffort = computed<string>(
  () => sessionModelSession.value?.reasoningEffort || "",
);
const isActiveSessionCodingAgent = computed(() => chatStore.activeSession?.source === "coding_agent");
const activeSessionEffortLabel = computed(() => {
  const value = chatStore.activeSession?.reasoningEffort || "";
  const opt = reasoningEffortOptions.value.find((o) => o.value === value);
  return opt ? opt.label : "";
});
// Whether the session's current model can reason at all. The rule table is
// consulted DIRECTLY rather than keyed off the absence of server capability
// metadata: `withModelCapabilities` omits empty lists to keep the payload
// small, so the models this control should hide for — the ones with NO
// capabilities — are exactly the ones that arrive with no metadata, and keying
// off that absence made the gate a no-op for its own target case. A server that
// DOES send capabilities still wins; it may know more than the static table.
const sessionModelSupportsReasoning = computed(() => {
  const model = sessionModelValue.value;
  if (!model) return true;
  const provider = sessionModelProvider.value;
  for (const group of modelMenuGroups.value) {
    if (provider && group.provider !== provider) continue;
    const capabilities = group.model_meta?.[model]?.capabilities;
    if (Array.isArray(capabilities)) return capabilities.includes("reasoning");
  }
  return modelCapabilities(model).includes("reasoning");
});

function onSessionModelReasoningEffortChange(value: string) {
  const sid = sessionModelSessionId.value;
  if (!sid) return;
  chatStore.setSessionReasoningEffort(sid, value || "");
}

function positionModelMenu() {
  const el = modelMenuBtnRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const menuH = 320;
  const openUp = window.innerHeight - r.bottom < menuH + 16;
  modelMenuPos.value = openUp
    ? { left: r.left, bottom: window.innerHeight - r.top + 8, maxHeight: Math.max(160, r.top - 24) }
    : { left: r.left, top: r.bottom + 8, maxHeight: Math.max(160, window.innerHeight - r.bottom - 24) };
}

function closeModelMenu() {
  showModelMenu.value = false;
  modelMenuSub.value = null;
  if (modelMenuCloseT) clearTimeout(modelMenuCloseT);
}

// Hover plumbing (prototype's documented fix): a 160ms safe-delay so moving the
// cursor from level 1 to the abutting level-2 flyout doesn't unmount it midway.
function keepModelSub(id: "model" | "effort" | null) {
  if (modelMenuCloseT) clearTimeout(modelMenuCloseT);
  if (id) {
    modelMenuLastSub.value = id;
    modelMenuSub.value = id;
  }
}
function laterCloseModelSub() {
  if (modelMenuCloseT) clearTimeout(modelMenuCloseT);
  modelMenuCloseT = setTimeout(() => {
    modelMenuSub.value = null;
  }, 160);
}

async function handleHeaderModelClick() {
  const sessionId = chatStore.activeSession?.id;
  if (!sessionId) {
    void handleNewChatPrimary();
    return;
  }
  if (showModelMenu.value) {
    closeModelMenu();
    return;
  }
  await openSessionModelModal(sessionId);
  modelMenuSub.value = null;
  positionModelMenu();
  showModelMenu.value = true;
}

async function pickModelFromMenu(model: string, provider: string) {
  // Reuse the existing switch flow verbatim: normal sessions apply immediately
  // (matching the prototype); scoped coding-agent sessions still confirm their
  // API protocol via the small mode dialog (an edge case, kept intact).
  await selectSessionModel(model, provider);
  closeModelMenu();
}

function pickEffortFromMenu(value: string) {
  onSessionModelReasoningEffortChange(value);
  closeModelMenu();
}

function openAddModelPage() {
  closeModelMenu();
  void router.push({ name: "hermes.models" });
}

function isSessionModelGroupCollapsed(provider: string) {
  return !!sessionModelCollapsedGroups.value[provider];
}

function toggleSessionModelGroup(provider: string) {
  sessionModelCollapsedGroups.value[provider] = !sessionModelCollapsedGroups.value[provider];
}

function isCustomSessionModel(model: string, provider: string) {
  return (appStore.customModels[provider] || []).includes(model);
}

function sessionModelDisplayName(model: string, provider: string) {
  return appStore.displayModelName(model, provider);
}

function sessionModelAlias(model: string, provider: string) {
  return appStore.getModelAlias(model, provider);
}

// Badges are display-only annotations from the BFF capability table; nothing
// here feeds the model/provider fields sent with a run.
function sessionModelHasCapability(
  model: string,
  group: { model_meta?: Record<string, { capabilities?: string[] }> },
  capability: string,
) {
  return !!group.model_meta?.[model]?.capabilities?.includes(capability);
}

function isSessionModelProfileDefault(model: string, provider: string) {
  return appStore.isProfileDefaultModel(sessionModelProfile.value, model, provider);
}

function defaultSessionModelApiMode(provider: string): CodingAgentApiMode {
  const group = sessionModelBaseGroups.value.find((item) => item.provider === provider);
  const providerKey = String(group?.provider || provider || "").toLowerCase();
  const baseUrl = String(group?.base_url || "").toLowerCase();
  return normalizeCodingAgentApiMode(
    group?.api_mode,
    inferCodingAgentApiMode(providerKey, baseUrl),
  );
}

async function applySessionModelSwitch(model: string, provider: string, apiMode?: CodingAgentApiMode) {
  if (!sessionModelSessionId.value) return;
  const res = await chatStore.switchSessionModel(model, provider, sessionModelSessionId.value, apiMode);
  if (res?.ok) {
    // The BFF owns the once-per-session decision (it persists the marker on the
    // session row in the same UPDATE as the model), so a reload or a remounted
    // picker cannot make it fire twice.
    // Once-per-session behaviour change — worth stating, and worth NOT having it
    // expire on a timer, since it explains something that will not be repeated.
    if (res.familySwitchNotice) {
      setNotice(t("chat.modelFamilySwitchNotice"), "info");
    }
    sessionModelValue.value = model;
    sessionModelProvider.value = provider;
    if (apiMode) sessionModelApiMode.value = apiMode;
    pendingSessionModelSwitch.value = null;
    showSessionModelModeModal.value = false;
    // The picker closes and the model pill repaints with the new model.
    showSessionModelModal.value = false;
  } else {
    setNotice(t("chat.modelSetFailed"), "error");
  }
}

async function selectSessionModel(model: string, provider: string) {
  const meta = sessionModelBaseGroups.value.find((group) => group.provider === provider)?.model_meta?.[model];
  if (meta?.disabled || !sessionModelSessionId.value) return;
  if (isSessionModelScopedCodingAgent.value) {
    pendingSessionModelSwitch.value = { model, provider };
    sessionModelApiMode.value = defaultSessionModelApiMode(provider);
    showSessionModelModeModal.value = true;
    return;
  }
  await applySessionModelSwitch(model, provider);
}

async function confirmSessionModelMode() {
  const pending = pendingSessionModelSwitch.value;
  if (!pending) return;
  await applySessionModelSwitch(pending.model, pending.provider, sessionModelApiMode.value);
}

function cancelSessionModelMode() {
  pendingSessionModelSwitch.value = null;
  showSessionModelModeModal.value = false;
}

async function handleSessionModelCustomSubmit() {
  const model = sessionModelCustomInput.value.trim();
  const provider = sessionModelCustomProvider.value;
  if (!model || !provider) return;
  await selectSessionModel(model, provider);
}
</script>

<template>
  <div class="chat-panel">
    <div v-if="notice" class="panel-notice" :class="`is-${notice.tone}`" data-testid="panel-notice">
      <span class="panel-notice__text">{{ notice.text }}</span>
      <button
        type="button"
        class="panel-notice__close"
        :title="t('common.close')"
        @click="notice = null"
      >&times;</button>
    </div>
    <!-- Resident progress, not a toast: building a compressed export can take
         long enough that a self-dismissing message would be gone first. -->
    <div v-if="exportingLabel" class="panel-notice is-info" data-testid="panel-progress">
      <span class="panel-notice__text">{{ exportingLabel }}</span>
    </div>
    <div
      v-if="currentMode === 'chat'"
      class="session-backdrop"
      :class="{ active: showSessions }"
      @click="showSessions = false"
    />
    <aside
      v-if="currentMode === 'chat'"
      class="session-list"
      :class="{ collapsed: !showSessions }"
    >
      <!-- Collapsed 64px icon rail: nav folds to centered glyphs, the mode
           switch to its vertical icon column, and the task list / footer are
           replaced by a single centered avatar. Its header toggle re-expands,
           so the rail is always self-recoverable even on the home screen where
           the main chat header (and its toggle) is hidden. -->
      <template v-if="!showSessions">
        <div class="page-sidebar-rail">
          <PageSidebarNav
            collapsed
            :active="pageSidebarActive"
            :home-active="isHomeState && !chatSidebarSurface"
            :primary-label="t('chat.newTask')"
            :show-primary-config="false"
            @primary="handleNewChatPrimary"
            @primary-config="handleNewChatPrimaryConfig"
            @collapse="showSessions = true"
          />
        </div>
        <div class="page-sidebar-rail-foot">
          <button
            class="sidebar-user__avatar sidebar-user__avatar--rail"
            type="button"
            :title="t('sidebar.accountAndSettings')"
            @click="openUserMenu"
          >
            <img v-if="sidebarUserAvatar" :src="sidebarUserAvatar" alt="" />
            <template v-else>{{ sidebarUserInitial }}</template>
          </button>
        </div>
      </template>

      <PageSidebarNav
        v-if="showSessions"
        class="page-sidebar-body"
        :active="pageSidebarActive"
        :home-active="isHomeState && !chatSidebarSurface"
        :primary-label="t('chat.newTask')"
        :show-primary-config="false"
        @primary="handleNewChatPrimary"
        @primary-config="handleNewChatPrimaryConfig"
        @collapse="showSessions = false"
      >
        <template #tasks>
        <!-- Prototype 任务列表 section header: a label plus exactly one
             filter icon. Profile filtering, workspace groups, batch
             management and the history page all live in the filter popover.
             While batch mode is on, the header swaps for the batch bar. -->
        <div v-if="!isBatchMode" class="session-section-head">
          <span class="session-section-title">{{ t("chat.taskList") }}</span>
          <button
            class="session-filter-btn"
            :class="{ 'is-open': showFilterPanel }"
            type="button"
            :title="t('chat.filterSessions')"
            @click="toggleFilterPanel"
          >
            <KpIcon name="line_screening" :size="16" />
          </button>
        </div>
        <div v-else class="session-section-head session-batch-bar">
          <span class="session-section-title">{{ t("chat.batchManage") }}</span>
          <div class="session-list-actions">
            <NButton
              quaternary
              size="tiny"
              @click="selectAllSessions"
              :disabled="!canSelectAll || isBatchDeleting"
              :title="t('chat.selectAll')"
            >
              <template #icon>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
              </template>
            </NButton>
            <NPopconfirm
              v-if="selectedCount > 0"
              v-model:show="showBatchDeleteConfirm"
              :positive-button-props="{ loading: isBatchDeleting, disabled: isBatchDeleting }"
              :negative-button-props="{ disabled: isBatchDeleting }"
              @positive-click="handleBatchDeleteConfirm"
            >
              <template #trigger>
                <NButton quaternary size="tiny" type="error" :loading="isBatchDeleting" :disabled="isBatchDeleting">
                  <template #icon>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                    >
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </template>
                </NButton>
              </template>
              {{ t('chat.confirmBatchDelete', { count: selectedCount }) }}
            </NPopconfirm>
            <NButton
              quaternary
              size="tiny"
              @click="toggleBatchMode"
              :disabled="isBatchDeleting"
            >
              <template #icon>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </template>
            </NButton>
          </div>
        </div>
        <div class="session-items">
        <div
          v-if="chatStore.isLoadingSessions && chatStore.sessions.length === 0"
          class="session-loading"
        >
          {{ t("common.loading") }}
        </div>
        <div v-else-if="chatStore.sessions.length === 0" class="session-empty">
          {{ t("chat.noSessions") }}
        </div>

        <!-- Prototype: pinned rows simply sort first and carry a flag glyph —
             no group header splits the list. -->
        <template v-if="pinnedSessions.length > 0">
          <SessionListItem
            v-for="s in pinnedSessions"
            :key="`pinned-${s.id}`"
            :session="s"
            :active="s.id === chatStore.activeSessionId"
            :pinned="true"
            :can-delete="
              s.id !== chatStore.activeSessionId ||
              chatStore.sessions.length > 1
            "
            :streaming="chatStore.isSessionLive(s.id)"
            :completed-unread="chatStore.isSessionCompletedUnread(s.id)"
            :selectable="isBatchMode"
            :selected="isSessionSelected(s)"
            :show-profile="true"
            :renaming="renamingSessionId === s.id"
            :to="sessionHref(s.id, s.profile)"
            @select="handleSessionClick(s)"
            @contextmenu="handleContextMenu($event, s.id)"
            @delete="handleDeleteSession(s.id)"
            @toggle-select="toggleSessionSelection(s)"
            @rename-commit="handleRenameCommit(s.id, $event)"
            @rename-cancel="renamingSessionId = null"
          />
        </template>

        <!-- Grouped by agent. The header is the same shape as the filter
             popover's workspace group: label + count + caret, click collapses. -->
        <template v-for="group in sessionAgentGroups" :key="`agent-${group.profile}`">
          <button
            v-if="showAgentGroupHeaders"
            type="button"
            class="session-group-header session-agent-group"
            :aria-expanded="!isAgentGroupCollapsed(group.profile)"
            :data-testid="`session-agent-group-${group.profile}`"
            @click="toggleAgentGroup(group.profile)"
          >
            <span class="session-group-label">{{ group.label }}</span>
            <span class="session-agent-group__count">{{ group.sessions.length }}</span>
            <span
              class="session-group-caret"
              :class="{ collapsed: isAgentGroupCollapsed(group.profile) }"
            >▾</span>
          </button>
          <SessionListItem
            v-for="s in group.sessions"
            v-show="!isAgentGroupCollapsed(group.profile)"
            :key="s.id"
            :session="s"
            :active="s.id === chatStore.activeSessionId"
            :pinned="false"
            :can-delete="
              s.id !== chatStore.activeSessionId ||
              chatStore.sessions.length > 1
            "
            :streaming="chatStore.isSessionLive(s.id)"
            :completed-unread="chatStore.isSessionCompletedUnread(s.id)"
            :selectable="isBatchMode"
            :selected="isSessionSelected(s)"
            :show-profile="true"
            :renaming="renamingSessionId === s.id"
            :to="sessionHref(s.id, s.profile)"
            @select="handleSessionClick(s)"
            @contextmenu="handleContextMenu($event, s.id)"
            @delete="handleDeleteSession(s.id)"
            @toggle-select="toggleSessionSelection(s)"
            @rename-commit="handleRenameCommit(s.id, $event)"
            @rename-cancel="renamingSessionId = null"
          />
        </template>
        </div>
        </template>
        <!-- Footer: the account row. The whole row is the affordance and opens
             the UserMenu (settings / appearance / sign out) — matching the
             prototype, which has no standalone gear; settings lives in the menu. -->
        <template #footer>
        <div class="page-sidebar-bottom">
          <button
            class="sidebar-user__trigger"
            :class="{ 'is-open': showUserMenu }"
            type="button"
            data-testid="sidebar-user-trigger"
            :title="t('sidebar.accountAndSettings')"
            @click="openUserMenu"
          >
            <span class="sidebar-user__avatar">
              <img v-if="sidebarUserAvatar" :src="sidebarUserAvatar" alt="" />
              <template v-else>{{ sidebarUserInitial }}</template>
            </span>
            <span class="sidebar-user__name">{{ sidebarUserName }}</span>
          </button>
        </div>
        </template>
      </PageSidebarNav>
    </aside>

    <!-- 筛选 popover: profile filter, workspace groups, batch management and
         the full-history entry — everything the prototype's single filter
         icon has to carry. In-tree fixed element, like the UserMenu. -->
    <template v-if="showFilterPanel">
      <div class="session-filter-backdrop" @click="closeFilterPanel" />
      <div class="session-filter-panel" :style="filterPanelStyle">
        <NSelect
          class="session-profile-filter"
          :value="sessionProfileFilter || '__all__'"
          :options="profileFilterOptions"
          size="small"
          :loading="profilesStore.loading"
          @update:value="handleProfileFilterChange"
        />
        <div v-if="workspaceGroups.length" class="workspace-groups">
          <button
            type="button"
            class="workspace-group-item"
            :class="{ active: !workspaceFilter }"
            @click="workspaceFilter = null"
          >
            <span>{{ t("chat.recentBadge") }}</span>
            <span>{{ chatStore.sessions.length }}</span>
          </button>
          <button
            type="button"
            class="session-group-header workspace-group-toggle"
            :aria-expanded="!workspaceGroupsCollapsed"
            @click="workspaceGroupsCollapsed = !workspaceGroupsCollapsed"
          >
            <span class="session-group-label">{{ t("chat.workspace") }}</span>
            <span class="session-group-caret" :class="{ collapsed: workspaceGroupsCollapsed }">▾</span>
          </button>
          <button
            v-for="group in workspaceGroups"
            v-show="!workspaceGroupsCollapsed"
            :key="`${group.profile}:${group.workspace}`"
            type="button"
            class="workspace-group-item"
            :class="{ active: workspaceFilter?.profile === group.profile && workspaceFilter?.workspace === group.workspace }"
            @click="selectWorkspaceGroup(group)"
          >
            <span class="workspace-group-name">📁 {{ sessionWorkspaceLabel(group.workspace) }}</span>
            <span>{{ group.count }}</span>
          </button>
        </div>
        <div class="session-filter-divider" />
        <button class="session-filter-item" type="button" @click="startBatchFromFilter">
          <KpIcon name="line_list" :size="15" class="session-filter-item__icon" />
          <span>{{ t('chat.batchManage') }}</span>
        </button>
        <button class="session-filter-item" type="button" @click="openHistoryPage">
          <KpIcon name="line_time" :size="15" class="session-filter-item__icon" />
          <span>{{ t('chat.viewAllHistory') }}</span>
        </button>
      </div>
    </template>

    <!-- UserMenu popover. Fixed-positioned and teleported so it is never
         clipped by the rail's overflow; dismissed by mousedown-away or Escape
         (document listeners — no backdrop, clicks pass through, per the
         prototype). -->
    <Teleport to="body">
      <template v-if="showUserMenu">
        <div ref="userMenuEl" class="user-menu fadein" :style="userMenuStyle">
          <!-- Header: name + copy handle, aligned to the sidebar's left inset
               and as wide as the rail's content box, so it reads as the account
               area growing out of the rail rather than floating over content. -->
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
          <button class="user-menu__item" type="button" @click="handleUserMenuSettings">
            <KpIcon name="line_setting" :size="15" class="user-menu__icon" />
            <span>{{ t('sidebar.settings') }}</span>
          </button>
          <!-- Appearance: a light/dark mini segmented control (same geometry as
               the Work/Design switch), not a toggle — the prototype shows the two
               named modes side by side. -->
          <div class="user-menu__item user-menu__item--appearance">
            <KpIcon name="line_photo_filter" :size="15" class="user-menu__icon" />
            <span>{{ t('sidebar.appearance') }}</span>
            <KpThemeSeg />
          </div>
          <div class="user-menu__divider" />
          <button class="user-menu__item" type="button" @click="handleLogout">
            <KpIcon name="full_arrow_back" :size="15" class="user-menu__icon" />
            <span>{{ t('sidebar.logout') }}</span>
          </button>
        </div>
      </template>
    </Teleport>

    <!-- The collapsed rail carries its own header toggle to re-expand, so the
         former floating reopen button is gone. The rail is always shown while
         collapsed (even on the home screen where the main chat header is
         hidden), so re-expansion stays reachable. -->

    <!-- Session row menu — the prototype TaskMenu: fixed 176px card, four
         36px icon rows, danger delete after a divider. Dismissed by
         mousedown-away / Escape / any scroll (document listeners registered
         while open). -->
    <Teleport to="body">
      <template v-if="showContextMenu">
        <div ref="sessionMenuEl" class="session-menu fadein" :style="sessionMenuStyle">
          <template v-for="(entry, i) in sessionMenuItems" :key="'divider' in entry ? `divider-${i}` : entry.key">
            <div v-if="'divider' in entry" class="session-menu__divider" />
            <button
              v-else
              class="session-menu__item"
              :class="{ 'is-danger': entry.danger }"
              type="button"
              @mouseenter="onSessionMenuEnter(entry)"
              @click="onSessionMenuClick(entry)"
            >
              <KpIcon :name="entry.icon" :size="14" class="session-menu__icon" />
              <span>{{ entry.label }}</span>
              <KpIcon v-if="entry.arrow" name="line_arrow_right" :size="11" class="session-menu__arrow" />
            </button>
          </template>
        </div>
        <!-- Workspace hover submenu (prototype 移动到项目): pick a target,
             applied immediately. -->
        <div
          v-if="showWorkspaceSubmenu && (workspaceMenuLoading || workspaceMenuFolders.length > 0)"
          ref="sessionSubmenuEl"
          class="session-menu session-menu--sub fadein"
          :style="sessionSubmenuStyle"
        >
          <div v-if="workspaceMenuLoading" class="session-menu__empty">{{ t('common.loading') }}</div>
          <template v-else>
            <button
              v-for="folder in workspaceMenuFolders"
              :key="folder.path"
              class="session-menu__item"
              type="button"
              @click="applyWorkspaceFromMenu(folder.path)"
            >
              <span>{{ folder.name }}</span>
            </button>
          </template>
        </div>
      </template>
    </Teleport>

    <NModal
      v-model:show="showWorkspaceModal"
      preset="dialog"
      :title="t('chat.setWorkspaceTitle')"
      :positive-text="t('common.ok')"
      :negative-text="t('common.cancel')"
      style="width: 520px"
      @positive-click="handleWorkspaceConfirm"
    >
      <FolderPicker v-model="workspaceValue" />
    </NModal>

    <!-- Model picker popover (prototype ModePicker). Replaces the old modal
         below, which is now unreachable (the pill opens this popover). -->
    <Teleport to="body">
      <template v-if="showModelMenu && modelMenuPos">
        <div class="model-menu-overlay" @click="closeModelMenu" />

        <!-- Level 2 flyout — to the LEFT of level 1 (the pill sits at the
             composer's right edge, so there's no room to the right). -->
        <div
          v-if="modelMenuSub"
          class="model-menu model-menu--sub"
          :style="{
            left: `${Math.max(8, modelMenuPos.left - 280)}px`,
            top: modelMenuPos.top != null ? `${modelMenuPos.top}px` : undefined,
            bottom: modelMenuPos.bottom != null ? `${modelMenuPos.bottom}px` : undefined,
            maxHeight: `${modelMenuPos.maxHeight}px`,
          }"
          @mouseenter="keepModelSub(modelMenuLastSub)"
          @mouseleave="laterCloseModelSub"
        >
          <template v-if="modelMenuSub === 'model'">
          <div class="model-menu__title">{{ t('chat.modelMenu.model') }}</div>
          <template v-for="group in modelMenuGroups" :key="group.provider">
            <div v-if="modelMenuGroups.length > 1" class="model-menu__group">{{ group.label }}</div>
            <div
              v-for="model in group.models"
              :key="group.provider + '/' + model"
              class="model-menu__opt"
              :class="{ locked: !!group.model_meta?.[model]?.disabled }"
              @click="group.model_meta?.[model]?.disabled ? null : pickModelFromMenu(model, group.provider)"
            >
              <div class="model-menu__opt-body">
                <div class="model-menu__opt-name">{{ sessionModelDisplayName(model, group.provider) }}</div>
                <div v-if="sessionModelAlias(model, group.provider)" class="model-menu__opt-desc">
                  {{ t('models.aliasCanonical', { model }) }}
                </div>
              </div>
              <KpIcon
                v-if="model === sessionModelValue && group.provider === sessionModelProvider"
                name="line_check"
                :size="14"
                class="model-menu__opt-check"
              />
            </div>
          </template>
          </template>
          <template v-else>
            <div class="model-menu__title">{{ t('chat.reasoningEffort.tooltip') }}</div>
            <div
              v-for="opt in reasoningEffortOptions"
              :key="opt.value"
              class="model-menu__opt"
              @click="pickEffortFromMenu(opt.value)"
            >
              <div class="model-menu__opt-body">
                <div class="model-menu__opt-name">{{ opt.label }}</div>
              </div>
              <KpIcon
                v-if="opt.value === sessionModelReasoningEffort"
                name="line_check"
                :size="14"
                class="model-menu__opt-check"
              />
            </div>
          </template>
        </div>

        <!-- Level 1 -->
        <div
          class="model-menu"
          :style="{
            left: `${modelMenuPos.left}px`,
            top: modelMenuPos.top != null ? `${modelMenuPos.top}px` : undefined,
            bottom: modelMenuPos.bottom != null ? `${modelMenuPos.bottom}px` : undefined,
            maxHeight: `${modelMenuPos.maxHeight}px`,
          }"
          @mouseenter="keepModelSub(null)"
          @mouseleave="laterCloseModelSub"
        >
          <div
            class="model-menu__row"
            :class="{ active: modelMenuSub === 'model' }"
            @mouseenter="keepModelSub('model')"
            @click="keepModelSub('model')"
          >
            <span class="model-menu__row-label">{{ t('chat.modelMenu.model') }}</span>
            <span class="model-menu__row-value">{{ activeSessionModelLabel }}</span>
            <KpIcon name="line_arrow_right" :size="12" class="model-menu__row-caret" />
          </div>
          <!-- Off entirely for a model that cannot reason: the row states that
               instead of opening an empty flyout. -->
          <div
            class="model-menu__row"
            :class="{
              active: modelMenuSub === 'effort',
              locked: !sessionModelSupportsReasoning,
            }"
            data-testid="model-menu-effort-row"
            @mouseenter="sessionModelSupportsReasoning && keepModelSub('effort')"
            @click="sessionModelSupportsReasoning && keepModelSub('effort')"
          >
            <span class="model-menu__row-label">{{ t('chat.reasoningEffort.tooltip') }}</span>
            <span class="model-menu__row-value">{{ sessionModelSupportsReasoning
              ? activeSessionEffortLabel
              : t('chat.reasoningEffort.unsupported') }}</span>
            <KpIcon v-if="sessionModelSupportsReasoning" name="line_arrow_right" :size="12" class="model-menu__row-caret" />
          </div>
          <!-- No reasoning-effort row: effort follows the model's own
               configuration and is not user-selectable. -->
          <div class="model-menu__divider" />
          <div class="model-menu__foot" @click="openAddModelPage">
            <span class="model-menu__foot-label">{{ t('chat.modelMenu.addModel') }}</span>
            <!-- A gear, not a caret: this row leaves the menu for settings
                 rather than opening another level of it. -->
            <KpIcon name="line_setting" :size="14" class="model-menu__foot-icon" />
          </div>
        </div>
      </template>
    </Teleport>

    <NModal
      v-model:show="showSessionModelModal"
      preset="card"
      :title="t('chat.setModelTitle')"
      :style="{ width: 'min(480px, calc(100vw - 32px))' }"
      :mask-closable="true"
    >
      <NInput
        v-model:value="sessionModelSearch"
        :placeholder="t('models.searchPlaceholder')"
        clearable
        size="small"
        class="session-model-search"
      />
      <div class="session-model-list">
        <div v-for="group in filteredSessionModelGroups" :key="group.provider" class="session-model-group">
          <div class="session-model-group-header" @click="toggleSessionModelGroup(group.provider)">
            <svg
              class="session-model-group-arrow"
              :class="{ collapsed: isSessionModelGroupCollapsed(group.provider) }"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span class="session-model-group-label">{{ group.label }}</span>
            <span class="session-model-group-count">{{ group.models.length }}</span>
          </div>
          <div v-show="!isSessionModelGroupCollapsed(group.provider)" class="session-model-group-items">
            <div
              v-for="model in group.models"
              :key="model"
              class="session-model-item"
              :class="{
                active: model === sessionModelValue && group.provider === sessionModelProvider,
                disabled: !!group.model_meta?.[model]?.disabled,
              }"
              :title="group.model_meta?.[model]?.disabled ? t('models.disabledTooltip') : ''"
              @click="selectSessionModel(model, group.provider)"
            >
              <span class="session-model-item-label">
                <span class="session-model-item-name">{{ sessionModelDisplayName(model, group.provider) }}</span>
                <span v-if="sessionModelAlias(model, group.provider)" class="session-model-item-id">
                  {{ t('models.aliasCanonical', { model }) }}
                </span>
              </span>
              <span
                v-if="sessionModelHasCapability(model, group, 'vision')"
                class="session-model-badge-cap"
                :title="t('models.capabilityVision')"
                :aria-label="t('models.capabilityVision')"
              >👁</span>
              <span
                v-if="sessionModelHasCapability(model, group, 'reasoning')"
                class="session-model-badge-cap"
                :title="t('models.capabilityReasoning')"
                :aria-label="t('models.capabilityReasoning')"
              >🧠</span>
              <span
                v-if="isSessionModelProfileDefault(model, group.provider)"
                class="session-model-badge-cap"
                :title="t('models.defaultModelTooltip')"
                :aria-label="t('models.defaultModelTooltip')"
              >⭐</span>
              <span v-if="group.model_meta?.[model]?.preview" class="session-model-badge-preview">{{ t('models.previewBadge') }}</span>
              <span v-if="group.model_meta?.[model]?.disabled" class="session-model-badge-disabled">{{ t('models.disabledBadge') }}</span>
              <span v-if="isCustomSessionModel(model, group.provider)" class="session-model-badge-custom">{{ t('models.customBadge') }}</span>
              <svg
                v-if="model === sessionModelValue && group.provider === sessionModelProvider"
                class="session-model-check"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          </div>
        </div>
        <div v-if="filteredSessionModelGroups.length === 0" class="session-model-empty">
          {{ sessionModelSearch ? 'No results' : 'No models' }}
        </div>
        <div class="session-model-custom">
          <div class="session-model-custom-row">
            <NSelect
              v-model:value="sessionModelCustomProvider"
              :options="sessionModelProviderOptions"
              size="small"
              class="session-model-custom-provider"
            />
            <NInput
              v-model:value="sessionModelCustomInput"
              :placeholder="t('models.customModelPlaceholder')"
              size="small"
              class="session-model-custom-input"
              @keydown.enter="handleSessionModelCustomSubmit"
            />
          </div>
          <div class="session-model-custom-hint">
            {{ t('models.customModelHint') }}
          </div>
        </div>
      </div>
    </NModal>

    <NModal
      v-model:show="showSessionModelModeModal"
      preset="dialog"
      :title="t('codingAgents.protocolScope')"
      :mask-closable="true"
      style="width: min(420px, calc(100vw - 32px))"
    >
      <NSelect
        v-model:value="sessionModelApiMode"
        :options="newChatApiModeOptions"
      />
      <template #action>
        <NButton size="small" @click="cancelSessionModelMode">
          {{ t('common.cancel') }}
        </NButton>
        <NButton size="small" type="primary" @click="confirmSessionModelMode">
          {{ t('common.confirm') }}
        </NButton>
      </template>
    </NModal>

    <NDrawer
      v-model:show="showNewChatModal"
      class="new-chat-drawer"
      placement="right"
      width="min(440px, 100vw)"
      :mask-closable="true"
    >
      <NDrawerContent :title="t('chat.newTask')" closable>
        <div class="new-chat-form">
          <label class="new-chat-field">
            <span class="new-chat-label">{{ t("chat.agent") }}</span>
            <NSelect
              v-model:value="newChatAgent"
              :options="newChatAgentOptions"
              :disabled="newChatLoading"
            />
          </label>
          <label v-if="isNewChatCodingAgent" class="new-chat-field">
            <span class="new-chat-label">{{ t("codingAgents.launchModeScope") }}</span>
            <NRadioGroup v-model:value="newChatAgentMode" name="new-chat-coding-agent-mode">
              <NRadioButton
                v-for="option in newChatAgentModeOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </NRadioButton>
            </NRadioGroup>
          </label>
          <label class="new-chat-field">
            <span class="new-chat-label">{{ t("sidebar.profiles") }}</span>
            <NSelect
              :value="newChatProfile"
              :options="newChatProfileOptions"
              :loading="newChatLoading || profilesStore.loading"
              :disabled="newChatLoading || newChatProfileOptions.length === 0"
              @update:value="handleNewChatProfileChange"
            />
          </label>
          <label v-if="newChatUsesProviderModel" class="new-chat-field">
            <span class="new-chat-label">{{ t("models.provider") }}</span>
            <NSelect
              :value="newChatProvider"
              :options="newChatProviderOptions"
              :disabled="newChatLoading"
              @update:value="handleNewChatProviderChange"
            />
          </label>
          <label v-if="newChatUsesProviderModel" class="new-chat-field">
            <span class="new-chat-label">{{ t("models.models") }}</span>
            <NSelect
              v-model:value="newChatModel"
              :options="newChatModelOptions"
              :disabled="newChatLoading || !newChatProvider"
              filterable
            />
          </label>
          <label v-if="isNewChatCodingAgent && newChatAgentMode === 'scoped'" class="new-chat-field">
            <span class="new-chat-label">{{ t("codingAgents.protocolScope") }}</span>
            <NSelect
              v-model:value="newChatApiMode"
              :options="newChatApiModeOptions"
              :disabled="newChatLoading"
            />
          </label>
          <label v-if="newChatNeedsBaseUrl" class="new-chat-field">
            <span class="new-chat-label">{{ t("models.baseUrl") }}</span>
            <NInput
              v-model:value="newChatBaseUrl"
              :placeholder="t('models.baseUrlPlaceholder')"
            />
          </label>
          <label v-if="newChatNeedsApiKey" class="new-chat-field">
            <span class="new-chat-label">{{ t("models.apiKey") }}</span>
            <NInput
              v-model:value="newChatApiKey"
              type="password"
              show-password-on="click"
              :placeholder="t('models.apiKeyPlaceholder')"
            />
          </label>
          <div class="new-chat-field">
            <span class="new-chat-label">{{ t("chat.workspace") }}</span>
            <FolderPicker v-model="newChatWorkspace" />
          </div>
        </div>
        <template #footer>
          <div class="new-chat-actions">
            <NButton @click="showNewChatModal = false">{{ t("common.cancel") }}</NButton>
            <NButton
              type="primary"
              :disabled="!canConfirmNewChat"
              @click="confirmNewChat"
            >
              {{ t("chat.newTask") }}
            </NButton>
          </div>
        </template>
      </NDrawerContent>
    </NDrawer>

    <div class="chat-main" :class="{ 'is-home': isHomeState }">
      <!-- Nav surfaces (智能体 / 自动化 / …) own the whole content area in the
           prototype — they carry their own page title, so the run header would
           be a second, contradictory one showing the last session's name. -->
      <header v-show="!isHomeState && !chatSidebarSurface" class="chat-header">
        <div class="header-left">
          <!-- No agent mark here. The prototype dropped the 20px "K" square:
               this row answers "which task am I looking at", and the task name
               IS the answer — the agent's own mark already appears on the run's
               thinking line below, so a second one is the same identity said
               twice. -->
          <!-- 专家会话身份 (digital-employee-session-entry): an expert-bound
               session says WHO it is bound to, because that binding is fixed
               for the whole session and the task name alone cannot tell you.
               An ordinary chat falls through to the task name. -->
          <div v-if="activeSessionExpert && !chatSidebarSurface" class="expert-session-identity">
            <img
              v-if="activeSessionExpert.avatar"
              class="expert-session-avatar"
              :src="activeSessionExpert.avatar"
              :alt="activeSessionExpert.label"
              @error="onExpertAvatarError(activeSessionExpert.avatar)"
            >
            <span v-else class="expert-session-avatar expert-session-avatar--fallback" aria-hidden="true">
              {{ activeSessionExpert.initial }}
            </span>
            <span class="expert-session-copy">
              <strong>{{ activeSessionExpert.label }}</strong>
              <small>{{ t("chat.expertSessionFixed") }}</small>
            </span>
            <button class="expert-session-capabilities" type="button" @click="openExpertCapabilities">
              {{ t("chat.expertCapabilities") }}
            </button>
          </div>
          <template v-else>
            <span class="header-session-title">{{ headerTitle }}</span>
            <span v-if="headerStartedAt" class="header-session-time">{{ headerStartedAt }}</span>
          </template>
          <span
            v-if="chatStore.activeSession?.workspace"
            class="workspace-badge"
            :title="chatStore.activeSession.workspace"
            >📁
            {{
              chatStore.activeSession.workspace.split("/").pop() ||
              chatStore.activeSession.workspace
            }}</span
          >
        </div>
        <div class="header-actions">
          <!-- chat/live mode toggle hidden -->
          <template v-if="currentMode === 'chat' && !chatSidebarSurface">
            <NTooltip v-if="isSuperAdmin" trigger="hover">
              <template #trigger>
                <NButton
                  class="header-tool-toggle"
                  :class="{ active: showToolPanel }"
                  quaternary
                  size="small"
                  @click="showToolPanel = !showToolPanel"
                  circle
                >
                  <template #icon>
                    <!-- Prototype line_screen: a monitor — the working-surface toggle. -->
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                    >
                      <rect x="3" y="4" width="18" height="13" rx="2" />
                      <line x1="8" y1="20" x2="16" y2="20" />
                      <line x1="12" y1="17" x2="12" y2="20" />
                    </svg>
                  </template>
                </NButton>
              </template>
              {{ t("drawer.files") }} / {{ t("drawer.terminal") }}
            </NTooltip>
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  quaternary
                  size="small"
                  @click="showRunPanel = !showRunPanel"
                  circle
                >
                  <template #icon>
                    <!-- Prototype PanelIcon: rounded rect + rail divider. -->
                    <svg
                      width="17"
                      height="17"
                      viewBox="0 0 20 20"
                      fill="none"
                    >
                      <rect
                        x="2.6"
                        y="3.6"
                        width="14.8"
                        height="12.8"
                        rx="3"
                        stroke="currentColor"
                        stroke-width="1.5"
                      />
                      <path d="M8.4 3.6V16.4" stroke="currentColor" stroke-width="1.5" />
                    </svg>
                  </template>
                </NButton>
              </template>
              {{ t("chat.runPanel.title") }}
            </NTooltip>
          </template>
        </div>
      </header>

      <template v-if="currentMode === 'chat'">
        <div
          ref="chatContentWrapperRef"
          class="chat-content-wrapper"
          :class="{ 'chat-content-wrapper--surface': !!chatSidebarSurface }"
        >
          <div v-if="chatSidebarSurface" class="chat-surface-host">
            <ExpertCatalogView v-if="chatSidebarSurface === 'expert'" />
            <AgentsView v-else-if="chatSidebarSurface === 'agents'" embedded />
            <SettingsView v-else-if="chatSidebarSurface === 'settings'" embedded />
            <JobsView v-else-if="chatSidebarSurface === 'automation'" embedded />
            <AppsView v-else-if="chatSidebarSurface === 'apps'" embedded />
            <FilesView v-else-if="chatSidebarSurface === 'files'" embedded />
            <SkillsView v-else-if="chatSidebarSurface === 'skills'" embedded />
            <CredentialsView v-else-if="chatSidebarSurface === 'connectors'" embedded />
          </div>
          <div v-else class="chat-main-content">
            <!-- Home state owns its own block instead of borrowing the message
                 list's empty slot. The list has to grow to fill the column, so
                 anything rendered inside it gets pushed to the top and leaves a
                 gap above the composer; collapsing the list to fix that just
                 collapses the content with it. Keep the list mounted (v-show)
                 so its scroll refs and session snapshots survive. -->
            <!-- The wordmark is KpSplitText (per-character entrance + flowing
                 gradient). The WebGL warp mark (KpWarpText) is still in the
                 codebase on purpose — it took several rounds to settle, and the
                 prototype likewise keeps it as the documented way back: swap this
                 one line for `<KpWarpText />`. -->
            <div v-if="isHomeState" class="home-hero">
              <KpSplitText />
            </div>
            <MessageList v-show="!isHomeState" ref="messageListRef" />
            <!-- position: relative anchors the mascot, which is absolutely
                 positioned on the composer's top edge. It must NOT join layout:
                 in flow it pushes the composer down and breaks the fixed
                 wordmark(104) + gap(32) rhythm. -->
            <div class="home-composer-wrap">
            <KpMascot v-if="isHomeState" :height="72" />
            <ChatInput>
              <!-- Model picker now lives in the composer tool row (moved out of
                   the header). The pill is a trigger only — clicking runs the
                   exact same model-selection flow as before via
                   handleHeaderModelClick; all model logic stays in ChatPanel. -->
              <template #model>
                <button
                  ref="modelMenuBtnRef"
                  type="button"
                  class="composer-model-button"
                  :class="{ open: showModelMenu }"
                  :title="activeSessionModelLabel"
                  @click="handleHeaderModelClick"
                >
                  <KpIcon name="full_star_ai" :size="14" class="composer-model-button__spark" />
                  <span class="composer-model-button__label">{{ activeSessionModelLabel }}</span>
                  <span
                    v-if="!isActiveSessionCodingAgent && activeSessionEffortLabel"
                    class="composer-model-button__effort"
                  >{{ activeSessionEffortLabel }}</span>
                  <KpIcon name="line_down" :size="10" class="composer-model-button__caret" />
                </button>
              </template>
              <template #pillbar>
                <button
                  v-if="isHermesChatSession(chatStore.activeSession)"
                  type="button"
                  class="composer-workspace-button"
                  :title="composerWorkspace || t('chat.setWorkspace')"
                  @click="openComposerWorkspacePicker"
                >
                  📁 {{ sessionWorkspaceLabel(composerWorkspace) || t('chat.setWorkspace') }}
                </button>
              </template>
            </ChatInput>
            </div>
            <!-- Starter cards live below the composer, matching the home
                 layout: wordmark, then the field, then the suggestions. They
                 are rendered here rather than in the message list's empty slot
                 so they land on the correct side of the input. -->
            <KpStarterBoard v-if="isHomeState" class="home-starters" @pick="prefillComposer" />
          </div>
          <RunPanel
            v-if="showRunPanel && !chatSidebarSurface"
            :messages="chatStore.messages"
            :running="chatStore.isStreaming"
            :aborted="chatStore.isAborting"
            @navigate="handleRunPanelNavigate"
          />
          <aside
            v-if="toolPanelMounted && !chatSidebarSurface"
            v-show="showToolPanel"
            class="chat-tool-panel"
            :style="toolPanelStyle"
          >
            <div
              class="chat-tool-resize-handle"
              @pointerdown="startToolResize"
            />
            <div class="chat-tool-panel-inner">
              <div class="chat-tool-content">
                <DetailPanel :dismiss-panel="closeToolPanel" />
                <TerminalPanel
                  v-show="activeToolPanel === 'terminal'"
                  :visible="showToolPanel && activeToolPanel === 'terminal'"
                />
              </div>
            </div>
          </aside>
        </div>
      </template>
      <ConversationMonitorPane
        v-else
        :human-only="sessionBrowserPrefsStore.humanOnly"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;
.panel-notice {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: min(560px, calc(100% - 32px));
  padding: 12px;
  border-radius: var(--r-ctl);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
}

.panel-notice.is-error {
  background: var(--danger-bg);
  color: var(--danger);
}

/* Information, not an alarm — neutral surface with a hairline. */
.panel-notice.is-info {
  background: var(--surface-2);
  color: var(--fg-primary);
  box-shadow: inset 0 0 0 0.5px var(--divider);
}

.panel-notice__text {
  flex: 1;
  min-width: 0;
}

.panel-notice__close {
  flex: 0 0 auto;
  border: 0;
  background: none;
  color: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}


.chat-panel {
  display: flex;
  height: 100%;
  position: relative;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
}

.session-model-search {
  margin-bottom: 12px;
}

.session-model-list {
  max-height: 50vh;
  overflow-y: auto;
  scrollbar-width: thin;
}

.session-model-group {
  margin-bottom: 4px;
}

.session-model-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  font-size: 12px;
  font-weight: 600;
  color: $text-secondary;
  cursor: pointer;
  border-radius: $radius-sm;
  user-select: none;
  transition: background-color $transition-fast;

  &:hover {
    background-color: $bg-secondary;
  }
}

.session-model-group-arrow {
  flex-shrink: 0;
  transition: transform $transition-fast;

  &.collapsed {
    transform: rotate(-90deg);
  }
}

.session-model-group-label {
  flex: 1;
}

.session-model-group-count {
  font-size: 11px;
  color: $text-muted;
  font-weight: 400;
}

.session-model-group-items {
  padding-left: 8px;
}

.session-model-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 13px;
  color: $text-secondary;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover {
    background-color: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }

  &.active {
    color: $accent-primary;
    font-weight: 500;
  }

  &.disabled {
    opacity: 0.45;
    cursor: not-allowed;

    &:hover {
      background-color: transparent;
      color: $text-secondary;
    }
  }
}

.session-model-item-label {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.session-model-item-name,
.session-model-item-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: $font-code;
}

.session-model-item-name {
  font-size: 12px;
}

.session-model-item-id {
  color: $text-muted;
  font-size: 10px;
  font-weight: 400;
}

.session-model-check {
  flex-shrink: 0;
  color: $accent-primary;
}

.session-model-badge-cap {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 1;
  opacity: 0.85;
  margin-right: 2px;
}

.session-model-badge-preview,
.session-model-badge-custom,
.session-model-badge-disabled {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  margin-right: 4px;
  letter-spacing: 0.03em;
}

.session-model-badge-preview {
  color: #fff;
  background: #d97706;
}

.session-model-badge-custom {
  color: #fff;
  background: $accent-primary;
}

.session-model-badge-disabled {
  color: $text-muted;
  background: transparent;
  border: 1px solid $border-color;
  padding: 0 5px;
}

.session-model-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
  color: $text-muted;
}

.session-model-custom {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid $border-color;
}

.session-model-custom-row {
  display: flex;
  gap: 8px;
}

.session-model-custom-provider {
  width: 160px;
  flex-shrink: 0;
}

.session-model-custom-input {
  flex: 1;
}

.session-model-custom-hint {
  margin-top: 6px;
  font-size: 11px;
  color: $text-muted;
}

// Prototype aside: 248px (rail 64), --bg-softer, one 12/12/16 padding frame
// shared by both states so nothing jumps while the width animates.
.session-list {
  width: $sidebar-width;
  background: var(--bg-softer);
  // §9.6: hairlines are 0.5pt. At 1px on a 2x screen this rail edge is two
  // physical pixels — twice the spec, and it is the longest line on screen.
  border-right: 0.5px solid $border-color;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  padding: 12px 12px 16px;
  transition:
    width $transition-normal,
    opacity $transition-normal;
  overflow: hidden;

  // Collapsed is a 64px icon rail, not a full hide: the nav folds to centered
  // glyphs (PageSidebarNav `collapsed`) and the footer to a single avatar.
  &.collapsed {
    width: 64px;
  }

  @media (max-width: $breakpoint-mobile) {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    z-index: 120;
    background: var(--bg-softer);
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.1);
    width: $sidebar-width;

    // On mobile the sidebar is an overlay drawer, so collapsed means hidden
    // entirely rather than a rail.
    &.collapsed {
      width: $sidebar-width;
      transform: translateX(-100%);
      opacity: 0;
      pointer-events: none;
    }
  }
}

// The expanded sidebar body is the slotted PageSidebarNav; it owns the single
// scroll region and the footer divider.
.page-sidebar-body {
  flex: 1;
  min-height: 0;
}

.page-sidebar-rail {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.page-sidebar-rail-foot {
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  padding-top: 12px;
}

@media (max-width: $breakpoint-mobile) {
  .session-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 110;
    opacity: 0;
    pointer-events: none;
    transition: opacity $transition-fast;

    &.active {
      opacity: 1;
      pointer-events: auto;
    }
  }
}

// Prototype 任务列表 section header: label left, one 32px icon button right,
// inset "0 4px 8px 12px" inside the shared scroll region.
.session-section-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  padding: 0 4px 8px 12px;
}

.session-section-title {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  font: var(--w-semibold) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-secondary);
}

.session-filter-btn {
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

  &:hover,
  &.is-open {
    background: var(--gray-f2);
    color: var(--fg-primary);
  }
}

.page-sidebar-bottom {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

// Clickable user row → opens the UserMenu popover. Height 40, quiet hover tint.
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

  // Prototype states: open = selected tint, hover = surface-3 (hover wins
  // while both apply — declared after so it takes precedence, matching the
  // prototype's !important hover rule).
  &.is-open {
    background: var(--selected-bg);
  }

  &:hover {
    background: var(--surface-3);
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

.sidebar-user__name {
  flex: 1;
  min-width: 0;
  // The trigger is a <button>, which centers its text by default; without this
  // the name is centered inside its flex box and drifts far from the avatar.
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
  color: var(--fg-secondary);
}

.sidebar-user__settings {
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

// Collapsed rail avatar: same 24px avatar as the expanded account row
// (prototype keeps ONE avatar size across both states), centered, a button
// that opens the UserMenu.
.sidebar-user__avatar--rail {
  border: 0;
  cursor: pointer;
  transition: box-shadow var(--motion-fast) var(--ease-std);

  &:hover {
    box-shadow: inset 0 0 0 2px var(--gray-e0);
  }
}

// ─── UserMenu popover ───────────────────────────────────────
.user-menu {
  position: fixed;
  z-index: 3001;
  width: 224px;
  padding: 6px;
  background: var(--bg);
  border-radius: var(--r-card);
  // Prototype UserMenu chrome: the notification shadow, no hairline ring.
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

  // Label only — :not() keeps this off the KpThemeSeg root (also a direct
  // <span> child, since a child component's root carries the parent's scope
  // attribute), which flex:1 + overflow:hidden used to stretch and clip.
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
    background: var(--surface-3);
  }

  // The appearance row still tints on hover (every .row does in the prototype)
  // but is not itself clickable — only the segments are.
  &--appearance {
    cursor: default;
  }
}

// The appearance segmented control lives in the shared KpThemeSeg component.

.user-menu__divider {
  height: 1px;
  margin: 6px 0;
  background: var(--divider);

  // Prototype: the head's divider carries no top margin — the head padding
  // already provides the 12px.
  &:first-of-type {
    margin-top: 0;
  }
}

// ─── Session row menu (prototype TaskMenu) ──────────────────
.session-menu {
  position: fixed;
  z-index: 3001;
  width: 176px;
  padding: 6px;
  background: var(--bg);
  border-radius: var(--r-card);
  box-shadow: var(--shadow-notification);
}

.session-menu--sub {
  z-index: 3002;
  // The folder list is real data and can be long — scroll inside the card
  // rather than running off-screen (the prototype's mock list is always short).
  max-height: min(360px, calc(100vh - 24px));
  overflow-y: auto;
}

.session-menu__empty {
  display: flex;
  align-items: center;
  height: 36px;
  padding: 0 10px;
  color: var(--fg-aux);
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
}

.session-menu__item {
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

  > span {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  :deep(.session-menu__icon) {
    color: var(--fg-aux);
  }

  :deep(.session-menu__arrow) {
    color: var(--fg-disabled);
  }

  &:hover {
    background: var(--surface-3);
  }

  &.is-danger {
    color: var(--danger);

    :deep(.session-menu__icon) {
      color: var(--danger);
    }
  }
}

.session-menu__divider {
  height: 1px;
  margin: 4px 0;
  background: var(--divider);
}

// ─── 筛选 popover ───────────────────────────────────────────
// Same chrome as the UserMenu: 224px card, notification shadow, fixed.
.session-filter-backdrop {
  position: fixed;
  inset: 0;
  z-index: 3000;
}

.session-filter-panel {
  position: fixed;
  z-index: 3001;
  width: 224px;
  padding: 6px;
  background: var(--bg);
  border-radius: var(--r-card);
  box-shadow: var(--shadow-notification);
}

.session-filter-divider {
  height: 1px;
  margin: 6px 0;
  background: var(--divider);
}

.session-filter-item {
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

  > span {
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

  &:hover {
    background: var(--gray-f2);
  }
}

.session-profile-filter {
  width: 100%;
  margin-bottom: 6px;
}

.workspace-groups {
  padding-top: 2px;
}

.workspace-group-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-ctl);
  background: transparent;
  color: var(--fg-primary);
  font: var(--w-regular) var(--t-13) / var(--lh-1) var(--font-cn);
  cursor: pointer;
  text-align: left;
  transition: background var(--motion-fast) var(--ease-std);

  &:hover {
    background: var(--gray-f2);
  }

  &.active {
    background: var(--gray-f2);
    color: var(--fg-title);
  }
}

.workspace-group-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 8px 10px 4px;
  border: 0;
  background: transparent;
  cursor: pointer;
}

// Shared by the filter popover's workspace group and the in-list agent groups.
.session-group-caret {
  color: var(--fg-disabled);
  font-size: 10px;
  transition: transform 0.15s ease;

  &.collapsed {
    transform: rotate(-90deg);
  }
}

.workspace-group-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// Batch bar (only while batch mode is on) — reuses the section head slot.
.session-list-actions {
  display: flex;
  align-items: center;
  gap: 4px;

  .n-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 24px;
    min-height: 24px;
  }
}

.new-chat-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

:deep(.new-chat-drawer .n-drawer-content) {
  height: 100%;
  display: flex;
  flex-direction: column;
}

:deep(.new-chat-drawer .n-drawer-header),
:deep(.new-chat-drawer .n-drawer-footer) {
  flex-shrink: 0;
}

:deep(.new-chat-drawer .n-drawer-body) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

:deep(.new-chat-drawer .n-drawer-body-content-wrapper) {
  height: 100%;
  overflow-y: auto;
}

:deep(.new-chat-drawer .folder-picker) {
  max-height: 260px;
}

:deep(.new-chat-drawer .folder-tree) {
  max-height: 170px;
}

@media (max-width: $breakpoint-mobile) {
  :deep(.new-chat-drawer .n-drawer-body-content-wrapper) {
    padding-top: 12px;
    padding-bottom: 12px;
  }

  :deep(.new-chat-drawer .folder-picker) {
    max-height: 210px;
  }

  :deep(.new-chat-drawer .folder-tree) {
    max-height: 128px;
  }
}

.new-chat-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.new-chat-label {
  font-size: 12px;
  color: $text-muted;
  font-weight: 500;
}

.new-chat-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.session-group-header {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
}

.session-group-label {
  font-size: 12px;
  font-weight: var(--w-medium);
  color: var(--fg-disabled);
}

// In-list agent group header. Borrows .session-group-header's shape and adds
// the row insets the task rows carry, so the label lines up with their titles.
.session-agent-group {
  width: 100%;
  border: 0;
  background: transparent;
  padding: 12px 12px 4px;
  text-align: left;

  .session-group-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__count {
    font: var(--w-regular) var(--t-12) / var(--lh-1) var(--font-data);
    color: var(--fg-disabled);
    font-variant-numeric: tabular-nums;
  }
}

// The rows live inside the shared sidebar scroll region (PageSidebarNav's
// body); this is just a plain column, gaps come from the rows' own margins.
.session-items {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.session-loading,
.session-empty {
  padding: 16px 10px;
  font-size: 12px;
  color: $text-muted;
  text-align: center;
}

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

// Home state: no title bar, and the composer belongs to the centered column
// under the wordmark rather than being a full-width bar welded to the floor.
// 800px is the content measure the whole home block shares.
.chat-main.is-home {
  // The whole home column is centered in the viewport rather than the message
  // list taking all the height and shoving the composer to the floor. It is
  // the list shell that grows, not the empty block inside it, so this is the
  // element that has to stop growing.
  // Top-aligned with 96px of headroom, not vertically centered: the block
  // grows downward as suggestions appear, and centering would make the
  // wordmark drift every time the content below it changes height.
  // The prototype's home pad is `96px 40px 56px`. The side padding only bites
  // below 880, where the 800 column stops fitting; the 56 is what keeps the
  // last starter card off the floor.
  .chat-main-content {
    justify-content: flex-start;
    padding: 96px 40px 56px;
  }

  // Hero, composer and starters are all one 800 column, flush left and right.
  // They each used to carry an extra `padding: 0 8px`, which pulled the
  // wordmark and the starter grid 16px narrower than the composer between
  // them — three things that are meant to share one edge, on two edges.
  // ⚠️ The 104 height is locked, NOT left to the text. There is a regression
  // contract that the composer's top sits at 232 (wordmark 104 + gap 32), and
  // KpSplitText's glyphs are inline-block with a translateY entrance — letting the
  // line size itself pushes the composer down. 56px/1.2 measures ~67, so this
  // height is doing real work.
  .home-hero {
    width: 100%;
    max-width: 800px;
    height: 104px;
    display: grid;
    place-items: center;
    margin: 0 auto 32px;
  }

  :deep(.chat-input-area) {
    width: 100%;
    max-width: 800px;
    margin: 0 auto;
  }

  // The mascot's anchor — and it has to BE the 800 column, not just a
  // `position: relative` around it. Left full width, `right: 0` on the mascot
  // resolves against the whole content area and parks it at the far edge of the
  // window instead of on the composer's corner. The composer inside is already
  // capped at 800 and centred, so without these three lines the wrapper and the
  // thing it is supposed to anchor to are different boxes.
  .home-composer-wrap {
    position: relative;
    width: 100%;
    max-width: 800px;
    margin-left: auto;
    margin-right: auto;
  }

  .home-starters {
    width: 100%;
    max-width: 800px;
    // 40px top matches the prototype's StarterBoard marginTop. Spelled out
    // here because this shorthand previously (`margin: 0 auto`) silently
    // zeroed the component's own margin-top and welded the chips to the
    // composer's bottom edge.
    margin: 40px auto 0;
  }
}

.chat-content-wrapper {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
  min-width: 0;
  max-width: 100%;
}

.chat-content-wrapper--surface {
  background: $bg-primary;
}

.chat-surface-host {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.chat-surface-host > * {
  height: 100%;
  min-height: 0;
}

.chat-main-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

// Model picker pill, relocated from the header into the composer tool row.
// Flat Keep pill matching .composer-scope-pill / the prototype ModePicker: a
// leading sparkle, the active model label, and a caret. No drop shadow; hover
// deepens the surface tint. Click opens the existing model-selection flow.
/* Lives in the composer's pill row, not below the box: the row is where the
   other scope statements already are. */
.composer-workspace-button {
  padding: 4px 9px;
  border: 1px solid $border-color;
  border-radius: 999px;
  background: $bg-card;
  color: $text-secondary;
  cursor: pointer;
  font-size: 12px;

  &:hover {
    color: $text-primary;
    border-color: $accent-primary;
  }
}

.composer-model-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  max-width: 260px;
  padding: 0 13px;
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--fg-primary);
  font: var(--w-medium) var(--t-12) / var(--lh-1) var(--font-cn);
  cursor: pointer;
  flex: none;
  transition: background var(--motion-fast) var(--ease-std),
    color var(--motion-fast) var(--ease-std);

  &:hover,
  &.open {
    background: var(--surface-2);
  }

  &__spark {
    color: var(--hue-blue);
    flex: none;
  }

  &__label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__effort {
    color: var(--fg-aux);
    flex: none;
  }

  &__caret {
    color: var(--fg-disabled);
    flex: none;
    transition: transform var(--motion-fast) var(--ease-std);
  }

  &.open &__caret {
    transform: rotate(180deg);
  }
}

// Model picker popover (prototype ModePicker): two-level hover menu.
.model-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 29;
}

.model-menu {
  position: fixed;
  width: 260px;
  padding: 8px;
  overflow: auto;
  background: var(--bg);
  border-radius: var(--r-card);
  // Hairline in and out, no drop shadow: §7.1 gives cards no shadow, and the
  // prototype's own popovers carry exactly this double 0.5px ring.
  box-shadow:
    inset 0 0 0 0.5px var(--divider),
    0 0 0 0.5px var(--divider);
  z-index: 30;

  &--sub {
    // Same clamp as the prototype — a fixed 280 overflows a phone viewport.
    width: min(280px, calc(100vw - 32px));
    z-index: 31;
  }

  &__title,
  &__group {
    padding: 4px 12px;
    font: var(--w-regular) var(--t-12) / var(--lh-1) var(--font-cn);
    color: var(--fg-disabled);
  }

  &__group {
    color: var(--fg-aux);
  }

  // Level-1 row: left label, right current value + caret. Hover opens sub.
  &__row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: var(--r-ctl);
    cursor: pointer;

    &.active {
      background: var(--selected-bg);
    }

    &-label {
      flex: 1;
      font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
      color: var(--fg-primary);
    }

    &-value {
      max-width: 108px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
      color: var(--fg-aux);
    }

    &-caret {
      color: var(--fg-disabled);
      flex: none;
    }
  }

  &__divider {
    height: 1px;
    margin: 4px 4px;
    background: var(--divider);
  }

  // Footer row (add model).
  &__foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: var(--r-ctl);
    cursor: pointer;

    &:hover {
      background: var(--surface-3);
    }

    &-label {
      flex: 1;
      font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
      color: var(--fg-secondary);
    }

    &-icon {
      color: var(--fg-aux);
      flex: none;
    }
  }

  // Level-2 option: name + optional desc + check.
  &__opt {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 12px;
    border-radius: var(--r-ctl);
    cursor: pointer;

    &:hover {
      background: var(--surface-3);
    }

    &.locked {
      opacity: 0.4;
      cursor: default;

      &:hover {
        background: transparent;
      }
    }

    &-body {
      flex: 1;
      min-width: 0;
    }

    &-name {
      font: var(--w-medium) var(--t-14) / var(--lh-1) var(--font-cn);
      color: var(--fg-primary);
    }

    &-desc {
      font: var(--w-regular) var(--t-12) / var(--lh-1) var(--font-cn);
      color: var(--fg-aux);
    }

    &-check {
      margin-top: 4px;
      color: var(--fg-title);
      flex: none;
    }
  }
}

// Prototype run header: one 12/24 strip on a hairline, reading
// mark → title → time, with the actions pushed right by a flex spacer.
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  border-bottom: 0.5px solid var(--divider);
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  // Prototype: title + time sit on the 8px step (the agent mark that used to
  // open this row is gone, so 10 had nothing left to separate).
  gap: 8px;
  overflow: hidden;
  flex: 1;
  min-width: 0;
}

.header-session-title {
  font: var(--w-medium) var(--t-14) / var(--lh-tight) var(--font-cn);
  color: var(--fg-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-session-time {
  font: var(--w-regular) var(--t-12) / var(--lh-tight) var(--font-cn);
  color: var(--fg-aux);
  flex: 0 0 auto;
}

.expert-session-identity {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}

.expert-session-avatar {
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  object-fit: cover;
}

.expert-session-avatar--fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(var(--accent-primary-rgb), 0.14);
  color: var(--accent-primary);
  font-weight: 700;
}

.expert-session-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;

  strong,
  small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    color: $text-primary;
    font-size: 14px;
  }

  small {
    color: $text-muted;
    font-size: 11px;
  }
}

.expert-session-capabilities {
  flex: 0 0 auto;
  border: 1px solid $border-color;
  border-radius: 999px;
  padding: 4px 9px;
  background: transparent;
  color: var(--accent-primary);
  cursor: pointer;
  font-size: 11px;
}

.source-badge {
  font-size: 10px;
  color: $text-muted;
  background: rgba($text-muted, 0.12);
  padding: 1px 7px;
  border-radius: 8px;
  flex-shrink: 0;
  white-space: nowrap;
  line-height: 16px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;

  // Prototype header actions are 32px transparent ghost circles tinted
  // fg-aux, not bordered controls. Naive writes its own --n-text-color as an
  // inline style, so the tint has to be set on `color` directly.
  :deep(.n-button) {
    width: 32px;
    height: 32px;
    color: var(--fg-aux);

    &:hover {
      color: var(--fg-secondary);
    }
  }
}

.chat-mode-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-right: 4px;
}

@media (max-width: $breakpoint-mobile) {
  .chat-header {
    padding: calc(16px + env(safe-area-inset-top, 0px)) 12px 16px 52px;
  }


  .expert-session-identity {
    gap: 6px;
  }

  .expert-session-avatar {
    width: 30px;
    height: 30px;
  }

  .expert-session-capabilities {
    padding-inline: 7px;
  }

}

.workspace-badge {
  font-size: 11px;
  color: $text-muted;
  background: rgba(255, 255, 255, 0.05);
  padding: 2px 8px;
  border-radius: 4px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
}

.header-tool-toggle.active {
  color: var(--accent-primary);
  background: rgba(var(--accent-primary-rgb), 0.1);
}

.chat-tool-panel {
  position: relative;
  flex: 0 0 auto;
  min-width: 320px;
  max-width: 100%;
  background: $bg-card;
  border-left: 1px solid $border-color;
  display: flex;
  min-height: 0;
  overflow: visible;
}

.chat-tool-resize-handle {
  position: absolute;
  left: -7px;
  top: 0;
  bottom: 0;
  width: 14px;
  cursor: col-resize;
  z-index: 20;

  &::after {
    content: "";
    position: absolute;
    left: 6px;
    top: 0;
    bottom: 0;
    width: 1px;
    background:
      linear-gradient($border-color, $border-color) top / 1px calc(50% - 26px) no-repeat,
      linear-gradient($border-color, $border-color) bottom / 1px calc(50% - 26px) no-repeat;
    transition: background $transition-fast;
    z-index: 1;
  }

  &::before {
    content: "";
    position: absolute;
    left: 1px;
    top: 50%;
    width: 12px;
    height: 38px;
    transform: translateY(-50%);
    border-radius: 6px;
    background:
      linear-gradient($text-muted, $text-muted) center 12px / 6px 1px no-repeat,
      linear-gradient($text-muted, $text-muted) center 19px / 6px 1px no-repeat,
      linear-gradient($text-muted, $text-muted) center 26px / 6px 1px no-repeat,
      $bg-card;
    border: 1px solid $border-color;
    opacity: 0.9;
    transition: all $transition-fast;
    z-index: 2;
  }

  &:hover::after {
    background:
      linear-gradient(var(--accent-primary), var(--accent-primary)) top / 1px calc(50% - 26px) no-repeat,
      linear-gradient(var(--accent-primary), var(--accent-primary)) bottom / 1px calc(50% - 26px) no-repeat;
  }

  &:hover::before {
    background:
      linear-gradient(var(--accent-primary), var(--accent-primary)) center 12px / 6px 1px no-repeat,
      linear-gradient(var(--accent-primary), var(--accent-primary)) center 19px / 6px 1px no-repeat,
      linear-gradient(var(--accent-primary), var(--accent-primary)) center 26px / 6px 1px no-repeat,
      $bg-card;
    border-color: var(--accent-primary);
    opacity: 1;
  }
}

.chat-tool-panel-inner {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.chat-tool-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.chat-tool-content > * {
  height: 100%;
  min-height: 0;
}

@media (max-width: $breakpoint-mobile) {
  .chat-tool-panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 70;
    left: 0;
    width: 100% !important;
    min-width: 0;
    border-left: none;
    box-shadow: none;
  }

  .chat-tool-resize-handle {
    display: none;
  }
}
</style>
