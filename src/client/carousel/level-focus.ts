/**
 * Which card a layer focuses when the current session is not one of its own.
 *
 * Lifted out of `AppFrame` by the third live walkthrough (2026-09-07), which
 * found that **switching tabs away and back moved the focus** — spec §7.1 step
 * 6 asks for the focused card AND the scroll position to survive that trip, and
 * only the scroll did.
 *
 * The cause was a half-finished loop: `geometry-store.ts` has always WRITTEN
 * `focusedSessionId` into each level's record, and nothing anywhere READ it
 * back. The carousel controller's restore effect uses `scrollLeft` and the
 * anchor only — it cannot do more, because the focused card is DSH's current
 * session and the controller does not own that. `AppFrame` did own it, and
 * picked `currentLevelNodes[0]`: the layer's first card, unconditionally. So
 * returning to a tab always landed on the first card, which (the layer being
 * ordered most-recently-used first) is usually not the one the user left.
 *
 * This function closes the loop and is the only place the choice is made.
 * @module dsh-plugin-matou-layout/src/client/carousel/level-focus
 */

export interface LevelFocusInput {
  /**
   * The layer the user explicitly stands in: `null` for the root layer, an id
   * for a drilled one, `undefined` for "unset" — see `level-store.ts`'s
   * three-state contract. `undefined` means the layer is DERIVED from the
   * focused session (码头 `SessionCanvas.tsx:43-46`), so by construction the
   * focus is already in it and there is nothing to choose.
   */
  readonly explicitParentId: string | null | undefined
  /** DSH's current session, if any. */
  readonly currentSessionId: string | undefined
  /** That session's effective parent, if it is known to this scene's graph. */
  readonly currentParentId: string | undefined
  /** The layer being rendered: `undefined` for the root layer. */
  readonly parentId: string | undefined
  /** This layer's cards, in the order the user sees them. */
  readonly levelSessionIds: readonly string[]
  /** What this level's persisted geometry remembers being focused, if anything. */
  readonly persistedFocusedSessionId: string | undefined
}

/**
 * Choose the card an explicit layer should focus, or nothing when the layer
 * should leave the focus alone.
 * @param input - the layer, the current session, the layer's cards and what the level remembers.
 * @returns the session to focus, or `undefined` to change nothing.
 */
export function levelFocusTargetOf(input: LevelFocusInput): string | undefined {
  // Rule 1: a derived layer never moves the focus — it IS the focus's layer.
  if (input.explicitParentId === undefined) return undefined
  // The current session already stands in this layer: nothing to do.
  if (input.currentSessionId !== undefined && input.currentParentId === input.parentId) return undefined
  // An empty layer moves nothing, which is what leaves the user free to create
  // a session in a layer whose children were all removed.
  if (input.levelSessionIds.length === 0) return undefined
  // The remembered card wins, but only while it is still HERE: a record
  // outlives the session it names (removal, archiving), and focusing a card
  // that no longer exists shows the user an empty focused slot.
  const remembered = input.persistedFocusedSessionId
  if (remembered !== undefined && input.levelSessionIds.includes(remembered)) return remembered
  return input.levelSessionIds[0]
}
