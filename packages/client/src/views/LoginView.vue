<script lang="ts">
// api/client.ts routes every local-BFF 401 back to this view, so two 401s in
// quick succession can leave a stale mount's probe in flight. This counter must
// live in the plain <script> block — a `<script setup>` binding is re-created
// per instance, so a newer mount could never invalidate an older one's verdict
// and a late `false` would yank an already-recovered session into OAuth.
let probeGeneration = 0;

const SESSION_PROBE_TIMEOUT_MS = 4000;

function claimProbeGeneration(): () => boolean {
  const generation = ++probeGeneration;
  return () => generation === probeGeneration;
}
</script>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { takeSignedOutReason } from "@/composables/useSignedOutReason";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { setApiKey, hasApiKey, setRuntimeMode } from "@/api/client";
import { fetchAuthStatus, loginWithPassword } from "@/api/auth";

const { t } = useI18n();
const router = useRouter();

const username = ref("");
const password = ref("");
const loading = ref(false);
const errorMsg = ref("");
const showLockResetHint = ref(false);

// Auth mode: 'password' (upstream default) or 'feishu' (sunke: 飞书唯一登录).
// While checking, the password form stays hidden so it never flashes before a
// Feishu redirect.
const loginMethod = ref<"password" | "feishu">("password");
const authChecking = ref(true);

// If already has a key, try to go to main page
if (hasApiKey()) {
  router.replace("/hermes/chat");
}

function redirectToFeishu() {
  // Feishu OAuth is the only login entry. The server round-trips to Feishu
  // (instant auto-consent when the SSO session is live) and its callback sets
  // the hermes_feishu_session cookie + redirects to chat.
  window.location.assign("/api/auth/feishu/login");
}

/**
 * The hermes_feishu_session cookie is httpOnly, so the only way to know whether
 * this browser is already signed in is to ask the server. Without this check
 * every arrival at this view burned a full Feishu round-trip (never silent — it
 * renders the 授权 page) even when the 30-day cookie was perfectly valid:
 *   - the bare root URL `/` IS this view (public route, no session guard), so a
 *     bookmark without a hash re-authed on every single visit;
 *   - api/client.ts routes ANY local-BFF 401 to `{name:'login'}`, so one
 *     transient 401 logged the user out for real.
 * Both paths funnel through here, so one probe fixes both. Deliberately a raw
 * relative fetch rather than api/client's `request()`: that helper's global 401
 * handler redirects back to this same view.
 */
async function hasLiveFeishuSession(): Promise<boolean> {
  // A hung BFF must not strand the user on a blank login shell — an unanswered
  // probe has to time out into the OAuth fallback, same as a thrown one.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SESSION_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch("/api/auth/me", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: abort.signal,
    });
    return res.ok;
  } catch {
    // Network failure/abort tells us nothing about the session — fall through
    // to OAuth rather than stranding the user on a blank login page.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

onMounted(async () => {
  // Why the last session ended, if it ended on its own (401 / 403) rather than
  // by signing out. Read before the first await so a slow status probe cannot
  // swallow it, and read-once so it does not resurface on a later visit.
  errorMsg.value = takeSignedOutReason();
  // Claimed before the first await: a slow status request on an older mount
  // must not outlive a newer one and drag an already-recovered session to OAuth.
  const isCurrentProbe = claimProbeGeneration();
  try {
    const status = await fetchAuthStatus();
    if (!isCurrentProbe()) return;
    setRuntimeMode(status.authMode, status.plane);
    if (status.authMode === "trusted-feishu") {
      loginMethod.value = "feishu";
      router.replace("/hermes/chat");
      return;
    }
    if (status.authMode === "feishu-oauth-dev") {
      // Never render the password form in this mode.
      loginMethod.value = "feishu";
      const live = await hasLiveFeishuSession();
      if (!isCurrentProbe()) return;
      if (live) {
        router.replace("/hermes/chat");
        return;
      }
      redirectToFeishu();
      return;
    }
  } catch {
    // Login remains available; the submit request will surface connection errors.
  } finally {
    authChecking.value = false;
  }
});

async function handleLogin() {
  await handlePasswordLogin();
}

async function handlePasswordLogin() {
  if (!username.value.trim() || !password.value) {
    errorMsg.value = t("login.credentialsRequired");
    return;
  }

  loading.value = true;
  errorMsg.value = "";
  showLockResetHint.value = false;

  try {
    const sessionToken = await loginWithPassword(username.value.trim(), password.value);
    setApiKey(sessionToken);
    router.replace("/hermes/chat");
  } catch (err: any) {
    if (err.status === 429 || err.status === 503) {
      errorMsg.value = t("login.tooManyAttempts");
      showLockResetHint.value = true;
    } else {
      errorMsg.value = err.message || t("login.invalidCredentials");
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-view">
    <div class="login-card">
      <div class="login-logo">
        <img src="/logo.png" alt="Hermes" width="80" height="80" />
      </div>
      <h1 class="login-title">{{ t("login.title") }}</h1>
      <p class="login-desc">{{ t("login.description") }}</p>

      <!-- Feishu-only mode: show a waking state instead of the password form -->
      <div v-if="authChecking || loginMethod === 'feishu'" class="wake-state" role="status" aria-live="polite">
        <div class="wake-spinner" aria-hidden="true"></div>
      </div>

      <template v-else>
      <p class="login-default-hint">{{ t("login.defaultCredentialsHint") }}</p>

      <form class="login-form" @submit.prevent="handleLogin">
        <input
          v-model="username"
          type="text"
          class="login-input"
          :placeholder="t('login.usernamePlaceholder')"
          autofocus
        />
        <input
          v-model="password"
          type="password"
          class="login-input"
          :placeholder="t('login.passwordPlaceholder')"
          @keyup.enter="handleLogin"
        />

        <div v-if="errorMsg" class="login-error">{{ errorMsg }}</div>
        <div v-if="showLockResetHint" class="login-lock-hint">
          <span>{{ t("login.lockResetHint") }}</span>
          <code>hermes-web-ui clear-login-locks --restart</code>
          <span>{{ t("login.defaultLoginResetHint") }}</span>
          <code>hermes-web-ui reset-default-login</code>
        </div>
        <button type="submit" class="login-btn" :disabled="loading">
          {{ loading ? "..." : t("login.submit") }}
        </button>
      </form>
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.login-view {
  height: calc(100 * var(--vh));
  display: flex;
  align-items: center;
  justify-content: center;
  background: $bg-primary;
}

.login-card {
  width: 480px;
  max-width: calc(100vw - 32px);
  padding: 56px;
  border: 1px solid $border-color;
  border-radius: $radius-lg;
  background: $bg-card;
  text-align: center;

  @media (max-width: $breakpoint-mobile) {
    padding: 32px 24px;
  }
}

.login-logo {
  margin-bottom: 24px;
}

.login-title {
  font-size: 26px;
  font-weight: 600;
  color: $text-primary;
  margin: 0 0 10px;
}

.login-desc {
  font-size: 14px;
  color: $text-muted;
  margin: 0 0 12px;
  line-height: 1.6;
}

.login-default-hint {
  margin: 0 0 28px;
  font-family: $font-code;
  font-size: 13px;
  color: $text-secondary;
}

.wake-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 18px 0 8px;
}

.wake-spinner {
  width: 34px;
  height: 34px;
  border: 3px solid rgba(var(--accent-primary-rgb), 0.18);
  border-top-color: $accent-primary;
  border-radius: 50%;
  animation: wake-spin 0.9s linear infinite;
}

@keyframes wake-spin {
  to {
    transform: rotate(360deg);
  }
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.login-input {
  width: 100%;
  padding: 14px 16px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  font-size: 15px;
  color: $text-primary;
  background: $bg-input;
  outline: none;
  transition: border-color $transition-fast;
  box-sizing: border-box;
  font-family: $font-code;

  &::placeholder {
    color: $text-muted;
  }

  &:focus {
    border-color: $accent-primary;
  }
}

.login-error {
  font-size: 13px;
  color: $error;
  text-align: left;
}

.login-lock-hint {
  padding: 10px 12px;
  border: 1px solid rgba(var(--warning-rgb), 0.35);
  border-radius: $radius-sm;
  background: rgba(var(--warning-rgb), 0.08);
  color: $text-secondary;
  font-size: 12px;
  line-height: 1.5;
  text-align: left;

  code {
    display: block;
    margin-top: 4px;
    color: $text-primary;
    font-family: $font-code;
    word-break: break-all;
  }
}

.login-btn {
  width: 100%;
  padding: 14px;
  border: none;
  border-radius: $radius-sm;
  background: $text-primary;
  color: var(--text-on-accent);
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity $transition-fast;

  &:hover {
    opacity: 0.85;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}
</style>
