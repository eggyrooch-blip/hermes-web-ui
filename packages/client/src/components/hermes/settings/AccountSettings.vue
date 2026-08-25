<script setup lang="ts">
import { ref, onMounted } from "vue";
import { NButton, NInput, NModal, NForm, NFormItem, NPopconfirm } from "naive-ui";
import { useI18n } from "vue-i18n";
import { changePassword, changeUsername, fetchCurrentUser, fetchLockedIps, unlockSpecificIp, unlockAllIps, fetchMyAvatar, updateMyAvatar, resetMyAvatar } from "@/api/auth";
import type { LockedIp, UserAvatar } from "@/api/auth";
import ProfileAvatar from "@/components/hermes/profiles/ProfileAvatar.vue";
import multiavatar from "@multiavatar/multiavatar";
import KpSectionTitle from "@/components/kippies/KpSectionTitle.vue";

const { t } = useI18n();

const username = ref<string | null>(null);
const loading = ref(false);

// User avatar
const avatar = ref<UserAvatar | null>(null);
const avatarFileInput = ref<HTMLInputElement | null>(null);
const avatarSaving = ref(false);
/**
 * Three resident carriers, each next to what it is about.
 *
 * All the successes here are visible without being told: the avatar picture
 * changes, the dialog closes, the unlocked row leaves the list. Failures and
 * validation are what needs saying — and validation in particular has no
 * business in a toast, since the field it refers to is right there and a timed
 * message can expire before it is read.
 *
 * `credentialError` is shared by the password and username dialogs because only
 * one of them is ever open.
 */
const avatarError = ref('');
const credentialError = ref('');
const locksError = ref('');

function compressImage(file: File, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        const tryCompress = (quality: number) => {
          const result = canvas.toDataURL('image/jpeg', quality)
          if (result.length <= maxBytes || quality <= 0.3) resolve(result)
          else tryCompress(quality - 0.1)
        }
        tryCompress(0.8)
      }
      img.onerror = reject
      img.src = reader.result as string
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function handleAvatarUpload(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    avatarError.value = t('settings.userAvatar.invalidType')
    target.value = ''
    return
  }
  if (file.size > 1024 * 1024) {
    avatarError.value = t('settings.userAvatar.tooLarge')
    target.value = ''
    return
  }
  avatarSaving.value = true
  avatarError.value = ''
  try {
    let dataUrl: string
    if (file.size > 500 * 1024) {
      dataUrl = await compressImage(file, 500 * 1024)
    } else {
      dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(r.result as string)
        r.onerror = reject
        r.readAsDataURL(file)
      })
    }
    await updateMyAvatar({ type: 'image', dataUrl })
    // The picture on screen changing is the report.
    avatar.value = { type: 'image', dataUrl }
  } catch (err: any) {
    avatarError.value = err.message || t('settings.userAvatar.saveFailed')
  } finally {
    avatarSaving.value = false
    target.value = ''
  }
}

async function handleRandomAvatar() {
  avatarSaving.value = true
  avatarError.value = ''
  try {
    const randomPart = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
    const seed = `${username.value || 'default'}-${Date.now()}-${randomPart}`
    const svg = multiavatar(seed)
    const dataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
    await updateMyAvatar({ type: 'image', dataUrl, seed })
    avatar.value = { type: 'image', dataUrl, seed }
  } catch (err: any) {
    avatarError.value = err.message || t('settings.userAvatar.saveFailed')
  } finally {
    avatarSaving.value = false
  }
}

async function handleResetAvatar() {
  avatarSaving.value = true
  avatarError.value = ''
  try {
    await resetMyAvatar()
    avatar.value = { type: 'default', seed: username.value || 'default' }
  } catch (err: any) {
    avatarError.value = err.message || t('settings.userAvatar.resetFailed')
  } finally {
    avatarSaving.value = false
  }
}

// Change password form
const showChangePasswordModal = ref(false);
const currentPasswordForPwd = ref("");
const newPasswordVal = ref("");
const newPasswordConfirm = ref("");

// Change username form
const showChangeUsernameModal = ref(false);
const currentPasswordForName = ref("");
const newUsernameVal = ref("");

onMounted(async () => {
  try {
    const user = await fetchCurrentUser();
    username.value = user.username;
  } catch { /* ignore */ }
  try {
    const av = await fetchMyAvatar();
    avatar.value = av || { type: 'default', seed: username.value || 'default' };
  } catch { /* ignore */ }
});

async function handleChangePassword() {
  if (newPasswordVal.value !== newPasswordConfirm.value) {
    credentialError.value = t("login.passwordMismatch");
    return;
  }
  if (newPasswordVal.value.length < 6) {
    credentialError.value = t("login.passwordTooShort");
    return;
  }
  loading.value = true;
  credentialError.value = "";
  try {
    await changePassword(currentPasswordForPwd.value, newPasswordVal.value);
    showChangePasswordModal.value = false;
    currentPasswordForPwd.value = "";
    newPasswordVal.value = "";
    newPasswordConfirm.value = "";
    // The dialog closing is the report.
  } catch (err: any) {
    credentialError.value = err.message || t("common.saveFailed");
  } finally {
    loading.value = false;
  }
}

async function handleChangeUsername() {
  if (newUsernameVal.value.trim().length < 2) {
    credentialError.value = t("login.usernameTooShort");
    return;
  }
  loading.value = true;
  credentialError.value = "";
  try {
    await changeUsername(currentPasswordForName.value, newUsernameVal.value.trim());
    username.value = newUsernameVal.value.trim();
    showChangeUsernameModal.value = false;
    currentPasswordForName.value = "";
    newUsernameVal.value = "";
  } catch (err: any) {
    credentialError.value = err.message || t("common.saveFailed");
  } finally {
    loading.value = false;
  }
}

function openChangePasswordModal() {
  credentialError.value = "";
  currentPasswordForPwd.value = "";
  newPasswordVal.value = "";
  newPasswordConfirm.value = "";
  showChangePasswordModal.value = true;
}

function openChangeUsernameModal() {
  credentialError.value = "";
  currentPasswordForName.value = "";
  newUsernameVal.value = "";
  showChangeUsernameModal.value = true;
}

// Locked IPs management
const lockedIps = ref<LockedIp[]>([]);
const loadingLocks = ref(false);

async function loadLockedIps() {
  loadingLocks.value = true;
  try {
    lockedIps.value = await fetchLockedIps();
  } catch { /* ignore */ }
  finally {
    loadingLocks.value = false;
  }
}

async function handleUnlockIp(ip: string) {
  try {
    locksError.value = "";
    await unlockSpecificIp(ip);
    // The row leaving the list is the report.
    await loadLockedIps();
  } catch (err: any) {
    locksError.value = err.message || t("common.saveFailed");
  }
}

async function handleUnlockAll() {
  try {
    locksError.value = "";
    await unlockAllIps();
    // The list emptying is the report.
    await loadLockedIps();
  } catch (err: any) {
    locksError.value = err.message || t("common.saveFailed");
  }
}

function formatTime(ts: number): string {
  const remaining = Math.max(0, Math.round((ts - Date.now()) / 60000));
  return remaining > 0 ? `${remaining} min` : t("common.expired");
}

function lockedIpTypeLabel(type: LockedIp["type"]): string {
  return t(`settings.lockedIps.type.${type}`);
}

onMounted(() => { loadLockedIps(); });
</script>

<template>
  <div class="account-settings">
    <!-- User Avatar -->
    <div class="avatar-section">
      <KpSectionTitle>{{ t('settings.userAvatar.title') }}</KpSectionTitle>
      <p v-if="avatarError" class="settings-error" data-testid="avatar-error">{{ avatarError }}</p>
      <div class="avatar-row">
        <div class="avatar-display">
          <ProfileAvatar
            :name="username || 'default'"
            :avatar="avatar?.type === 'image' && avatar.dataUrl ? { type: 'image', dataUrl: avatar.dataUrl } : null"
            :size="80"
          />
        </div>
        <div class="avatar-actions">
          <p class="avatar-hint">{{ t('settings.userAvatar.hint') }}</p>
          <div class="action-buttons">
            <NButton @click="avatarFileInput?.click()">{{ t('settings.userAvatar.upload') }}</NButton>
            <NButton @click="handleRandomAvatar" :loading="avatarSaving">{{ t('settings.userAvatar.random') }}</NButton>
            <NButton @click="handleResetAvatar" :loading="avatarSaving">{{ t('settings.userAvatar.reset') }}</NButton>
          </div>
          <input
            ref="avatarFileInput"
            type="file"
            accept=".png,.jpg,.jpeg,.webp"
            style="display: none"
            @change="handleAvatarUpload"
          />
        </div>
      </div>
    </div>

    <div class="configured-section">
      <KpSectionTitle :note="t('login.setupDescription')">{{ t('settings.account.sectionCredentials') }}</KpSectionTitle>
      <!-- Prototype Row anatomy: t-sub-medium title left, GhostBtn actions right. -->
      <div class="setting-row catrow">
        <span class="row-title">{{ t("login.passwordLoginConfigured", { username }) }}</span>
        <div class="action-buttons">
          <NButton @click="openChangePasswordModal">{{ t("login.changePassword") }}</NButton>
          <NButton @click="openChangeUsernameModal">{{ t("login.changeUsername") }}</NButton>
        </div>
      </div>
    </div>

    <!-- Locked IPs management -->
    <div class="locked-ips-section">
      <KpSectionTitle :note="t('settings.lockedIps.count', { count: lockedIps.length })">
        {{ t("settings.lockedIps.title") }}
        <template #action>
          <div class="action-buttons">
            <NButton size="small" :loading="loadingLocks" @click="loadLockedIps">{{ t("common.retry") }}</NButton>
            <NPopconfirm v-if="lockedIps.length > 0" @positive-click="handleUnlockAll">
              <template #trigger>
                <NButton size="small" type="warning">{{ t("settings.lockedIps.unlockAll") }}</NButton>
              </template>
              {{ t("settings.lockedIps.unlockAllConfirm") }}
            </NPopconfirm>
          </div>
        </template>
      </KpSectionTitle>
      <p v-if="locksError" class="settings-error" data-testid="locks-error">{{ locksError }}</p>
      <div v-if="lockedIps.length > 0" class="locked-list">
        <!-- Rows, not bordered cards — sections are delimited by the title rule alone. -->
        <div v-for="lock in lockedIps" :key="lock.ip + lock.type" class="setting-row catrow">
          <div class="locked-info">
            <span class="locked-ip">{{ lock.ip }}</span>
            <span class="locked-badge">{{ lockedIpTypeLabel(lock.type) }}</span>
            <span class="locked-ttl">{{ formatTime(lock.lockedUntil) }}</span>
          </div>
          <NButton size="tiny" type="error" ghost @click="handleUnlockIp(lock.ip)">{{ t("settings.lockedIps.unlock") }}</NButton>
        </div>
      </div>
      <p v-else class="empty-hint">{{ t("settings.lockedIps.empty") }}</p>
    </div>

    <!-- Change password modal -->
    <NModal v-model:show="showChangePasswordModal" preset="dialog" :title="t('login.changePassword')">
      <p v-if="credentialError" class="settings-error" data-testid="credential-error">{{ credentialError }}</p>
      <NForm label-placement="top">
        <NFormItem :label="t('login.currentPassword')">
          <NInput v-model:value="currentPasswordForPwd" type="password" show-password-on="click" :placeholder="t('login.currentPassword')" />
        </NFormItem>
        <NFormItem :label="t('login.newPassword')">
          <NInput v-model:value="newPasswordVal" type="password" show-password-on="click" :placeholder="t('login.newPassword')" />
        </NFormItem>
        <NFormItem :label="t('login.confirmPassword')">
          <NInput v-model:value="newPasswordConfirm" type="password" show-password-on="click" :placeholder="t('login.confirmPassword')" @keyup.enter="handleChangePassword" />
        </NFormItem>
      </NForm>
      <template #action>
        <NButton @click="showChangePasswordModal = false">{{ t("common.cancel") }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleChangePassword">{{ t("common.save") }}</NButton>
      </template>
    </NModal>

    <!-- Change username modal -->
    <NModal v-model:show="showChangeUsernameModal" preset="dialog" :title="t('login.changeUsername')">
      <p v-if="credentialError" class="settings-error" data-testid="credential-error">{{ credentialError }}</p>
      <NForm label-placement="top">
        <NFormItem :label="t('login.currentPassword')">
          <NInput v-model:value="currentPasswordForName" type="password" show-password-on="click" :placeholder="t('login.currentPassword')" />
        </NFormItem>
        <NFormItem :label="t('login.newUsername')">
          <NInput v-model:value="newUsernameVal" :placeholder="t('login.usernamePlaceholder')" @keyup.enter="handleChangeUsername" />
        </NFormItem>
      </NForm>
      <template #action>
        <NButton @click="showChangeUsernameModal = false">{{ t("common.cancel") }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleChangeUsername">{{ t("common.save") }}</NButton>
      </template>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;
.settings-error {
  margin: 0 0 12px;
  padding: 12px;
  border-radius: var(--r-ctl);
  background: var(--danger-bg);
  color: var(--danger);
  font: var(--w-regular) var(--t-13) / var(--lh-multi) var(--font-cn);
}


.account-settings {
  padding: 0;
}

// Prototype Row: 12px padding pulled back out with -12 margins so the hover
// tint bleeds while content stays aligned with the section title above.
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 12px;
  margin: 0 -12px;
  border-radius: var(--r-ctl);
  transition: background var(--motion-fast) var(--ease-std);
}

.row-title {
  font: var(--w-medium) var(--t-14) / var(--lh-tight) var(--font-cn);
  color: var(--fg-primary);
}

.action-buttons {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.locked-ips-section {
  margin-top: 36px;
}

.locked-list {
  display: flex;
  flex-direction: column;
}

.locked-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.locked-ip {
  font-family: $font-code;
  font-size: 13px;
  color: $text-primary;
}

// Prototype list tag: 22px neutral pill on surface-3.
.locked-badge {
  height: 22px;
  padding: 0 8px;
  border-radius: var(--r-pill);
  background: var(--gray-f2);
  font: var(--w-medium) var(--t-12) / 22px var(--font-cn);
  color: var(--fg-secondary);
}

.locked-ttl {
  font-size: 12px;
  color: $text-muted;
}

.empty-hint {
  font: var(--w-regular) var(--t-12) / var(--lh-1) var(--font-cn);
  color: var(--fg-disabled);
  margin: 0;
  padding: 12px 0;
}

.avatar-section {
  margin-bottom: 36px;
}

.configured-section {
  margin-bottom: 36px;
}

.avatar-row {
  display: flex;
  align-items: center;
  gap: 24px;
}

.avatar-display {
  flex-shrink: 0;
}

.avatar-actions {
  flex: 1;
}

.avatar-hint {
  font-size: 12px;
  color: $text-muted;
  margin: 0 0 12px;
}
</style>
