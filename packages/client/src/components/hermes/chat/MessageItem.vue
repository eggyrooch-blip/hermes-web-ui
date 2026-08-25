<script setup lang="ts">
import type { Message, ContentBlock, Session, WorkspaceDiffInlineFile } from "@/stores/hermes/chat";
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import { useCopyFeedback } from "@/composables/useCopyFeedback";
import { downloadFile, getDownloadUrl } from "@/api/hermes/download";
import { copyToClipboard } from "@/utils/clipboard";
import MarkdownRenderer from "./MarkdownRenderer.vue";
import FeedbackControl from "./FeedbackControl.vue";
import SourceRefs from "./SourceRefs.vue";
import { parseThinking } from "@/utils/thinking-parser";
import { useChatStore } from "@/stores/hermes/chat";
import { useFilesStore } from "@/stores/hermes/files";
import { useSettingsStore } from "@/stores/hermes/settings";
import {
  copyTextToClipboard,
  extractUnifiedDiffPayload,
  handleCodeBlockCopyClick,
  inferStructuredLanguage,
  renderHighlightedCodeBlock,
} from "./highlight";
import { useGlobalSpeech } from "@/composables/useSpeech";
import { useVoiceSettings } from "@/composables/useVoiceSettings";
import { speedToEdgeRate, hzToEdgePitch } from "@/utils/ttsHelpers";
import KpIcon from "@/components/kippies/KpIcon.vue";

const TOOL_PAYLOAD_DISPLAY_LIMIT = 1000;
const JSON_STRING_DISPLAY_LIMIT = 200;
const JSON_MAX_DEPTH = 6;
const JSON_MAX_NODES = 1000;
const JSON_MAX_KEYS_PER_OBJECT = 50;
const JSON_MAX_ITEMS_PER_ARRAY = 50;
const JSON_TRUNCATED_KEY = "__truncated__";

const props = defineProps<{
  message: Message;
  highlight?: boolean;
  headingIdPrefix?: string;
  session?: Session | null;
  feedbackEligible?: boolean;
}>();
const { t } = useI18n();
// Copy feedback lands on the button that was pressed — copying changes nothing
// on screen, so it is the one action that must say something, and a transcript
// is exactly where a toast is furthest from the control you clicked.
const copyFeedback = useCopyFeedback();
/** A download that never started. The browser announces the ones that do. */
const downloadError = ref("");
const chatStore = useChatStore();
const filesStore = useFilesStore();

const isSystem = computed(() => props.message.role === "system");
const isAgentError = computed(() => props.message.role === "assistant" && props.message.systemType === "error");
const feedbackSessionId = computed(() => (props.session ?? chatStore.activeSession)?.id || "");

const effectiveHeadingIdPrefix = computed(() => props.headingIdPrefix || `msg-${props.message.id}`);
const isCommandMessage = computed(() => props.message.role === "command" || props.message.systemType === "command");
const isCommandError = computed(() => props.message.role === "command" && props.message.systemType === "error");
const isStatusCommand = computed(() =>
  isCommandMessage.value
  && props.message.commandAction === "status"
  && props.message.commandData?.type !== "goal"
);
const isWorkspaceDiffCommand = computed(() => isCommandMessage.value && props.message.commandAction === "workspace.diff");
// Prototype has exactly two conversation voices: the user (right-side bubble)
// and the agent (left-side plain text). A command the USER typed (echoed back
// with role 'command', content starting with '/') therefore renders as an
// ordinary user bubble; command RESPONSES render as a quiet gray status line
// and system notices use the prototype's tinted danger block.
const isUserCommand = computed(
  () => isCommandMessage.value && (props.message.content || "").trimStart().startsWith("/"),
);
const displayRole = computed(() => (isUserCommand.value ? "user" : props.message.role));
const statusItems = computed(() => {
  const data = props.message.commandData || {};
  return [
    { key: "status", value: data.isWorking ? "running" : "idle" },
    { key: "source", value: data.source },
    { key: "profile", value: data.profile },
    { key: "model", value: data.model || "-" },
    { key: "queue", value: data.queueLength ?? 0 },
    { key: "run", value: data.runId || "-" },
  ];
});

type WorkspaceDiffFileClick = {
  id: number
  path: string
  change_id?: string | null
  session_id?: string | null
  additions?: number
  deletions?: number
}

const inlineWorkspaceDiffFiles = computed<WorkspaceDiffInlineFile[]>(() => {
  const messageRunId = typeof props.message.runId === "string" ? props.message.runId : "";
  const session = props.session ?? chatStore.activeSession;
  return session ? chatStore.workspaceDiffFilesForRun(session.id, messageRunId) : [];
});

async function openWorkspaceDiffFile(file: WorkspaceDiffFileClick): Promise<void> {
  const session = props.session ?? chatStore.activeSession;
  const displayPath = `/workspace/${String(file.path).replace(/^\/+/, "")}`;
  const fileName = String(file.path).split("/").filter(Boolean).pop() || String(file.path);
  await filesStore.previewWorkspaceDiffFile({
    displayPath,
    fileName,
    changeId: String(file.change_id || ""),
    fileId: file.id,
    sessionId: String(file.session_id || session?.id || ""),
    profile: props.session?.profile,
  });
}

type DisplayContentFile = {
  type: 'image' | 'file'
  name: string
  path?: string
  url?: string
}

function getBlockText(block: any): string {
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text' || block.type === 'input_text') {
    return typeof block.text === 'string' ? block.text : ''
  }
  return ''
}

function getImageUrlFromBlock(block: any): string | null {
  if (!block || typeof block !== 'object') return null
  if (block.type !== 'input_image' && block.type !== 'image_url') return null
  const raw = block.image_url
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object' && typeof raw.url === 'string') return raw.url
  return null
}

function imageNameFromDataUrl(url: string, index: number): string {
  const match = url.match(/^data:image\/([^;,]+)/i)
  const ext = match?.[1] === 'jpeg' ? 'jpg' : match?.[1] || 'png'
  return `image-${index + 1}.${ext}`
}

function parseContentBlocks(content: string): Array<ContentBlock | Record<string, unknown>> | null {
  const trimmed = content.trim()
  if (!trimmed) return null

  const parse = (value: string) => {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.length > 0 && 'type' in parsed[0]
      ? parsed as Array<ContentBlock | Record<string, unknown>>
      : null
  }

  try {
    return parse(trimmed)
  } catch {
    // Hermes Agent stored some multimodal user messages via Python str(list),
    // e.g. [{'type': 'text'}, {'type': 'image_url', ...}]. Convert that
    // legacy repr into JSON for display only.
    if (!trimmed.startsWith("[{'") && !trimmed.startsWith('[{"')) return null
    try {
      return parse(
        trimmed
          .replace(/\bNone\b/g, 'null')
          .replace(/\bTrue\b/g, 'true')
          .replace(/\bFalse\b/g, 'false')
          .replace(/'/g, '"'),
      )
    } catch {
      return null
    }
  }
}

// Parse ContentBlock[] from JSON string
const contentBlocks = computed(() => {
  const content = props.message.content || '';
  return parseContentBlocks(content);
});

// Check if content is in ContentBlock[] format
const isContentBlockArray = computed(() => contentBlocks.value !== null);

// Extract text content from ContentBlock[] for display
const displayText = computed(() => {
  if (!isContentBlockArray.value) {
    return props.message.content || '';
  }

  // Extract text from blocks
  return contentBlocks.value!
    .map(block => getBlockText(block))
    .filter(Boolean)
    .join('\n');
});

// Extract files from ContentBlock[]
const contentFiles = computed<DisplayContentFile[] | null>(() => {
  if (!isContentBlockArray.value) return null;

  return contentBlocks.value!.flatMap<DisplayContentFile>((block, index) => {
    if (block.type === 'image') {
      return [{
        type: 'image' as const,
        name: String((block as any).name || `image-${index + 1}`),
        path: String((block as any).path || ''),
      }].filter(file => file.path)
    }
    if (block.type === 'file') {
      return [{
        type: 'file' as const,
        name: String((block as any).name || `file-${index + 1}`),
        path: String((block as any).path || ''),
      }].filter(file => file.path)
    }
    const imageUrl = getImageUrlFromBlock(block)
    if (imageUrl?.startsWith('data:image/')) {
      return [{
        type: 'image' as const,
        name: imageNameFromDataUrl(imageUrl, index),
        url: imageUrl,
      }]
    }
    return []
  });
});

function getContentFileUrl(file: DisplayContentFile): string {
  if (file.url) return file.url
  return file.path ? getDownloadUrl(file.path, file.name) : ''
}

const toolExpanded = ref(false);
const previewUrl = ref<string | null>(null);

const settingsStore = useSettingsStore();
const speech = useGlobalSpeech();
const voiceSettings = useVoiceSettings();
// NOTE: the assistant turn deliberately carries NO avatar of any kind (see the
// template). Whatever replaces it must never fall back to the active PROFILE's
// avatar: in multitenancy each user IS a profile, so that made the agent wear the
// user's own Feishu photo — the "talking to yourself" bug this file used to guard.
// Copy entire bubble content
const copyableContent = computed(() => {
  if (props.message.role === 'tool') return null
  const content = props.message.content || ''
  if (!content.trim()) return null
  return content
})

async function copyBubbleContent() {
  const text = copyableContent.value
  if (!text) return
  await copyFeedback.run('bubble', () => copyToClipboard(text))
}

const parsedThinking = computed(() =>
  parseThinking(props.message.content || "", { streaming: !!props.message.isStreaming }),
);

// 优先使用来自 reasoning 字段/事件的思考文本；否则回退到从 content 解析的 <think> 标签。
// 若两者共存，则拼接展示（罕见，但保持信息不丢）。
const hasReasoningField = computed(() => !!(props.message.reasoning && props.message.reasoning.length > 0));

const hasThinking = computed(() => hasReasoningField.value || parsedThinking.value.hasThinking);

const thinkingFullText = computed(() => {
  const parts: string[] = [];
  if (props.message.reasoning) parts.push(props.message.reasoning);
  parts.push(...parsedThinking.value.segments);
  if (parsedThinking.value.pending) parts.push(parsedThinking.value.pending);
  return parts.join("\n\n");
});

// 流式思考态：仍有未闭合 <think> 标签，或 reasoning 有内容但正文尚未开始。
const thinkingStreamingNow = computed(() => {
  if (!props.message.isStreaming) return false;
  if (parsedThinking.value.pending !== null) return true;
  if (hasReasoningField.value && !props.message.content) return true;
  return false;
});

const thinkingOverride = ref<boolean | null>(null);

const thinkingExpanded = computed(() => {
  if (thinkingStreamingNow.value) return true;
  if (thinkingOverride.value !== null) return thinkingOverride.value;
  return !!settingsStore.display.show_reasoning;
});

function toggleThinking() {
  thinkingOverride.value = !thinkingExpanded.value;
}

const nowTick = ref(Date.now());
let tickTimer: number | null = null;

function ensureTick() {
  const ob = chatStore.getThinkingObservation(props.message.id);
  const shouldTick = !!(
    props.message.isStreaming &&
    ob?.startedAt !== undefined &&
    ob.endedAt === undefined
  );
  if (shouldTick && tickTimer === null) {
    tickTimer = window.setInterval(() => {
      nowTick.value = Date.now();
    }, 1000);
  } else if (!shouldTick && tickTimer !== null) {
    window.clearInterval(tickTimer);
    tickTimer = null;
  }
}

watchEffect(ensureTick);

onBeforeUnmount(() => {
  if (tickTimer !== null) window.clearInterval(tickTimer);
});

const thinkingDurationMs = computed<number | null>(() => {
  const ob = chatStore.getThinkingObservation(props.message.id);
  if (!ob?.startedAt) return null;
  const startedAt = ob.startedAt!; // Non-null assertion after check
  const end = ob?.endedAt ?? (props.message.isStreaming ? nowTick.value : startedAt);
  return Math.max(0, end - startedAt);
});

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

// Prototype ThinkingDisclosure: the header IS the elapsed/total time (not a
// "Thinking" label + a char count). Falls back to the plain label only before
// any duration is known.
const thinkingHeaderText = computed(() => {
  const ms = thinkingDurationMs.value;
  if (ms !== null && ms > 0) {
    const duration = formatDuration(ms);
    return thinkingStreamingNow.value
      ? t('chat.thinkingProcessing', { duration })
      : t('chat.thinkingElapsed', { duration });
  }
  return thinkingStreamingNow.value ? t('chat.thinkingInProgress') : t('chat.thinkingLabel');
});

// Prototype msgTime: toTimeString().slice(0, 8) — always HH:MM:SS.
const timeStr = computed(() => {
  const date = new Date(props.message.timestamp);
  return Number.isNaN(date.getTime()) ? "" : date.toTimeString().slice(0, 8);
});

function isImage(type: string): boolean {
  return type.startsWith("image/");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * Extract the upload file path from message content for a given attachment.
 * Upload format in content: [File: name.txt](/tmp/hermes-uploads/abc123.txt)
 */
function getFilePathFromContent(attName: string): string | null {
  const content = props.message.content || "";

  // Try ContentBlock[] format first
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.length > 0 && 'type' in parsed[0]) {
      const fileBlock = parsed.find((block: any) =>
        block.type === 'file' && block.name === attName
      );
      if (fileBlock && (fileBlock as any).path) {
        return (fileBlock as any).path;
      }
    }
  } catch {
    // Not valid JSON, continue to regex matching
  }

  // Fallback to markdown format: [File: name](path)
  const regex = /\[File:\s*([^\]]+)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match[1].trim() === attName.trim()) return match[2];
  }

  return null;
}

function handleAttachmentDownload(att: { name: string; url: string; type: string }) {
  const filePath = getFilePathFromContent(att.name);
  if (filePath) {
    // A download that starts is announced by the browser itself.
    downloadFile(filePath, att.name).catch((err: Error) => {
      downloadError.value = err.message || t("download.downloadFailed");
    });
    return;
  }
  if (att.url && att.url.startsWith("blob:")) {
    const a = document.createElement("a");
    a.href = att.url;
    a.download = att.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

type ToolPayload = {
  full: string;
  display: string;
  language?: string;
};

function truncateLongString(value: string, marker: string): string {
  return value.length > JSON_STRING_DISPLAY_LIMIT
    ? value.slice(0, JSON_STRING_DISPLAY_LIMIT) + "\n" + marker
    : value;
}

function truncateJsonValue(value: unknown, marker: string): unknown {
  let nodeCount = 0;
  const seen = new WeakSet<object>();

  function stringifyLength(candidate: unknown): number {
    return JSON.stringify(candidate, null, 2).length;
  }

  function visit(current: unknown, depth: number): unknown {
    nodeCount += 1;
    if (nodeCount > JSON_MAX_NODES) {
      return marker;
    }

    if (typeof current === "string") return truncateLongString(current, marker);
    if (current === null || typeof current !== "object") return current;

    if (seen.has(current)) return `[Circular ${marker}]`;
    if (depth >= JSON_MAX_DEPTH) {
      return Array.isArray(current) ? `[Array ${marker}]` : `[Object ${marker}]`;
    }

    seen.add(current);

    if (Array.isArray(current)) {
      const result: unknown[] = [];
      const maxItems = Math.min(current.length, JSON_MAX_ITEMS_PER_ARRAY);
      for (let i = 0; i < maxItems; i += 1) {
        const remaining = current.length - i;
        result.push(visit(current[i], depth + 1));
        if (stringifyLength(result) > TOOL_PAYLOAD_DISPLAY_LIMIT) {
          result.pop();
          result.push(`${marker}: ${remaining} more items`);
          seen.delete(current);
          return result;
        }
      }
      if (current.length > maxItems) {
        result.push(`${marker}: ${current.length - maxItems} more items`);
      }
      seen.delete(current);
      return result;
    }

    const entries = Object.entries(current as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    const maxKeys = Math.min(entries.length, JSON_MAX_KEYS_PER_OBJECT);
    for (let i = 0; i < maxKeys; i += 1) {
      const [key, val] = entries[i];
      const remaining = entries.length - i;
      result[key] = visit(val, depth + 1);
      if (stringifyLength(result) > TOOL_PAYLOAD_DISPLAY_LIMIT) {
        delete result[key];
        result[JSON_TRUNCATED_KEY] = `${marker}: ${remaining} more keys`;
        seen.delete(current);
        return result;
      }
    }
    if (entries.length > maxKeys) {
      result[JSON_TRUNCATED_KEY] = `${marker}: ${entries.length - maxKeys} more keys`;
    }
    seen.delete(current);
    return result;
  }

  const truncated = visit(value, 0);
  if (stringifyLength(truncated) <= TOOL_PAYLOAD_DISPLAY_LIMIT) return truncated;
  return { [JSON_TRUNCATED_KEY]: marker };
}

function normalizeToolPayload(raw: unknown): string {
  if (raw === null || raw === undefined || raw === "") return "";
  if (typeof raw === "string") return raw;
  try {
    const serialized = JSON.stringify(raw);
    if (serialized !== undefined) return serialized;
  } catch {
    // Fall through to String(raw) for non-serializable runtime payloads.
  }
  return String(raw);
}

function formatToolPayload(raw?: unknown, extractDiff = false): ToolPayload {
  const text = normalizeToolPayload(raw);
  if (!text) {
    return { full: "", display: "" };
  }

  const shouldParseJson = typeof raw !== "string" || /^[\[{]/.test(text.trim());
  if (shouldParseJson) {
    try {
      const parsed = JSON.parse(text);
      const full = JSON.stringify(parsed, null, 2);
      const extractedDiff = extractDiff ? extractUnifiedDiffPayload(parsed) : null;
      if (extractedDiff) {
        return {
          full,
          display: extractedDiff,
          language: "diff",
        };
      }
      const display = full.length > TOOL_PAYLOAD_DISPLAY_LIMIT
        ? JSON.stringify(truncateJsonValue(parsed, t("chat.truncated")), null, 2)
        : full;
      return {
        full,
        display,
        language: "json",
      };
    } catch {
      // Fall through to text rendering for non-JSON strings.
    }
  }

  const language = inferStructuredLanguage(text);
  return {
    full: text,
    display:
      language === "diff" || text.length <= TOOL_PAYLOAD_DISPLAY_LIMIT
        ? text
        : text.slice(0, TOOL_PAYLOAD_DISPLAY_LIMIT) + "\n" + t("chat.truncated"),
    language,
  };
}

function renderToolPayload(content: string, language?: string): string {
  return renderHighlightedCodeBlock(content, language, t("common.copy"), {
    maxHighlightLength: TOOL_PAYLOAD_DISPLAY_LIMIT,
    formatDiffFoldLabel: (hiddenCount) => t("chat.unchangedLines", { count: hiddenCount }),
  });
}

async function handleToolDetailClick(event: MouseEvent): Promise<void> {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const button = target.closest<HTMLElement>("[data-copy-code=\"true\"]");
  if (!button) return;

  event.preventDefault();

  const source = button.closest<HTMLElement>("[data-copy-source]")?.dataset.copySource;
  if (source === "tool-args" && fullToolArgs.value) {
    await copyFeedback.run("tool-args", () => copyTextToClipboard(fullToolArgs.value));
    return;
  }
  if (source === "tool-result" && fullToolResult.value) {
    await copyFeedback.run("tool-result", () => copyTextToClipboard(fullToolResult.value));
    return;
  }

  // Code blocks report on their own button (see flashCopyResult in highlight.ts).
  await handleCodeBlockCopyClick(event);
}

const hasAttachments = computed(
  () => (props.message.attachments?.length ?? 0) > 0,
);

const toolArgsPayload = computed(() => formatToolPayload(props.message.toolArgs));
const toolResultPayload = computed(() => formatToolPayload(props.message.toolResult, true));

const hasToolDetails = computed(
  () => !!(toolArgsPayload.value.full || toolResultPayload.value.full),
);

const fullToolArgs = computed(() => toolArgsPayload.value.full);
const formattedToolArgs = computed(() => toolArgsPayload.value.display);
const fullToolResult = computed(() => toolResultPayload.value.full);
const formattedToolResult = computed(() => toolResultPayload.value.display);

const renderedToolArgs = computed(() => {
  if (!formattedToolArgs.value) return "";
  return renderToolPayload(
    formattedToolArgs.value,
    toolArgsPayload.value.language,
  );
});

const renderedToolResult = computed(() => {
  if (!formattedToolResult.value) return "";
  return renderToolPayload(
    formattedToolResult.value,
    toolResultPayload.value.language,
  );
});

// 语音播放相关
const canPlaySpeech = computed(() => {
  // 只有 assistant 消息可以播放
  if (props.message.role !== 'assistant') return false
  if (!copyableContent.value) return false
  // OpenAI / Custom / Edge / MiMo 不依赖浏览器 Web Speech API
  if (voiceSettings.provider.value === 'openai' || voiceSettings.provider.value === 'custom' || voiceSettings.provider.value === 'edge' || voiceSettings.provider.value === 'mimo') return true
  return speech.isSupported
})

const isPlayingThisMessage = computed(() => {
  // OpenAI / Custom / Edge / MiMo 模式
  if (voiceSettings.provider.value === 'openai' || voiceSettings.provider.value === 'custom' || voiceSettings.provider.value === 'edge' || voiceSettings.provider.value === 'mimo') {
    return speech.currentCustomMessageId.value === props.message.id && speech.isCustomPlaying.value
  }
  return speech.currentMessageId.value === props.message.id && speech.isPlaying.value
})

const isPausedThisMessage = computed(() => {
  // OpenAI / Custom / Edge / MiMo 模式
  if (voiceSettings.provider.value === 'openai' || voiceSettings.provider.value === 'custom' || voiceSettings.provider.value === 'edge' || voiceSettings.provider.value === 'mimo') {
    return speech.currentCustomMessageId.value === props.message.id && speech.isCustomPaused.value
  }
  return speech.currentMessageId.value === props.message.id && speech.isPaused.value
})

function handleSpeechToggle() {
  if (!canPlaySpeech.value) {
    return
  }
  const content = props.message.content || ''

  // OpenAI TTS 模式
  if (voiceSettings.provider.value === 'openai') {
    const apiUrl = voiceSettings.openaiBaseUrl.value
    if (!apiUrl) {
      console.warn('[MessageItem] OpenAI TTS 地址为空')
      return
    }
    speech.openaiToggle(props.message.id, content, {
      provider: 'openai',
      baseUrl: voiceSettings.openaiBaseUrl.value,
      apiKey: voiceSettings.openaiApiKey.value,
      model: voiceSettings.openaiModel.value,
      voice: voiceSettings.openaiVoice.value,
    })
    return
  }

  // 自定义端点模式（OpenAI 兼容，如 GPT-SoVITS）
  if (voiceSettings.provider.value === 'custom') {
    const apiUrl = voiceSettings.customUrl.value
    if (!apiUrl) {
      console.warn('[MessageItem] 自定义 TTS 地址为空')
      return
    }
    speech.openaiToggle(props.message.id, content, {
      provider: 'custom',
      baseUrl: voiceSettings.customUrl.value,
      apiKey: voiceSettings.customApiKey.value || undefined,
    })
    return
  }

  // Edge TTS 模式
  if (voiceSettings.provider.value === 'edge') {
    // URL 为空时使用内建后端代理
    const apiUrl = voiceSettings.edgeUrl.value || '/api/tts/proxy'
    speech.openaiToggle(props.message.id, content, {
      provider: 'edge',
      baseUrl: apiUrl,
      voice: voiceSettings.edgeVoice.value,
      rate: speedToEdgeRate(voiceSettings.edgeRate.value),
      pitch: hzToEdgePitch(voiceSettings.edgePitchHz.value),
    })
    return
  }

  // MiMo TTS 模式
  if (voiceSettings.provider.value === 'mimo') {
    const apiKey = voiceSettings.mimoApiKey.value
    speech.mimoToggle(props.message.id, content, {
      baseUrl: voiceSettings.mimoBaseUrl.value,
      apiKey: apiKey || undefined,
      authMode: voiceSettings.mimoAuthMode.value,
      model: voiceSettings.mimoModel.value,
      voiceMode: voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voicedesign' ? 'voiceDesign' : voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voiceclone' ? 'voiceClone' : 'preset',
      voice: voiceSettings.mimoVoice.value,
      voiceDesignDesc: voiceSettings.mimoVoiceDesignDesc.value || undefined,
      voiceCloneDataUri: voiceSettings.mimoVoiceCloneDataUri.value || undefined,
      voiceCloneFormat: voiceSettings.mimoVoiceCloneFormat.value,
      stylePrompt: voiceSettings.mimoStylePrompt.value || undefined,
    })
    return
  }

  // Web Speech API 模式
  if (voiceSettings.provider.value === 'webspeech') {
    speech.toggleBrowser(props.message.id, content, {
      voiceName: voiceSettings.webspeechVoice.value || undefined,
    })
    return
  }

  // 后备（无 provider 匹配时）
  speech.toggle(props.message.id, content)
}

// 监听自动播放事件
let autoPlayHandler: ((e: Event) => void) | null = null

function handleAutoplayTtsError(err: unknown) {
  if (err instanceof Error && err.name === 'AbortError') return
  console.warn('[MessageItem] TTS autoplay failed:', err)
}

onMounted(() => {
  autoPlayHandler = (e: Event) => {
    const customEvent = e as CustomEvent<{ messageId: string; content: string }>
    if (customEvent.detail.messageId === props.message.id && canPlaySpeech.value) {
      const content = customEvent.detail.content || props.message.content || ''
      if (voiceSettings.provider.value === 'openai') {
        const apiUrl = voiceSettings.openaiBaseUrl.value
        if (apiUrl) void speech.openaiPlay(props.message.id, content, {
          provider: 'openai',
          baseUrl: voiceSettings.openaiBaseUrl.value,
          apiKey: voiceSettings.openaiApiKey.value,
          model: voiceSettings.openaiModel.value,
          voice: voiceSettings.openaiVoice.value,
        }).catch(handleAutoplayTtsError)
      } else if (voiceSettings.provider.value === 'custom') {
        const apiUrl = voiceSettings.customUrl.value
        if (apiUrl) void speech.openaiPlay(props.message.id, content, {
          provider: 'custom',
          baseUrl: voiceSettings.customUrl.value,
          apiKey: voiceSettings.customApiKey.value || undefined,
        }).catch(handleAutoplayTtsError)
      } else if (voiceSettings.provider.value === 'edge') {
        void speech.openaiPlay(props.message.id, content, {
          provider: 'edge',
          baseUrl: '/api/tts/proxy',
          voice: voiceSettings.edgeVoice.value,
          rate: speedToEdgeRate(voiceSettings.edgeRate.value),
          pitch: hzToEdgePitch(voiceSettings.edgePitchHz.value),
        }).catch(handleAutoplayTtsError)
      } else if (voiceSettings.provider.value === 'mimo') {
        const apiKey = voiceSettings.mimoApiKey.value
        void speech.mimoPlay(props.message.id, content, {
          baseUrl: voiceSettings.mimoBaseUrl.value,
          apiKey: apiKey || undefined,
          authMode: voiceSettings.mimoAuthMode.value,
          model: voiceSettings.mimoModel.value,
          voiceMode: voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voicedesign' ? 'voiceDesign' : voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voiceclone' ? 'voiceClone' : 'preset',
          voice: voiceSettings.mimoVoice.value,
          voiceDesignDesc: voiceSettings.mimoVoiceDesignDesc.value || undefined,
          voiceCloneDataUri: voiceSettings.mimoVoiceCloneDataUri.value || undefined,
          voiceCloneFormat: voiceSettings.mimoVoiceCloneFormat.value,
          stylePrompt: voiceSettings.mimoStylePrompt.value || undefined,
        }).catch(handleAutoplayTtsError)
      } else if (voiceSettings.provider.value === 'webspeech') {
        const text = speech.extractReadableText(content)
        if (text) {
          speech.stop(false)
          speech.speakViaBrowser(props.message.id, text, {
            voiceName: voiceSettings.webspeechVoice.value || undefined,
          })
        }
      } else {
        speech.enqueue(props.message.id, content)
      }
    }
  }
  window.addEventListener('auto-play-speech', autoPlayHandler)
})

// 组件卸载时停止播放并清理事件监听
onBeforeUnmount(() => {
  if (autoPlayHandler) {
    window.removeEventListener('auto-play-speech', autoPlayHandler)
  }
  if (speech.currentMessageId.value === props.message.id || speech.currentCustomMessageId.value === props.message.id) {
    speech.stop();
  }
});
</script>

<template>
  <div
    v-if="!isWorkspaceDiffCommand"
    class="message"
    :class="[displayRole, { highlight }]"
    :id="`message-${message.id}`"
  >
    <template v-if="message.role === 'tool'">
      <div
        class="tool-line"
        :class="{ expandable: hasToolDetails }"
        @click="hasToolDetails && (toolExpanded = !toolExpanded)"
      >
        <svg
          v-if="hasToolDetails"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          class="tool-chevron"
          :class="{ rotated: toolExpanded }"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <svg
          v-else
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          class="tool-icon"
        >
          <path
            d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
          />
        </svg>
        <span class="tool-name">{{ message.toolName }}</span>
        <span
          v-if="message.toolPreview && !toolExpanded"
          class="tool-preview"
          >{{ message.toolPreview }}</span
        >
        <span
          v-if="message.toolStatus === 'running'"
          class="tool-spinner"
        ></span>
        <span v-if="message.toolStatus === 'error'" class="tool-error-badge">{{
          t("chat.error")
        }}</span>
      </div>
      <div v-if="toolExpanded && hasToolDetails" class="tool-details" @click="handleToolDetailClick">
        <div v-if="formattedToolArgs" class="tool-detail-section" data-copy-source="tool-args">
          <div class="tool-detail-label">{{ t("chat.arguments") }}</div>
          <div class="tool-detail-code-block" v-html="renderedToolArgs"></div>
        </div>
        <div v-if="formattedToolResult" class="tool-detail-section" data-copy-source="tool-result">
          <div class="tool-detail-label">{{ t("chat.result") }}</div>
          <div class="tool-detail-code-block" v-html="renderedToolResult"></div>
        </div>
      </div>
    </template>
    <template v-else>
      <div class="msg-body">
        <!-- No identity row above the answer. The prototype deleted it: that row
             carried only the product's own name, and the user is already inside
             the product — the signature is the mascot on the run's thinking line
             (MessageList), which sits on the line that is actually changing
             ("已处理 N 秒") instead of spending a whole row on a brand name. -->
        <div class="msg-content" :class="message.role">
          <div
            class="message-bubble"
            :class="{
              system: isSystem,
              'agent-error': isAgentError,
              command: isCommandMessage && !isUserCommand,
              'command-error': isCommandError && !isUserCommand,
              'speech-playing': isPlayingThisMessage && !isPausedThisMessage,
            }"
          >
            <div v-if="hasAttachments" class="msg-attachments">
              <div
                v-for="att in message.attachments"
                :key="att.id"
                class="msg-attachment"
                :class="{ image: isImage(att.type) }"
              >
                <template v-if="isImage(att.type) && att.url">
                  <img
                    :src="att.url"
                    :alt="att.name"
                    class="msg-attachment-thumb"
                    @click="previewUrl = att.url"
                  />
                </template>
                <template v-else>
                  <div class="msg-attachment-file" @click="handleAttachmentDownload(att)" style="cursor: pointer;" :title="t('download.downloadFile')">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                    >
                      <path
                        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
                      />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span class="att-name">{{ att.name }}</span>
                    <span class="att-size">{{ formatSize(att.size) }}</span>
                    <svg class="att-download-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </div>
                </template>
              </div>
            </div>
            <div
              v-if="hasThinking"
              class="thinking-block"
              :class="{ expanded: thinkingExpanded }"
            >
              <div class="thinking-header" @click="toggleThinking">
                <span class="thinking-label">{{ thinkingHeaderText }}</span>
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  class="thinking-chevron"
                  :class="{ rotated: thinkingExpanded }"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
              <div class="thinking-divider" aria-hidden="true"></div>
              <div v-if="thinkingExpanded" class="thinking-body">
                <MarkdownRenderer :content="thinkingFullText" />
              </div>
            </div>
            <MarkdownRenderer
              v-if="parsedThinking.body && message.role === 'assistant'"
              :content="parsedThinking.body"
              :heading-id-prefix="effectiveHeadingIdPrefix"
              :workspace-diff-files="inlineWorkspaceDiffFiles"
              @workspace-diff-file-click="openWorkspaceDiffFile"
            />

            <!-- Render user message content -->
            <template v-if="message.role === 'user'">
              <!-- ContentBlock[] format -->
              <template v-if="isContentBlockArray">
                <div v-if="contentFiles && contentFiles.length > 0" class="msg-attachments">
                  <div
                    v-for="(file, idx) in contentFiles"
                    :key="idx"
                    class="msg-attachment"
                    :class="{ image: file.type === 'image' }"
                  >
                    <template v-if="file.type === 'image'">
                      <img
                        :src="getContentFileUrl(file)"
                        :alt="file.name"
                        class="msg-attachment-thumb"
                        @click="previewUrl = getContentFileUrl(file)"
                      />
                    </template>
                    <template v-else>
                      <div
                        class="msg-attachment-file"
                        @click="file.path && downloadFile(file.path, file.name).catch(err => (downloadError = err.message || t('download.downloadFailed')))"
                        style="cursor: pointer;"
                        :title="t('download.downloadFile')"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                        <span class="att-name">{{ file.name }}</span>
                      </div>
                    </template>
                  </div>
                </div>
                <MarkdownRenderer v-if="displayText" :content="displayText" />
              </template>
              <!-- Plain text format -->
              <MarkdownRenderer v-else-if="message.content" :content="message.content" />
            </template>

            <!-- Render assistant message content -->
            <MarkdownRenderer
              v-if="message.role === 'assistant' && (message.content || inlineWorkspaceDiffFiles.length > 0) && !parsedThinking.body"
              :content="message.content"
              :heading-id-prefix="effectiveHeadingIdPrefix"
              :workspace-diff-files="inlineWorkspaceDiffFiles"
              @workspace-diff-file-click="openWorkspaceDiffFile"
            />

            <!-- Render system message content -->
            <MarkdownRenderer
              v-if="message.role === 'system' && message.content && !isCommandMessage"
              :content="message.content"
            />
            <div v-if="isStatusCommand" class="command-result command-status">
              <div class="command-status-grid">
                <span
                  v-for="item in statusItems"
                  :key="item.key"
                  class="command-status-item"
                >
                  <span class="command-status-key">{{ item.key }}</span>
                  <span class="command-status-value">{{ item.value }}</span>
                </span>
              </div>
            </div>
            <!-- User-typed commands read as an ordinary user message; command
                 responses are a quiet status line — no slash chip (prototype
                 has no command vocabulary at all). -->
            <MarkdownRenderer v-else-if="isUserCommand && message.content" :content="message.content" />
            <div v-else-if="isCommandMessage && message.content" class="command-result">
              <MarkdownRenderer :content="message.content" />
            </div>

            <span v-if="message.isStreaming && !message.content" class="streaming-dots">
              <span></span><span></span><span></span>
            </span>
          </div>
          <!-- Prototype: only user and assistant messages carry a meta/action
               row; command echoes and system notices have none. -->
          <p v-if="downloadError" class="msg-download-error" data-testid="msg-download-error">
            {{ downloadError }}
          </p>
          <!-- 来源引用 (digital-employee-source-view): sits ABOVE the action
               row, like the prototype's citation strip — the refs belong to the
               answer, not to the actions. -->
          <SourceRefs
            v-if="message.role === 'assistant' && !message.isStreaming && message.sourceRefs?.length && feedbackSessionId"
            :refs="message.sourceRefs"
            :session-id="feedbackSessionId"
          />
          <div v-if="displayRole === 'user' || displayRole === 'assistant'" class="message-meta">
            <span v-if="displayRole === 'user'" class="message-time">{{ timeStr }}</span>
            <!-- Prototype MsgActions order: 复制 first, then the role's own
                 actions (user: 编辑; assistant: 有用/没用/分享). The inert
                 placeholders match the prototype's IconBtns-without-onClick.
                 Speech playback is a hermes extra and sits last. -->
            <button
              v-if="copyableContent"
              class="copy-bubble-btn"
              :class="{
                'is-copy-ok': copyFeedback.state('bubble') === 'ok',
                'is-copy-fail': copyFeedback.state('bubble') === 'fail',
              }"
              @click="copyBubbleContent"
              :title="copyFeedback.state('bubble') === 'fail' ? t('chat.copyFailed') : t('chat.copyBubble')"
            >
              <!-- Becomes a tick for a beat: copying changes nothing else on
                   screen, so the button is the only honest place to answer. -->
              <svg v-if="copyFeedback.state('bubble') === 'ok'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M20 6 9 17l-5-5"/>
              </svg>
              <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
            <button
              v-if="displayRole === 'user'"
              class="msg-action-btn"
              type="button"
              :title="t('common.edit')"
            >
              <KpIcon name="line_edit" :size="16" />
            </button>
            <template v-if="message.role === 'assistant'">
              <!-- 有用/没用 = the real thing, not the prototype's inert
                   IconBtns: FeedbackControl carries the rating through to the
                   feedback API and reads it back after a reload. It renders the
                   same two KpIcons inline in this row. 分享 stays inert —
                   there is nothing to persist it into yet. -->
              <FeedbackControl
                v-if="feedbackEligible && feedbackSessionId && message.runId"
                :session-id="feedbackSessionId"
                :run-id="message.runId"
              />
              <button class="msg-action-btn" type="button" :title="t('chat.msgShare')">
                <KpIcon name="line_share" :size="16" />
              </button>
            </template>
            <button
              v-if="canPlaySpeech"
              class="speech-bubble-btn"
              :class="{ playing: isPlayingThisMessage, paused: isPausedThisMessage }"
              @click="handleSpeechToggle"
              :title="isPlayingThisMessage ? (isPausedThisMessage ? t('chat.resumeSpeech') : t('chat.pauseSpeech')) : t('chat.playSpeech')"
            >
              <svg v-if="!isPlayingThisMessage || isPausedThisMessage" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
              <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="6" y="4" width="4" height="16"/>
                <rect x="14" y="4" width="4" height="16"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
  <Teleport to="body">
    <div v-if="previewUrl" class="image-preview-overlay" @click.self="previewUrl = null">
      <img :src="previewUrl" class="image-preview-img" @click="previewUrl = null" />
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;
.msg-download-error {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: var(--r-ctl);
  background: var(--danger-bg);
  color: var(--danger);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
}

.copy-bubble-btn.is-copy-ok {
  color: var(--keep-green);
}

.copy-bubble-btn.is-copy-fail {
  color: var(--danger);
}


.message {
  display: flex;
  flex-direction: column;
  position: relative;
  min-width: 0;
  max-width: 100%;

  &.user {
    align-items: flex-end;

    .msg-body {
      max-width: 80%;
      position: relative;
      z-index: 1;
    }

    .msg-content.user {
      align-items: flex-end;
    }

    // Prototype user bubble: --gray-f2 fill, asymmetric radius (sharp
    // bottom-right corner), 12/16 padding.
    .message-bubble {
      background-color: var(--gray-f2);
      border-radius: 16px 16px 2px 16px;
      padding: 12px 16px;
    }
  }

  &.assistant {
    flex-direction: row;
    align-items: flex-start;
    gap: 8px;

    .msg-body {
      max-width: 88%;
      position: relative;
      z-index: 1;
      flex-direction: column;
    }

    // Prototype: assistant output is PLAIN TEXT — no fill, no border, no
    // radius, no padding ("正文是纯文本，不套气泡"). Only the error variant
    // keeps a box (below).
    .message-bubble:not(.agent-error) {
      background-color: transparent;
      border-radius: 0;
      padding: 0;
    }

    .message-bubble.agent-error {
      color: $error;
      background-color: rgba(var(--error-rgb), 0.06);
      border: 1px solid rgba(var(--error-rgb), 0.2);
    }
  }

  &.tool {
    align-items: flex-start;
  }

  &.system {
    align-items: flex-start;
  }

  &.command {
    align-items: flex-start;
  }

  &.highlight {
    .message-bubble {
      box-shadow: 0 0 0 1px rgba(var(--accent-primary-rgb), 0.45);
    }
  }
}

@keyframes gradient-flow {
  0% {
    background-position: 0% 50%;
  }
  50% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0% 50%;
  }
}

.msg-body {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 85%;
  min-width: 0;
  box-sizing: border-box;
}

.msg-content {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}

.message-bubble {
  padding: 10px 14px;
  // Prototype t-body-multi: chat copy runs at 16px with the reading leading.
  font-size: var(--t-16);
  line-height: var(--lh-read);

  // .markdown-body pins 14px for other surfaces; chat copy follows the bubble.
  :deep(.markdown-body) {
    font-size: inherit;
    line-height: inherit;
  }
  word-break: break-word;
  overflow-wrap: anywhere;
  border-radius: 10px;
  max-width: 100%;
  min-width: 0;
  position: relative;
  box-sizing: border-box;

  // Prototype notice block (the RunScreen fail block): tinted card, 12px
  // padding, --r-ctl radius, 14/1.6 danger text — no colored side stripe.
  &.system {
    padding: 12px;
    border-radius: var(--r-ctl);
    background-color: var(--danger-bg);
    color: var(--danger);
    max-width: 88%;
    font-size: var(--t-14);
    line-height: 1.6;

    :deep(.markdown-body) {
      color: inherit;
    }
  }

  // Command RESPONSES are a quiet status line (ToolLine typography): no pill,
  // no fill — the prototype has no command vocabulary, so machine acks read
  // like tool output.
  &.command {
    border: none;
    background-color: transparent;
    padding: 0;
    max-width: min(100%, 960px);
    font-size: 13px;
    line-height: 1.6;
    color: var(--fg-aux);

    :deep(.markdown-body) {
      color: inherit;
    }
  }

  // A failed command is the same notice block as a system error.
  &.command-error {
    padding: 12px;
    border-radius: var(--r-ctl);
    background-color: var(--danger-bg);
    color: var(--danger);
  }

  &.agent-error {
    color: $error;
    background-color: rgba(var(--error-rgb), 0.06);
    border: 1px solid rgba(var(--error-rgb), 0.2);

    :deep(.markdown-body),
    :deep(.markdown-body p),
    :deep(.markdown-body li),
    :deep(.markdown-body strong),
    :deep(.markdown-body code) {
      color: $error;
    }
  }

  &.speech-playing {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
    animation: rainbow-glow 4s linear infinite;
  }
}

.command-result {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;

  :deep(.markdown-body) {
    min-width: 0;
  }

  :deep(.markdown-body p) {
    margin: 0;
  }
}

.command-status {
  align-items: center;
}

.command-status-grid {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  scrollbar-width: thin;
}

.command-status-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  padding: 2px 7px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.1);
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.035);
  line-height: 1.4;
}

.command-status-key {
  color: $text-muted;
  font-size: 11px;
}

.command-status-value {
  color: $text-primary;
  font-family: $font-code;
  font-size: 11px;
}

@keyframes rainbow-glow {
  0% {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
  }
  16.66% {
    box-shadow:
      0 0 0 2px #feca57,
      0 0 10px rgba(254, 202, 87, 0.4),
      0 0 20px rgba(254, 202, 87, 0.2);
  }
  33.33% {
    box-shadow:
      0 0 0 2px #48dbfb,
      0 0 10px rgba(72, 219, 251, 0.4),
      0 0 20px rgba(72, 219, 251, 0.2);
  }
  50% {
    box-shadow:
      0 0 0 2px #ff9ff3,
      0 0 10px rgba(255, 159, 243, 0.4),
      0 0 20px rgba(255, 159, 243, 0.2);
  }
  66.66% {
    box-shadow:
      0 0 0 2px #54a0ff,
      0 0 10px rgba(84, 160, 255, 0.4),
      0 0 20px rgba(84, 160, 255, 0.2);
  }
  83.33% {
    box-shadow:
      0 0 0 2px #5f27cd,
      0 0 10px rgba(95, 39, 205, 0.4),
      0 0 20px rgba(95, 39, 205, 0.2);
  }
  100% {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
  }
}

.msg-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.msg-attachment {
  border-radius: $radius-sm;
  overflow: hidden;
  background-color: rgba(0, 0, 0, 0.04);
  border: 1px solid $border-light;

  &.image {
    max-width: 200px;
  }
}

.msg-attachment-thumb {
  display: block;
  max-width: 200px;
  max-height: 160px;
  object-fit: contain;
  cursor: pointer;
}

.msg-attachment-file {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: $text-secondary;

  .att-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 160px;
  }

  .att-size {
    color: $text-muted;
    font-size: 11px;
    flex-shrink: 0;
  }
}

.thinking-block {
  margin-bottom: 8px;
  padding: 4px 0;

  .thinking-header {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font: var(--w-regular) var(--t-13) / 1.4 var(--font-cn);
    color: var(--fg-secondary);
    cursor: pointer;
    padding: 2px 4px;
    border-radius: var(--r-card-s);
    user-select: none;
    transition: background var(--motion-fast) var(--ease-std);

    &:hover {
      background: var(--gray-fa);
    }
  }

  .thinking-chevron {
    flex-shrink: 0;
    color: var(--fg-aux);
    transition: transform var(--motion-fast) var(--ease-std);

    &.rotated {
      transform: rotate(90deg);
    }
  }

  .thinking-label {
    flex-shrink: 0;
  }

  // Prototype: a hairline divider directly under the time header.
  .thinking-divider {
    height: 1px;
    margin: 8px 0 0;
    background: var(--divider);
  }

  .thinking-meta {
    color: var(--fg-aux);
    font-variant-numeric: tabular-nums;
  }

  .thinking-body {
    margin-top: 6px;
    margin-left: 8px;
    padding-left: 12px;
    border-left: 0.5px solid var(--divider);
    font-size: var(--t-13);
    line-height: 1.6;
    color: var(--fg-aux);

    :deep(p) { margin: 0.3em 0; }
  }
}

// Prototype: the meta row is always visible — time (user only) plus a row of
// 28px transparent icon buttons, gap 4, tucked 4px under the bubble.
// Prototype: the user meta row is a gap-4 wrapper (time + actions) sitting
// 4px under the bubble; the action buttons themselves run at gap 2
// (MsgActions). The time keeps the extra 2px so time→button reads as 4.
.message-meta {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 4px;
}

.message-time {
  margin-right: 2px;
}

// Assistant answers carry the standalone MsgActions row: marginTop 8.
.message.assistant .message-meta {
  margin-top: 8px;
}

// Prototype IconBtn (.ab): no hover tint at all — the only feedback is the
// press dim (opacity .6 on :active).
.copy-bubble-btn,
.speech-bubble-btn,
.msg-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--fg-aux);
  cursor: pointer;
  border-radius: 9999px;
  padding: 0;
  transition: opacity var(--motion-base) var(--ease-std);

  &:active {
    opacity: 0.6;
  }
}

// 没用 = the praise glyph flipped, as in the prototype.
.msg-action-flip {
  transform: rotate(180deg);
}

.speech-bubble-btn {
  &.playing {
    color: var(--accent-primary);
    animation: pulse 1.5s ease-in-out infinite;

    &.paused {
      animation: none;
      opacity: 0.6;
    }
  }
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

// Prototype t-meta (12/lh-tight) with the inline fg-disabled override.
.message-time {
  font: var(--w-regular) var(--t-12) / var(--lh-tight) var(--font-cn);
  color: var(--fg-disabled);
  user-select: none;
}

.tool-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font: var(--w-regular) var(--t-12) / 1.4 var(--font-cn);
  color: var(--fg-secondary);
  padding: 2px 4px;
  border-radius: var(--r-card-s);
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;

  &.expandable {
    cursor: pointer;

    &:hover {
      background: var(--gray-fa);
    }
  }

  .tool-name {
    font-family: var(--font-mono);
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-preview {
    display: block;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: min(400px, 100%);
    color: var(--fg-aux);
  }
}

.tool-chevron {
  flex-shrink: 0;
  color: var(--fg-aux);
  transition: transform var(--motion-fast) var(--ease-std);

  &.rotated {
    transform: rotate(90deg);
  }
}

.tool-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--fg-aux);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}

.tool-error-badge {
  font-size: var(--t-9);
  color: var(--danger);
  background: var(--danger-bg);
  padding: 0 4px;
  border-radius: var(--r-card-s);
  line-height: 14px;
  margin-left: 4px;
}

.tool-details {
  margin-left: 16px;
  margin-top: 2px;
  border-left: 0.5px solid var(--divider);
  padding-left: 10px;
}

.tool-detail-section {
  margin-bottom: 6px;
}

.tool-detail-label {
  font-size: var(--t-10);
  font-weight: var(--w-semibold);
  color: var(--fg-aux);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 2px;
}

.tool-detail-code-block {
  :deep(.hljs-code-block) {
    margin: 0;
  }

  :deep(.code-header) {
    background: var(--gray-fa);
  }

  :deep(code.hljs) {
    font-size: 11px;
    max-height: 300px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  :deep(.hljs-unified-diff code.hljs) {
    max-height: none;
    overflow-y: visible;
    white-space: pre;
    word-break: normal;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.streaming-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background-color: $text-muted;
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: blink 0.8s infinite;
}

.streaming-dots {
  display: flex;
  gap: 4px;
  padding: 4px 0;

  span {
    width: 6px;
    height: 6px;
    background-color: $text-muted;
    border-radius: 50%;
    animation: pulse 1.4s infinite ease-in-out;

    &:nth-child(2) { animation-delay: 0.2s; }
    &:nth-child(3) { animation-delay: 0.4s; }
  }
}

@keyframes blink {
  0%,
  50% {
    opacity: 1;
  }
  51%,
  100% {
    opacity: 0;
  }
}

@keyframes pulse {
  0%,
  80%,
  100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  40% {
    opacity: 1;
    transform: scale(1);
  }
}

.image-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.image-preview-img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 4px;
}

@media (max-width: $breakpoint-mobile) {
  .message.user .msg-body {
    max-width: 100%;
  }

  .message.assistant .msg-body {
    max-width: 100%;
  }

  .message.system .msg-body {
    max-width: 100%;
  }
}
</style>
