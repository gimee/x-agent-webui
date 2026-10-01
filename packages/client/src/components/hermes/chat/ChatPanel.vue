<script setup lang="ts">
import {
  exportSession,
  renameSession,
  setSessionWorkspace,
} from "@/api/studio/sessions";
import type { AvailableModelGroup } from "@/api/hermes/system";
import { fetchCodingAgentsStatus, inferCodingAgentApiMode, normalizeCodingAgentApiMode, type ChatCodingAgentId, type CodingAgentApiMode, type CodingAgentId } from "@/api/coding-agents";
import { agentInstallationState, fetchAgentAvailabilitySnapshot } from "@/api/agent-status";
import { useChatStore, type Session } from "@/stores/hermes/chat";
import { useAppStore } from "@/stores/hermes/app";
import { useProfilesStore } from "@/stores/hermes/profiles";
import { useFilesStore } from "@/stores/hermes/files";
import { useToolPanelStore } from "@/stores/hermes/tool-panel";
import { useSessionBrowserPrefsStore } from "@/stores/hermes/session-browser-prefs";
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NDropdown,
  NInput,
  NModal,
  NSelect,
  NTooltip,
  NRadioButton,
  NRadioGroup,
  NSpin,
  useMessage,
  type DropdownOption,
} from "naive-ui";
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { copyToClipboard } from "@/utils/clipboard";
import FolderPicker from "./FolderPicker.vue";
import ChatInput from "./ChatInput.vue";
import RealtimeVoiceStage from "./RealtimeVoiceStage.vue";
import ConversationMonitorPane from "./ConversationMonitorPane.vue";
import MessageList from "./MessageList.vue";
import SessionListItem from "./SessionListItem.vue";
import SessionListTabs from "./SessionListTabs.vue";
import VirtualSessionList from "./VirtualSessionList.vue";
import OutlinePanel from "./OutlinePanel.vue";
import SubagentStreamPanel from "./SubagentStreamPanel.vue";
import { buildActiveSessionMenuOptions, buildSessionContextMenuOptions } from "./session-menu-options";
import PageSidebarNav from "@/components/layout/PageSidebarNav.vue";
import { isStoredSuperAdmin } from "@/api/client";
import { useDefaultWorkspace } from "@/composables/useDefaultWorkspace";
import { useCollapsedProviderGroups } from "@/composables/useCollapsedProviderGroups";
import { canScopedCodingAgentUseProvider, usesServerManagedProviderAuth } from "@/utils/codingAgentProviders";
import { OPEN_SUBAGENT_STREAM_EVENT, type OpenSubagentStreamDetail } from "@/utils/hermes/subagent-stream";
import { desktopBridge, hasDesktopBrowserBridge } from "@/utils/desktop-bridge";
import { OPEN_DESKTOP_BROWSER_PANEL_EVENT } from "@/utils/desktop-browser";
import {
  createBrowserAnnotationAttachment,
  type BrowserAnnotationSubmission,
} from "@/utils/browser-annotation-submit";

const props = withDefaults(defineProps<{
  standalone?: boolean;
  // community-restored-content-mode-prop
  contentMode?: "chat" | "connections" | "agents" | "models" | "skills" | "memory";
  initialComposerText?: string;
  composerPersistDraft?: boolean;
}>(), {
  standalone: false,
  contentMode: "chat",
  initialComposerText: "",
  composerPersistDraft: true,
});

const FilesPanel = defineAsyncComponent(async () => (await import('./FilesPanel.vue')).default);
const ConnectionsPanel = defineAsyncComponent(async () => (await import('@/components/hermes/connections/ConnectionsPanel.vue')).default);
const AgentManagerPanel = defineAsyncComponent(async () => (await import('@/views/hermes/AgentManagerView.vue')).default);
const ModelsPanel = defineAsyncComponent(async () => (await import('@/views/hermes/ModelsView.vue')).default);
// community-restored-content-panels
const SkillsPanel = defineAsyncComponent(async () => (await import('@/views/hermes/SkillsView.vue')).default);
const MemoryPanel = defineAsyncComponent(async () => (await import('@/views/hermes/MemoryView.vue')).default);
const WorkspaceDiffPreview = defineAsyncComponent(async () => (await import('@/components/hermes/files/WorkspaceDiffPreview.vue')).default);
const FilePreview = defineAsyncComponent(async () => (await import('@/components/hermes/files/FilePreview.vue')).default);
const DesktopBrowserPanel = defineAsyncComponent(async () => (await import('./DesktopBrowserPanel.vue')).default);
// hermes-v050:C6 终端面板只在工具面板里按需出现，xterm 不再进聊天首屏静态闭包。
const TerminalPanel = defineAsyncComponent(async () => (await import('./TerminalPanel.vue')).default);

const chatStore = useChatStore();
const appStore = useAppStore();
const profilesStore = useProfilesStore();
const filesStore = useFilesStore();
const toolPanelStore = useToolPanelStore();
const sessionBrowserPrefsStore = useSessionBrowserPrefsStore();
const router = useRouter();
const message = useMessage();
const { t } = useI18n();
const isSuperAdmin = computed(() => isStoredSuperAdmin());

const showOutline = ref(false);
const ACTIVE_SESSION_MENU_ID = "active-session-actions-menu";
const showActiveSessionMenu = ref(false);
const activeSessionMenuTriggerRef = ref<InstanceType<typeof NButton> | null>(null);
let activeSessionMenuInitialFocus: "first" | "last" = "first";
let restoreActiveSessionMenuTriggerFocus = false;
const activeSessionSupportsPersistence = computed(() =>
  Boolean(chatStore.activeSession && !chatStore.activeSession.isLocalOnly),
);
const showRealtimeVoice = ref(false);
const messageListRef = ref<InstanceType<typeof MessageList> | null>(null);
const chatInputRef = ref<(InstanceType<typeof ChatInput> & {
  addFiles?: (files: File[]) => void;
  focusComposer?: () => void;
}) | null>(null);
const chatContentWrapperRef = ref<HTMLElement | null>(null);
const chatMainContentRef = ref<HTMLElement | null>(null);
let sessionFadeAnimation: Animation | null = null;
let workspacePreviewRequestSeq = 0;
let workspacePreviewRequestPending = false;
const chatDropCounter = ref(0);
const isChatDropActive = ref(false);
const showToolPanel = ref(false);
const previewOnlyFileOpen = ref(false);
const toolPanelTransitionReady = ref(false);
const activeToolPanel = ref<"files" | "terminal" | "browser">("files");
const desktopBrowserAvailable = hasDesktopBrowserBridge();
const desktopChatWindowAvailable = desktopBridge()?.isDesktop === true
  && typeof desktopBridge()?.openChatWindow === "function";
const selectedSubagent = ref<OpenSubagentStreamDetail | null>(null);
const selectedSubagentStream = computed(() => {
  const selected = selectedSubagent.value;
  return selected ? chatStore.getSubagentStream(selected.sessionId, selected.subagentId) : null;
});
const activeWorkspaceSessionId = computed(() => chatStore.activeSession?.workspace && !chatStore.activeSession.isLocalOnly ? chatStore.activeSession.id : null);
const activePreviewSessionId = computed(() => chatStore.activeSession?.id && !chatStore.activeSession.isLocalOnly ? chatStore.activeSession.id : null);
const activeWorkspacePath = computed(() => chatStore.activeSession?.workspace && !chatStore.activeSession.isLocalOnly ? chatStore.activeSession.workspace : null);
const TOOL_PANEL_MIN_WIDTH = 360;
const TOOL_PANEL_DEFAULT_WIDTH = 560;
const TOOL_PANEL_STORAGE_KEY = "hermes.chat.toolPanelWidth";
const toolPanelWidth = ref(loadToolPanelWidth());
const toolResizeStart = ref<{ x: number; width: number; deltaSign: 1 | -1 } | null>(null);

const currentMode = ref<"chat" | "live">("chat");


// Initialize synchronously from the media query so first paint is correct.
// On narrow viewports the session list is an absolute-positioned overlay
// (z-index 10) on top of the chat area; if we default to `true`, onMounted
// only flips it to `false` AFTER the first render, causing a visible flash
// where the session list covers the chat content ("auto-fixes after a
// moment" — that was the race).
const showSessions = ref(
  !props.standalone && (
    typeof window === "undefined" ||
    !window.matchMedia("(max-width: 768px)").matches
  )
);
const pageSidebarExpanded = computed(
  () => !props.standalone && currentMode.value === "chat" && showSessions.value,
);
let mobileQuery: MediaQueryList | null = null;
const isMobile = ref(
  typeof window !== "undefined" &&
  window.matchMedia("(max-width: 768px)").matches,
);
const toolPanelStyle = computed(() => ({
  width: isMobile.value ? "100%" : `min(${toolPanelWidth.value}px, 100%)`,
}));

function openRealtimeVoice() {
  if (!chatStore.activeSessionId) return;
  showRealtimeVoice.value = true;
}

function closeRealtimeVoice() {
  showRealtimeVoice.value = false;
}

function sessionHref(sessionId: string, profile?: string | null) {
  return router.resolve({
    name: chatStore.runtimeMode === "global_agent" ? "hermes.globalAgentSession" : "hermes.session",
    params: { sessionId },
    query: profile ? { profile } : undefined,
  }).href;
}

function openSessionInNewTab(sessionId: string, profile = sessionProfile(sessionId)) {
  if (typeof window === "undefined") return;
  const bridge = desktopBridge();
  if (bridge?.isDesktop && bridge.openChatWindow) {
    void bridge.openChatWindow(sessionId, profile || undefined);
    return;
  }
  window.open(sessionHref(sessionId, profile), "_blank", "noopener,noreferrer");
}

function handleOutlineNavigate(target: { messageId: string; anchorId: string }) {
  messageListRef.value?.scrollToAnchor(target.messageId, target.anchorId);
  if (isMobile.value) showOutline.value = false;
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
  const delta = (event.clientX - start.x) * start.deltaSign;
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
    deltaSign: document.documentElement.dir === "rtl" ? 1 : -1,
  };
  window.addEventListener("pointermove", handleToolResizeMove);
  window.addEventListener("pointerup", stopToolResize);
  document.body.style.userSelect = "none";
  document.body.style.cursor = "col-resize";
}

function closeToolPanelOverlay(): boolean {
  if (toolPanelStore.workspaceDiff && filesStore.hasUnsavedChanges) {
    message.warning(t("files.unsavedChanges"));
    return false;
  }
  if (toolPanelStore.workspaceDiff && filesStore.editingFile) filesStore.closeEditor();
  workspacePreviewRequestSeq += 1;
  workspacePreviewRequestPending = false;
  filesStore.closePreview();
  toolPanelStore.closeWorkspaceDiff();
  selectedSubagent.value = null;
  previewOnlyFileOpen.value = false;
  showToolPanel.value = false;
  return true;
}

function toggleToolPanel() {
  if (showToolPanel.value) {
    closeToolPanelOverlay();
    return;
  }
  showToolPanel.value = true;
}

function handleToolPanelBeforeEnter() {
  toolPanelTransitionReady.value = false;
}

function handleToolPanelAfterEnter() {
  toolPanelTransitionReady.value = true;
}

function handleToolPanelBeforeLeave() {
  toolPanelTransitionReady.value = false;
}

function handleToolPanelLeaveCancelled() {
  toolPanelTransitionReady.value = true;
}

function hasDraggedFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

function resetChatDropState() {
  chatDropCounter.value = 0;
  isChatDropActive.value = false;
}

function handleChatDragOver(event: DragEvent) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function handleChatDragEnter(event: DragEvent) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  chatDropCounter.value += 1;
  isChatDropActive.value = true;
}

function handleChatDragLeave(event: DragEvent) {
  if (!hasDraggedFiles(event)) return;
  chatDropCounter.value -= 1;
  if (chatDropCounter.value <= 0) resetChatDropState();
}

function handleChatDrop(event: DragEvent) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  const files = Array.from(event.dataTransfer?.files || []);
  const target = event.target instanceof Element ? event.target : null;
  resetChatDropState();
  if (!files.length || target?.closest(".chat-input-area")) return;
  chatInputRef.value?.addFiles?.(files);
}

function handleWorkspaceFileAttach(file: File) {
  chatInputRef.value?.addFiles?.([file]);
}

async function submitBrowserAnnotations(payload: BrowserAnnotationSubmission): Promise<boolean> {
  const attachment = createBrowserAnnotationAttachment(payload);
  await chatStore.sendMessage("", [attachment]);
  return true;
}

async function handleSessionClick(sessionId: string) {
  chatStore.clearSessionCompletedUnread(sessionId);
  await router.push({
    name: chatStore.runtimeMode === "global_agent" ? "hermes.globalAgentSession" : "hermes.session",
    params: { sessionId },
  });
  if (chatStore.activeSessionId !== sessionId) {
    await chatStore.switchSession(sessionId);
  }
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

watch(
  pageSidebarExpanded,
  (expanded) => appStore.setPageSidebarExpanded(expanded),
  { immediate: true },
);

function workspacePreviewPath(filePath: string): string | null {
  const workspace = activeWorkspacePath.value?.replace(/\\/g, "/").replace(/\/+$/, "");
  let decodedPath = filePath;
  try {
    decodedPath = decodeURIComponent(filePath);
  } catch {
    // Keep malformed percent sequences unchanged so the server can reject them.
  }
  const normalizedPath = decodedPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedPath || !(normalizedPath.startsWith("/") || /^[a-zA-Z]:\//.test(normalizedPath))) return null;
  if (!workspace) return normalizedPath;
  const ignoreCase = /^[a-zA-Z]:\//.test(workspace);
  const comparableWorkspace = ignoreCase ? workspace.toLowerCase() : workspace;
  const comparablePath = ignoreCase ? normalizedPath.toLowerCase() : normalizedPath;
  if (!comparablePath.startsWith(`${comparableWorkspace}/`)) return normalizedPath;
  return normalizedPath.slice(workspace.length + 1);
}

function handleWorkspaceFilePreviewRequest(event: Event) {
  const customEvent = event as CustomEvent<{ path?: string; fileName?: string; previewOnly?: boolean }>;
  const sessionId = activePreviewSessionId.value;
  const filePath = typeof customEvent.detail?.path === "string" ? customEvent.detail.path : "";
  const previewPath = workspacePreviewPath(filePath);
  if (!sessionId || !previewPath) return;

  customEvent.preventDefault();
  const requestSeq = ++workspacePreviewRequestSeq;
  workspacePreviewRequestPending = true;
  const fileName = customEvent.detail?.fileName || previewPath.split("/").pop() || previewPath;
  filesStore.closePreview();
  toolPanelStore.closeWorkspaceDiff();
  selectedSubagent.value = null;
  const previewOnly = customEvent.detail?.previewOnly === true;
  previewOnlyFileOpen.value = previewOnly;
  if (previewOnly) showToolPanel.value = true;
  void filesStore.openSessionWorkspacePreview(sessionId, previewPath, fileName)
    .then(() => {
      if (requestSeq === workspacePreviewRequestSeq) workspacePreviewRequestPending = false;
    })
    .catch((error) => {
      if (requestSeq !== workspacePreviewRequestSeq) return;
      workspacePreviewRequestPending = false;
      previewOnlyFileOpen.value = false;
      if (previewOnly) showToolPanel.value = false;
      message.error(error instanceof Error ? error.message : t("files.previewFailed"));
    });
}

function handleOpenSubagentStreamRequest(event: Event) {
  const customEvent = event as CustomEvent<OpenSubagentStreamDetail>;
  const detail = customEvent.detail;
  if (!detail?.sessionId || !detail.subagentId || detail.sessionId !== chatStore.activeSessionId) return;
  if (toolPanelStore.workspaceDiff && filesStore.hasUnsavedChanges) {
    message.warning(t("files.unsavedChanges"));
    return;
  }
  if (toolPanelStore.workspaceDiff && filesStore.editingFile) filesStore.closeEditor();
  workspacePreviewRequestSeq += 1;
  workspacePreviewRequestPending = false;
  filesStore.closePreview();
  toolPanelStore.closeWorkspaceDiff();
  previewOnlyFileOpen.value = false;
  selectedSubagent.value = detail;
  showToolPanel.value = true;
}

function handleOpenDesktopBrowserPanelRequest() {
  if (!desktopBrowserAvailable) return;
  if (toolPanelStore.workspaceDiff && filesStore.hasUnsavedChanges) {
    message.warning(t("files.unsavedChanges"));
    return;
  }
  if (toolPanelStore.workspaceDiff && filesStore.editingFile) filesStore.closeEditor();
  workspacePreviewRequestSeq += 1;
  workspacePreviewRequestPending = false;
  filesStore.closePreview();
  toolPanelStore.closeWorkspaceDiff();
  previewOnlyFileOpen.value = false;
  selectedSubagent.value = null;
  activeToolPanel.value = "browser";
  showToolPanel.value = true;
}

onMounted(() => {
  resetSessionProfileFilterForChatList();
  mobileQuery = window.matchMedia("(max-width: 768px)");
  handleMobileChange(mobileQuery);
  mobileQuery.addEventListener("change", handleMobileChange);
  window.addEventListener("hermes:open-page-sidebar", openPageSidebar);
  window.addEventListener("hermes:preview-workspace-file", handleWorkspaceFilePreviewRequest);
  window.addEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, handleOpenDesktopBrowserPanelRequest);
  window.addEventListener(OPEN_SUBAGENT_STREAM_EVENT, handleOpenSubagentStreamRequest);
  window.addEventListener("resize", handleToolPanelViewportResize);
  handleToolPanelViewportResize();
  // ChatView.onMounted 已经发起了 profiles 请求；这里只兜底，复用 in-flight，不再打第二路 CLI。
  void profilesStore.ensureProfiles();
});

watch(
  () => chatStore.activeSessionId,
  async (sessionId, previousSessionId) => {
    if (sessionId === previousSessionId || !previousSessionId) return;

    if (filesStore.previewFile || toolPanelStore.workspaceDiff || selectedSubagent.value || previewOnlyFileOpen.value) {
      closeToolPanelOverlay();
    } else {
      workspacePreviewRequestSeq += 1;
      workspacePreviewRequestPending = false;
      filesStore.closePreview();
    }
    if (!sessionId) return;

    await nextTick();
    // A session you just opened should be ready to type in. Without this the
    // composer keeps whatever focus the sidebar click left behind, so the first
    // keystroke goes nowhere.
    chatInputRef.value?.focusComposer?.();

    const surface = chatMainContentRef.value;
    if (!surface || typeof surface.animate !== "function") return;

    sessionFadeAnimation?.cancel();
    sessionFadeAnimation = surface.animate(
      [
        { opacity: 0 },
        { opacity: 1 },
      ],
      {
        duration: 1500,
        easing: "ease",
      },
    );
  },
  { flush: "post" },
);

onUnmounted(() => {
  mobileQuery?.removeEventListener("change", handleMobileChange);
  window.removeEventListener("hermes:open-page-sidebar", openPageSidebar);
  window.removeEventListener("hermes:preview-workspace-file", handleWorkspaceFilePreviewRequest);
  window.removeEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, handleOpenDesktopBrowserPanelRequest);
  window.removeEventListener(OPEN_SUBAGENT_STREAM_EVENT, handleOpenSubagentStreamRequest);
  window.removeEventListener("resize", handleToolPanelViewportResize);
  stopToolResize();
  sessionFadeAnimation?.cancel();
  workspacePreviewRequestSeq += 1;
  if (workspacePreviewRequestPending || previewOnlyFileOpen.value || filesStore.previewFile?.workspaceSessionId) filesStore.closePreview();
  workspacePreviewRequestPending = false;
  previewOnlyFileOpen.value = false;
  toolPanelStore.closeWorkspaceDiff();
  sessionFadeAnimation = null;
});
watch(showToolPanel, async (visible) => {
  if (!visible || isMobile.value) return;
  await nextTick();
  handleToolPanelViewportResize();
});

watch(
  () => toolPanelStore.workspaceDiff,
  (workspaceDiff) => {
    if (workspaceDiff) {
      workspacePreviewRequestSeq += 1;
      workspacePreviewRequestPending = false;
      filesStore.closePreview();
      selectedSubagent.value = null;
      previewOnlyFileOpen.value = false;
      showToolPanel.value = true;
    }
  },
);

watch(
  () => filesStore.previewFile,
  (previewFile) => {
    if (previewFile) {
      selectedSubagent.value = null;
      activeToolPanel.value = "files";
      showToolPanel.value = true;
    }
  },
);

const showRenameModal = ref(false);
const renameValue = ref("");
const renameSessionId = ref<string | null>(null);
const renameInputRef = ref<InstanceType<typeof NInput> | null>(null);
const sessionListTab = ref<"all" | "starred">("all");

function resetSessionProfileFilterForChatList() {
  if (!chatStore.sessionProfileFilter) return;
  chatStore.setSessionProfileFilter(null);
  if (chatStore.sessionsLoaded || chatStore.isLoadingSessions) {
    const routeSessionId = router.currentRoute.value.params.sessionId;
    void chatStore.loadSessions(
      null,
      typeof routeSessionId === "string" ? routeSessionId : chatStore.activeSessionId,
    );
  }
}

watch(
  () => chatStore.sessionProfileFilter,
  resetSessionProfileFilterForChatList,
  { flush: "sync" },
);
function sortSessionsForSidebar(items: Session[]): Session[] {
  return [...items].sort((a, b) => {
    return (b.updatedAt || 0) - (a.updatedAt || 0) || a.id.localeCompare(b.id);
  });
}

const visibleSessions = computed(() => sortSessionsForSidebar(
  sessionListTab.value === "starred"
    ? chatStore.sessions.filter((session) =>
      sessionBrowserPrefsStore.isStarred(session.id),
    )
    : chatStore.sessions,
));

const activeSessionTitle = computed(
  () => chatStore.activeSession?.title || t("chat.newChat"),
);

const activeSessionUsesGlobalCodingAgentConfig = computed(() => {
  const session = chatStore.activeSession;
  return session?.codingAgentMode === "global" && Boolean(session.codingAgentId || session.source === "coding_agent");
});

// hermes-ui-tweaks: the composer label is an unambiguous raw provider:model
// pair; do not replace it with a configured alias.  Self-hosted providers are
// named `custom:<something>` by convention — that namespace prefix is noise in
// a label this narrow, so strip it.
const activeSessionModelLabel = computed(() => {
  const session = chatStore.activeSession;
  if (activeSessionUsesGlobalCodingAgentConfig.value) return t("codingAgents.launchModeGlobal");
  if (!session?.model) return t("models.selectModel");
  const provider = (session.provider?.trim() || "").replace(/^custom:/, "");
  return provider ? `${provider}:${session.model}` : session.model;
});

const headerTitle = computed(() =>
  currentMode.value === "live"
    ? t("chat.liveSessions")
    : activeSessionTitle.value,
);

const showNewChatModal = ref(false);
const newChatAgent = ref<"hermes" | ChatCodingAgentId>("hermes");
const newChatAgentMode = ref<"global" | "scoped">("scoped");
const newChatProfile = ref<string>("default");
const newChatProvider = ref<string>("");
const newChatModel = ref<string>("");
const newChatModelKind = ref<"model" | "moa">("model");
const newChatBaseUrl = ref<string>("");
const newChatApiKey = ref<string>("");
const newChatApiMode = ref<CodingAgentApiMode>("codex_responses");
const newChatWorkspace = ref("");
const newChatLoading = ref(false);

// Default workspace feature (multiple defaults supported)
const defaultWorkspaces = ref<string[]>([]);
const recentWorkspaces = ref<Array<{ path: string; lastUsed: number; useCount: number }>>([]);
let workspaceComposable: ReturnType<typeof useDefaultWorkspace> | null = null;

function initWorkspaceComposable(profile: string) {
  workspaceComposable = useDefaultWorkspace(profile);
  defaultWorkspaces.value = workspaceComposable.loadDefaultWorkspaces();
  recentWorkspaces.value = workspaceComposable.loadRecentWorkspaces();
}

function handleToggleDefaultWorkspace() {
  if (!workspaceComposable) return;
  const currentPath = newChatWorkspace.value;
  if (!currentPath) return;
  
  const isDefault = defaultWorkspaces.value.includes(currentPath);
  if (isDefault) {
    workspaceComposable.removeDefaultWorkspace(currentPath);
    defaultWorkspaces.value = defaultWorkspaces.value.filter(p => p !== currentPath);
  } else {
    workspaceComposable.addDefaultWorkspace(currentPath);
    defaultWorkspaces.value = [...defaultWorkspaces.value, currentPath];
  }
}

function handleSelectRecentWorkspace(path: string) {
  newChatWorkspace.value = path;
}

function handleSelectDefaultWorkspace(path: string) {
  newChatWorkspace.value = path;
  showDefaultWorkspaceMenu.value = false;
}

function handleTogglePinRecent(path: string) {
  if (!workspaceComposable) return;
  const isDefault = defaultWorkspaces.value.includes(path);
  if (isDefault) {
    workspaceComposable.removeDefaultWorkspace(path);
    defaultWorkspaces.value = defaultWorkspaces.value.filter(p => p !== path);
  } else {
    workspaceComposable.addDefaultWorkspace(path);
    defaultWorkspaces.value = [...defaultWorkspaces.value, path];
  }
}

const isCurrentWorkspaceDefault = computed(() => {
  return Boolean(newChatWorkspace.value && defaultWorkspaces.value.includes(newChatWorkspace.value));
});

const showDefaultWorkspaceMenu = ref(false);

function getFolderName(path: string | null): string {
  if (!path) return '';
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

const mostRecentDefaultWorkspace = computed(() => {
  if (defaultWorkspaces.value.length === 0) return null;
  
  // 从最近使用记录中找第一个默认工作区
  const recent = [...recentWorkspaces.value].sort((a, b) => b.lastUsed - a.lastUsed);
  for (const entry of recent) {
    if (defaultWorkspaces.value.includes(entry.path)) {
      return entry.path;
    }
  }
  
  // 如果没有使用记录，返回第一个默认工作区
  return defaultWorkspaces.value[0];
});

// 动态计算可见的工作区数量（根据容器宽度）
const visibleDefaultWorkspaces = computed(() => {
  if (defaultWorkspaces.value.length === 0) return [];
  
  // 简单策略：前2个总是可见，其余通过"更多"菜单
  // 未来可以根据实际容器宽度动态调整
  const maxVisible = Math.min(2, defaultWorkspaces.value.length);
  return defaultWorkspaces.value.slice(0, maxVisible);
});

const hasHiddenDefaults = computed(() => {
  return defaultWorkspaces.value.length > visibleDefaultWorkspaces.value.length;
});

const hiddenDefaultWorkspaces = computed(() => {
  const visible = new Set(visibleDefaultWorkspaces.value);
  return defaultWorkspaces.value.filter(ws => !visible.has(ws));
});

const newChatAgentOptions = computed(() => [
  { label: "Hermes", value: "hermes" },
  { label: "Claude", value: "claude-code" },
  { label: "Codex", value: "codex" },
  { label: "Pi", value: "pi" },
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

function effectiveNewChatMode(
  _agent: typeof newChatAgent.value,
  requestedMode: typeof newChatAgentMode.value,
) {
  return requestedMode;
}

function getModelGroupsForProfile(profile: string) {
  const profileModels = appStore.profileModelGroups.find(
    (entry) => entry.profile === profile,
  );
  return profileModels?.groups || [];
}

function isNewChatProviderAllowed(group: AvailableModelGroup) {
  if (group.provider === "moa") return newChatAgent.value === "hermes";
  const mode = effectiveNewChatMode(newChatAgent.value, newChatAgentMode.value);
  if (!(newChatAgent.value !== "hermes" && mode === "scoped")) return true;
  return canScopedCodingAgentUseProvider(newChatAgent.value as ChatCodingAgentId, group.provider);
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
  if (
    profile === activeProfileName &&
    selectedGroup?.models.includes(selectedModel)
  ) {
    return {
      provider: selectedProvider,
      model: selectedModel,
    };
  }
  const profileModels = appStore.profileModelGroups.find(
    (entry) => entry.profile === profile,
  );
  const defaultProvider = profileModels?.default_provider || "";
  const defaultModel = profileModels?.default || "";
  const providerGroup = defaultProvider
    ? groups.find((group) => group.provider === defaultProvider)
    : undefined;
  const fallbackGroup = providerGroup || groups.find((group) => group.models.length > 0);
  return {
    provider: fallbackGroup?.provider || "",
    model: fallbackGroup?.models.includes(defaultModel)
      ? defaultModel
      : fallbackGroup?.models[0] || "",
  };
}

const newChatProfileOptions = computed(() =>
  (profilesStore.profiles.length > 0 ? profilesStore.profiles : [{ name: "default" }]).map((profile) => ({
    label: profile.name,
    value: profile.name,
  })),
);

const newChatModelGroups = computed(() => {
  const groups = getSelectableModelGroupsForProfile(newChatProfile.value);
  return newChatModelKind.value === "moa"
    ? groups.filter((group) => group.provider === "moa")
    : groups.filter((group) => group.provider !== "moa");
});

const newChatMoaGroup = computed(() =>
  getSelectableModelGroupsForProfile(newChatProfile.value).find((group) => group.provider === "moa"),
);

const newChatCanUseMoa = computed(() =>
  newChatAgent.value === "hermes" && Boolean(newChatMoaGroup.value?.models.length),
);

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
const isNewChatExternalCodingAgent = computed(() => newChatAgent.value === "claude-code" || newChatAgent.value === "codex" || newChatAgent.value === "pi");
const effectiveNewChatAgentMode = computed(() =>
  effectiveNewChatMode(newChatAgent.value, newChatAgentMode.value),
);
const isNewChatGlobalCodingAgent = computed(() =>
  isNewChatCodingAgent.value && effectiveNewChatAgentMode.value === "global",
);
const newChatUsesProviderModel = computed(() => !isNewChatGlobalCodingAgent.value);
const newChatNeedsBaseUrl = computed(() =>
  isNewChatCodingAgent.value && effectiveNewChatAgentMode.value === "scoped" && !selectedNewChatProviderGroup.value?.base_url,
);
const newChatUsesServerAuth = computed(() =>
  usesServerManagedProviderAuth(newChatAgent.value as ChatCodingAgentId, selectedNewChatProviderGroup.value?.provider),
);
const newChatNeedsApiKey = computed(() =>
  isNewChatCodingAgent.value &&
  effectiveNewChatAgentMode.value === "scoped" &&
  !newChatUsesServerAuth.value &&
  !selectedNewChatProviderGroup.value?.api_key,
);
const canConfirmNewChat = computed(() => {
  if (!newChatProfile.value) return false;
  if (!newChatUsesProviderModel.value) return true;
  if (!newChatProvider.value || !newChatModel.value) return false;
  if (!isNewChatCodingAgent.value) return true;
  if (isNewChatCodingAgent.value && effectiveNewChatAgentMode.value === "scoped" && !newChatApiMode.value) return false;
  if (newChatNeedsBaseUrl.value && !newChatBaseUrl.value.trim()) return false;
  if (newChatNeedsApiKey.value && !newChatApiKey.value.trim()) return false;
  return true;
});

function defaultNewChatApiMode(group?: AvailableModelGroup): CodingAgentApiMode {
  const providerKey = String(group?.provider || newChatProvider.value || "").toLowerCase();
  const baseUrl = String(group?.base_url || newChatBaseUrl.value || "").toLowerCase();
  return normalizeCodingAgentApiMode(
    group?.api_mode,
    inferCodingAgentApiMode(providerKey, baseUrl),
  );
}

function syncNewChatApiMode() {
  newChatApiMode.value = defaultNewChatApiMode(selectedNewChatProviderGroup.value);
}

function syncNewChatModelSelection() {
  const defaults = getDefaultModelForProfile(newChatProfile.value);
  newChatModelKind.value = defaults.provider === "moa" && newChatAgent.value === "hermes"
    ? "moa"
    : "model";
  newChatProvider.value = defaults.provider;
  newChatModel.value = defaults.model;
  newChatBaseUrl.value = "";
  newChatApiKey.value = "";
  syncNewChatApiMode();
}

function handleNewChatModelKindChange(value: "model" | "moa") {
  if (value === "moa") {
    const group = newChatMoaGroup.value;
    if (!group?.models.length) return;
    newChatModelKind.value = "moa";
    newChatProvider.value = "moa";
    newChatModel.value = group.models[0];
  } else {
    newChatModelKind.value = "model";
    const groups = getSelectableModelGroupsForProfile(newChatProfile.value)
      .filter((group) => group.provider !== "moa");
    const profileModels = appStore.profileModelGroups.find(
      (entry) => entry.profile === newChatProfile.value,
    );
    const defaultGroup = groups.find((group) => group.provider === profileModels?.default_provider);
    const group = defaultGroup || groups.find((item) => item.models.length > 0);
    newChatProvider.value = group?.provider || "";
    newChatModel.value = group?.models.includes(profileModels?.default || "")
      ? profileModels?.default || ""
      : group?.models[0] || "";
  }
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
  () => {
    ensureNewChatProviderSelection();
    // Reload workspace data when profile changes
    if (newChatProfile.value) {
      initWorkspaceComposable(newChatProfile.value);
    }
  },
);

async function openNewChatModal() {
  showNewChatModal.value = true;
  newChatLoading.value = true;
  try {
    if (profilesStore.profiles.length === 0) await profilesStore.fetchProfiles();
    if (appStore.modelGroups.length === 0 && appStore.profileModelGroups.length === 0) {
      await appStore.loadModels();
    }
    newChatProfile.value =
      profilesStore.activeProfileName ||
      profilesStore.profiles.find((profile) => profile.active)?.name ||
      profilesStore.profiles[0]?.name ||
      "default";
    
    // Initialize workspace composable and load defaults
    initWorkspaceComposable(newChatProfile.value);
    
    // Auto-fill most recent default workspace if available
    if (mostRecentDefaultWorkspace.value) {
      newChatWorkspace.value = mostRecentDefaultWorkspace.value;
    } else {
      newChatWorkspace.value = "";
    }
    
    syncNewChatModelSelection();
  } finally {
    newChatLoading.value = false;
  }
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
  if (newChatAgent.value === "hermes") {
    newChatLoading.value = true;
    try {
      const status = await fetchAgentAvailabilitySnapshot();
      if (agentInstallationState(status, "hermes") === "not-installed") {
        showNewChatModal.value = false;
        if (isSuperAdmin.value) {
          await router.push({ name: "hermes.agentManager", query: { runtime: "install" } });
        } else {
          message.warning(t("codingAgents.installRequired", { agent: "Hermes" }));
        }
        return;
      }
    } catch (error) {
      console.warn("Failed to read Hermes Agent availability before creating a chat:", error);
    } finally {
      newChatLoading.value = false;
    }
  }

  if (isNewChatExternalCodingAgent.value) {
    newChatLoading.value = true;
    try {
      const agentId = newChatAgent.value as CodingAgentId;
      const status = await fetchCodingAgentsStatus();
      const tool = status.tools.find((item) => item.id === agentId);
      if (!tool?.installed) {
        const fallbackName = agentId === "codex" ? "Codex" : agentId === "pi" ? "Pi" : "Claude";
        message.warning(t("codingAgents.installRequired", { agent: tool?.name || fallbackName }));
        showNewChatModal.value = false;
        await router.push({ name: "hermes.agentManager" });
        return;
      }
    } catch {
      message.error(t("codingAgents.loadFailed"));
      return;
    } finally {
      newChatLoading.value = false;
    }
  }

  const group = selectedNewChatProviderGroup.value;
  const source = newChatAgent.value === "hermes" ? "cli" : "coding_agent";
  const codingAgentMode = effectiveNewChatAgentMode.value;
  const isGlobalCodingAgent = source === "coding_agent" && codingAgentMode === "global";
  const agent = newChatAgent.value === "codex"
    ? "codex"
    : newChatAgent.value === "claude-code"
      ? "claude"
      : newChatAgent.value === "pi"
        ? "pi"
      : "hermes";
  const session = chatStore.newChat({
    profile: newChatProfile.value,
    provider: isGlobalCodingAgent ? undefined : newChatProvider.value,
    model: isGlobalCodingAgent ? undefined : newChatModel.value,
    source,
    agent,
    codingAgentId: newChatAgent.value === "hermes" ? undefined : newChatAgent.value,
    codingAgentMode: source === "coding_agent" ? codingAgentMode : undefined,
    workspace: newChatWorkspace.value || null,
    baseUrl: source === "coding_agent" && !isGlobalCodingAgent ? group?.base_url || newChatBaseUrl.value.trim() || undefined : undefined,
    apiKey: source === "coding_agent" && !isGlobalCodingAgent ? group?.api_key || newChatApiKey.value.trim() || undefined : undefined,
    apiMode: isNewChatCodingAgent.value && !isGlobalCodingAgent ? newChatApiMode.value : undefined,
  });
  // Record workspace to recent list
  if (newChatWorkspace.value && workspaceComposable) {
    workspaceComposable.recordWorkspaceUsage(newChatWorkspace.value);
    recentWorkspaces.value = workspaceComposable.loadRecentWorkspaces();
  }
  
  await router.push({
    name: chatStore.runtimeMode === "global_agent" ? "hermes.globalAgentSession" : "hermes.session",
    params: { sessionId: session.id },
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
    if (ok) message.success(t("common.copied"));
    else message.error(t("common.copied") + " ✗");
  }
}

async function copySessionId(id?: string) {
  const sessionId = id || chatStore.activeSessionId;
  if (sessionId) {
    const ok = await copyToClipboard(sessionId);
    if (ok) message.success(t("common.copied"));
    else message.error(t("common.copied") + " ✗");
  }
}

const activeSessionMenuOptions = computed<DropdownOption[]>(() => buildActiveSessionMenuOptions({
  outline: t("chat.outlineTitle"),
  rename: t("chat.rename"),
  open: t(desktopChatWindowAvailable
    ? "chat.openSessionInNewWindow"
    : "chat.openSessionInNewTab"),
  copyId: t("chat.copySessionId"),
}, {
  canRename: activeSessionSupportsPersistence.value,
  canOpen: activeSessionSupportsPersistence.value,
}));

function activeSessionMenuProps() {
  return {
    id: ACTIVE_SESSION_MENU_ID,
    role: "menu",
    "aria-label": t("chat.sessionActions"),
  };
}

function activeSessionMenuNodeProps(option: DropdownOption) {
  return {
    id: `${ACTIVE_SESSION_MENU_ID}-${String(option.key || "item")}`,
    role: "menuitem",
    tabindex: -1,
    "aria-disabled": option.disabled ? "true" as const : undefined,
  };
}

function activeSessionMenuItems(): HTMLElement[] {
  if (typeof document === "undefined") return [];
  const menu = document.getElementById(ACTIVE_SESSION_MENU_ID);
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
}

function focusActiveSessionMenuItem(position: number | "first" | "last") {
  const items = activeSessionMenuItems();
  if (items.length === 0) return;
  const index = position === "first"
    ? 0
    : position === "last"
      ? items.length - 1
      : (position + items.length) % items.length;
  items[index]?.focus({ preventScroll: true });
}

function focusActiveSessionMenuTrigger() {
  const element = activeSessionMenuTriggerRef.value?.$el as HTMLElement | undefined;
  element?.focus({ preventScroll: true });
}

function focusAdjacentToActiveSessionMenuTrigger(backwards: boolean) {
  if (typeof document === "undefined") return;
  const trigger = activeSessionMenuTriggerRef.value?.$el as HTMLElement | undefined;
  if (!trigger) return;
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((element) => {
    if (element.closest(`#${ACTIVE_SESSION_MENU_ID}`) || element.closest('[inert]')) return false;
    if (element.tabIndex < 0 || element.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
  const triggerIndex = candidates.indexOf(trigger);
  if (triggerIndex < 0) return;
  const target = candidates[triggerIndex + (backwards ? -1 : 1)];
  target?.focus({ preventScroll: true });
}

function handleActiveSessionMenuTriggerKeydown(event: KeyboardEvent) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  event.stopPropagation();
  activeSessionMenuInitialFocus = event.key === "ArrowUp" ? "last" : "first";
  showActiveSessionMenu.value = true;
}

function handleActiveSessionMenuKeydown(event: KeyboardEvent) {
  const items = activeSessionMenuItems();
  const current = (event.target as HTMLElement | null)?.closest<HTMLElement>('[role="menuitem"]');
  const currentIndex = current ? items.indexOf(current) : -1;

  if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Home") focusActiveSessionMenuItem("first");
    else if (event.key === "End") focusActiveSessionMenuItem("last");
    else if (event.key === "ArrowDown") focusActiveSessionMenuItem(currentIndex < 0 ? 0 : currentIndex + 1);
    else focusActiveSessionMenuItem(currentIndex < 0 ? items.length - 1 : currentIndex - 1);
    return;
  }

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    event.stopPropagation();
    current?.querySelector<HTMLElement>(".n-dropdown-option-body")?.click();
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    restoreActiveSessionMenuTriggerFocus = true;
    showActiveSessionMenu.value = false;
  } else if (event.key === "Tab") {
    event.preventDefault();
    event.stopPropagation();
    const backwards = event.shiftKey;
    restoreActiveSessionMenuTriggerFocus = false;
    showActiveSessionMenu.value = false;
    void nextTick().then(() => focusAdjacentToActiveSessionMenuTrigger(backwards));
  }
}

watch(showActiveSessionMenu, async (visible, wasVisible) => {
  if (visible) {
    restoreActiveSessionMenuTriggerFocus = false;
    await nextTick();
    focusActiveSessionMenuItem(activeSessionMenuInitialFocus);
    activeSessionMenuInitialFocus = "first";
    return;
  }
  if (!wasVisible || !restoreActiveSessionMenuTriggerFocus) return;
  restoreActiveSessionMenuTriggerFocus = false;
  await nextTick();
  focusActiveSessionMenuTrigger();
});

function openRenameSession(sessionId: string) {
  const session = chatStore.sessions.find((item) => item.id === sessionId)
    || (chatStore.activeSession?.id === sessionId ? chatStore.activeSession : null);
  renameSessionId.value = sessionId;
  renameValue.value = session?.title || "";
  showRenameModal.value = true;
  nextTick(() => {
    renameInputRef.value?.focus();
  });
}

function handleActiveSessionMenuSelect(key: string) {
  const sessionId = chatStore.activeSessionId;
  if (!sessionId) return;
  restoreActiveSessionMenuTriggerFocus = key !== "rename";
  if (key === "outline") {
    showOutline.value = !showOutline.value;
  } else if (key === "rename") {
    if (!activeSessionSupportsPersistence.value) return;
    openRenameSession(sessionId);
  } else if (key === "open-link") {
    if (!activeSessionSupportsPersistence.value) return;
    openSessionInNewTab(sessionId, chatStore.activeSession?.profile || null);
  } else if (key === "copy-id") {
    void copySessionId(sessionId);
  }
}

async function handleDeleteSession(id: string) {
  const ok = await chatStore.deleteSession(id);
  if (!ok) {
    message.error(t("common.deleteFailed"));
    return;
  }
  sessionBrowserPrefsStore.removeStarred(id);
  message.success(t("chat.sessionDeleted"));
}

const contextSessionId = ref<string | null>(null);

const contextSession = computed(() =>
  contextSessionId.value
    ? chatStore.sessions.find((session) => session.id === contextSessionId.value) || null
    : null,
);

const canSetContextSessionModel = computed(() =>
  contextSession.value?.source === "cli" ||
  (contextSession.value?.source === "coding_agent" && contextSession.value?.codingAgentMode !== "global"),
);

const contextMenuOptions = computed(() => buildSessionContextMenuOptions({
  includeArchive: contextSession.value?.source !== "global_agent",
  includeModel: canSetContextSessionModel.value,
  labels: {

    rename: t("chat.rename"),
    archive: t("chat.archiveSession"),
    workspace: t("chat.setWorkspace"),
    model: t("chat.setModel"),
    export: t("chat.export"),
    exportFull: t("chat.exportFull"),
    exportCompressed: t("chat.exportCompressed"),
    open: t(desktopChatWindowAvailable
      ? "chat.openSessionInNewWindow"
      : "chat.openSessionInNewTab"),
    copyLink: t("chat.copySessionLink"),
    copyId: t("chat.copySessionId"),
  },
}));
function openSettingsPage() {
  router.push({ name: "hermes.settings" });
}

function handleContextMenu(e: MouseEvent, sessionId: string) {
  e.preventDefault();
  contextSessionId.value = sessionId;
  showContextMenu.value = true;
  contextMenuX.value = e.clientX;
  contextMenuY.value = e.clientY;
}

const showContextMenu = ref(false);
const contextMenuX = ref(0);
const contextMenuY = ref(0);

function parseExportKey(key: string): { mode: 'full' | 'compressed'; ext: 'json' | 'txt' } | null {
  if (key === 'export-full-json') return { mode: 'full', ext: 'json' }
  if (key === 'export-full-txt') return { mode: 'full', ext: 'txt' }
  if (key === 'export-compressed-json') return { mode: 'compressed', ext: 'json' }
  if (key === 'export-compressed-txt') return { mode: 'compressed', ext: 'txt' }
  return null
}

async function handleContextMenuSelect(key: string) {
  showContextMenu.value = false;
  if (!contextSessionId.value) return;
  if (key === "copy-link") {
    copySessionLink(contextSessionId.value);
  } else if (key === "copy-id") {
    copySessionId(contextSessionId.value);
  } else if (key === "open-link") {
    openSessionInNewTab(contextSessionId.value, contextSession.value?.profile || null);
  } else if (key === "archive") {
    const ok = await chatStore.archiveSession(contextSessionId.value);
    if (ok) {
      message.success(t("chat.sessionArchived"));
    } else {
      message.error(t("chat.archiveSessionFailed"));
    }
  } else if (parseExportKey(key)) {
    const { mode, ext } = parseExportKey(key)!;
    const loadingMsg = mode === "compressed" ? message.loading(t("chat.exportCompressing"), { duration: 0 }) : null;
    try {
      await exportSession(contextSessionId.value, mode, ext);
      loadingMsg?.destroy();
      message.success(t("chat.exportSuccess"));
    } catch {
      loadingMsg?.destroy();
      message.error(t("chat.exportFailed"));
    }
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
    openRenameSession(contextSessionId.value);
  }
}

function handleClickOutside() {
  showContextMenu.value = false;
}

async function handleRenameConfirm() {
  if (!renameSessionId.value || !renameValue.value.trim()) return;
  const ok = await renameSession(
    renameSessionId.value,
    renameValue.value.trim(),
  );
  if (ok) {
    const session = chatStore.sessions.find(
      (s) => s.id === renameSessionId.value,
    );
    if (session) session.title = renameValue.value.trim();
    if (chatStore.activeSession?.id === renameSessionId.value) {
      chatStore.activeSession.title = renameValue.value.trim();
    }
    message.success(t("chat.renamed"));
  } else {
    message.error(t("chat.renameFailed"));
  }
  showRenameModal.value = false;
}

const showWorkspaceModal = ref(false);
const workspaceValue = ref("");
const workspaceSessionId = ref<string | null>(null);

function openActiveSessionWorkspace() {
  const session = chatStore.activeSession;
  if (!session?.id) return;
  workspaceSessionId.value = session.id;
  workspaceValue.value = session.workspace || "";
  showWorkspaceModal.value = true;
}

async function handleWorkspaceConfirm() {
  if (!workspaceSessionId.value) return;
  const ok = await setSessionWorkspace(
    workspaceSessionId.value,
    workspaceValue.value || null,
  );
  if (ok) {
    const session = chatStore.sessions.find(
      (s) => s.id === workspaceSessionId.value,
    );
    if (session) session.workspace = workspaceValue.value || null;
    if (chatStore.activeSession?.id === workspaceSessionId.value) {
      chatStore.activeSession.workspace = workspaceValue.value || null;
    }
    message.success(t("chat.workspaceSet"));
  } else {
    message.error(t("chat.workspaceSetFailed"));
  }
  showWorkspaceModal.value = false;
}

const showSessionModelModal = ref(false);
const showSessionModelModeModal = ref(false);
const sessionModelSessionId = ref<string | null>(null);
const sessionModelSearch = ref("");
const sessionModelKind = ref<"model" | "moa">("model");
const {
  isGroupCollapsed: isSessionModelGroupCollapsed,
  toggleGroup: toggleSessionModelCollapsedGroup,
} = useCollapsedProviderGroups();
const sessionModelValue = ref("");
const sessionModelProvider = ref("");
const sessionModelCustomInput = ref("");
const sessionModelCustomProvider = ref("");
const sessionModelApiMode = ref<CodingAgentApiMode>("codex_responses");
const pendingSessionModelSwitch = ref<{ model: string; provider: string } | null>(null);
const sessionModelSwitching = ref(false);

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
const sessionModelCodingAgentId = computed<ChatCodingAgentId | undefined>(() =>
  sessionModelSession.value?.codingAgentId ||
  (sessionModelSession.value?.agent === "claude"
    ? "claude-code"
      : sessionModelSession.value?.agent === "codex"
        ? "codex"
      : sessionModelSession.value?.agent === "pi"
        ? "pi"
        : undefined),
);
const isSessionModelCodingAgent = computed(() =>
  sessionModelSession.value?.source === "coding_agent" || Boolean(sessionModelSession.value?.codingAgentId),
);

const sessionModelAllGroups = computed(() =>
  sessionModelProfile.value
    ? getModelGroupsForProfile(sessionModelProfile.value).filter((group) => (
        group.provider === "moa"
          ? !isSessionModelCodingAgent.value
          : (!isSessionModelScopedCodingAgent.value ||
            !sessionModelCodingAgentId.value ||
            canScopedCodingAgentUseProvider(sessionModelCodingAgentId.value, group.provider))
      ))
    : [],
);

const sessionModelBaseGroups = computed(() =>
  sessionModelAllGroups.value.filter((group) => group.provider !== "moa"),
);

const sessionMoaGroup = computed(() =>
  sessionModelAllGroups.value.find((group) => group.provider === "moa"),
);

const sessionCanUseMoa = computed(() =>
  !isSessionModelCodingAgent.value && Boolean(sessionMoaGroup.value?.models.length),
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

const filteredSessionMoaModels = computed(() => {
  const models = sessionMoaGroup.value?.models || [];
  const query = sessionModelSearch.value.trim().toLowerCase();
  return query ? models.filter((model) => model.toLowerCase().includes(query)) : models;
});

async function openSessionModelModal(sessionId: string) {
  const requestedSession =
    chatStore.sessions.find((s) => s.id === sessionId) ||
    (chatStore.activeSession?.id === sessionId ? chatStore.activeSession : undefined);
  if (
    requestedSession?.codingAgentMode === "global" &&
    Boolean(requestedSession.codingAgentId || requestedSession.source === "coding_agent")
  ) return;
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
  const usesMoa = session?.provider === "moa" && sessionCanUseMoa.value;
  sessionModelKind.value = usesMoa ? "moa" : "model";
  sessionModelValue.value = usesMoa
    ? session?.model || ""
    : providerGroup ? session?.model || defaults.model || "" : defaults.model || "";
  sessionModelProvider.value = usesMoa
    ? "moa"
    : providerGroup ? session?.provider || "" : defaults.provider || "";
  sessionModelCustomProvider.value = usesMoa ? defaults.provider : sessionModelProvider.value;
  sessionModelSearch.value = "";
  sessionModelCustomInput.value = "";
  showSessionModelModal.value = true;
}

function handleSessionModelKindChange(value: "model" | "moa") {
  if (sessionModelSwitching.value || (value === "moa" && !sessionCanUseMoa.value)) return;
  sessionModelKind.value = value;
  sessionModelSearch.value = "";
}

function handleHeaderModelClick() {
  if (activeSessionUsesGlobalCodingAgentConfig.value) return;
  const sessionId = chatStore.activeSession?.id;
  if (!sessionId) {
    openNewChatModal();
    return;
  }
  openSessionModelModal(sessionId);
}

function toggleSessionModelGroup(provider: string) {
  if (sessionModelSwitching.value) return;
  toggleSessionModelCollapsedGroup(provider);
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
  if (!sessionModelSessionId.value || sessionModelSwitching.value) return;
  sessionModelSwitching.value = true;
  try {
    const ok = await chatStore.switchSessionModel(model, provider, sessionModelSessionId.value, apiMode);
    if (ok) {
      sessionModelValue.value = model;
      sessionModelProvider.value = provider;
      if (apiMode) sessionModelApiMode.value = apiMode;
      pendingSessionModelSwitch.value = null;
      showSessionModelModeModal.value = false;
      showSessionModelModal.value = false;
      message.success(t("chat.modelSet"));
    } else {
      message.error(t("chat.modelSetFailed"));
    }
  } finally {
    sessionModelSwitching.value = false;
  }
}

async function selectSessionModel(model: string, provider: string) {
  const meta = sessionModelBaseGroups.value.find((group) => group.provider === provider)?.model_meta?.[model];
  if (meta?.disabled || !sessionModelSessionId.value || sessionModelSwitching.value) return;
  if (isSessionModelScopedCodingAgent.value) {
    pendingSessionModelSwitch.value = { model, provider };
    sessionModelApiMode.value = sessionModelSession.value?.provider === provider && sessionModelSession.value.apiMode
      ? normalizeCodingAgentApiMode(sessionModelSession.value.apiMode, defaultSessionModelApiMode(provider))
      : defaultSessionModelApiMode(provider);
    showSessionModelModeModal.value = true;
    return;
  }
  await applySessionModelSwitch(model, provider);
}

async function selectSessionMoaPreset(preset: string) {
  if (!preset || sessionModelSwitching.value) return;
  await applySessionModelSwitch(preset, "moa");
}

async function confirmSessionModelMode() {
  const pending = pendingSessionModelSwitch.value;
  if (!pending) return;
  await applySessionModelSwitch(pending.model, pending.provider, sessionModelApiMode.value);
}

function cancelSessionModelMode() {
  if (sessionModelSwitching.value) return;
  pendingSessionModelSwitch.value = null;
  showSessionModelModeModal.value = false;
}

async function handleSessionModelCustomSubmit() {
  const model = sessionModelCustomInput.value.trim();
  const provider = sessionModelCustomProvider.value;
  if (!model || !provider || sessionModelSwitching.value) return;
  await selectSessionModel(model, provider);
}
</script>

<template>
  <div class="chat-panel" :class="{ 'chat-panel--standalone': standalone }">
    <div
      v-if="currentMode === 'chat' && !standalone"
      class="session-backdrop"
      :class="{ active: showSessions }"
      @click="showSessions = false"
    />
    <aside
      v-if="currentMode === 'chat' && !standalone"
      class="session-list"
      :class="{ collapsed: !showSessions }"
    >
      <div v-if="showSessions" class="page-sidebar-top">
        <PageSidebarNav
          :active="contentMode === 'connections' ? 'connections' : contentMode === 'skills' ? 'skills' : contentMode === 'memory' ? 'memory' : contentMode === 'agents' ? 'agents' : contentMode === 'models' ? 'models' : chatStore.runtimeMode === 'global_agent' ? 'global' : 'chat'"
          :primary-label="t('chat.newChat')"
          @primary="openNewChatModal"
        />
        <div class="session-list-toolbar">
          <SessionListTabs v-model="sessionListTab" />
          <div class="session-list-actions">
            <button class="session-close-btn" @click="showSessions = false">
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
            </button>
          </div>
        </div>
      </div>
      <!-- hermes-v050:C1 侧栏只渲染视口附近的会话行 -->
      <VirtualSessionList v-if="showSessions" class="session-items" :items="visibleSessions">
        <template #empty>
          <div
            v-if="chatStore.isLoadingSessions && chatStore.sessions.length === 0"
            class="session-loading"
          >
            {{ t("common.loading") }}
          </div>
          <div v-else class="session-empty">
            {{ sessionListTab === "starred" ? t("chat.noStarredSessions") : t("chat.noSessions") }}
          </div>
        </template>

        <template #default="{ item: s }">
        <SessionListItem
          :key="s.id"
          :session="s"
          :active="s.id === chatStore.activeSessionId"
          :starred="sessionBrowserPrefsStore.isStarred(s.id)"
          :can-delete="
            s.id !== chatStore.activeSessionId ||
            chatStore.sessions.length > 1
          "
          :streaming="chatStore.isSessionLive(s.id)"
          :completed-unread="chatStore.isSessionCompletedUnread(s.id)"
          :to="sessionHref(s.id)"
          :intercept-modified-navigation="desktopChatWindowAvailable"
          @select="handleSessionClick(s.id)"
          @open-new="openSessionInNewTab(s.id, s.profile || null)"
          @contextmenu="handleContextMenu($event, s.id)"
          @delete="handleDeleteSession(s.id)"
          @toggle-star="sessionBrowserPrefsStore.toggleStarred(s.id)"
        />
        </template>
      </VirtualSessionList>
      <div v-if="showSessions" class="page-sidebar-bottom">
        <button class="page-sidebar-menu-btn" type="button" @click="openSettingsPage">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span>{{ t("sidebar.settings") }}</span>
        </button>
      </div>
    </aside>

    <NDropdown
      placement="bottom-start"
      trigger="manual"
      :x="contextMenuX"
      :y="contextMenuY"
      :options="contextMenuOptions"
      :show="showContextMenu"
      @select="handleContextMenuSelect"
      @clickoutside="handleClickOutside"
    />

    <NModal
      v-model:show="showRenameModal"
      preset="dialog"
      :title="t('chat.renameSession')"
      :positive-text="t('common.ok')"
      :negative-text="t('common.cancel')"
      @positive-click="handleRenameConfirm"
    >
      <NInput
        ref="renameInputRef"
        v-model:value="renameValue"
        :placeholder="t('chat.enterNewTitle')"
        @keydown.enter="handleRenameConfirm"
      />
    </NModal>

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

    <NModal
      v-model:show="showSessionModelModal"
      preset="card"
      :title="t('chat.setModelTitle')"
      :style="{ width: 'min(480px, calc(100vw - 32px))' }"
      :mask-closable="!sessionModelSwitching"
      :close-on-esc="!sessionModelSwitching"
      :closable="!sessionModelSwitching"
    >
      <NSpin :show="sessionModelSwitching" class="session-model-switch-spin">
        <template #description>{{ t('chat.modelSwitching') }}</template>
        <div v-if="sessionCanUseMoa" class="session-model-kind-field">
          <span class="session-model-kind-label">{{ t('chat.modelType') }}</span>
          <NRadioGroup
            :value="sessionModelKind"
            name="session-model-kind"
            @update:value="handleSessionModelKindChange"
          >
            <NRadioButton value="model">{{ t('chat.standardModels') }}</NRadioButton>
            <NRadioButton value="moa">{{ t('chat.moaPresets') }}</NRadioButton>
          </NRadioGroup>
        </div>
        <NInput
          v-model:value="sessionModelSearch"
          :placeholder="t('models.searchPlaceholder')"
          :disabled="sessionModelSwitching"
          clearable
          size="small"
          class="session-model-search"
        />
        <div v-if="sessionModelKind === 'model'" class="session-model-list" :aria-busy="sessionModelSwitching">
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
                switching: sessionModelSwitching,
              }"
              :aria-disabled="sessionModelSwitching || !!group.model_meta?.[model]?.disabled"
              :title="group.model_meta?.[model]?.disabled ? t('models.disabledTooltip') : ''"
              @click="selectSessionModel(model, group.provider)"
            >
              <span class="session-model-item-label">
                <span class="session-model-item-name">{{ sessionModelDisplayName(model, group.provider) }}</span>
                <span v-if="sessionModelAlias(model, group.provider)" class="session-model-item-id">
                  {{ t('models.aliasCanonical', { model }) }}
                </span>
              </span>
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
        <!-- hermes-v050:U16-T12 -->
        <div v-if="filteredSessionModelGroups.length === 0" class="session-model-empty">
          {{ sessionModelSearch ? t('models.noResults') : t('models.noModels') }}
        </div>
        </div>
        <div v-else class="session-model-list" :aria-busy="sessionModelSwitching">
          <div class="session-model-group-items session-moa-items">
            <div
              v-for="preset in filteredSessionMoaModels"
              :key="preset"
              class="session-model-item"
              :class="{
                active: preset === sessionModelValue && sessionModelProvider === 'moa',
                switching: sessionModelSwitching,
              }"
              :aria-disabled="sessionModelSwitching"
              @click="selectSessionMoaPreset(preset)"
            >
              <span class="session-model-item-label">
                <span class="session-model-item-name">{{ preset }}</span>
              </span>
              <svg
                v-if="preset === sessionModelValue && sessionModelProvider === 'moa'"
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
          <div v-if="filteredSessionMoaModels.length === 0" class="session-model-empty">
            {{ t('chat.noMoaPresets') }}
          </div>
        </div>
        <div v-if="sessionModelKind === 'model'" class="session-model-custom">
          <div class="session-model-custom-row">
            <NSelect
              v-model:value="sessionModelCustomProvider"
              :options="sessionModelProviderOptions"
              :disabled="sessionModelSwitching"
              size="small"
              class="session-model-custom-provider"
            />
            <NInput
              v-model:value="sessionModelCustomInput"
              :placeholder="t('models.customModelPlaceholder')"
              :disabled="sessionModelSwitching"
              size="small"
              class="session-model-custom-input"
              @keydown.enter="handleSessionModelCustomSubmit"
            />
          </div>
          <div class="session-model-custom-hint">
            {{ t('models.customModelHint') }}
          </div>
        </div>
      </NSpin>
    </NModal>

    <NModal
      v-model:show="showSessionModelModeModal"
      preset="dialog"
      :title="t('codingAgents.protocolScope')"
      :mask-closable="!sessionModelSwitching"
      :close-on-esc="!sessionModelSwitching"
      :closable="!sessionModelSwitching"
      style="width: min(420px, calc(100vw - 32px))"
    >
      <NSelect
        v-model:value="sessionModelApiMode"
        :options="newChatApiModeOptions"
        :disabled="sessionModelSwitching"
      />
      <template #action>
        <NButton size="small" :disabled="sessionModelSwitching" @click="cancelSessionModelMode">
          {{ t('common.cancel') }}
        </NButton>
        <NButton size="small" type="primary" :loading="sessionModelSwitching" @click="confirmSessionModelMode">
          {{ sessionModelSwitching ? t('chat.modelSwitching') : t('common.confirm') }}
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
      <NDrawerContent :title="t('chat.newChat')" closable>
        <div class="new-chat-form">
          <label class="new-chat-field">
            <span class="new-chat-label">{{ t("chat.agent") }}</span>
            <NSelect
              v-model:value="newChatAgent"
              :options="newChatAgentOptions"
              :disabled="newChatLoading"
            />
          </label>
          <label v-if="isNewChatExternalCodingAgent" class="new-chat-field">
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
              @update:value="handleNewChatProfileChange"
            />
          </label>
          <label v-if="newChatUsesProviderModel && newChatCanUseMoa" class="new-chat-field">
            <span class="new-chat-label">{{ t('chat.modelType') }}</span>
            <NRadioGroup
              :value="newChatModelKind"
              name="new-chat-model-kind"
              @update:value="handleNewChatModelKindChange"
            >
              <NRadioButton value="model">{{ t('chat.standardModels') }}</NRadioButton>
              <NRadioButton value="moa">{{ t('chat.moaPresets') }}</NRadioButton>
            </NRadioGroup>
          </label>
          <label v-if="newChatUsesProviderModel && newChatModelKind === 'model'" class="new-chat-field">
            <span class="new-chat-label">{{ t("models.provider") }}</span>
            <NSelect
              :value="newChatProvider"
              :options="newChatProviderOptions"
              :disabled="newChatLoading"
              @update:value="handleNewChatProviderChange"
            />
          </label>
          <label v-if="newChatUsesProviderModel" class="new-chat-field">
            <span class="new-chat-label">
              {{ newChatModelKind === 'moa' ? t('chat.moaPresets') : t('models.models') }}
            </span>
            <NSelect
              v-model:value="newChatModel"
              :options="newChatModelOptions"
              :disabled="newChatLoading || !newChatProvider"
              filterable
            />
          </label>
          <label v-if="isNewChatCodingAgent && effectiveNewChatAgentMode === 'scoped'" class="new-chat-field">
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
            <span class="new-chat-label">
              {{ t("chat.workspace") }}
              <NTooltip v-if="isCurrentWorkspaceDefault">
                <template #trigger>
                  <span class="workspace-default-badge">{{ t("chat.workspaceDefault") }}</span>
                </template>
                {{ t("chat.workspaceDefaultTooltip") }}
              </NTooltip>
            </span>
            <!-- Default workspace chips -->
            <div v-if="defaultWorkspaces.length > 0" class="default-workspace-chips">
              <span class="default-workspace-label">{{ t("chat.defaultWorkspace") }}:</span>
              <div class="workspace-chips-container">
                <template v-for="(ws, index) in visibleDefaultWorkspaces" :key="ws">
                  <div
                    class="workspace-chip"
                    :class="{ active: newChatWorkspace === ws }"
                    @click="handleSelectDefaultWorkspace(ws)"
                    :title="ws"
                  >
                    {{ getFolderName(ws) }}
                  </div>
                  <span v-if="index < visibleDefaultWorkspaces.length - 1 || hasHiddenDefaults" class="workspace-chip-separator">/</span>
                </template>
                <div v-if="hasHiddenDefaults" class="workspace-chip-dropdown">
                  <button class="workspace-chip-more" @click="showDefaultWorkspaceMenu = !showDefaultWorkspaceMenu">
                    {{ t("chat.more") }} ▼
                  </button>
                  <div v-if="showDefaultWorkspaceMenu" class="workspace-dropdown-menu">
                    <div
                      v-for="ws in hiddenDefaultWorkspaces"
                      :key="ws"
                      class="workspace-dropdown-item"
                      @click="handleSelectDefaultWorkspace(ws)"
                      :title="ws"
                    >
                      {{ getFolderName(ws) }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <FolderPicker
              v-model="newChatWorkspace"
              show-favorite
              :favorite="isCurrentWorkspaceDefault"
              :favorite-disabled="!newChatWorkspace"
              :favorite-title="isCurrentWorkspaceDefault ? t('chat.workspaceUnpin') : t('chat.workspacePin')"
              @toggle-favorite="handleToggleDefaultWorkspace"
            />
            <div v-if="recentWorkspaces.length > 0" class="recent-workspaces">
              <span class="recent-workspaces-label">{{ t("chat.workspaceRecent") }}:</span>
              <div class="recent-workspaces-chips">
                <NButton
                  v-for="ws in recentWorkspaces"
                  :key="ws.path"
                  size="tiny"
                  :type="ws.path === newChatWorkspace ? 'primary' : 'default'"
                  @click="handleSelectRecentWorkspace(ws.path)"
                >
                  <template #icon>
                    <span
                      v-if="defaultWorkspaces.includes(ws.path)"
                      class="recent-pin-icon"
                      @click.stop="handleTogglePinRecent(ws.path)"
                      :title="t('chat.workspaceUnpin')"
                    >★</span>
                    <span
                      v-else
                      class="recent-pin-icon"
                      @click.stop="handleTogglePinRecent(ws.path)"
                      :title="t('chat.workspacePin')"
                    >☆</span>
                  </template>
                  {{ getFolderName(ws.path) }}
                </NButton>
              </div>
            </div>
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
              {{ t("common.create") }}
            </NButton>
          </div>
        </template>
      </NDrawerContent>
    </NDrawer>

    <div
      class="chat-main"
      :class="{ 'chat-main--sidebar-collapsed': currentMode !== 'chat' || !showSessions }"
    >
      <ConnectionsPanel
        v-if="contentMode === 'connections'"
        :sidebar-collapsed="!showSessions"
        @toggle-sidebar="showSessions = !showSessions"
      />
      <AgentManagerPanel
        v-else-if="contentMode === 'agents'"
        :sidebar-collapsed="!showSessions"
        @toggle-sidebar="showSessions = !showSessions"
      />
      <ModelsPanel
        v-else-if="contentMode === 'models'"
        :sidebar-collapsed="!showSessions"
        @toggle-sidebar="showSessions = !showSessions"
      />
      <!-- community-restored-content-panels-template -->
      <SkillsPanel
        v-else-if="contentMode === 'skills'"
      />
      <MemoryPanel
        v-else-if="contentMode === 'memory'"
      />
      <template v-else>
      <header v-if="!standalone" class="chat-header">
        <div class="header-left">
          <NButton
            v-if="currentMode === 'chat'"
            class="header-sidebar-toggle"
            quaternary
            size="small"
            @click="showSessions = !showSessions"
            circle
          >
            <template #icon>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
              >
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
              </svg>
            </template>
          </NButton>
          <span class="header-session-title" dir="auto">{{ headerTitle }}</span>
          <button
            v-if="chatStore.activeSession?.workspace"
            class="workspace-badge"
            type="button"
            :title="chatStore.activeSession.workspace"
            @click="openActiveSessionWorkspace"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <span>
              {{
                chatStore.activeSession.workspace.split("/").pop() ||
                chatStore.activeSession.workspace
              }}
            </span>
          </button>
        </div>
        <div class="header-actions">
          <!-- chat/live mode toggle hidden -->
          <template v-if="currentMode === 'chat'">
            <NTooltip v-if="isSuperAdmin" trigger="hover">
              <template #trigger>
                <NButton
                  class="header-tool-toggle"
                  :class="{ active: showToolPanel }"
                  quaternary
                  size="small"
                  :aria-label="t('chat.sidePanel')"
                  :aria-expanded="showToolPanel"
                  aria-controls="chat-tool-panel"
                  @click="toggleToolPanel"
                  circle
                >
                  <template #icon>
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <line x1="15" y1="3" x2="15" y2="21" />
                    </svg>
                  </template>
                </NButton>
              </template>
              {{ desktopBrowserAvailable ? `${t("drawer.files")} / ${t("drawer.terminal")} / ${t("browser.title")}` : `${t("drawer.files")} / ${t("drawer.terminal")}` }}
            </NTooltip>
            <NDropdown
              v-model:show="showActiveSessionMenu"
              trigger="click"
              placement="bottom-end"
              :keyboard="false"
              :menu-props="activeSessionMenuProps"
              :node-props="activeSessionMenuNodeProps"
              :options="activeSessionMenuOptions"
              :show-arrow="true"
              @select="handleActiveSessionMenuSelect"
              @keydown="handleActiveSessionMenuKeydown"
            >
              <NTooltip trigger="hover" :disabled="showActiveSessionMenu">
                <template #trigger>
                  <NButton
                    ref="activeSessionMenuTriggerRef"
                    class="header-session-menu-trigger"
                    quaternary
                    size="small"
                    :disabled="!chatStore.activeSessionId"
                    :aria-label="t('chat.sessionActions')"
                    :aria-expanded="showActiveSessionMenu"
                    aria-controls="active-session-actions-menu"
                    aria-haspopup="menu"
                    @keydown="handleActiveSessionMenuTriggerKeydown"
                    circle
                  >
                    <template #icon>
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.4"
                        stroke-linecap="round"
                        aria-hidden="true"
                      >
                        <path d="M5 12h.01M12 12h.01M19 12h.01" />
                      </svg>
                    </template>
                  </NButton>
                </template>
                {{ t("chat.sessionActions") }}
              </NTooltip>
            </NDropdown>
          </template>
        </div>
      </header>

      <template v-if="currentMode === 'chat'">
        <div
          ref="chatContentWrapperRef"
          class="chat-content-wrapper"
          :class="{ 'chat-content-wrapper--drop-active': isChatDropActive }"
          @dragover="handleChatDragOver"
          @dragenter="handleChatDragEnter"
          @dragleave="handleChatDragLeave"
          @drop="handleChatDrop"
        >
          <div ref="chatMainContentRef" class="chat-main-content">
            <MessageList
              ref="messageListRef"
              :approval-portal-to-body="showRealtimeVoice"
              scroll-scope="chat"
            />
            <ChatInput
              ref="chatInputRef"
              :model-label="activeSessionModelLabel"
              :model-disabled="activeSessionUsesGlobalCodingAgentConfig"
              :initial-text="initialComposerText"
              :persist-draft="composerPersistDraft"
              @model-click="handleHeaderModelClick"
              @voice-click="openRealtimeVoice"
            />
          </div>
          <OutlinePanel
            v-if="showOutline"
            :messages="chatStore.messages"
            @navigate="handleOutlineNavigate"
          />
          <Transition
            name="tool-panel"
            @before-enter="handleToolPanelBeforeEnter"
            @after-enter="handleToolPanelAfterEnter"
            @before-leave="handleToolPanelBeforeLeave"
            @leave-cancelled="handleToolPanelLeaveCancelled"
          >
            <aside
              v-if="showToolPanel"
              id="chat-tool-panel"
              class="chat-tool-panel"
              role="region"
              :aria-label="t('chat.sidePanel')"
              :style="toolPanelStyle"
            >
              <div
                class="chat-tool-resize-handle"
                @pointerdown="startToolResize"
              />
              <div class="chat-tool-panel-inner">
                <WorkspaceDiffPreview
                  v-if="toolPanelStore.workspaceDiff"
                  :custom-close="closeToolPanelOverlay"
                />
                <SubagentStreamPanel
                  v-else-if="selectedSubagent"
                  :stream="selectedSubagentStream"
                  @close="closeToolPanelOverlay"
                />
                <template v-else-if="previewOnlyFileOpen">
                  <FilePreview
                    v-if="filesStore.previewFile"
                    :custom-close="closeToolPanelOverlay"
                  />
                  <div v-else class="chat-file-preview-loading">
                    <NSpin size="small" />
                  </div>
                </template>
                <template v-else>
                  <div class="chat-tool-tabs" role="tablist">
                    <button
                      class="chat-tool-tab"
                      :class="{ active: activeToolPanel === 'files' }"
                      type="button"
                      role="tab"
                      :title="t('drawer.files')"
                      :aria-label="t('drawer.files')"
                      :aria-selected="activeToolPanel === 'files'"
                      @click="activeToolPanel = 'files'"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
                      </svg>
                    </button>
                    <button
                      class="chat-tool-tab"
                      :class="{ active: activeToolPanel === 'terminal' }"
                      type="button"
                      role="tab"
                      :title="t('drawer.terminal')"
                      :aria-label="t('drawer.terminal')"
                      :aria-selected="activeToolPanel === 'terminal'"
                      @click="activeToolPanel = 'terminal'"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3" y="4" width="18" height="16" rx="2" />
                        <path d="m7 9 3 3-3 3M13 15h4" />
                      </svg>
                    </button>
                    <button
                      v-if="desktopBrowserAvailable"
                      class="chat-tool-tab"
                      :class="{ active: activeToolPanel === 'browser' }"
                      type="button"
                      role="tab"
                      :title="t('browser.title')"
                      :aria-label="t('browser.title')"
                      :aria-selected="activeToolPanel === 'browser'"
                      @click="activeToolPanel = 'browser'"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3" y="4" width="18" height="16" rx="2" />
                        <path d="M3 9h18" />
                        <circle cx="6.5" cy="6.5" r=".75" fill="currentColor" stroke="none" />
                        <circle cx="9.5" cy="6.5" r=".75" fill="currentColor" stroke="none" />
                      </svg>
                    </button>
                  </div>
                  <div class="chat-tool-content">
                    <FilesPanel
                      v-show="activeToolPanel === 'files'"
                      :workspace-session-id="activeWorkspaceSessionId"
                      :workspace="activeWorkspacePath"
                      @attach="handleWorkspaceFileAttach"
                    />
                    <TerminalPanel
                      v-show="activeToolPanel === 'terminal'"
                      :visible="showToolPanel && activeToolPanel === 'terminal'"
                    />
                    <DesktopBrowserPanel
                      v-if="desktopBrowserAvailable && activeToolPanel === 'browser'"
                      :visible="toolPanelTransitionReady"
                      :submit="submitBrowserAnnotations"
                    />
                  </div>
                </template>
              </div>
            </aside>
          </Transition>
        </div>
      </template>
      <ConversationMonitorPane
        v-else
        :human-only="sessionBrowserPrefsStore.humanOnly"
      />
      </template>
    </div>
    <Teleport to="body">
      <RealtimeVoiceStage
        v-if="showRealtimeVoice"
        @close="closeRealtimeVoice"
      />
    </Teleport>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.chat-panel {
  display: flex;
  height: 100%;
  position: relative;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  background-color: $bg-card;
}

.session-model-search {
  margin-bottom: 12px;
}

.session-model-kind-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.session-model-kind-label {
  font-size: 12px;
  color: $text-muted;
  font-weight: 500;
}

.session-model-switch-spin {
  min-height: 180px;
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
  padding-inline-start: 8px;
}

.session-moa-items {
  padding-inline-start: 0;
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

  &.switching {
    cursor: wait;
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

.session-model-badge-preview,
.session-model-badge-custom,
.session-model-badge-disabled {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  margin-inline-end: 4px;
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

.session-list {
  width: $sidebar-width;
  min-height: 0;
  align-self: stretch;
  margin: 10px;
  background: $bg-sidebar-surface;
  border: 1px solid $border-color;
  border-radius: 14px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition:
    width $transition-normal,
    opacity $transition-normal;
  overflow: hidden;

  &.collapsed {
    width: 0;
    margin-inline-start: 0;
    margin-inline-end: 0;
    border: none;
    box-shadow: none;
    opacity: 0;
    pointer-events: none;
  }

  @media (max-width: $breakpoint-mobile) {
    position: absolute;
    left: 10px;
    top: 10px;
    bottom: 10px;
    height: auto;
    margin: 0;
    z-index: 120;
    width: $sidebar-width;

    &.collapsed {
      transform: translateX(calc(-100% - 10px));
      opacity: 0;
    }
  }
}

@media (max-width: $breakpoint-mobile) {
  .session-list .session-close-btn {
    display: flex;
  }

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

.page-sidebar-top {
  flex-shrink: 0;
  padding: 12px 12px 0;
  border-bottom: 1px solid $border-color;
}

.page-sidebar-tabs {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.page-sidebar-tab {
  width: 100%;
  min-width: 0;
  height: 34px;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 7px 10px;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  svg {
    flex-shrink: 0;
  }

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    line-height: 18px;
  }

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }
}

.session-list-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  // Align the tab bottoms with the header divider, without a second line.
  margin-bottom: -1px;
}

.session-list-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;

  .n-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 22px;
    min-height: 22px;
  }
}

.session-close-btn {
  display: none;
  border: none;
  background: none;
  cursor: pointer;
  color: $text-secondary;
  padding: 4px;
  border-radius: $radius-sm;
  height: 22px;
  min-height: 22px;
  align-items: center;
  justify-content: center;

  &:hover {
    background: rgba($accent-primary, 0.06);
  }
}

.session-list-title {
  font-size: 12px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  line-height: 22px;
}


.conversation-switch {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
  margin-top: 8px;
  padding: 2px;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.05);
}

.conversation-switch-tab {
  min-width: 0;
  height: 28px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: $text-secondary;
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  &:hover {
    color: $text-primary;
  }

  &.active {
    background: $bg-card;
    color: $text-primary;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
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

.new-chat-field-hint {
  font-size: 11px;
  color: $text-muted;
}

.new-chat-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.session-items {
  flex: 1;
  overflow-y: auto;
  padding: 10px 6px 12px;
}

.page-sidebar-bottom {
  flex-shrink: 0;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.page-sidebar-menu-btn {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
  height: 36px;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }
}

.page-sidebar-menu-btn span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 18px;
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
  margin: 10px 10px 10px 0;
  background: $bg-main-surface;
  border: 1px solid $border-color;
  border-radius: 14px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);

  &--sidebar-collapsed {
    margin-inline-start: 10px;
  }

  @media (max-width: $breakpoint-mobile) {
    margin: 0;
    border: none;
    border-radius: 0;
    box-shadow: none;
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

.chat-content-wrapper--drop-active::after {
  content: "";
  position: absolute;
  inset: 12px;
  z-index: 30;
  pointer-events: none;
  border: 2px dashed var(--accent-info);
  border-radius: 8px;
  background: rgba(var(--accent-info-rgb), 0.05);
}

.chat-main-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background-color: $bg-main-surface;
  animation: chat-surface-fade-in 1.5s ease both;
}

@keyframes chat-surface-fade-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 21px 20px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  flex: 1;
  min-width: 0;
}

.header-session-title {
  font-size: 16px;
  font-weight: 600;
  color: $text-primary;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.source-badge {
  font-size: 10px;
  color: $text-muted;
  /* hermes-v050:E-08 same valid 12% muted tint as .workspace-badge (U9); the Sass rgba() of $text-muted compiled to an invalid value */
  background: rgba(var(--text-muted-rgb), 0.12);
  padding: 1px 7px;
  border-radius: 8px;
  flex-shrink: 0;
  white-space: nowrap;
  line-height: 16px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

:global(#active-session-actions-menu [role="menuitem"]:focus-visible > .n-dropdown-option-body) {
  outline: 2px solid var(--accent-primary);
  outline-offset: -2px;
}

.chat-mode-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-inline-end: 4px;
}

@media (max-width: $breakpoint-mobile) {
  .chat-header {
    padding: calc(16px + env(safe-area-inset-top, 0px)) 12px 16px 52px;
  }

  .header-sidebar-toggle {
    display: none;
  }

  /* hermes-v050:U19 mobile header shows the session title again (ellipsis from the base rule);
     hermes-v050:U13 the workspace badge keeps its width, same as HistoryView mobile */
  .workspace-badge {
    flex-shrink: 0;
  }

}

.workspace-badge {
  border: 0;
  font-size: 11px;
  line-height: 16px;
  color: $text-muted;
  /* hermes-v050:U9 12% muted tint of .source-badge; rgb-var form as .context-bar so it is valid CSS */
  background: rgba(var(--text-muted-rgb), 0.12);
  padding: 2px 8px;
  border-radius: 4px;
  max-width: 160px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  cursor: pointer;

  svg {
    flex: 0 0 auto;
  }

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &:hover {
    color: $text-secondary;
    background: rgba(var(--accent-primary-rgb), 0.06);
  }
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
  max-inline-size: 100%;
  box-sizing: border-box;
  background: $bg-card;
  border-inline-start: 1px solid $border-color;
  display: flex;
  min-height: 0;
  overflow: visible;
}

.tool-panel-enter-active,
.tool-panel-leave-active {
  overflow: hidden;
  pointer-events: none;
  will-change: width, min-width, opacity;
  transition:
    width 0.25s cubic-bezier(0.4, 0, 0.2, 1),
    min-width 0.25s cubic-bezier(0.4, 0, 0.2, 1),
    opacity 0.16s ease,
    border-color 0.16s ease;
}

.tool-panel-enter-from,
.tool-panel-leave-to {
  width: 0 !important;
  min-width: 0;
  opacity: 0;
  border-inline-start-color: transparent;
}

.chat-tool-resize-handle {
  position: absolute;
  inset-inline-start: -7px;
  top: 0;
  bottom: 0;
  width: 14px;
  cursor: col-resize;
  z-index: 20;

  &::after {
    content: "";
    position: absolute;
    inset-inline-start: 6px;
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
    inset-inline-start: 1px;
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
  flex-direction: row;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: $bg-main-surface;
}

.chat-file-preview-loading {
  flex: 1;
  display: grid;
  place-items: center;
  min-width: 0;
  min-height: 0;
}

.chat-tool-tabs {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  order: 2;
  width: 48px;
  height: 100%;
  gap: 4px;
  padding: 8px 6px;
  border-inline-start: 1px solid $border-color;
  background: $bg-sidebar-surface;
  box-sizing: border-box;
}

.chat-tool-tab {
  position: relative;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: all $transition-fast;

  svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  &:hover {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.06);
  }

  &.active {
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.12);

    &::after {
      content: "";
      position: absolute;
      right: -6px;
      top: 9px;
      bottom: 9px;
      width: 2px;
      border-radius: 2px 0 0 2px;
      background: var(--accent-primary);
    }
  }
}

.chat-tool-content {
  order: 1;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: $bg-main-surface;
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
    max-width: 100vw !important;
    max-inline-size: 100vw;
    min-width: 0;
    box-sizing: border-box;
    border-inline-start: none;
    box-shadow: none;
  }

  .chat-tool-resize-handle {
    display: none;
  }

  .tool-panel-enter-active,
  .tool-panel-leave-active {
    transition:
      transform 0.25s cubic-bezier(0.4, 0, 0.2, 1),
      opacity 0.16s ease;
  }

  .tool-panel-enter-from,
  .tool-panel-leave-to {
    width: 100% !important;
    transform: translateX(100%);
  }

  .tool-panel-enter-from:dir(rtl),
  .tool-panel-leave-to:dir(rtl) {
    transform: translateX(-100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tool-panel-enter-active,
  .tool-panel-leave-active {
    transition-duration: 0.01ms;
  }
}

/* ── Default Workspace Feature ─────────────────────────────────── */

.default-workspace-chips {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.default-workspace-label {
  font-size: 13px;
  color: var(--n-text-color-3);
  flex-shrink: 0;
}

.workspace-chips-container {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
  position: relative;
}

.workspace-chip {
  padding: 4px 12px;
  font-size: 13px;
  color: var(--text-secondary);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.workspace-chip:hover {
  background: rgba(var(--accent-primary-rgb), 0.06);
  border-color: var(--accent-muted);
  color: var(--text-primary);
}

.workspace-chip.active {
  background: rgba(var(--accent-primary-rgb), 0.12);
  border-color: var(--accent-muted);
  color: var(--accent-primary);
  font-weight: 500;
}

.workspace-chip-separator {
  color: var(--n-text-color-3);
  font-size: 13px;
  user-select: none;
}

.workspace-chip-dropdown {
  position: relative;
  display: inline-block;
}

.workspace-chip-more {
  display: inline-flex;
  align-items: center;
  padding: 4px 12px;
  font-size: 13px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
  color: var(--text-secondary);
}

.workspace-chip-more:hover {
  background: rgba(var(--accent-primary-rgb), 0.06);
  border-color: var(--accent-muted);
  color: var(--text-primary);
}

.workspace-dropdown-menu {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  min-width: 200px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 9999;
  max-height: 300px;
  overflow-y: auto;
}

.workspace-dropdown-item {
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-dropdown-item:hover {
  background: var(--n-color-hover);
}

.workspace-default-badge {
  display: inline-block;
  margin-inline-start: 6px;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 600;
  color: #f5a623;
  background: rgba(245, 166, 35, 0.12);
  border: 1px solid rgba(245, 166, 35, 0.3);
  border-radius: 3px;
  vertical-align: middle;
}

.recent-workspaces {
  margin-top: 8px;
}

.recent-workspaces-label {
  display: block;
  font-size: 11px;
  color: $text-muted;
  margin-bottom: 4px;
}

.recent-workspaces-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.recent-pin-icon {
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  color: $text-muted;
  transition: color $transition-fast;

  &:hover {
    color: #f5a623;
  }
}
</style>
