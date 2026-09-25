/// <reference types="vite/client" />

import type { ShangboApi } from '../../shared/api'

declare global {
  interface Window {
    shangbo: ShangboApi
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

export {}