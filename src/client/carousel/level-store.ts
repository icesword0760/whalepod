/**
 * Which layer of the sibling-session carousel each scene currently shows —
 * the plugin's own analogue of 码头's `levelParentByScene`
 * (`HierarchyShell.tsx:445`, `Record<string, string | null | undefined>`),
 * and deliberately the SAME three states, because they mean three different
 * things:
 *
 * - `parentBySceneId[sceneId]` **absent** — no explicit layer: the layer is
 *   DERIVED from the focused session's own parent (码头
 *   `SessionCanvas.tsx:44-46`). This is the state a reload leaves behind.
 * - **`null`** — explicitly the scene's ROOT layer (the user navigated there).
 * - **a session id** — explicitly that session's children (the user drilled in).
 *
 * Collapsing "absent" into "root" is exactly what made the first pass at the
 * final review's I5 wrong: with an explicit layer 码头 does NOT move the
 * layer when focus goes elsewhere, it moves the FOCUS (`SessionCanvas.tsx:59`),
 * and a store that cannot tell the two apart cannot express that.
 *
 * Deliberately **not** persisted (no `persist` key, unlike `nav/store.ts`):
 * spec §3 "上台集合与持久化" states the drill depth resets on reload ("当前
 * 层（下钻深度）不持久化，重启回根层"), matching 码头. It is still "React
 * memory state" in the sense the brief asks for — a plain in-process
 * `defineStore` instance consumed through the same `useXxx`
 * (`SnapshotSelectorHook`) binding every other store on this plugin uses
 * (`org/store.ts`, `nav/store.ts`) — just without the localStorage mirror.
 *
 * Not persisting it is not the same as forcing the root layer, though: the
 * FOCUSED session is persisted per tab, so after a reload every scene is in
 * the "no explicit layer" state above and `AppFrame` DERIVES the layer from
 * that session's own parent — nothing is written back, exactly as 码头 keeps
 * deriving while `levelParentSessionId` is undefined. What is not persisted
 * is the layer itself; where the user was looking still is.
 *
 * A module-level store handle (not a per-scene one) because a globally
 * registered slot entry (`header-seats.tsx`'s `conversation.session.header.actions`
 * seat) needs to read/write the SAME instance `AppFrame` renders from, and
 * that seat is built once in `apply()`, outside AppFrame's own React subtree
 * — see the plan's Task 10 report for the full reasoning.
 * @module dsh-plugin-matou-layout/src/client/carousel/level-store
 */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

export interface LevelState {
  /** See the module doc for the absent / `null` / id three-state contract. */
  readonly parentBySceneId: Record<string, string | null>
}

export type LevelActions = {
  /**
   * Set one scene's EXPLICIT layer: a session id for its children, or `null`
   * for the scene's root layer. There is no "unset" verb — the derived state
   * is the initial one, which a user navigation deliberately leaves for good
   * (码头 never clears `levelParentByScene` either).
   */
  setLevel: (draft: LevelState, sceneId: string, parentSessionId: string | null) => void
}

/** Create the level store handle; the plugin `apply()` owns its one instance. */
export function createLevelStore(): EngineStoreHandle<LevelState, LevelActions> {
  return defineStore({
    init: (): LevelState => ({ parentBySceneId: {} }),
    // No `persist`: see the module doc — the drill depth is intentionally
    // memory-only and resets to the root layer on reload.
    actions: {
      setLevel: (draft, sceneId, parentSessionId) => {
        draft.parentBySceneId[sceneId] = parentSessionId
      },
    },
  })
}
