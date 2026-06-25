/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** AiHub portal URL surfaced as the expert-page entry button. Unset = button hidden. */
  readonly VITE_HERMES_AIHUB_URL?: string
}

declare const __APP_VERSION__: string

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
