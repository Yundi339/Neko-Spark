import type { GmApi } from '@shared/types'

declare global {
  interface Window {
    gm: GmApi
  }
}

export {}
