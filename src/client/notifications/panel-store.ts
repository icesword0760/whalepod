/**
 * Whether the notification-center panel (S5 Task 7's `shell.overlay`
 * occupant) is open. A module-level store, not local React state, because
 * the bell (`sidebar.footer.action`, `Bell.tsx`) and the panel
 * (`shell.overlay`) are different seats rendered into different React
 * subtrees (Ruling-S5-1) — exactly the reason `carousel/level-store.ts`
 * gives for its own module-level handle: a plain `useState` cannot bridge
 * two disjoint subtrees, only a shared store outside both can.
 *
 * Same shape as the other three plugin stores (`org/store.ts`,
 * `nav/store.ts`, `carousel/level-store.ts`): `apply()` creates ONE instance
 * via `.create()` and threads it through `WorkbenchInjected` (`hooks.panel`
 * for reads, `togglePanel` for the write — the same split
 * `hooks.notifications`/`pushNotification` already uses, since `hooks` is
 * rebound to a read-only selector hook and an imperative method placed there
 * would vanish from the component's props).
 * @module dsh-plugin-matou-layout/src/client/notifications/panel-store
 */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/**
 * Notification-center panel open/closed state. `open` is NOT `readonly`
 * here (unlike `level-store.ts`'s `parentBySceneId`, whose actions mutate the
 * record's CONTENTS rather than reassigning the field itself): `setOpen`/
 * `toggle` reassign `draft.open` directly, and `ActionsDecl<T>`'s `draft: T`
 * carries the interface's own modifiers — no immer `Draft<T>` unwrapping —
 * so a `readonly` field here would reject that assignment (see
 * `org/store.ts`'s `OrgMirrorState` for the same non-readonly convention on
 * a directly-reassigned scalar field).
 */
export interface PanelState {
  open: boolean
}

export type PanelActions = {
  /** Set the panel's open state explicitly. */
  setOpen: (draft: PanelState, open: boolean) => void
  /** Flip the panel's open state — what the bell's click uses. */
  toggle: (draft: PanelState) => void
}

/** Create the panel store handle; the plugin `apply()` owns its one instance. */
export function createPanelStore(): EngineStoreHandle<PanelState, PanelActions> {
  return defineStore({
    init: (): PanelState => ({ open: false }),
    // No `persist`: the panel starts closed on every reload, like every
    // other transient UI-chrome state this plugin tracks.
    actions: {
      setOpen: (draft, open) => { draft.open = open },
      toggle: (draft) => { draft.open = !draft.open },
    },
  })
}
