/// <reference types="vite/client" />
import type { InfohubApi } from '../../shared/ipc'

declare global {
  interface Window {
    api: InfohubApi
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
