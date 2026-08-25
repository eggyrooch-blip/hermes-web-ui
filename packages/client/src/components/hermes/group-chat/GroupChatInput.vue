<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NTooltip } from 'naive-ui'
import KpIcon from '@/components/kippies/KpIcon.vue'
import ComposerBox from '@/components/hermes/chat/ComposerBox.vue'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import { buildMentionOptions, type MentionOption } from './mention-options'
import type { Attachment } from '@/stores/hermes/chat'
import { CHAT_INPUT_HEIGHT_MOBILE_QUERY, chatInputHeightStyle, clampChatInputHeight } from '@/utils/chat-input-height'

const { t } = useI18n()
const emit = defineEmits<{ send: [content: string, attachments?: Attachment[]] }>()
const store = useGroupChatStore()
const settingsStore = useSettingsStore()

const inputText = ref('')
const inputWrapperRef = ref<HTMLDivElement>()
const textareaRef = ref<HTMLTextAreaElement>()
const dropdownRef = ref<HTMLDivElement>()
const fileInputRef = ref<HTMLInputElement>()
const attachments = ref<Attachment[]>([])
const isDragging = ref(false)
const dragCounter = ref(0)
const isComposing = ref(false)
// Auto-play voice is set in 设置 → 显示 (same localStorage key); the composer
// only has to hand the stored preference to the store on mount. It used to own
// an inline switch here, which is why the two composers had different tool rows.
onMounted(() => {
    const saved = localStorage.getItem('autoPlaySpeech')
    if (saved !== null) store.setAutoPlaySpeech(saved === 'true')
})

watch(() => settingsStore.display.chat_input_height, () => {
    textareaHeight.value = null
})

// 自定义高度拖拽
const textareaHeight = ref<number | null>(null)
const isMobileInput = ref(false)
let mobileInputQuery: MediaQueryList | null = null

// FIELD_INSET is the field section's own padding (20 above the caret, 20 of
// floor before the tool row). The wrapper is border-box with a fixed inline
// height, so the configured textarea height has to be grown by it — otherwise
// 设置 → 显示 says 56 and the visible field is 16. Same formula as ChatInput.
const FIELD_INSET = 40
const inputWrapperStyle = computed(() => {
    const style = chatInputHeightStyle(settingsStore.display.chat_input_height, textareaHeight.value, isMobileInput.value)
    if (style.height) {
        style.height = `${Number.parseInt(style.height, 10) + FIELD_INSET}px`
    }
    return style
})
const inputTextareaStyle = computed(() => (isMobileInput.value ? {} : { height: '100%' }))

function syncMobileInputState() {
    if (typeof window === 'undefined') return
    const nextIsMobile = mobileInputQuery?.matches ?? window.innerWidth <= 768
    isMobileInput.value = nextIsMobile
    if (nextIsMobile) textareaHeight.value = null
}

function startResize(e: MouseEvent) {
  e.preventDefault()
  if (isMobileInput.value) return
  const el = textareaRef.value
  if (!el) return
  // Measured off the wrapper, so the inset has to come back off or the first
  // drag jumps by FIELD_INSET.
  const startHeight = inputWrapperRef.value?.clientHeight
    ? inputWrapperRef.value.clientHeight - FIELD_INSET
    : el.clientHeight
  const startY = e.clientY

  function onMouseMove(e: MouseEvent) {
    const deltaY = e.clientY - startY
    const newHeight = startHeight - deltaY
    textareaHeight.value = clampChatInputHeight(newHeight)
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

// ─── Mention State ───────────────────────────────────────

const mentionActive = ref(false)
const mentionQuery = ref('')
const mentionStartIndex = ref(-1)
const dropdownX = ref(0)
const dropdownY = ref(0)
const dropdownBottom = ref(0)
const placement = ref<'bottom' | 'top'>('bottom')
const activeIndex = ref(0)

const filteredMentionOptions = computed(() => buildMentionOptions(store.agents, mentionQuery.value))

const canSend = computed(() => !!inputText.value.trim() || attachments.value.length > 0)

// ─── Scroll active item into view ──────────────────────

function scrollToActive() {
    nextTick(() => {
        if (!dropdownRef.value) return
        const active = dropdownRef.value.querySelector('.active') as HTMLElement | null
        if (active) active.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    })
}

// ─── Mention Logic ───────────────────────────────────────

function updateMentionState() {
    const el = textareaRef.value
    if (!el) { mentionActive.value = false; return }

    const text = inputText.value
    const cursorPos = el.selectionStart

    // Find the last @ before the cursor
    let atPos = -1
    for (let i = cursorPos - 1; i >= 0; i--) {
        if (text[i] === '@') { atPos = i; break }
        if (text[i] === ' ' || text[i] === '\n') break
    }

    if (atPos === -1) {
        mentionActive.value = false
        return
    }

    // Make sure the @ is not part of a word (e.g. an email address like a@b).
    // Test for a word character rather than for whitespace: CJK text, fullwidth
    // punctuation and emoji are all legitimate mention prefixes, and Chinese
    // input never types a space before @ (你好@ / 问题，@).
    if (atPos > 0 && /\w/.test(text[atPos - 1])) {
        mentionActive.value = false
        return
    }

    const query = text.slice(atPos + 1, cursorPos)
    if (query.includes(' ')) {
        mentionActive.value = false
        return
    }

    mentionQuery.value = query
    mentionStartIndex.value = atPos
    activeIndex.value = 0

    // Calculate dropdown position using mirror span
    const mirror = document.createElement('span')
    const style = getComputedStyle(el)
    const props = ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'textTransform', 'wordSpacing', 'textIndent', 'border', 'padding', 'boxSizing', 'lineHeight']
    props.forEach(p => { (mirror.style as any)[p] = style[p as any] })
    mirror.style.position = 'absolute'
    mirror.style.visibility = 'hidden'
    mirror.style.whiteSpace = 'nowrap'
    mirror.textContent = text.slice(0, atPos + 1)

    const rect = el.getBoundingClientRect()
    document.body.appendChild(mirror)
    const mirrorRect = mirror.getBoundingClientRect()
    document.body.removeChild(mirror)

    dropdownX.value = rect.left + mirrorRect.width - el.scrollLeft

    // Decide placement: if dropdown would go below viewport, flip upward
    const estimatedHeight = Math.min(filteredMentionOptions.value.length * 36 + 8, 240)
    const spaceBelow = window.innerHeight - rect.top + el.scrollTop - 8
    if (spaceBelow < estimatedHeight && rect.top - el.scrollTop - 8 > estimatedHeight) {
        placement.value = 'top'
        dropdownY.value = rect.top - el.scrollTop - 8
    } else {
        placement.value = 'bottom'
        dropdownY.value = rect.top - el.scrollTop - 8
    }

    dropdownBottom.value = window.innerHeight - dropdownY.value

    mentionActive.value = filteredMentionOptions.value.length > 0
}

function selectMention(name: string) {
    const el = textareaRef.value
    if (!el || mentionStartIndex.value === -1) return

    const before = inputText.value.slice(0, mentionStartIndex.value)
    const after = inputText.value.slice(el.selectionStart)
    inputText.value = `${before}@${name} ${after}`
    mentionActive.value = false

    nextTick(() => {
        if (el) {
            const newPos = before.length + name.length + 2
            el.setSelectionRange(newPos, newPos)
            el.focus()
            if (textareaHeight.value === null && isMobileInput.value) {
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight, 100) + 'px'
            }
        }
    })
}

// ─── Event Handlers ──────────────────────────────────────

function handleKeydown(e: KeyboardEvent) {
    // Mention navigation — fully custom, no NDropdown interference
    if (mentionActive.value && filteredMentionOptions.value.length > 0) {
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            activeIndex.value = (activeIndex.value + 1) % filteredMentionOptions.value.length
            scrollToActive()
            return
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault()
            activeIndex.value = (activeIndex.value - 1 + filteredMentionOptions.value.length) % filteredMentionOptions.value.length
            scrollToActive()
            return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            selectMention(filteredMentionOptions.value[activeIndex.value].name)
            return
        }
        if (e.key === 'Escape') {
            e.preventDefault()
            mentionActive.value = false
            return
        }
    }

    if (e.key !== 'Enter' || e.shiftKey) return
    if (isComposing.value || e.isComposing || e.keyCode === 229) return
    e.preventDefault()
    handleSend()
}

function handleSend() {
    const content = inputText.value.trim()
    if (!content && attachments.value.length === 0) return

    emit('send', content, attachments.value.length > 0 ? attachments.value : undefined)
    inputText.value = ''
    attachments.value = []
    mentionActive.value = false
    // 发送后重置到自定义高度（不清除拖拽状态）
}

function handleInput(e: Event) {
    store.emitTyping()
    if (!isComposing.value) {
        updateMentionState()
    }

    // 用户手动拖拽自定义高度时，不覆盖
    if (textareaHeight.value !== null || !isMobileInput.value) return
    const el = e.target as HTMLTextAreaElement
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 100) + 'px'
}

function handleMentionClick(option: MentionOption) {
    selectMention(option.name)
}

function handleMentionHover(index: number) {
    activeIndex.value = index
}

// ─── Click outside to close dropdown ─────────────────

function onDocumentMousedown(e: MouseEvent) {
    if (!mentionActive.value) return
    const target = e.target as HTMLElement
    if (!target.closest('.mention-dropdown')) {
        mentionActive.value = false
    }
}

onMounted(() => {
    mobileInputQuery = window.matchMedia?.(CHAT_INPUT_HEIGHT_MOBILE_QUERY) ?? null
    syncMobileInputState()
    mobileInputQuery?.addEventListener?.('change', syncMobileInputState)
    document.addEventListener('mousedown', onDocumentMousedown)
})

onUnmounted(() => {
    mobileInputQuery?.removeEventListener?.('change', syncMobileInputState)
    mobileInputQuery = null
    document.removeEventListener('mousedown', onDocumentMousedown)
})

function handleCompositionStart() {
    isComposing.value = true
}

function handleCompositionEnd() {
    requestAnimationFrame(() => {
        isComposing.value = false
        updateMentionState()
    })
}

function addFile(file: File) {
    if (attachments.value.find(a => a.name === file.name)) return
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    attachments.value.push({
        id,
        name: file.name,
        type: file.type,
        size: file.size,
        url: URL.createObjectURL(file),
        file,
    })
}

function handleAttachClick() {
    fileInputRef.value?.click()
}

function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement
    if (!input.files) return
    for (const file of input.files) addFile(file)
    input.value = ''
}

function handlePaste(e: ClipboardEvent) {
    const items = Array.from(e.clipboardData?.items || [])
    const imageItems = items.filter(i => i.type.startsWith('image/'))
    if (!imageItems.length) return
    e.preventDefault()
    for (const item of imageItems) {
        const blob = item.getAsFile()
        if (!blob) continue
        const ext = item.type.split('/')[1] || 'png'
        addFile(new File([blob], `pasted-${Date.now()}.${ext}`, { type: item.type }))
    }
}

function handleDragOver(e: DragEvent) {
    e.preventDefault()
}

function handleDragEnter(e: DragEvent) {
    e.preventDefault()
    if (e.dataTransfer?.types.includes('Files')) {
        dragCounter.value++
        isDragging.value = true
    }
}

function handleDragLeave() {
    dragCounter.value--
    if (dragCounter.value <= 0) {
        dragCounter.value = 0
        isDragging.value = false
    }
}

function handleDrop(e: DragEvent) {
    e.preventDefault()
    dragCounter.value = 0
    isDragging.value = false
    for (const file of Array.from(e.dataTransfer?.files || [])) addFile(file)
    textareaRef.value?.focus()
}

function removeAttachment(id: string) {
    const idx = attachments.value.findIndex(a => a.id === id)
    if (idx !== -1) {
        URL.revokeObjectURL(attachments.value[idx].url)
        attachments.value.splice(idx, 1)
    }
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function isImage(type: string): boolean {
    return type.startsWith('image/')
}
</script>

<template>
    <!-- Same box component as the main composer: frame, section order and insets
         all live in ComposerBox. No `run` — group chat has no home state, so its
         composer is always the primary one and takes the plain box. -->
    <ComposerBox>

        <!-- Tool row, same anatomy as the main composer: attach alone on the far
             left, a spacer, then the send circle on the right. The auto-play and
             tool-trace toggles that used to sit here are gone for the same reason
             ChatInput dropped them — both live in 设置 → 显示 (DisplaySettings),
             on the same localStorage key and the same composable, so nothing is
             lost and the two composers no longer carry different tool rows. -->
        <div class="input-top-bar">
            <NTooltip trigger="hover">
                <template #trigger>
                    <NButton class="attach-button" quaternary size="tiny" circle @click="handleAttachClick">
                        <template #icon>
                            <!-- Prototype AddMenu is a plus, not a paperclip. -->
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        </template>
                    </NButton>
                </template>
                {{ t('chat.attachFiles') }}
            </NTooltip>

            <span class="tool-row-spacer" />

            <div class="input-actions">
                <!-- Same 32px icon-only circle as the main composer, with the
                     Keep glyph rather than a hand-drawn plane. -->
                <NButton
                    class="send-button"
                    size="small"
                    type="primary"
                    circle
                    :disabled="!canSend"
                    :aria-label="t('chat.send')"
                    :title="t('chat.send')"
                    @click="handleSend"
                >
                    <template #icon>
                        <KpIcon name="full_send" :size="16" />
                    </template>
                </NButton>
            </div>
        </div>
        <div v-if="attachments.length > 0" class="attachment-previews">
            <div v-for="att in attachments" :key="att.id" class="attachment-preview" :class="{ image: isImage(att.type) }">
                <img v-if="isImage(att.type)" :src="att.url" :alt="att.name" class="attachment-thumb" />
                <div v-else class="attachment-file">
                    <span class="file-name">{{ att.name }}</span>
                    <span class="file-size">{{ formatSize(att.size) }}</span>
                </div>
                <button class="attachment-remove" @click="removeAttachment(att.id)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
        </div>
        <div
            ref="inputWrapperRef"
            class="input-wrapper"
            :class="{ 'drag-over': isDragging }"
            :style="inputWrapperStyle"
            @dragover="handleDragOver"
            @dragenter="handleDragEnter"
            @dragleave="handleDragLeave"
            @drop="handleDrop"
        >
            <input ref="fileInputRef" type="file" multiple class="file-input-hidden" @change="handleFileChange" />
            <div class="resize-handle" @mousedown="startResize"></div>
            <textarea
                ref="textareaRef"
                v-model="inputText"
                class="input-textarea"
                :style="inputTextareaStyle"
                :placeholder="t('groupChat.inputPlaceholder')"
                rows="1"
                @keydown="handleKeydown"
                @compositionstart="handleCompositionStart"
                @compositionend="handleCompositionEnd"
                @input="handleInput"
                @paste="handlePaste"
            />
            <!-- Send does NOT live in the field: like the main composer, it sits
                 in the tool row above, so the field is only the caret. -->
        </div>
        <Transition name="dropdown-fade">
            <div
                v-if="mentionActive && filteredMentionOptions.length > 0"
                ref="dropdownRef"
                class="mention-dropdown"
                :class="{ 'placement-top': placement === 'top' }"
                :style="{
                    left: dropdownX + 'px',
                    top: placement === 'bottom' ? dropdownY + 'px' : 'auto',
                    bottom: placement === 'top' ? dropdownBottom + 'px' : 'auto',
                }"
            >
                <div
                    v-for="(option, i) in filteredMentionOptions"
                    :key="option.key"
                    class="mention-dropdown-item"
                    :class="{ active: i === activeIndex, 'mention-all-option': option.type === 'all' }"
                    @mousedown.prevent="handleMentionClick(option)"
                    @mouseenter="handleMentionHover(i)"
                >
                    <span class="mention-name">{{ option.label }}</span>
                    <span class="mention-profile">{{ option.description }}</span>
                </div>
            </div>
        </Transition>
    </ComposerBox>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

// Box, section order and insets come from ComposerBox (shared with ChatInput).
// Only the contents of the sections are styled here.


// Attach is a 32px ghost circle, same weight as every other tool-row control.
.attach-button {
    flex-shrink: 0;
    width: 32px !important;
    height: 32px !important;
}

// Pushes send to the right edge, leaving attach alone on the left.
.tool-row-spacer {
    flex: 1 1 auto;
    min-width: 0;
}

.attachment-previews {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.attachment-preview {
    position: relative;
    border-radius: $radius-sm;
    overflow: hidden;
    background-color: $bg-secondary;
    border: 1px solid $border-color;

    &.image {
        width: 64px;
        height: 64px;
    }
}

.attachment-thumb {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.attachment-file {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 8px 12px;
    min-width: 80px;
    max-width: 140px;
    color: $text-secondary;

    .file-name {
        font-size: 11px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
    }

    .file-size {
        font-size: 10px;
        color: $text-muted;
    }
}

.attachment-remove {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: none;
    background: rgba(0, 0, 0, 0.5);
    color: var(--text-on-overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    transition: opacity $transition-fast;

    .attachment-preview:hover & {
        opacity: 1;
    }
}

.file-input-hidden {
    display: none;
}

.typing-dots {
    display: inline-flex;
    align-items: center;
    gap: 2px;

    span {
        display: block;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background-color: $text-muted;
        animation: typing-bounce 1.2s infinite;

        &:nth-child(2) { animation-delay: 0.2s; }
        &:nth-child(3) { animation-delay: 0.4s; }
    }
}

@keyframes typing-bounce {
    0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
    30% { transform: translateY(-3px); opacity: 1; }
}

.input-wrapper {
    display: flex;
    align-items: flex-end;
    gap: 10px;
}

.resize-handle {
    position: absolute;
    top: -4px;
    left: 0;
    right: 0;
    height: 8px;
    cursor: row-resize;
    z-index: 2;

    &:hover {
        background: rgba($accent-primary, 0.15);
        border-radius: 4px;
    }
}

.input-textarea {
    flex: 1;
    box-sizing: border-box;
    background: none;
    border: none;
    outline: none;
    color: $text-primary;
    font-family: $font-ui;
    // Same field type as the main composer: 16/1.6, not 14/1.5.
    font-size: 16px;
    line-height: 1.6;
    resize: none;
    max-height: 400px;
    min-height: 20px;
    overflow-y: auto;

    @media (max-width: 768px) {
        font-size: 16px;
    }

    &::placeholder {
        color: $text-muted;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
}

.input-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
    align-items: center;
}

// Compact round send (prototype: 32x32 pill), same rules as ChatInput's:
// `canSend` drives the ground via :disabled — empty reads as the disabled look
// (transparent ground, muted glyph), with content it fills with `--gray-33`, the
// same ground as every other main button. See ChatInput's `.send-button` for why
// it is neither green (green is the status colour) nor purple (purple is
// selection), and for why the §9.1 hover/press overlay is written out rather
// than borrowed from the global `.ab` class.
.send-button {
    width: 32px !important;
    height: 32px !important;
    min-width: 32px !important;
    border-radius: 9999px !important;
    background-color: var(--gray-33) !important;
    color: #fff !important;
    transition: background-color var(--motion-fast) var(--ease-std),
        color var(--motion-fast) var(--ease-std);

    :deep(.n-button__border),
    :deep(.n-button__state-border) {
        display: none;
    }

    &::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        pointer-events: none;
        background: #000;
        opacity: 0;
        transition: opacity 90ms var(--ease-std);
    }

    // The glyph has to outrank the overlay, or pressing the key hides the icon.
    :deep(.n-button__content) {
        position: relative;
        z-index: 1;
    }

    &:hover::after { opacity: 0.08; }
    &:active::after { opacity: 0.2; }

    &:disabled {
        background-color: transparent !important;
        color: var(--fg-disabled) !important;
        opacity: 1 !important;

        &::after { opacity: 0 !important; }
    }

    .dark &,
    [data-theme='dark'] & {
        &::after { background: #fff; }
        &:hover::after { opacity: 0.1; }
        &:active::after { opacity: 0.22; }
    }
}

/* ── Custom mention dropdown (replaces NDropdown) ── */

.mention-dropdown {
    position: fixed;
    background: $bg-card;
    border: 1px solid $border-color;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    min-width: 200px;
    max-height: 240px;
    overflow-y: auto;
    z-index: 9999;
    padding: 4px;
}

.mention-dropdown-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.1s;

    &:hover,
    &.active {
        background: rgba(var(--text-primary-rgb), 0.08);
    }

    .mention-name {
        color: $text-primary;
        font-size: 14px;
        font-weight: 500;
    }

    .mention-profile {
        color: $text-muted;
        font-size: 12px;
    }

    &.mention-all-option .mention-name {
        color: $accent-primary;
        font-weight: 600;
    }
}

/* ── Dropdown fade/scale animation (matching NDropdown) ── */

.dropdown-fade-enter-active {
    transition: opacity 0.2s cubic-bezier(0, 0, .2, 1), transform 0.2s cubic-bezier(0, 0, .2, 1);
    transform-origin: top;
}
.dropdown-fade-leave-active {
    transition: opacity 0.2s cubic-bezier(.4, 0, 1, 1), transform 0.2s cubic-bezier(.4, 0, 1, 1);
    transform-origin: top;
}
.dropdown-fade-enter-from,
.dropdown-fade-leave-to {
    opacity: 0;
    transform: scale(0.9);
}
.placement-top.dropdown-fade-enter-active,
.placement-top.dropdown-fade-leave-active {
    transform-origin: bottom;
}
</style>
