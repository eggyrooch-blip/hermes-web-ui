import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import { i18n } from './i18n'
import App from './App.vue'
import './styles/global.scss'

// Apply dark class before mount to prevent FOUC
const savedTheme = localStorage.getItem('hermes_theme') || 'system'
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
if (savedTheme === 'dark' || (savedTheme === 'system' && prefersDark)) {
  document.documentElement.classList.add('dark')
}

// Read token from URL BEFORE router initializes (hash router strips params).
// SECURITY: once captured, the token is removed from window.location so it
// cannot leak into Referer headers, browser history, screenshots, or shared
// links. The login view consumes it from window.__LOGIN_TOKEN__.
const urlParams = new URLSearchParams(window.location.search)
const [hashPath, hashQueryString] = window.location.hash.split('?')
const hashQuery = hashQueryString ? new URLSearchParams(hashQueryString) : null
const urlToken = urlParams.get('token') || hashQuery?.get('token') || null
if (urlToken) {
  ;(window as any).__LOGIN_TOKEN__ = urlToken
  urlParams.delete('token')
  hashQuery?.delete('token')
  const cleanedSearch = urlParams.toString()
  const cleanedHashQuery = hashQuery?.toString() || ''
  const cleanedHash = cleanedHashQuery ? `${hashPath}?${cleanedHashQuery}` : hashPath
  const cleanedUrl = `${window.location.pathname}${cleanedSearch ? `?${cleanedSearch}` : ''}${cleanedHash || ''}`
  try {
    window.history.replaceState(window.history.state, '', cleanedUrl)
  } catch {
    // Some embedded browsers reject history mutation; the token still lives
    // only in memory at this point.
  }
}

const app = createApp(App)
app.use(createPinia())
app.use(i18n)
app.use(router)
app.mount('#app')
