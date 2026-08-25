<script setup lang="ts">
/**
 * Apps — the enterprise app catalog from the prototype's app screen
 * (prototype `ProjectsScreen`), including its two sub-states:
 *
 *  - clicking a card opens `ProjectDetail` (back header + CMS iframe),
 *  - "新建项目" opens `NewProjectPage` (two-step wizard: 基本信息 → 上传代码).
 *
 * Mock data on purpose: there is no apps API yet. The screen exists so the
 * navigation and layout can be reviewed against the design. Replace `APPS`
 * with a store call when the endpoint lands.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NModal } from 'naive-ui'
import KpPage from '@/components/kippies/KpPage.vue'
import KpIcon from '@/components/kippies/KpIcon.vue'
import KpAppIcon from '@/components/kippies/KpAppIcon.vue'
import KpBtn from '@/components/kippies/KpBtn.vue'
import KpIconBtn from '@/components/kippies/KpIconBtn.vue'
import KpSectionTitle from '@/components/kippies/KpSectionTitle.vue'
import FolderPicker from '@/components/hermes/chat/FolderPicker.vue'

// `embedded` lets Apps render inside the chat sidebar surface, which owns the
// viewport height. Default false keeps the standalone route unchanged.
const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })

const { t } = useI18n()

type AppEntry = {
  id: string
  icon?: string
  tone: string
  name: string
  desc: string
  owner: string
  tasks: number
  when: string
  workspace?: string
}

// Exactly the prototype ProjectsScreen dataset (icons, hues, copy and all) —
// this screen must read identical to the design until the real API lands.
const APPS = ref<AppEntry[]>([
  {
    id: 'pr1',
    icon: 'line_chart',
    tone: 'var(--hue-green)',
    name: '季度经营分析',
    desc: 'Q3 三地报表、退货率归因、管理层材料',
    owner: '陈可',
    tasks: 12,
    when: '刚刚',
  },
  {
    id: 'pr2',
    icon: 'line_content',
    tone: 'var(--hue-purple)',
    name: '供应商与合同',
    desc: '合同条款抽取、供应商对比、续签跟踪',
    owner: '王芳',
    tasks: 6,
    when: '今天 10:24',
  },
  {
    id: 'pr3',
    icon: 'line_drafts',
    tone: 'var(--hue-blue)',
    name: '个人草稿',
    desc: '临时任务与草稿，未归入具体项目',
    owner: '陈可',
    tasks: 3,
    when: '昨天',
  },
])

// ─── Detail (prototype ProjectDetail): back header + CMS iframe ─────────────
const openApp = ref<AppEntry | null>(null)

// ─── Create wizard (prototype NewProjectPage) ────────────────────────────────
// Select options and the mock creator are prototype data, like APPS above.
const TYPES = ['静态页面', '动态页面']
const LINES = ['产研', '市场', '销售', '财务', '法务', '人力']

const creating = ref(false)
const step = ref(0)
const formName = ref('')
const formPid = ref('')
const formType = ref('')
const formLines = ref<string[]>([])
const formDesc = ref('')
const formWorkspace = ref('')

const step1Valid = computed(
  () =>
    !!(formName.value.trim() && formPid.value.trim() && formType.value && formLines.value.length && formDesc.value.trim()),
)

function openCreate() {
  step.value = 0
  formName.value = ''
  formPid.value = ''
  formType.value = ''
  formLines.value = [LINES[0]]
  formDesc.value = ''
  formWorkspace.value = ''
  creating.value = true
}

function onPidInput(e: Event) {
  formPid.value = (e.target as HTMLInputElement).value.toLowerCase()
}

function addLine(e: Event) {
  const select = e.target as HTMLSelectElement
  const v = select.value
  if (v && !formLines.value.includes(v)) formLines.value = [...formLines.value, v]
  select.value = ''
}

function removeLine(line: string) {
  formLines.value = formLines.value.filter(l => l !== line)
}

function submitCreate() {
  APPS.value = [
    {
      id: `pr${Date.now()}`,
      tone: 'var(--hue-green)',
      name: formName.value.trim(),
      desc: formDesc.value.trim(),
      owner: '陈可',
      tasks: 0,
      when: '刚刚',
      workspace: formWorkspace.value || undefined,
    },
    ...APPS.value,
  ]
  creating.value = false
}

// Folder pick runs through the app's real FolderPicker in a modal (same
// pattern as the chat workspace modal) — the prototype mocks this tree.
const folderModalShow = ref(false)
const folderValue = ref<string | null>(null)

function openFolderModal() {
  folderValue.value = formWorkspace.value || null
  folderModalShow.value = true
}

function confirmFolder() {
  formWorkspace.value = folderValue.value || ''
  folderModalShow.value = false
}

function clearWorkspace(e: Event) {
  e.stopPropagation()
  formWorkspace.value = ''
}
</script>

<template>
  <!-- Prototype ProjectDetail: back header over a full-bleed CMS iframe. -->
  <div v-if="openApp" class="app-detail" :class="{ 'is-embedded': props.embedded }">
    <div class="app-detail__head">
      <KpIconBtn :title="t('apps.back')" @click="openApp = null">
        <KpIcon name="line_arrow_right" :size="16" style="transform: rotate(180deg)" />
      </KpIconBtn>
      <div class="app-detail__id">
        <div class="t-sub-medium app-detail__name">{{ openApp.name }}</div>
        <div class="t-meta app-detail__owner">{{ openApp.owner }}</div>
      </div>
    </div>
    <iframe
      class="app-detail__frame"
      src="https://ark.example.com/aidock-cms/admin/apps"
      :title="openApp.name"
    />
  </div>

  <!-- Prototype NewProjectPage: two-step wizard (基本信息 → 上传代码). -->
  <div v-else-if="creating" class="app-create" :class="{ 'is-embedded': props.embedded }">
    <div class="app-create__inner">
      <div class="app-create__head">
        <KpIconBtn :title="t('apps.back')" @click="creating = false">
          <KpIcon name="line_arrow_right" :size="17" style="transform: rotate(180deg)" />
        </KpIconBtn>
        <div>
          <div class="t-h4 app-create__title">{{ t('apps.createTitle') }}</div>
          <div class="t-meta app-create__sub">{{ t('apps.createSub') }}</div>
        </div>
      </div>

      <div class="app-create__steps">
        <template v-for="(s, i) in [
          { label: t('apps.stepBasic'), icon: 'line_info' },
          { label: t('apps.stepUpload'), icon: 'line_link' },
        ]" :key="s.label">
          <KpIcon v-if="i > 0" name="line_arrow_right" :size="13" color="var(--fg-disabled)" />
          <div class="app-create__step" :class="{ 'is-active': step === i }">
            <KpIcon :name="s.icon" :size="14" />
            <span>{{ s.label }}</span>
          </div>
        </template>
      </div>

      <div class="app-create__card">
        <div class="app-create__cardhead">
          <div class="t-sub-medium app-create__cardtitle">
            {{ step === 0 ? t('apps.stepBasic') : t('apps.stepUpload') }}
          </div>
          <div class="t-meta app-create__cardsub">
            {{ step === 0 ? t('apps.stepBasicSub') : t('apps.stepUploadSub') }}
          </div>
        </div>

        <div class="app-create__body">
          <template v-if="step === 0">
            <div>
              <div class="t-sub-medium app-create__label">
                {{ t('apps.fieldName') }}<span class="app-create__req"> *</span>
              </div>
              <input
                v-model="formName"
                class="app-create__field"
                :placeholder="t('apps.fieldNamePh')"
              />
            </div>
            <div>
              <div class="t-sub-medium app-create__label">
                {{ t('apps.fieldId') }}<span class="app-create__req"> *</span>
              </div>
              <input
                :value="formPid"
                class="app-create__field"
                :placeholder="t('apps.fieldIdPh')"
                @input="onPidInput"
              />
              <div class="t-meta app-create__hint">{{ t('apps.fieldIdHint') }}</div>
            </div>
            <div>
              <div class="t-sub-medium app-create__label">
                {{ t('apps.fieldType') }}<span class="app-create__req"> *</span>
              </div>
              <select v-model="formType" class="app-create__field app-create__select">
                <option value="">{{ t('apps.fieldTypePh') }}</option>
                <option v-for="ty in TYPES" :key="ty" :value="ty">{{ ty }}</option>
              </select>
            </div>
            <div>
              <div class="t-sub-medium app-create__label">
                {{ t('apps.fieldLines') }}<span class="app-create__req"> *</span>
              </div>
              <div v-if="formLines.length" class="app-create__lines">
                <span v-for="line in formLines" :key="line" class="app-create__line-chip">
                  {{ line }}
                  <span class="app-create__line-x" @click="removeLine(line)">
                    <KpIcon name="line_close" :size="11" />
                  </span>
                </span>
              </div>
              <select value="" class="app-create__field app-create__select" @change="addLine">
                <option value="">{{ t('apps.fieldLinesPh') }}</option>
                <option v-for="line in LINES.filter(l => !formLines.includes(l))" :key="line" :value="line">
                  {{ line }}
                </option>
              </select>
            </div>
            <div>
              <div class="t-sub-medium app-create__label">
                {{ t('apps.fieldDesc') }}<span class="app-create__req"> *</span>
              </div>
              <textarea
                v-model="formDesc"
                class="app-create__field app-create__textarea"
                :placeholder="t('apps.fieldDescPh')"
              />
            </div>
          </template>
          <div v-else>
            <div class="t-sub-medium app-create__label">{{ t('apps.fieldCode') }}</div>
            <button type="button" class="ab app-create__folder" @click="openFolderModal">
              <KpIcon name="full_link" :size="14" color="var(--fg-disabled)" />
              <span class="app-create__folder-text" :class="{ 'is-set': formWorkspace }">
                {{ formWorkspace || t('apps.pickFolder') }}
              </span>
              <span v-if="formWorkspace" class="app-create__folder-x" @click="clearWorkspace">
                <KpIcon name="line_close" :size="12" color="var(--fg-disabled)" />
              </span>
            </button>
          </div>
        </div>

        <div class="app-create__divider" />

        <div class="app-create__foot">
          <KpBtn kind="line" size="m" :style="{ borderRadius: '8px' }" @click="creating = false">
            {{ t('common.cancel') }}
          </KpBtn>
          <KpBtn
            v-if="step === 0"
            kind="primary"
            size="m"
            icon-end="line_arrow_right"
            :disabled="!step1Valid"
            @click="step1Valid && (step = 1)"
          >
            {{ t('apps.next') }}
          </KpBtn>
          <div v-else class="app-create__foot-group">
            <KpBtn kind="ghost" size="m" @click="step = 0">{{ t('apps.prev') }}</KpBtn>
            <KpBtn kind="primary" size="m" icon="line_check" @click="submitCreate">
              {{ t('apps.createSubmit') }}
            </KpBtn>
          </div>
        </div>
      </div>
    </div>

    <NModal
      v-model:show="folderModalShow"
      preset="dialog"
      :title="t('apps.pickFolder')"
      :positive-text="t('common.ok')"
      :negative-text="t('common.cancel')"
      style="width: 520px"
      @positive-click="confirmFolder"
    >
      <FolderPicker v-model="folderValue" />
    </NModal>
  </div>

  <KpPage
    v-else
    wide
    :class="{ 'is-embedded': props.embedded }"
    :title="t('apps.title')"
    :sub="t('apps.subCount', { n: APPS.length })"
  >
    <template #right>
      <KpBtn kind="dark" icon="full_add" @click="openCreate">{{ t('apps.create') }}</KpBtn>
    </template>

    <KpSectionTitle>{{ t('apps.all') }}</KpSectionTitle>

    <!-- Catalog cards (prototype ProjectsScreen): a card grid, not a row list. -->
    <div class="apps-grid">
      <div v-for="a in APPS" :key="a.id" class="apps-card catrow" @click="openApp = a">
        <div class="apps-card__head">
          <KpAppIcon :icon="a.icon" :mark="a.name[0]" :color="a.tone" :size="40" />
          <div class="apps-card__title">
            <div class="apps-card__name">{{ a.name }}</div>
          </div>
        </div>
        <p class="apps-card__desc">{{ a.desc }}</p>
        <!-- Prototype card floor: who owns it on the left, how much it has run
             on the right — the owner reads as the card's byline, not a subtitle
             under the name. -->
        <div class="apps-card__foot">
          <KpIcon name="full_star_ai" :size="14" color="var(--hue-blue)" />
          <span class="apps-card__owner">{{ a.owner }}</span>
          <span class="apps-card__spacer" />
          <span class="t-meta apps-card__stats">
            {{ t('apps.taskCount', { n: a.tasks }) }} · {{ a.when }}
          </span>
        </div>
      </div>
    </div>
  </KpPage>
</template>

<style scoped lang="scss">
// ─── Detail (prototype ProjectDetail) ────────────────────────────────────────
.app-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.app-detail__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 24px;
  border-bottom: 0.5px solid var(--divider);
}

.app-detail__id {
  min-width: 0;
}

.app-detail__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-detail__owner {
  margin-top: 2px;
}

.app-detail__frame {
  flex: 1;
  border: 0;
  width: 100%;
}

// ─── Create wizard (prototype NewProjectPage) ────────────────────────────────
.app-create {
  flex: 1;
  overflow: auto;
  padding: 28px 40px 56px;
}

.app-create__inner {
  max-width: 720px;
  margin: 0 auto;
}

.app-create__head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}

.app-create__title {
  color: var(--fg-title);
}

.app-create__sub {
  margin-top: 2px;
}

.app-create__steps {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 20px;
}

.app-create__step {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 12px;
  border-radius: var(--r-pill);
  background: var(--gray-f7);
  color: var(--fg-aux);
  font: var(--w-medium) var(--t-13) / var(--lh-1) var(--font-cn);

  &.is-active {
    background: var(--action);
    color: var(--action-fg);
  }
}

.app-create__card {
  background: var(--bg);
  border-radius: var(--r-card);
  box-shadow: inset 0 0 0 0.5px var(--divider);
}

.app-create__cardhead {
  padding: 20px 24px 4px;
}

.app-create__cardtitle {
  font-size: 16px;
}

.app-create__cardsub {
  margin-top: 4px;
}

.app-create__body {
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.app-create__label {
  margin-bottom: 8px;
}

.app-create__req {
  color: var(--danger);
}

.app-create__field {
  width: 100%;
  height: 40px;
  border: 0;
  outline: none;
  border-radius: 8px;
  background: var(--surface-2);
  padding: 10px 12px;
  font: var(--w-regular) var(--t-14) / 1.6 var(--font-cn);
  color: var(--fg-primary);
  box-sizing: border-box;

  &::placeholder {
    color: var(--fg-aux);
  }
}

.app-create__select {
  appearance: none;
  cursor: pointer;
}

.app-create__textarea {
  height: 96px;
  resize: none;
}

.app-create__hint {
  margin-top: 6px;
  color: var(--fg-disabled);
}

.app-create__lines {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.app-create__line-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 4px 0 8px;
  border-radius: var(--r-pill);
  background: var(--keep-green-bg);
  color: #0a9c67;
  font: var(--w-medium) var(--t-12) / var(--lh-1) var(--font-cn);
}

.app-create__line-x {
  display: inline-flex;
  cursor: pointer;
  padding: 2px;
}

.app-create__folder {
  width: 100%;
  height: 40px;
  border: 0;
  border-radius: 8px;
  background: var(--surface-2);
  padding: 0 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font: var(--w-regular) var(--t-14) / var(--lh-1) var(--font-cn);
}

.app-create__folder-text {
  flex: 1;
  text-align: left;
  color: var(--fg-aux);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &.is-set {
    color: var(--fg-primary);
  }
}

.app-create__folder-x {
  display: inline-flex;
}

.app-create__divider {
  height: 1px;
  background: var(--divider);
}

.app-create__foot {
  display: flex;
  gap: 8px;
  padding: 20px;
  justify-content: space-between;
}

.app-create__foot-group {
  display: flex;
  gap: 8px;
}

// ─── Catalog ─────────────────────────────────────────────────────────────────
// Catalog cards (prototype ItemCard inside CatalogGroup cols=2): exactly two
// columns on a 40px gutter, no row gap, flush under the section rule.
.apps-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 40px;

  @media (max-width: 768px) {
    grid-template-columns: minmax(0, 1fr);
  }
}

.apps-card {
  display: flex;
  flex-direction: column;
  padding: 20px;
  border-radius: var(--r-card);
  box-shadow: inset 0 0 0 0.5px var(--divider);
  cursor: pointer;
  transition: background var(--motion-base) var(--ease-std);
  margin-bottom: 12px;

  &:hover {
    background: var(--gray-fa);
  }
}

.apps-card__head {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
}

.apps-card__title {
  min-width: 0;
  flex: 1;
}

.apps-card__name {
  font: var(--w-medium) var(--t-16) / 1.6 var(--font-cn);
  color: var(--fg-title);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.apps-card__owner {
  font: var(--w-medium) var(--t-13) / var(--lh-1) var(--font-cn);
  color: var(--fg-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.apps-card__desc {
  flex: 1;
  font: var(--w-regular) var(--t-13) / 1.6 var(--font-cn);
  color: var(--fg-secondary);
  margin: 0 0 16px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.apps-card__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--fg-aux);
}

.apps-card__spacer {
  flex: 1;
}

.apps-card__stats {
  color: var(--fg-disabled);
  white-space: nowrap;
}
</style>
