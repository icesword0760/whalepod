/**
 * Persisted navigation memory. Device-local on purpose: "where I was looking"
 * is a per-browser fact, not part of the shared organization document.
 * @module dsh-plugin-matou-layout/src/client/nav/store
 */

import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import { EMPTY_NAV, remember } from './navigation.ts'
import type { NavMemory, NavTarget } from './navigation.ts'

export type NavActions = {
  navigate: (draft: NavMemory, target: NavTarget) => void
}

const PERSIST_KEY = 'dsh-plugin-matou-layout.nav.v1'

/** Create the navigation store handle; the plugin apply owns its instance. */
export function createNavStore(): EngineStoreHandle<NavMemory, NavActions> {
  return defineStore({
    init: (): NavMemory => ({
      taskByWorkspace: { ...EMPTY_NAV.taskByWorkspace },
      sceneByTask: { ...EMPTY_NAV.sceneByTask },
      sessionByScene: { ...EMPTY_NAV.sessionByScene },
    }),
    persist: PERSIST_KEY,
    actions: {
      navigate: (draft, target: NavTarget) => {
        const next = remember(draft, target)
        draft.activeWorkspaceId = next.activeWorkspaceId
        draft.taskByWorkspace = next.taskByWorkspace
        draft.sceneByTask = next.sceneByTask
        draft.sessionByScene = next.sessionByScene
      },
    },
  })
}
