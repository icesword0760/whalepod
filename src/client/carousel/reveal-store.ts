/**
 * One **explicit navigation request** per workbench tab: "put this session
 * back under the user's eyes, and do it even if it is already the focused
 * one." The plugin's port of 码头's `revealSessionByScene`
 * (`hierarchy/HierarchyShell.tsx:1047-1054`), whose payload is the same pair
 * — a session id plus a monotonically increasing `sequence`.
 *
 * **Why a counter and not just the id (S4 裁定 T-5).** The carousel centers
 * the focused card from an effect keyed on `focusedSessionId`
 * (`useCarouselController.ts`'s "Center the focused card whenever it
 * changes"), which returns early when that id did NOT change. Both callers
 * that need this store routinely name the session that is ALREADY focused:
 * the DAG overlay's node click (spec §7.3 step 6 requires the carousel to
 * re-center on it) and the notification center's row click (S5 shipped with
 * exactly this dead spot — clicking a row pointing at the current session
 * did nothing at all). React has no state change to observe there, so the
 * request itself has to carry the change. 码头 says the same thing in its
 * own words at `session-canvas/SessionCarousel.tsx:366-370`: "DAG and
 * notification navigation may select the already-focused Session. In that
 * case React has no focus-ID change to observe, so force the carousel
 * position from this explicit navigation request."
 *
 * Keyed **by scene**, exactly like 码头's `Record<sceneId, {sessionId,
 * sequence}>`: two tabs each remember their own last request, and revealing
 * something in one tab must not yank the other tab's strip around when the
 * user comes back to it.
 *
 * A module-level store instance rather than React state, for the same
 * Ruling-S5-1 reason `notifications/panel-store.ts` and
 * `carousel/level-store.ts` give: the writers (`workbench/actions.ts`'s
 * `revealSession`, reached from the DAG overlay seat and the notification
 * panel seat) and the reader (`AppFrame` → `Carousel`) live in disjoint
 * React subtrees.
 *
 * **Not persisted** (no `persist`, like `level-store.ts`): a reveal is a
 * momentary instruction, not a place. Replaying the last session's request
 * on reload would fight the per-level geometry restore that spec §7.1 step 6
 * relies on.
 * @module dsh-plugin-matou-layout/src/client/carousel/reveal-store
 */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** One tab's latest reveal instruction. `seq` is what makes a repeat of the same `sessionId` observable. */
export interface RevealRequest {
  readonly sessionId: string
  /** Monotonic per scene, starting at 1; consumers act on a CHANGE, never on the value. */
  readonly seq: number
}

export interface RevealState {
  /**
   * Latest request per scene id. `readonly` on the field (the record's
   * CONTENTS are what the action mutates) — same convention as
   * `level-store.ts`'s `parentBySceneId`.
   */
  readonly bySceneId: Record<string, RevealRequest>
}

export type RevealActions = {
  /**
   * Record "center `sessionId` in `sceneId` now", bumping that scene's `seq`.
   * There is no "clear" verb: a consumed request costs nothing to keep, and
   * clearing it would need a second write from the view layer for no gain.
   */
  request: (draft: RevealState, sceneId: string, sessionId: string) => void
}

/** Create the reveal store handle; the plugin `apply()` owns its one instance. */
export function createRevealStore(): EngineStoreHandle<RevealState, RevealActions> {
  return defineStore({
    init: (): RevealState => ({ bySceneId: {} }),
    actions: {
      request: (draft, sceneId, sessionId) => {
        draft.bySceneId[sceneId] = { sessionId, seq: (draft.bySceneId[sceneId]?.seq ?? 0) + 1 }
      },
    },
  })
}
