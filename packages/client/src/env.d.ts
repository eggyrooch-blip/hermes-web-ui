/// <reference types="vite/client" />

declare const __APP_VERSION__: string

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

// noVNC ships untyped ES modules; ScreenView narrows the RFB surface it uses.
declare module '@novnc/novnc' {
  const RFB: unknown
  export default RFB
}
