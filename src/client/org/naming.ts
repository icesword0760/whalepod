/**
 * UI-level naming rules and destructive-action impact counts. These stay out
 * of the reducer on purpose: uniqueness and auto-numbering are how the
 * workbench talks to the user, not integrity constraints of the document.
 * @module dsh-plugin-matou-layout/src/client/org/naming
 */

import type { MatouSceneView, MatouTaskView } from './derive.ts'

/**
 * "base", "base 2", "base 3"… skipping names already in use (PRD 03/05).
 * @param existing - sibling names in the same scope.
 * @param base - the localized base word.
 * @returns the first free numbered name.
 */
export function nextNumberedName(existing: readonly string[], base: string): string {
  const taken = new Set(existing.map(name => name.trim()))
  if (!taken.has(base)) return base
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${index}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Validate a user-entered name against its siblings.
 * @param name - raw input.
 * @param taken - sibling names (the item's own current name excluded by the caller).
 * @param labels - localized failure copy.
 * @returns a failure message, or undefined when the name is acceptable.
 */
export function validateUniqueName(
  name: string,
  taken: readonly string[],
  labels: { readonly empty: string; readonly duplicate: string },
): string | undefined {
  const trimmed = name.trim()
  if (trimmed.length === 0) return labels.empty
  if (taken.some(candidate => candidate.trim() === trimmed)) return labels.duplicate
  return undefined
}

export interface DeleteImpact {
  readonly sceneCount: number
  readonly sessionCount: number
}

/** What removing a task takes with it (sessions are only unplaced, never deleted). */
export function taskDeleteImpact(task: MatouTaskView): DeleteImpact {
  return {
    sceneCount: task.scenes.length,
    sessionCount: task.scenes.reduce((sum, scene) => sum + scene.sessions.length, 0),
  }
}

/** What removing a scene takes with it. */
export function sceneDeleteImpact(scene: MatouSceneView): DeleteImpact {
  return { sceneCount: 1, sessionCount: scene.sessions.length }
}
