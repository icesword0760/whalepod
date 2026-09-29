/**
 * Whether the session-DAG overlay (S4 Task 12's `shell.overlay` occupant) is
 * open. A module-level store, not local React state, for the same Ruling-S5-1
 * reason `notifications/panel-store.ts` gives: the tab-bar button
 * (`workbench/SceneTabBar.tsx`, inside AppFrame's stage) and the overlay
 * itself (`shell.overlay`, a sibling seat) are rendered into different React
 * subtrees, and a plain `useState` cannot bridge two disjoint subtrees.
 *
 * Same shape as the plugin's other stores (`org/store.ts`, `nav/store.ts`,
 * `carousel/level-store.ts`, `notifications/panel-store.ts`): `apply()`
 * creates ONE instance via `.create()` and threads it through
 * `WorkbenchInjected` — `hooks.dag` for reads, `openDag`/`closeDag` (plain
 * top-level `WorkbenchActions` members, outside the `hooks` compartment the
 * renderer strips down to read-only selector hooks) for the writes.
 *
 * **No `toggle`, unlike the notification bell's panel — deliberate.** The bell
 * needs one because the same control both opens and closes the panel, and it
 * paid for that with the pointerdown/click double-flip documented across
 * `notifications/NotificationCenter.tsx:40-83`. The DAG overlay cannot have
 * that problem: while it is open `#root` is `inert` (S4 Task 12), so the tab
 * bar's button is not clickable at all. Every open therefore comes from the
 * tab bar and every close from the overlay's own Esc / close button / node
 * click — two different interactions, each meaning exactly one direction. So
 * `openDag` only ever writes `true` and `closeDag` only ever writes `false`,
 * and there is no verb that could flip the wrong way.
 * @module dsh-plugin-matou-layout/src/client/dag/panel-store
 */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/**
 * DAG overlay open/closed state. `open` is NOT `readonly` (the same
 * convention `notifications/panel-store.ts`'s `PanelState` explains):
 * `setOpen` reassigns `draft.open` directly, and `ActionsDecl<T>`'s `draft: T`
 * carries the interface's own modifiers — no immer `Draft<T>` unwrapping — so
 * a `readonly` field here would reject that assignment.
 */
export interface DagPanelState {
  open: boolean
}

export type DagPanelActions = {
  /** Set the overlay's open state explicitly — the only write (see the module doc on why there is no `toggle`). */
  setOpen: (draft: DagPanelState, open: boolean) => void
}

/** Create the DAG-overlay store handle; the plugin `apply()` owns its one instance. */
export function createDagPanelStore(): EngineStoreHandle<DagPanelState, DagPanelActions> {
  return defineStore({
    init: (): DagPanelState => ({ open: false }),
    // No `persist`: the overlay starts closed on every reload, like every
    // other transient UI-chrome state this plugin tracks. (The DAG's viewport
    // IS persisted — `dag/viewport-store.ts` — because it is the user's
    // observation point, not chrome.)
    actions: {
      setOpen: (draft, open) => { draft.open = open },
    },
  })
}
